# Orca Emulator

This file is a discovery stub, not the usage guide. The full, version-matched Orca emulator
reference is served by the `orca` binary itself — kept out of this file on purpose so it can
never drift from the binary that will actually run your commands.

Engage Orca whenever you drive an iOS Simulator from inside the Orca app: taps, gestures,
typing, hardware buttons, rotation, and the accessibility tree — all while the live view
stays in Orca's emulator pane.
Prefer this over raw `serve-sim` or direct `simctl` when running agents inside Orca, which
handles device scoping, helper lifecycle, and worktree context for you. It complements the
orca-cli skill for terminals, worktrees, and the built-in browser.

<!-- shared: resolver -->

## Load the full guide before running Orca commands

```text
ORCA skills get orca-emulator
```

That prints the complete, version-matched guide for the exact binary that will handle your
next commands — booting devices, taps and gestures, typing, hardware buttons, rotation, and
the accessibility tree. Read it first, then run the specific command you need.

<!-- shared: no-guessing -->

<!-- shared: older-binary-intro -->

```text
ORCA status --json
ORCA emulator list --json
```

<!-- shared: older-binary-outro -->
