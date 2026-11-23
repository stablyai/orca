# Low-level topology

```text
ORCA terminal create --worktree active --title <task_name> --command "<agent_command>" --json
ORCA terminal wait --terminal <handle> --for tui-idle --timeout-ms 60000 --json
ORCA orchestration dispatch --task <task_id> --to <handle> --inject
```

To give a Task to a terminal or chat Orca did not start:

```text
ORCA orchestration worker-start --task <task_id> --terminal <handle> --json
```

When `dispatch --inject` or `worker-start --terminal` submits a Task to a busy native chat, Orca queues the Task until the chat can take a new turn. Ordinary mail sent with `send` also queues a notice in current builds. A send receipt records delivery to the mailbox, not that the chat has interrupted its current turn or read the message.
