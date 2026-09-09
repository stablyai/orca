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

Do not substitute a remote terminal handle. Omit `--from` for ordinary
coordinator calls; a dispatched worker instead copies the exact `--from` and
capability arguments in its preamble. `check` is the exception: it identifies
its caller with `--terminal`, never `--from`.

Group addresses include `@all`, `@idle`, `@claude`, `@codex`, `@opencode`,
`@gemini`, `@droid`, `@grok`, `@cursor`, and `@worktree:<id>`. Use them only for
intentional fan-out status or questions. `worker_done`, heartbeat, and other
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
