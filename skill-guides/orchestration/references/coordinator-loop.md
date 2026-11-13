# Coordinator loop

## Task DAGs

A Task needs a Run, so create one first. Workers editing the same files at once
need separate workspaces.

```text
ORCA orchestration run-create --objective "<goal>"
ORCA orchestration task-create --spec "<dependent work>" --deps <json_array>
ORCA orchestration task-list --ready --brief
ORCA orchestration worker-start --task <task_id> --worktree current --agent <agent>
```

On every wake, start the Tasks `task-list --ready` shows.

## Several Runs

A later `run-create` keeps your earlier Runs: their mail still wakes you, but
commands without `--run` use the newest Run, so pass `--run <id>` for an earlier
one. `run-use` keeps only the Run it names.

## Wake types

A Run's mailbox wakes you for every message type by default. `--notify-types` on
`run-create` or `run-use` narrows those wake pointers to the types worth a turn;
every other type stays in the inbox until your next check. `none` stops wake
pointers entirely and `all` restores every type.

```text
ORCA orchestration run-use --id <run_id> --notify-types "worker_done,escalation,question"
```
