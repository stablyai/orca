---
name: orca-cli
description: >-
  Use the public `orca` CLI to operate Orca-managed worktrees, folder contexts,
  terminals, repos, automations, worktree comments, and the browser embedded
  inside the Orca app. Use when the user says "$orca-cli", "use orca cli",
  "Orca worktree", "child worktree", "spawn codex/claude in a worktree",
  "read/wait/send Orca terminal", "terminal send", "Orca browser", or "control
  the browser inside Orca". Prefer this over raw `git worktree`, ad hoc PTYs,
  Playwright, or Computer Use when the task touches Orca-managed state. Use
  Computer Use for browser windows, webviews, or desktop UI outside Orca's
  embedded browser.
---

# Orca CLI

Use `orca` when Orca's running editor/runtime is the source of truth. On Linux, use `orca-ide` wherever this file says `orca`.

**Dev builds (`pnpm dev`):** after `pnpm build:cli`, the dev CLI is exposed as `orca-dev` (the global shim points at this checkout's wrapper + out/cli). Inside a dev Orca's terminals use `orca-dev emulator ...` (or `./config/scripts/orca-dev.mjs emulator ...` for worktree-local invocation that does not depend on the /usr/local/bin symlink). Plain `orca` targets any installed production Orca. The app's own agent preambles use `orca-dev` automatically in dev mode.

Use plain shell tools when Orca state does not matter.

## Start Here

```bash
command -v orca || command -v orca-ide
orca status --json
orca worktree ps --json
orca terminal list --json
```

If Orca is not running, start it:

```bash
orca open --json
orca status --json
```

Prefer `--json` for agent-driven calls. If the CLI is missing, say so explicitly instead of inspecting source files first.

## Worktrees

An Orca worktree is Orca's tracked view of a repo checkout, its metadata, terminals, browser tabs, and UI state.

Common commands:

```bash
orca repo list --json
orca repo show --repo id:<repoId> --json
orca repo add --path /abs/repo --json
orca repo set-base-ref --repo id:<repoId> --ref origin/main --json
orca repo search-refs --repo id:<repoId> --query main --limit 10 --json
orca worktree list --repo id:<repoId> --json
orca worktree ps --json
orca worktree current --json
orca worktree show --worktree <selector> --json
orca worktree create --repo id:<repoId> --name related-task --json
orca worktree create --repo id:<repoId> --name related-task --parent-worktree active --json
orca worktree create --repo id:<repoId> --name folder-child --parent-worktree folder:<folderId> --json
orca worktree create --name child-task --agent codex --prompt "hi" --json
orca worktree create --name independent-task --no-parent --json
orca worktree set --worktree id:<worktreeId> --display-name "My Task" --json
orca worktree set --worktree active --comment "reproduced bug; testing fix" --json
orca worktree rm --worktree id:<worktreeId> --force --json
```

Selectors:

- `id:<worktreeId>`, `path:<absolutePath>`, `branch:<branchName>`, `issue:<number>`
- `active` / `current` for the enclosing Orca-managed worktree from the shell cwd
- For `worktree create --parent-worktree` only, folder/worktree parent context keys are also valid: `folder:<folderId>`, `worktree:<worktreeId>`, `id:folder:<folderId>`, `id:worktree:<worktreeId>`

Lineage rules:

- When creating from inside an Orca-managed worktree or folder context, Orca infers the current parent context when it can.
- Use `--parent-worktree active` when the child worktree relationship should be explicit.
- Use `--parent-worktree folder:<folderId>` or `--parent-worktree worktree:<worktreeId>` when a folder or worktree parent context should be explicit.
- Use `--no-parent` only when the new work is independent.
- If `--repo` is omitted, Orca infers the repo from the current Orca worktree when possible.

Agent/setup flags:

```bash
orca worktree create --name task --agent codex --prompt "hi" --json
orca worktree create --name task --agent claude --setup run --json
orca worktree create --name task --setup skip --json
orca worktree create --name task --run-hooks --json
```

- `--agent <id>` launches that agent in the first terminal; `--prompt <text>` sends initial work to it.
- `--setup run|skip|inherit` controls repo setup hooks. Default is `inherit`, which follows the repo's setup policy.
- `--run-hooks` is a legacy alias for `--setup run`; it also reveals/activates the new worktree.
- `--agent`, `--activate`, and `--run-hooks` reveal the new worktree. Plain create stays in the background.
- Let Orca choose setup terminal placement from repo settings, including tab vs split behavior. Do not manually create extra setup terminals.
- If an older installed CLI rejects `--agent`, `--prompt`, or `--setup`, create the worktree normally, then run `orca terminal create --worktree <selector> --command "codex"` and `orca terminal send` if a prompt is needed.
- `worktree create` creates a new checkout. For a fresh agent in the current checkout, use `orca terminal create --worktree active --command "codex" --json`.

## Worktree Comments

A worktree comment is the short status text shown in Orca's workspace list/card for quick progress visibility.

Coding agents should update the active worktree comment at meaningful checkpoints:

```bash
orca worktree set --worktree active --comment "fix implemented; running integration tests" --json
```

Update after meaningful state changes such as repro, fix, validation, handoff, or blocker. Keep comments short/current; failures are best-effort unless Orca state was requested.

## Terminals

Common commands:

```bash
orca terminal list --worktree id:<worktreeId> --json
orca terminal show --terminal <handle> --json
orca terminal read --terminal <handle> --json
orca terminal read --terminal <handle> --cursor <cursor> --limit 1000 --json
orca terminal read --json
orca terminal send --terminal <handle> --text "continue" --enter --json
orca terminal send --text "echo hello" --enter --json
orca terminal wait --terminal <handle> --for exit --timeout-ms 5000 --json
orca terminal wait --terminal <handle> --for tui-idle --timeout-ms 300000 --json
orca terminal stop --worktree id:<worktreeId> --json
orca terminal create --json
orca terminal create --title "Worker" --json
orca terminal create --worktree active --command "codex" --json
orca terminal split --terminal <handle> --direction vertical --json
orca terminal split --terminal <handle> --direction horizontal --command "npm test" --json
orca terminal rename --terminal <handle> --title "New Name" --json
orca terminal switch --terminal <handle> --json
orca terminal close --terminal <handle> --json
```

Terminal rules:

- `--terminal` is optional for most commands; omitted means the active terminal in the current worktree.
- Use `terminal read` before `terminal send` unless the next input is obvious.
- Use `terminal send` only for direct terminal input or one-off prompts where no task state, inbox, or reply tracking is needed.
- For structured coordination, invoke the `orchestration` skill; it uses `orca orchestration ...` commands for messages, handoffs, task DAGs, dispatches, inbox/reply flows, and coordinator loops.
- Use `terminal create --worktree active --command "<agent>"` for a fresh agent in the current worktree. Use `worktree create --agent <agent>` only for a separate checkout.
- Use `terminal wait --for tui-idle` for agent CLIs such as Claude Code, Gemini, and Codex; always pass `--timeout-ms`.
- Terminal handles are runtime-scoped. If Orca restarts or returns `terminal_handle_stale`, reacquire with `terminal list`.
- For long output, use cursor reads. After a limited tail preview, page from `oldestCursor`; after a cursor read, continue with `nextCursor` while `limited` is true and `nextCursor !== latestCursor`.
- `--direction horizontal` splits left/right. `--direction vertical` splits top/bottom.

## Automations

An automation is a scheduled Orca prompt run by a chosen provider against either a repo-created worktree or an existing workspace.

```bash
orca automations list --json
orca automations show <automationId> --json
orca automations create --name "Daily review" --trigger daily --time 09:00 --prompt "Review open changes" --provider codex --repo id:<repoId> --json
orca automations create --name "Weekday triage" --trigger "0 9 * * 1-5" --prompt "Triage issues" --provider claude --repo path:/abs/repo --disabled --json
orca automations create --name "Inbox digest" --trigger hourly --prompt "Summarize unread mail" --provider codex --workspace active --reuse-session --json
orca automations edit <automationId> --trigger weekdays --time 09:30 --fresh-session --json
orca automations run <automationId> --json
orca automations runs --id <automationId> --json
orca automations remove <automationId> --json
```

Schedules accept `hourly`, `daily`, `weekdays`, `weekly`, 5-field cron, or RRULE. Use `--time <HH:MM>` with `daily`/`weekdays`/`weekly`, and `--day <0-6>` only with `weekly` where Sunday is `0`.

Use `--repo <selector>` for a new worktree per run, or `--workspace <selector>` / `--workspace-mode existing` for an existing Orca worktree. `--repo` and `--workspace` are mutually exclusive. Use `--reuse-session` only for existing-workspace automations; if the previous terminal is gone, Orca falls back to a fresh session. Prefer `--disabled` while testing setup.

## Built-In Browser

The built-in browser is Orca's embedded browser tab surface, scoped to Orca worktrees; it is not Chrome/Safari or desktop app UI.

These commands control only Orca's embedded browser tabs. For external Chrome/Safari/webviews or Orca app chrome/settings, use the Computer Use skill/tool. If the user explicitly asks for Orca CLI desktop control, use `orca computer ...`; do not use browser commands for desktop UI.

Use a snapshot-interact-re-snapshot loop:

```bash
orca goto --url https://example.com --json
orca snapshot --json
orca click --element @e3 --json
orca snapshot --json
```

Common commands:

```bash
orca goto --url <url> --json
orca back --json
orca reload --json
orca snapshot --json
orca screenshot --json
orca full-screenshot --json
orca pdf --json
orca click --element <ref> --json
orca fill --element <ref> --value <text> --json
orca type --input <text> --json
orca select --element <ref> --value <value> --json
orca check --element <ref> --json
orca scroll --direction down --amount 1000 --json
orca hover --element <ref> --json
orca focus --element <ref> --json
orca keypress --key Enter --json
orca upload --element <ref> --files <paths> --json
orca wait --text <text> --json
orca wait --url <substring> --json
orca wait --selector <css> --json
orca wait --load networkidle --json
orca eval --expression <js> --json
orca tab list --json
orca tab create --url <url> --json
orca tab switch --index <n> --json
orca tab close --index <n> --json
orca cookie get --json
orca capture start --json
orca console --limit 50 --json
orca network --limit 50 --json
orca exec --command "help" --json
```

Browser rules:

- Re-snapshot after navigation, tab switches, clicks that change the page, and any `browser_stale_ref`.
- Refs like `@e1` are assigned by `snapshot`, scoped to one tab, and invalidated by navigation or tab switch.
- Browser commands default to the current worktree and its active tab. Use `--worktree all` only intentionally.
- For concurrent browser work, run `orca tab list --json`, read `tabs[].browserPageId`, and pass `--page <browserPageId>` on later commands.
- Use typed tab commands (`orca tab list/create/close/switch`), not `orca exec --command "tab ..."`, so Orca keeps UI state synchronized.
- Prefer `wait --text`, `--url`, `--selector`, or `--load` after async page changes instead of bare timeouts.
- Less common workflows can use typed commands above or `orca exec --command "<agent-browser command>"` passthrough.
- If `fill` or `type` fails on a custom input, try `orca focus --element @e1 --json` then `orca inserttext --text "text" --json`.

Common recoveries:

- `browser_no_tab`: open a tab with `orca tab create --url <url> --json`.
- `browser_stale_ref`: run `orca snapshot --json` and retry with fresh refs.
- `browser_tab_not_found`: run `orca tab list --json` before switching or closing.

## Next Action

Confirm `orca status --json` unless already checked this turn, then choose the narrowest command for the job: `worktree ps/current/create`, `terminal list/read/wait/send`, `automations list`, or built-in browser `snapshot`.

## Mobile Emulator (iOS Simulator via serve-sim)

The mobile emulator surface is workspace-scoped like browser tabs (active per worktree for unqualified; explicit --worktree/--device/--emulator for targeting). Always prefer `orca emulator ...` over raw `npx serve-sim` or simctl when inside Orca (the bridge owns lifecycle, scoping, and registration with the live pane).

See the dedicated `orca-emulator` skill for the full table (tap/type/gesture/button/rotate/camera/permissions/ax/list/attach/exec/kill + --json + gotchas like tap preferred, normalized 0-1, name->UDID early resolve in bridge, US ASCII type, camera one-time builds, stale state cleanup, no auto-focus on attach except --focus flag mirroring browser exactly, AX via HTTP endpoint from state).

Common:

```sh
orca emulator list --json
orca emulator attach "iPhone 17 Pro" --json
orca emulator tap 0.5 0.7 --json
orca emulator type "hello" --json
orca emulator gesture '[{"type":"begin","x":0.5,"y":0.8},{"type":"move","x":0.5,"y":0.4},{"type":"end","x":0.5,"y":0.2}]' --json
orca emulator button home --json
orca emulator exec --command "tap 0.5 0.7" --json   # no "serve-sim" in the command string
orca emulator kill --json
```

Rules (mirror browser):

- Default: current worktree's active (pane open or attach sets it; unqualified "just works").
- Explicit: --device <udid|name> or --emulator <OrcaId from list> (bridge resolves names early to avoid serve-sim control bug).
- --worktree all only for list.
- Recoveries: 'emulator_no_active' → orca emulator attach or open pane; stale → list/kill/attach.
- No raw serve-sim in agent prompts/skills (use orca wrappers; see orca-emulator skill).

The live pane (when implemented) registers its stream with the bridge for default targeting (seamless, recommended option per design).

## Next Action (continued)

... or emulator list/attach/tap while the live view is visible.
