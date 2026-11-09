# Low-level topology

```text
ORCA terminal create --worktree active --title <task_name> --command "<agent_command>" --json
ORCA terminal wait --terminal <handle> --for tui-idle --timeout-ms 60000 --json
ORCA orchestration dispatch --task <task_id> --to <handle> --inject
```

To give a Task to a terminal or chat Orca did not start:

```text
ORCA orchestration worker-start --task <task_id> --terminal <handle> --worktree <its_workspace> --json
```
