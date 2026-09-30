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

## Readiness before submission

When the coordinator drives setup itself, such as `/model` or `/reasoning` slash
commands and a readiness probe, keep it one short interactive phase:

- Send deterministic setup back to back in one tool call when each
  acknowledgement can be checked afterward.
- `terminal wait --for tui-idle` confirms launch readiness and a completed agent
  turn. It is not a slash-command acknowledgement: a TUI whose status line keeps
  repainting may never settle, and the wait spends its whole timeout.
- Confirm each acknowledgement with `terminal read` polls for its expected text,
  bounded in seconds.
- Verify the model and effort actually in effect from the agent's own evidence
  before submitting; never claim them from requested arguments.
- Escalate to longer waits or diagnostics only after a short check fails.

Once the Task is submitted, stop reading the pane and return to the compact
guide's filtered `check --wait`.

`dispatch --inject` creates authoritative Task/Dispatch context but deliberately
keeps an operator-created process unsupervised: it creates no supervised worker
resource row. `worker-show`, `worker-read`, and `worker-list` report the lane as
`unsupervised`; `worker-stop` and `worker-abandon` do not close that process, and
settled retain/release take no process action.

Use `worker-start --terminal <handle>` when lifecycle ownership of an existing
agent terminal is required. Never imply that low-level dispatch retroactively
owns a process, never use it to route around the nested-depth limit, and never
use it for an ownership handoff.
