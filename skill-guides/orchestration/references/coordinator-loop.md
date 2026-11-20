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

Set `task-create --model <model> --effort <level>` to plan different models for
different Tasks. Fresh `worker-start --task` launches (including retries) inherit
these defaults. `--effort` requires a model at Task creation. At worker start,
`--model` replaces both defaults, or `--effort` alone adjusts the inherited model's
effort. The chosen agent validates compatibility at launch; `--terminal` reuses
the running configuration. `task-list --json` includes each Task's defaults.

## Several Runs

A later `run-create` keeps your earlier Runs: their mail still wakes you, but
commands without `--run` use the newest Run, so pass `--run <id>` for an earlier
one. `run-use` keeps only the Run it names.
