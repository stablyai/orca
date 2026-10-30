# Recovery and cleanup

Act only on proof. `worker-list --run <run_id> --include-remote --json` gives
each worker's liveness and `nextAction`; follow it.

Retry a failed or stopped attempt on the same Task; `--spec` would create a new
one. Placement is not inherited:

```text
ORCA orchestration worker-start --task <task_id> --retry-of <dispatch_id> --worktree <placement> --agent <agent> --json
```

`worker-stop` exits 1 with `stop_unknown` when it cannot prove the agent
stopped; check `worker-show` before acting again.

`orchestration reset` deletes coordination state; run it only when the user
gives that state up.
