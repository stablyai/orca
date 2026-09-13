# Mobile Terminal Compose Input

## Context

Orca Mobile has two terminal input modes:

- Buffered compose: a native text field holds the draft. Send writes the whole string
  through one `terminal.send` with `enter: true`.
- Direct / live input: a hidden capture field forwards keystroke deltas to the PTY.

Live input costs one RPC per mirror batch and fights iOS dictation and IME, because
the controlled field must stay in lockstep with the remote TUI. Compose input uses
the system text field, so dictation, autocorrect, and CJK IMEs work as they do in
any other iOS app. The TUI updates after send.

## Goals

- First-seen mobile terminal tabs start in buffered compose mode.
- Keep the accessory toggle so a terminal can switch to live input for raw TUI
  control (vim, fzf, pagers).
- Persist a manual live opt-out so a later default change does not flip that
  terminal back to live.
- Keep behavior on the mobile client. Do not add host or desktop preference state.
- Do not open the keyboard just because a terminal becomes active.

## Non-goals

- Removing live input.
- Changing `terminal.send`, mobile subscription, or PTY sizing semantics.
- Persisting a live opt-in across app launches.
- Changing accessory keys, paste, terminal gesture input, or mouse-aware TUI routing.

## Design

`liveInputTerminalHandles` is the mode set. Empty means compose. The client still
marks first-seen handles as defaulted so a later discovery pass does not re-apply
policy. It does not add those handles to the live set.

Dictation in compose mode appends to the native field. The user sends. One RPC.

## UI Behavior

Compose mode shows the visible text field and send button. Return inserts a newline.
The send button forwards the draft.

Live mode keeps the existing hidden capture field and tap-to-focus bar.

## SSH And Provider Notes

`terminal.send` writes the same PTY bytes on local, WSL, and SSH hosts. Compose
mode does not assume a local shell.

## Validation

- Unit test the default merge:
  - first-seen handles are marked defaulted and stay out of the live set;
  - a persisted buffered opt-out is not enabled;
  - a handle the user toggled live stays live across discovery.
- Unit test stale-handle pruning from the terminal lifetime list.
- Run focused mobile terminal tests.
- Launch Orca Mobile in the iOS simulator, open a session terminal, and confirm
  the compose field is the default input surface.
