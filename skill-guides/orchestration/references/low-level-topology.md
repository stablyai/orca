# Low-level topology

Load this reference only when `worker-start` cannot express required custom argv
or terminal topology. It is not the normal supervised loop and is never a full
handoff recipe.

```text
ORCA terminal create --worktree active --title <task_name> --command "<agent_command>" --json
ORCA terminal wait --terminal <handle> --for tui-idle --timeout-ms 60000 --json
ORCA orchestration dispatch --task <task_id> --to <handle> --inject --json
```

Wait for readiness only when startup could lose injected input. Prefer
agent-first `worker-start` whenever its argv and topology are sufficient.

`dispatch --inject` creates authoritative Task/Dispatch context but deliberately
keeps an operator-created process unsupervised: it creates no supervised worker
resource row. `worker-show`, `worker-read`, and `worker-list` report the lane as
`unsupervised`; `worker-stop` and `worker-abandon` do not close that process, and
settled retain/release take no process action.

A dispatch without `--inject` is recorded only: the Task turns `dispatched` and
the terminal is never told. The response reports `injected: false` (newer
runtimes also return a `warning` saying so). Deliver the prompt yourself, or
reset the Task (`ORCA orchestration task-update --id <task_id> --status failed`,
then the same command with `--status ready`) before dispatching again with
`--inject`.

Use `worker-start --terminal <handle>` when lifecycle ownership of an existing
agent terminal is required. Never imply that low-level dispatch retroactively
owns a process, never use it to route around the nested-depth limit, and never
use it for an ownership handoff.
