# PR 25658 final pushed-head QA

- Final head: `37f4353d0905d621c104f33fafdb9889a263b1fa`; pinned parent baseline: `4ee3dddb3625ee4966e6e60d3f172f4ed0f30599`.
- Both heads were built in the owned child and launched with `env -i`, isolated HOME, ORCA_DEV_USER_DATA_PATH, CODEX_HOME, CLAUDE_CONFIG_DIR, ORCA_BACKGROUND_LAUNCH=1, `--password-store=basic`, and `--use-mock-keychain`; final app startup logged its resolved isolated userData path.
- Baseline has the settings controls at 14/12 but no preview node, so it cannot establish equivalent preview-row geometry or attribute final preview clipping; the final 440px preview geometry and visible narrow 20/18 screen are recorded as observations.
- Final driver passed 23 records: dark/light defaults, matching switch, all width caps, held contrast preview then release publication, keyboard focus, reset including held-draft Enter/reset/release, collapse retention, six locales, inert/no-links, and narrow/wide screenshots.
- Native context menu/clipboard behavior was deliberately not probed. Gemini was not used because the task prohibited extra agents; the verifier inspected the uncropped CDP screenshots directly.

## Safety observations

- hooks.json SHA256 before/after: `78922a784ee78e9e50587e93628cd3b9d4dfbe49087adc4514e6781cea38cbb9` (unchanged).
- config.toml SHA256 before/after: `375d81e0cf0617ba4f5e2602fb5e6de646c84b8626d4e95e325f27181d01a2b8`.
- Baseline launch group 78859 was terminated and its CDP/renderer listeners were absent afterward. Final launch group 5856 remains live pending coordinator copy acknowledgment.

## Superseded evidence disclosure

- The initial baseline is parent `4ee3dddb...`, not the required `origin/main`, and its `narrow-20-18` filename is inaccurate: the recorded fields remain 14/12. Those baseline screenshots and report must not be used as the required comparison.
- The initial locale screenshots are incomplete: they only waited for persisted `uiLanguage` and animation frames, so they do not prove the loaded catalog. The replacement driver now waits for the locale-specific preview question, tool line, and closing text before taking each screenshot.
- A prior report line included a QA-worktree `config.toml` trust-count observation. It was an actual earlier `grep -c` read under the then-provided rule, not copied text; it is removed from the active safety claim and will not be read again.
