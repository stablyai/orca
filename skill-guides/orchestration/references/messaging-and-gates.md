# Messaging and gates

Load this reference for inbox replay, attempt-specific guidance, group
addresses, blocking questions, or coordinator-managed DAG decisions.

A successful `send` proves durable enqueue. Wake and nudge are best-effort
attention only: neither proves the recipient read the message, began a turn, or
accepted steering.

## Coordinator delivery loop

`check` names its caller with `--terminal <handle>` and is the only verb that
rejects `--from`. Omit `--terminal` in a chat session, whose caller is always
`session:<id>`, and inside an Orca terminal, where Orca resolves the caller.
Pass your own handle explicitly from anywhere else, including a dispatched
worker reading coordinator follow-ups. A chat coordinator never waits: it
checks without `--wait` on each turn Orca starts for new mail.

A consuming coordinator `check` returns the bound Run's oldest FIFO Delivery,
up to 50 messages, and replays that exact batch until acknowledged. Process
every row and required terminal ownership decision before `--ack`. Type filters
decide when a waiter wakes; they do not authorize skipping older actionable
mail. A Delivery therefore always carries the whole FIFO batch whatever its
types, and a `check` without `--wait` hands that batch over unfiltered.
`--peek` and `--all` are read-only inspection, not progress through the
coordinator inbox.

An empty wait or timeout is a checkpoint. Continue rolling waits until every
expected Dispatch settles. Heartbeat or visible activity means alive, not done.

## Addresses

Use a stable Dispatch address for attempt-specific coordinator guidance:

```text
ORCA orchestration send --to dispatch:<dispatch_id> --subject "Follow-up" --body "<guidance>" --json
```

Do not substitute a remote terminal handle. Omit `--from` for ordinary
coordinator calls; a dispatched worker instead copies the exact `--from` and
capability arguments in its preamble. Any live chat session on this host is
reachable at `session:<id>`, its Orca session id, never the provider's id (it
changes on `/clear`). `ORCA status --json` reports your own as `caller.address`;
a `caller` with `live: false` carries the refusal that stops you acting as that
session, and `null` means the shell has no orchestration identity. A user may
copy a chat's address with its Copy Orchestration Address menu action. `/clear`
gives a chat a new address: Orca moves its Runs and unread mail there, and a
send to the old one is refused with the new one named. `check` is the exception: it identifies
its caller with `--terminal`, never `--from`.

Group addresses include `@all`, `@idle`, `@claude`, `@codex`, `@opencode`,
`@gemini`, `@droid`, `@grok`, `@cursor`, and `@worktree:<id>`. Every group but
`@worktree:<id>` means the live Dispatches of the sender's own Run. Mail goes
to each `dispatch:<id>` mailbox, except a worker coordinating a child Run
receives it in that `run:<id>` mailbox. A sender bound to no Run is refused;
`--run` must match the group audience and never grants membership.
A Run group excludes its owning coordinator; a worker raising a blocker sends
to `run:<id>`. A worker that created its own Run addresses that Run's workers,
not its siblings. `@worktree:<id>` reaches matching workspace terminals,
including coordinators. Use groups only for intentional fan-out status or
questions. `worker_done`, heartbeat, and other
Dispatch lifecycle messages never target groups.

## Questions and gates

A worker uses `ask`; its timeout leaves one durable question pending, which the
worker resumes by message ID. The coordinator answers that message with `reply`.

Use a gate only for a coordinator-owned Task-DAG decision:

```text
ORCA orchestration gate-create --task <task_id> --question "<decision>" --options <json_array> --json
ORCA orchestration gate-resolve --id <gate_id> --resolution "<choice>" --json
ORCA orchestration gate-list --task <task_id> --json
```

Pass `json_array` using the quoting rules of the active shell; do not copy POSIX
single-quote syntax into PowerShell or `cmd.exe`.

Do not create a gate merely to answer a worker's `ask`.
