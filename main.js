// ==UserScript==
// @name         GitHub Issue Triage Helper
// @namespace    https://github.com/nbolton/github-triage-helper
// @license      MIT
// @version      0.1
// @description  Suggest triage questions for GitHub issues using AI
// @author       nbolton
// @match        https://github.com/*/*/issues/*
// @grant        GM_xmlhttpRequest
// @connect      api.openai.com
// @connect      api.github.com
// @grant        GM.getValue
// @grant        GM.setValue
// ==/UserScript==

(async function () {
    'use strict';

    const suggestionBoxStyle = {
        margin: '16px 0px 0px 55px',
        padding: '12px 16px',
        border: '1px solid #30363d',
        borderRadius: '6px',
        fontSize: '14px',
        lineHeight: '1.5',
        whiteSpace: 'pre-wrap',
    };

    let apiKey = await GM.getValue("openai_api_key");
    if (!apiKey) {
        apiKey = prompt("OpenAI API key:");
        if (apiKey) {
            await GM.setValue("openai_api_key", apiKey);
        }
    }

    let githubToken = await GM.getValue("github_token");
    if (!githubToken) {
        githubToken = prompt("GitHub API token:");
        if (githubToken) {
            await GM.setValue("github_token", githubToken);
        }
    }

    let box = null;
    let lastUrl = location.href;

    const observer = new MutationObserver(() => {
        if (location.href !== lastUrl) {
            lastUrl = location.href;
            console.debug("URL changed:", lastUrl);
            onUrlChange();
            return;
        }

        // prevent recursion
        if (document.getElementById('ai-suggestions-box')) return;

        console.debug("DOM changed, injecting suggestion box");

        box = injectSuggestionBox();
        if (!box) {
            console.debug("No where to inject suggestion box");
            return;
        }

        box.innerHTML = "Loading AI suggestions...";
    });

    observer.observe(document.body, {
        childList: true,
        subtree: true
    });

    function onUrlChange() {
        run();
    }

    async function getIssueContext() {
        const pathMatch = window.location.pathname.match(/^\/([^/]+)\/([^/]+)\/issues\/(\d+)/);
        if (!pathMatch) return null;

        const [, owner, repo, issueNumber] = pathMatch;
        return { owner, repo, issueNumber };
    }

    async function fetchIssueText(githubToken) {
        console.log("Fetching issue text...");

        const context = await getIssueContext();
        if (!context) throw new Error("Invalid GitHub URL");

        console.debug("Issue number:", context.issueNumber);

        const { owner, repo, issueNumber } = context;

        const headers = {
            'Accept': 'application/vnd.github+json',
            'Authorization': `token ${githubToken}`,
            'User-Agent': 'GitHub-Issue-Triage-Script'
        };

        const issueUrl = `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}`;
        const commentsUrl = `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/comments`;

        const fetchWithGM = (url, timeoutMs = 5000) => {
            return Promise.race([
                new Promise((resolve, reject) => {
                    GM_xmlhttpRequest({
                        method: 'GET',
                        url,
                        headers,
                        onload: (res) => {
                            if (res.status !== 200) return reject(`GitHub API error ${res.status} for ${url}`);
                            try {
                                resolve(JSON.parse(res.responseText));
                            } catch (e) {
                                reject(`Failed to parse JSON from ${url}`);
                            }
                        },
                        onerror: () => reject(`Network error for ${url}`)
                    });
                }),
                new Promise((_, reject) => setTimeout(() => reject(new Error(`Request timed out after ${timeoutMs}ms`)), timeoutMs))
            ])
        }

        const [issue, comments] = await Promise.all([
            fetchWithGM(issueUrl),
            fetchWithGM(commentsUrl)
        ]);

        console.debug("GitHub response:", issue, comments);

        const allText = [
            `@${issue.user.login} (OP):\n${issue.body}`,
            ...comments.map(c => `@${c.user.login}:\n${c.body}`)
        ].join('\n\n---\n\n');

        return allText;
    }

    async function fetchAISuggestions(commentsText, apiKey) {
        console.log("Fetching AI suggestions...");

        const payload = JSON.stringify({
            model: "gpt-3.5-turbo",
            messages: [
                {
                    role: "system",
                    content: "You're a helpful assistant that suggests triage questions for GitHub issues."
                },
                {
                    role: "user",
                    content: `Here are comments from a GitHub issue:\n\n${commentsText}\n\nWhat questions would help triage this issue?`
                }
            ],
            temperature: 0.7,
            max_tokens: 300
        });

        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'POST',
                url: 'https://api.openai.com/v1/chat/completions',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`
                },
                data: payload,
                onload: function (response) {
                    try {
                        const json = JSON.parse(response.responseText);
                        console.debug("AI response:", json);
                        const content = json.choices?.[0]?.message?.content || 'No response';
                        resolve(content);
                    } catch (e) {
                        reject('Failed to parse AI response');
                    }
                },
                onerror: function () {
                    reject('Failed to reach AI server');
                }
            });
        });
    }

    function injectSuggestionBox(content) {
        const timeline = document.querySelector('[class*="Timeline-Timeline"]');

        if (!timeline) {
            return null;
        }

        const box = document.createElement('div');
        box.id = 'ai-suggestions-box';
        Object.assign(box.style, suggestionBoxStyle);
        timeline.parentNode.insertBefore(box, timeline.nextSibling);
        return box;
    }

    async function run() {

        if(!/\/issues\/\d+$/.test(location.href)) {
            console.log("Ignoring:", location.href);
            return;
        }

        const aiInput = await fetchIssueText(githubToken);
        console.debug("AI input text length:", aiInput.length);

        const aiSuggestions = await fetchAISuggestions(aiInput, apiKey);
        console.debug("AI suggestions:", aiSuggestions);

        if (!box) {
            // TODO: delay rendering until it is loaded
            console.error("Suggestions box didn't load in time");
            return;
        }

        box.innerHTML = aiSuggestions;
    }

    unsafeWindow.resetApiKey = async function () {
        await GM.deleteValue("openai_api_key");
        alert("API key cleared via console. Reload to re-enter.");
    };

    unsafeWindow.checkApiKey = async function () {
        const val = await GM.getValue("openai_api_key");
        console.log("Stored API key:", val);
    };

    unsafeWindow.resetGitHubToken = async function () {
        await GM.deleteValue("github_token");
        alert("GitHub token key cleared via console. Reload to re-enter.");
    };

    unsafeWindow.checkGitHubToken = async function () {
        const val = await GM.getValue("github_token");
        console.log("Stored GitHub token:", val);
    };

    run();
})();
