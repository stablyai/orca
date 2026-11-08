# Coordinator loop

## Task DAGs

A Task needs a Run, so create one first. Workers editing the same files at once
need separate workspaces.

```text
ORCA orchestration run-create --objective "<goal>"
ORCA orchestration task-create --spec "<dependent work>" --deps <json_array>
ORCA orchestration task-list --ready --brief
ORCA orchestration worker-start --task <task_id> --worktree current --agent codex
```

On every wake, start the Tasks `task-list --ready` shows.

## Several Runs

A later `run-create` keeps your earlier Runs: their mail still wakes you, but
commands without `--run` use the newest Run, so pass `--run <id>` for an earlier
one. `run-use` keeps only the Run it names.

## A coordinator outside Orca

A daemon, MCP server, or other process with no Orca terminal coordinates as a
saved runtime environment (`orca environment add`) instead of a pane:

```text
ORCA orchestration run-create --objective "<goal>" --external --environment <name>
ORCA orchestration worker-start --spec "<task>" --worktree id:<worktree_id> --agent codex --environment <name>
ORCA orchestration check --wait --types worker_done,escalation,question --environment <name>
```

No pane wakes it, so `check --wait` is its loop. It has no workspace, so name
one with `--worktree`. A terminal that runs `run-use` on its Run takes it over.
Inside an Orca terminal these commands act as that terminal, not as the
environment.
