# Worker contract

The injected preamble is authoritative. Copy its command rather than
reconstructing flags. In particular, preserve the exact executable, worker
handle, Dispatch capability, Task ID, and Dispatch ID.

## Heartbeat

Send heartbeats only at the cadence required by the live preamble. Skip them
while blocked inside `ask` or `check --wait`; those calls are liveness signals.

```text
ORCA orchestration send --from <worker_handle> --dispatch-capability <capability> --type heartbeat --subject "alive" --task-id <task_id> --dispatch-id <dispatch_id> --phase "<investigating|implementing|reviewing|waiting>"
```

Use typed lifecycle flags, not a hand-written JSON payload. A heartbeat proves
liveness, never completion.

## Ask and resume

Use Orca `ask` whenever the coordinator must answer. Never open a local question
TUI the coordinator cannot answer.

```text
ORCA orchestration ask --from <worker_handle> --dispatch-capability <capability> --question "<question>" --options "<choice-a>,<choice-b>" --timeout-ms 600000

ORCA orchestration ask --from <worker_handle> --dispatch-capability <capability> --resume <message_id> --timeout-ms 600000
```

A timeout or disconnect leaves the original question pending. Resume its
message ID; do not create a duplicate question.

## Reading coordinator follow-ups

The coordinator steers a running worker with `send --to dispatch:<id>`. That
enqueue is durable but does not interrupt you, so nothing arrives unless you
look:

```text
ORCA orchestration check --terminal <worker_handle> --json
```

Run it at each natural checkpoint — before starting a new file, after a test
run — and once more immediately before `worker_done`, so a redirect or a
cancellation lands before the Task settles. `check` names its caller with
`--terminal`, never `--from`. Stop checking after `worker_done`.

If `check` returns `consumer_fenced`, this process no longer owns its Dispatch:
the Attempt was re-attached to another worker or settled without you. Stop, do
not send `worker_done`, and do not retry the check. An empty `check` never means
you were replaced; `consumer_fenced` is the only way you learn that.

## Escalation

Escalate only before completion and only when the coordinator must intervene:

```text
ORCA orchestration send --from <worker_handle> --dispatch-capability <capability> --type escalation --subject "Blocked: <reason>" --body "<details>" --task-id <task_id> --dispatch-id <dispatch_id>
```

## Completion

Send exactly one terminal report. `--body` is three sentences: what changed,
what was found, and what remains. Use `--outcome failed` when the requested work
is not complete; never hide failure in prose or silently exit.

Append `--files-modified` or `--report-path` only when applicable, using actual
paths. Do not send documentation placeholders as metadata.

```text
ORCA orchestration send --from <worker_handle> --dispatch-capability <capability> --type worker_done --subject "<short status>" --body "<three sentences: work, findings, remaining>" --task-id <task_id> --dispatch-id <dispatch_id> --outcome succeeded
```

After `worker_done`, end the dispatched turn and idle. Do not poll, close your
own terminal, or begin unrelated work. A later direct user instruction is new
user-owned work and must not reuse settled lifecycle IDs; a supervised follow-up
arrives with a fresh preamble and Task block.
