# Messaging and gates

Load this reference for inbox replay, attempt-specific guidance, group
addresses, blocking questions, or coordinator-managed DAG decisions.

A successful `send` proves durable enqueue. Wake and nudge are best-effort
attention only: neither proves the recipient read the message, began a turn, or
accepted steering.

## Coordinator delivery loop

`check` names its caller with `--terminal <handle>` and is the only verb that
rejects `--from`. Omit `--terminal` inside an Orca terminal, where Orca resolves
the caller; pass it explicitly from anywhere else, including a dispatched
worker reading coordinator follow-ups.

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

A busy chat agent holds an agent's message as a queued card, run when its
turn ends. For a redirect or stop that cannot wait, add `--delivery steer`.
With `send`, the chat gets the "you have mail" notice in its running turn
(Claude and Codex take it mid-turn; an agent that runs one prompt at a time
ends its turn and takes it next, as a person's Send now does); it waits while
an approval or question is open. With `dispatch --inject`, the task goes in
the same way, or becomes a card while a prompt is open. A task reported handed
to the chat but not taken yet can still be dropped if that turn ends first (for
example on Stop), so check on a worker that never reports. Another Orca server
queues a steer. Terminal agents are unaffected: they get mail at their next
idle point or from `check --wait`.

Do not substitute a remote terminal handle. Omit `--from` for ordinary
coordinator calls; a dispatched worker instead copies the exact `--from` and
other arguments in its preamble. `check` is the exception: it identifies
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
