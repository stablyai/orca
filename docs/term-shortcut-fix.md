# Terminal Shortcut Audit And Fix Plan

## Context

Linked reports:

- `#443`: `Ctrl+R` / `Cmd+R` reverse search was blocked in the terminal.
- `#453`: fixed `#443` by removing the app-level reload accelerator conflict.
- `#481`: reports `Ctrl+U` (`unix-line-discard`) being swallowed.
- `#482`: reports `Ctrl+E` (`end-of-line`) being swallowed, but is marked not reproducible.

The symptom across all four links is "terminal control chord does not reach readline", but the current code shows they are not all the same bug.

## Findings

1. `#443` and `#453` are directly related.
   `CmdOrCtrl+R` was reserved above the renderer, so the terminal never saw the chord. `#453` fixed that by removing the reload accelerator and keeping only `Shift+CmdOrCtrl+R` for force reload.

2. `#481` and `#482` are related to the same problem class, but not proven to share `#443`'s exact root cause.
   Current `mainWindow.webContents.on('before-input-event', ...)` no longer reserves `R`, `U`, or `E`.
   Current terminal renderer shortcut handling also does not reserve macOS `Ctrl+R`, `Ctrl+U`, or `Ctrl+E`.

3. The real gap was auditability, not just one missing exception.
   Shortcut interception lived in multiple places:
   - main window `before-input-event`
   - browser guest `before-input-event`
   - terminal renderer `keydown` capture

   That made it easy to fix one conflict (`Cmd/Ctrl+R`) while leaving the overall reservation surface implicit and hard to verify.

## Reproduction Matrix

Expected behavior from a focused terminal on macOS:

- Pass through to shell/readline:
  - `Ctrl+R`
  - `Ctrl+U`
  - `Ctrl+E`
  - `Ctrl+A`
  - `Ctrl+W`
  - `Ctrl+K`
  - `Alt+B`
  - `Alt+F`
  - `Alt+D`

- Reserved by Orca:
  - `Cmd+F`
  - `Cmd+K`
  - `Cmd+W`
  - `Cmd+D`
  - `Cmd+Shift+D`
  - `Cmd+[`
  - `Cmd+]`
  - `Cmd+Shift+Enter`
  - `Ctrl+Backspace`
  - `Cmd+Backspace`
  - `Cmd+Delete`
  - `Alt+Backspace`

Expected behavior from main-process/browser-guest forwarding:

- Reserved:
  - zoom shortcuts
  - worktree palette
  - quick open
  - worktree index jump

- Must never be reserved there:
  - `Cmd/Ctrl+R`
  - readline control chords like `Ctrl+U`, `Ctrl+E`, `Ctrl+R`

## Plan

1. Centralize the window-level shortcut allowlist into a shared pure helper.
   Why: main-window and browser-guest forwarding should not drift apart, because either one can steal terminal input before the renderer sees it.

2. Centralize terminal-pane shortcut classification into a pure helper.
   Why: the terminal shortcut layer must stay an explicit allowlist so future shortcuts do not accidentally swallow readline chords.

3. Add regression tests that enumerate both sides:
   - allowed Orca shortcuts
   - guaranteed shell passthrough chords

4. Keep `#443` fixed and make the current status of `#481` / `#482` testable.
   Why: even if one report later turns out to be environment-specific, Orca should still have an executable contract for what it reserves.

## Implementation Notes

- Shared helper added for main-process shortcut resolution.
- Shared helper added for terminal-pane shortcut resolution.
- Tests added to encode the allowlist and passthrough matrix explicitly.

## Follow-Up Risk

This change makes the current reservation surface auditable, but it does not redesign non-macOS terminal shortcuts. Orca still uses `Ctrl` as the primary modifier for several terminal actions on Linux/Windows, which is a separate UX question from the macOS control-chord regressions linked above.
