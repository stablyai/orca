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

## Watching a Run

A supervisor outside the loop, such as a script or a status pane, can follow a
Run without reading its mail:

```text
ORCA orchestration watch --run <run_id> --types worker_state
```

It prints one JSON line per event: `message` (subject, never the body) and
`worker_state` (working, blocked, waiting or done). It marks nothing read, so
your own `check` still gets every message; `check` stays the source of truth.
