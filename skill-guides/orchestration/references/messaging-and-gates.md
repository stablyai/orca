# Messaging and gates

Handle a whole `check` batch before the next `check`.

To another agent, pick `--type` by what you expect back:

| Type       | Means                                    |
| ---------- | ---------------------------------------- |
| `notice`   | Information; keep going, no reply needed |
| `question` | Answer me                                |
| `handoff`  | This job is yours now                    |

With `--to` and no `--type`, mail is a notice. With no `--to`, a worker's mail
is a status report to its coordinator. Workers report with `worker_done`,
`escalation` and the other report types as before.

Groups (`@all`, `@idle`, `@codex`, ...) reach the live workers of your Run;
`@worktree:<id>` also reaches coordinators in that workspace. Use groups only
for deliberate fan-out.

To reach an agent on a paired server, use `send --on <server>`; a reply to mail
from another server needs no flag. See
[Placement and remote execution](placement-and-remote.md).
