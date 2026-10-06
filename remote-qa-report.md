# PR 25658 exact-head hidden Electron QA

Head: `354c3efb70d0214bf8a9bdb44aab7baf50d4ae65` in `/Users/m4air/orca/workspaces/orca/pr25658-review-qa-2`.

The isolated app launched through `launch-final.sh` with `ORCA_BACKGROUND_LAUNCH=1`, isolated HOME/userData/CODEX_HOME/CLAUDE_CONFIG_DIR and Chromium `--password-store=basic --use-mock-keychain` switches. CDP identity reported the exact child repo root and `pr25658-review-qa-2` label; no managed accounts or personal chats were seeded.

I used CDP to open Settings > Appearance and directly inspected `final-preview.png`. The live dark preview shows the translated synthetic question, 12-second work state, expanded Grep/Read tool run, JSON code and closing answer above the controls; the preview has `inert`, capture blockers in source, and a measured 738px by 440px viewport.

The permitted real Codex hashes stayed hooks `78922a784ee78e9e50587e93628cd3b9d4dfbe49087adc4514e6781cea38cbb9` and config `5c86e7f86d0c451ba78e9d53673ea75a28bef0882d4b40084c07b679ad9cdbbe`; the exact-child config trust count remained 1. This bounded rerun did not complete the requested six-locale, light theme, drag/keyboard/reset, or all geometry matrix before handoff; those remain unverified.

Two pre-Electron launch failures are retained in `launch-final.log`: `/usr/bin/node` did not exist, then electron-vite rejected unseparated Chromium flags. The final launcher uses the dependency install in this owned child and forwards the flags after `--`; final CDP reached `http://localhost:5174/` on port 9441.
