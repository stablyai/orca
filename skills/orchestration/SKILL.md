---
name: orchestration
description: >-
  Use MCode orchestration for structured multi-agent coordination: threaded
  messages, blocking ask/reply flows, task dispatch, worker_done/escalation
  waits, task DAGs, decision gates, coordinator loops, or decomposing work
  across agents. Use `mcode-cli` instead for full ownership handoffs, including
  requests phrased as "hand off", "handoff", "handover", "give this to another
  agent", or "another worktree" when the user did not explicitly ask to
  supervise, monitor, wait for results, or coordinate a DAG. Use `mcode-cli` for
  ordinary terminal control, lightweight terminal prompts, shell commands, MCode
  worktree management, reading or waiting on terminals, and automation of the
  browser embedded inside MCode. Use Computer Use for browser windows, webviews,
  MCode app UI, or desktop UI outside MCode's embedded browser.
---

# MCode Orchestration

This file is a discovery stub, not the usage guide. The full, version-matched MCode
orchestration reference is served by the `mcode` binary itself — kept out of this file on
purpose so it can never drift from the binary that will actually run your commands.

Engage MCode orchestration whenever you need structured multi-agent coordination: threaded
messages, blocking ask/reply flows, task dispatch, worker_done/escalation waits, task DAGs,
decision gates, coordinator loops, or decomposing work across agents. Use the mcode-cli skill
instead for full ownership handoffs ("hand off", "handoff", "handover", "give this to
another agent", "another worktree") when the user did not ask to supervise, monitor, wait
for results, or coordinate a DAG — and for ordinary terminal control, shell commands,
worktree management, and the built-in browser. Coordination requires real MCode runtime
state; never substitute a non-MCode subagent tool.

## Resolve the CLI for this session

Choose the executable once and reuse it for every later command:

- If the `MCODE_CLI_COMMAND` environment variable is set, use its value. MCode exports this
  for managed WSL sessions.
- Otherwise, in a dev checkout whose session exposes `MCODE_DEV_REPO_ROOT`, use `mcode-dev`.
- Otherwise, on Linux outside an MCode-managed terminal, use `mcode-ide`. Never run bare
  `mcode` there — outside MCode's terminals it normally resolves to the
  GNOME MCode screen reader (`/usr/bin/mcode`) and starts speech on the user's machine.
- Otherwise, use `mcode`.

Below, `MCODE` is a placeholder for the executable you resolved. Substitute it before
running anything; do not create a shell variable or run `MCODE` literally. This works the
same way in POSIX shells, PowerShell, and cmd.exe.

If the selected executable cannot run, report its exact error and stop. Do not fall through
to another executable, which could silently target a different MCode build.

## Load the full guide before running MCode commands

```text
MCODE skills get orchestration
```

That prints the complete, version-matched guide for the exact binary that will handle your
next commands — task creation and dispatch, injected lifecycle preambles, worker_done
authority, decision gates, and coordinator loops. Read it first, then run the specific
command you need.

Don't guess subcommands or flags from memory or from a cached copy of this stub. They
change between MCode releases, and this file deliberately no longer lists them. Confirm the
app is up with `MCODE status --json` (start it with `MCODE open --json` if needed), and
prefer `--json` for agent-driven calls.

## If an older MCode does not recognize `skills get`

Use this fallback only when the selected binary explicitly reports that `skills get` is an
unknown command. Another failure is not proof of an older binary; report it rather than
guessing or changing executables. For a confirmed pre-guide binary, use only this bounded,
read-only bootstrap to orient. Do not dead-end and do not invent commands:

```text
MCODE status --json
MCODE orchestration task-list --json
MCODE terminal list --json
```

Then tell the user that updating MCode restores the full, version-matched guide via
`MCODE skills get orchestration`. Beyond these commands, ask the user rather than guessing a
command surface this older binary may not support.
