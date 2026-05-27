# Keyboard Layout Shortcut Dispatch

## Problem

Keyboard shortcuts must follow the user's active keyboard layout. A shortcut like `Cmd+W`
means "Command plus the key that produces `w`", not "Command plus the physical key labeled
W on a US keyboard." Physical-position matching breaks Dvorak, Colemak, AZERTY, JIS, and
other non-US layouts, and it also makes user keybinding overrides impossible to reason about.

## Decision

Orca app shortcuts dispatch by logical key by default.

The shared keybinding registry in `src/shared/keybindings.ts` is the source of truth for
app commands, configurable commands, shortcut recording, labels, conflict detection, browser
guest forwarding, and terminal pane commands. Code handling a user-facing app command must
call `keybindingMatchesAction`, `keybindingMatchesInput`, or a policy function built on those
helpers.

Physical `KeyboardEvent.code` may only decide a shortcut when the key is layout-invariant or
the platform cannot provide a real logical key.

Allowed physical-code uses:

- Modifier key release tracking, such as left/right Control release for held `Ctrl+Tab`.
- Layout-invariant keys, such as arrows, Tab, Enter, Escape, Backspace, Delete, Insert,
  PageUp, PageDown, and explicit numpad bindings.
- Dead, unidentified, or missing logical keys where `KeyboardEvent.key` cannot describe the
  produced key.
- Terminal byte encoding where the intent is a physical terminal escape sequence rather than
  an Orca command.

Disallowed physical-code uses:

- Letter shortcuts for app actions.
- Punctuation shortcuts for app actions when `KeyboardEvent.key` reports the produced
  punctuation.
- Clipboard shortcuts that are exposed as app or terminal UI commands.
- Hardcoded undo/redo/new/close/copy/paste handling outside the shared registry.

## Terminal Boundary

Terminal handling has two different jobs:

1. Orca commands that act on terminal UI, such as copy selection, paste, search, clear,
   pane focus, split, and close. These are app shortcuts and must be layout-aware.
2. Bytes sent to the shell, such as readline escapes and Option-as-Alt sequences. These may
   use physical key positions when terminal compatibility requires it.

This boundary is intentional. It lets non-US layouts use Orca commands naturally while
preserving shell behavior where users expect physical terminal-control sequences.

## Regression Requirements

Shortcut tests must cover both directions of a non-QWERTY swap:

- The key that produces the configured logical character must match, even if its physical code
  differs.
- The physical US key must not match when it produces a different logical character.

Tests must also cover intentional exceptions:

- Dead or missing key fallback.
- Shifted punctuation aliases.
- Numpad-specific bindings.
- Terminal byte-encoding paths that intentionally use physical codes.
