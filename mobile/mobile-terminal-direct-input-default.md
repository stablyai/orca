# Mobile Terminal Direct Input Default

## Context

Orca Mobile currently has two terminal input modes:

- Buffered command input: a visible command text field sends its content with Enter.
- Direct terminal input: a hidden capture field forwards keyboard bytes directly to the PTY.

Buffered input is safer for composing a full shell command, but it is awkward for terminal-native
flows: shells, TUIs, REPLs, editors, prompts, and remote SSH sessions all expect keystrokes to land
immediately. The mobile terminal already supports direct input via a per-terminal toggle; this
change makes direct input the default mode when a terminal is first seen on mobile.

## Goals

- Make first-seen mobile terminal tabs start in direct terminal input mode.
- Keep the existing accessory toggle so users can switch an individual terminal back to buffered
  command input.
- Preserve that manual opt-out while the terminal remains open and the session tab list refreshes.
- Keep behavior local to the mobile client. Do not add host/runtime state or desktop-visible
  preferences for this small default change.
- Avoid opening the keyboard automatically just because a terminal becomes active. Tapping the
  terminal should focus the direct input capture, matching the current live-input interaction model.

## Non-goals

- Removing buffered command input.
- Changing `terminal.send`, mobile subscription, or PTY sizing semantics.
- Persisting a user preference across app launches.
- Changing accessory keys, dictation, paste, terminal gesture input, or mouse-aware TUI routing.

## Design

The mobile session screen keeps `liveInputTerminalHandles`, a set of terminal handles whose input
bar is in direct mode. Today the set starts empty, so every terminal defaults to the buffered command
box.

The new behavior adds a companion "default already applied" set. When the mobile client discovers
terminal handles through session tab snapshots, `terminal.list`, or local terminal creation, it adds
only never-before-defaulted handles to `liveInputTerminalHandles`. If a user toggles a handle back to
buffered input, the handle stays in the defaulted set, so future tab refreshes do not flip it back to
direct input.

Handle cleanup uses `terminal.list` as the terminal lifetime signal. Session tab snapshots can lag
locally created or recently closed terminal tabs, so they should default never-before-seen handles but
should not prune the live/defaulted sets.

This keeps the default one-shot per handle:

1. New handle appears.
2. Mobile marks it direct input by default.
3. User can toggle it to buffered input.
4. Snapshot/list refreshes preserve the user's choice.
5. Worktree route reset clears the default tracking for the next session scope.

## UI Behavior

When a terminal is in direct mode, the existing live input bar remains:

- The accessory direct-input icon is active.
- The bar says keyboard input goes directly to the terminal.
- Tapping the terminal focuses the hidden capture input.
- The buffered command box remains available by pressing the same mode toggle.

When a terminal is in buffered mode, the existing command field remains unchanged.

## SSH And Provider Notes

SSH sessions are a primary reason for this default. Direct mode avoids local composition assumptions
and sends the same PTY bytes regardless of whether the shell is local or remote. The change does not
touch source-control provider behavior.

## Validation

- Unit test the one-shot default merge:
  - first-seen handles are enabled and marked defaulted;
  - an already defaulted handle is not re-enabled after manual opt-out;
  - newly discovered handles are still enabled.
- Unit test stale-handle pruning from the terminal lifetime list.
- Run focused mobile terminal tests.
- Launch Orca Mobile in the iOS simulator, reach the session terminal screen, and capture a
  screenshot showing the direct-input bar as the default terminal input surface.
