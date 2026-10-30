# Coordinator loop

## Task DAGs

A Task needs a Run, so create one first. Workers editing the same files at once
need separate workspaces.

```text
ORCA orchestration run-create --objective "<goal>" --json
ORCA orchestration task-create --spec "<dependent work>" --deps <json_array> --json
ORCA orchestration task-list --ready --brief --json
ORCA orchestration worker-start --task <task_id> --worktree current --agent codex --json
```

On every wake, start the Tasks `task-list --ready` shows.

## Several Runs

A later `run-create` keeps your earlier Runs: their mail still wakes you, but
commands without `--run` use the newest Run, so pass `--run <id>` for an earlier
one. `run-use` keeps only the Run it names.

## Reusing a worker

To give a finished worker follow-up work, create the Task, then start it on the
terminal handle and workspace from that worker's earlier `worker-start` receipt:

```text
ORCA orchestration task-create --spec "<follow-up>" --json
ORCA orchestration worker-start --task <task_id> --terminal <agent_terminal_handle> --worktree <its_workspace> --json
```
