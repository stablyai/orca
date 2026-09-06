# Orca CLI

This file is a discovery stub, not the usage guide. The full, version-matched Orca CLI
reference is served by the `orca` binary itself — kept out of this file on purpose so it
can never drift from the binary that will actually run your commands.

Engage Orca whenever its running editor/runtime is the source of truth: Orca-managed
worktrees, folder contexts, terminals, repos, automations, worktree comments, and the
browser embedded inside the Orca app. Triggers include "$orca-cli", "Orca worktree",
"child worktree", "spawn codex/claude in a worktree", "read/wait/send Orca terminal",
"full handoff" / "handover" / "give this to another agent", and "control the browser
inside Orca". Use plain shell tools when Orca state does not matter.

<!-- shared: resolver -->

## Load the full guide before running Orca commands

```text
ORCA skills get orca-cli
```

That prints the complete, version-matched guide for the exact binary that will handle your
next commands — worktrees, handoffs, terminals, automations, and the built-in browser.
Read it first, then run the specific command you need.

<!-- shared: no-guessing -->

<!-- shared: older-binary-intro -->

```text
ORCA status --json
ORCA worktree ps --json
ORCA terminal list --json
```

<!-- shared: older-binary-outro -->
