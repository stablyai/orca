# Terminal Close Confirmation

## Problem

- `CloseTerminalDialog` repeats the action users already requested with "Close Terminal?" and a generic "process will be killed" warning (`src/renderer/src/components/terminal-pane/CloseTerminalDialog.tsx:30`).
- `Cmd/Ctrl+W` closes only the focused split pane, or the tab when it is the last pane; the guard exists so tab-level close does not kill every pane by accident (`src/renderer/src/components/terminal-pane/keyboard-handlers.ts:364`).
- The running-process guard probes the PTY over the active runtime/SSH path and shows the dialog only when child processes exist (`src/renderer/src/components/terminal-pane/TerminalPane.tsx:781`).
- There is no way for power users to say "I understand, close it next time" even though similar destructive workflows persist skip-confirm settings (`src/shared/types.ts:2522`, `src/renderer/src/components/settings/GeneralWorkspaceSettingsSection.tsx:58`).

## Goal

Make the terminal close confirmation communicate the consequence, respect focused-pane scope, and allow users to disable future running-process close confirmations from the dialog or Settings.

## Non-goals

- Do not change window-close behavior; whole-window shutdown intentionally bypasses the child-process dialog.
- Do not change idle-shell behavior; idle shells still close immediately.
- Do not add bulk-close UI for this change.
- Do not introduce provider-specific agent kill logic; closing still uses the existing terminal close path.
- Do not add telemetry.

## Design

1. Add a persisted `skipCloseTerminalWithRunningProcessConfirm` boolean to `GlobalSettings`, defaulting to `false`.
2. Keep the existing child-process probe. If the new setting is true, close immediately after the probe reports child processes instead of showing the dialog.
3. Track the pending close as `{ paneId, copyKind }`, where `copyKind` is `agent` only when `agentStatusByPaneKey[makePaneKey(tabId, leafId)]` has a live non-unknown `agentType`; otherwise it is `command`.
4. Update dialog copy:
   - command: title `Stop running command?`, body `Closing this terminal will stop the command running inside it.`, destructive button `Stop and Close`.
   - agent: title `Stop this agent?`, body `Closing this terminal will stop the agent's current work.`, destructive button `Stop Agent`.
5. Add a checkbox: `Don't ask again for running terminals`. When checked and confirmed, persist `skipCloseTerminalWithRunningProcessConfirm: true` before closing the pane.
6. Add a Terminal Interaction settings switch: `Ask Before Closing Running Terminals`, checked when the skip flag is false.
7. Add the new setting to terminal settings search so "confirm", "close", "running", "agent", and "command" find it.

## Data flow

- `Cmd/Ctrl+W` or pane close action
- `TerminalPane.handleRequestClosePane(paneId)`
- Get `ptyId`; no PTY closes immediately
- `inspectRuntimeTerminalProcess(settings, ptyId)`
- No child processes closes immediately
- Child processes + skip setting closes immediately
- Child processes + confirmation enabled opens `CloseTerminalDialog(copyKind)`
- Confirm optionally persists skip flag, then calls `executeClosePane(paneId)`

## Edge cases

- If process inspection rejects, preserve the existing fallback: close the pane instead of trapping the shortcut.
- If the pane is removed before the dialog confirms, `executeClosePane` already no-ops when the manager cannot close it.
- For split panes, only the active pane gets the prompt and closes.
- For last-pane tabs, confirming still delegates to `onCloseTab`.
- Agent copy appears only from live pane status. Freshly launched agents that have not emitted hooks yet may use command copy; that is acceptable because the consequence is still accurate.
- SSH/runtime-host terminals still use the existing runtime process inspection; the setting lives in global renderer settings and is passed through the same update path.
- The skip flag affects only terminal running-process close confirmations, not workspace deletion, automation deletion, window close, or future bulk-close prompts.

## Test plan

- Unit/component:
  - `CloseTerminalDialog` renders command copy, agent copy, checkbox, and reports the checked state on confirm.
  - Settings search includes the running-terminal confirmation entry.
  - Default settings include `skipCloseTerminalWithRunningProcessConfirm: false`.
- Integration/lightweight:
  - Verify `TerminalPane` opens agent copy when live pane status has `agentType` and command copy otherwise.
  - Verify checked confirm persists the skip flag before closing.
- Electron:
  - Running command + default setting shows command confirmation.
  - Running command + checkbox checked confirms and future close skips the dialog.
  - Agent pane with live status shows agent confirmation copy.
  - Idle shell closes without confirmation.

## UI quality bar

- Dialog uses existing shadcn `Dialog` and `Button` primitives, token colors, and current compact modal sizing.
- Copy names the destructive consequence first and avoids implying every terminal/tab/window will close.
- Checkbox is visually subordinate to the message and aligned with existing dense dialog spacing.
- Settings row matches neighboring Terminal Interaction switch rows and is searchable.
- No layout shift, clipping, or button text overflow at the current modal width.

## Review screenshots

1. Running-command confirmation dialog.
2. Running-agent confirmation dialog.
3. Terminal Interaction settings row for `Ask Before Closing Running Terminals`.

## Rollout

1. Add shared setting type/default.
2. Add dialog copy modes and checkbox.
3. Wire `TerminalPane` to derive copy kind, honor skip flag, and persist "don't ask again" on confirm.
4. Add Terminal settings row and search entry.
5. Add targeted tests.
6. Force-add this design doc when staging because root `.gitignore` treats new `docs/**` files as local-only by default.

## Lightweight Eng Review

- Scope: kept focused on the existing running-process confirmation; no new close routing, bulk-close behavior, or native window-close changes.
- Architecture/data flow: renderer-only UI setting rides the existing settings persistence path; process detection remains owned by `inspectRuntimeTerminalProcess` so SSH/runtime compatibility does not fork.
- Failure modes covered:
  - process-inspection rejection preserves current close fallback
  - stale pane between prompt and confirm no-ops through existing manager guard
  - split-pane close remains pane-scoped
  - missing/stale agent status falls back to generic command copy
  - skip flag is scoped to terminal running-process confirmations only
- Test coverage required:
  - component test for `CloseTerminalDialog` copy/checkbox
  - shared default/type coverage via existing typecheck plus default-setting assertion
  - settings search test for new discoverable entry
  - focused TerminalPane behavior test if practical; otherwise Electron validation covers prompt routing
- Performance/blast radius: no polling, IPC, startup, or renderer-jank impact; only an extra settings boolean read during an already user-triggered close path.
- UI quality bar: Electron validation should judge the modal and Terminal settings row against `docs/STYLEGUIDE.md`, existing `Dialog`/`Button`/`SettingsSwitchRow`, and adjacent Terminal Interaction density.
- Required review screenshots:
  1. Running-command confirmation dialog
  2. Running-agent confirmation dialog
  3. Terminal Interaction settings row
- Residual risks: agent-specific copy depends on live hook status, so newly launched or manually run agents can still receive generic command copy; the design doc is ignored by default and must be force-staged for the PR.
