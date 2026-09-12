# DSH Console

Orca can launch the npm-published `@cofy-x/dsh-console` terminal UI in folder workspaces and Git worktrees. Choose **DSH Console** in the new-tab agent menu or set it as the default agent in Settings. Agent command, arguments and environment overrides use the same settings as other terminal agents.

## Installation

Install Node.js 24, pnpm, the public DSH CLI and DSH Console **on the host that runs the terminal**. For normal use, install the current npm `latest` releases:

```sh
npm install -g @deepseek-ai/dsh @cofy-x/dsh-console
```

This writes the selected npm global prefix. DSH's launcher creates its `dsh-console` profile on first use and uses pnpm for profile packages. Detection requires `dsh-console`, `dsh`, `pnpm` and `node` on the execution host's PATH. Restart Orca or refresh agent detection after changing PATH. Configure and authenticate DSH normally before launching a model session; Orca does not copy or manage provider credentials.

The recorded verification baseline is `@cofy-x/dsh-console@0.1.0-alpha.13` with `@deepseek-ai/dsh@0.1.5-rc.1`; installing newer releases does not rerun that acceptance. The DSH packages use caret dependency ranges. Pinning the top-level CLI alone does **not** pin all of its transitive DSH packages; use a lockfile and explicit overrides when reproducing a coherent prerelease baseline. See the [published launcher](https://github.com/cofy-x/dsh-console) for upstream installation requirements.

## Launch and resume

The published launcher supports these interactive arguments:

- `--prompt <text>` / `-p`: submit an initial prompt and remain interactive. Orca uses this for an initial message.
- `--continue` / `-c`: continue the latest matching workspace conversation. Set this in the agent's additional arguments when that is the desired launch behavior.
- `--resume <session-id>`: resume an exact DSH conversation. Orca captures the provider's session ID from real session events and uses this for its resume flow.
- `/quit` (alias `/exit`): leave the Console. Ctrl+C cancels an active request through the native Console UI. Escape handles prompt editing and dismissing suggestions; the tested release still displays an inaccurate “esc to cancel” hint while running.

`--prompt-interactive` is not a public launcher flag for the tested Console version. Session IDs are provider IDs, not Orca pane or terminal IDs. DSH remains responsible for transcript persistence and workspace-scoped continuation.

## Status bridge

Orca installs a Cordis plugin that activates only for Orca-launched sessions into:

```text
$DSH_HOME/profiles/dsh-console/orca-status/index.mjs
$DSH_HOME/profiles/dsh-console/orca-status/package.json
```

`DSH_HOME` defaults to `~/.dsh`. The installer adds one managed insert entry to the profile's `cordis.patch.yml`, preserves other entries, comments and `!!js` expressions, and refuses conflicting files or overrides. Removing the integration removes that entry and the two managed files. The anonymous package manifest is required: DSH's request inventory rejects a loose plugin whose nearest named package manifest has no version, as is normal for profile manifests.

The plugin observes public `session/event`, `agent/session-start`, `approval/request` and `user-questions/request` events. It forwards bounded snapshots through Orca's authenticated loopback hook endpoint into the existing unified agent status store. Native approval/question handlers retain their answers, errors and cancellation behavior. Root Console sessions are tracked; completion helpers and side sessions do not overwrite the main pane's status. No transcript polling or separate durable status database is introduced.

Working, waiting for input, blocked for approval, completed and interrupted turns use the existing Orca status and notification paths. Process exit uses the existing PTY lifecycle. DSH's dynamic terminal titles share Gemini's symbols; a proven DSH owner is retained instead of relabeling that pane as Gemini. Native notification display still depends on operating-system permission and Orca notification settings.

## Execution boundaries and compatibility

- **Local:** installation follows Orca's inherited `DSH_HOME`; launch the app with that environment if using a custom home. A per-command override to a different home needs the bridge installed in that home as well. No credentials or home directory are automatically copied.
- **SSH:** detection and installation run on the terminal host. The relay resolves that host's login-shell `DSH_HOME`, installs through the existing host filesystem/SFTP boundary, and uses the existing hook relay. Mac paths must not be used as remote configuration paths.
- **Windows/WSL:** local files use native path handling and atomic replacement. Existing PowerShell/cmd launch quoting and WSL guest launch/relay paths are reused. Install the CLI and its prerequisites in the selected environment; Windows installations do not establish WSL availability.
- **Version skew:** exact DSH session resume is gated by `agent-session.dsh-console-resume.v1` so an older host is not sent an unsupported resume enum.

The tested Console/DSH combination has a question-answer UI and service, but its default bundle does not register the model-facing `ask_user_question` tool. Real question testing therefore requires the public `@deepseek-ai/dsh-tool-ask-user` plugin in the **test/user profile**. Orca deliberately does not change the user's tool composition. Adding only an agent-preset roster does not mount that preset into Console's agent factory; upstream would need to compose the chosen preset during agent creation/resume for that broader behavior.

## Published-version limits

The macOS acceptance run also reproduced an early-cancellation race: pressing Ctrl+C immediately after submission displayed `Request cancelled.` in Console, but Orca's status remained working for 60 seconds. Cancelling after the actual `sleep 30` tool card appeared produced the real aborted turn event, updated Orca to interrupted, and allowed normal exit. The passing cancellation test waits for that tool card. This does not establish that early cancellation is fixed.

Orca excludes DSH from generic key-based interruption inference, because Escape only edits the prompt in this release and even Ctrl+C intent is not proof that execution ended. A minimal upstream remedy is to cancel pending prompt preparation/materialization as well as active execution, and guarantee a session/turn-qualified terminal event for accepted cancellation, including cancellation before the first step. This needs upstream validation; the integration does not patch the published Console package.

## Validation

The opt-in `tests/e2e/dsh-console-published.spec.ts` uses a published-package fixture and a configured real model. Its fixture root supplies `pinned-runtime/node_modules/.bin`, `toolchain/node_modules/.bin`, `dsh-home`, and an isolated `console-settings.json`; it never imports the Console development checkout. Keep provider credentials inside the ignored fixture home, not in committed fixtures or logs.

The tests use Orca's hidden Electron harness. `ORCA_DSH_CONSOLE_ACCEPTANCE_ROOT` selects the isolated fixture; `ORCA_BACKGROUND_LAUNCH=1` must remain set. Build the current Electron E2E and CLI outputs before using the harness's `SKIP_BUILD=1` option. The test outputs contain terminal screenshots and real notification dispatch results; unit tests of the bridge are distinct from published-package acceptance.

macOS arm64 is the local acceptance environment. SSH, Windows and WSL require validation on those actual hosts before claiming end-to-end support there.
