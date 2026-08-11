# Wedged worker detection

A supervised worker that hangs looks exactly like a worker that is thinking hard. The
coordinator only learns the difference when its own `check --wait` window expires,
which is routinely 15 to 60 minutes of nothing. Orca already receives turn-boundary
events from each worker's harness and already owns the worker's PTY, so it can notice
the silence much earlier and say so.

This detector says so and nothing else. **It never stops, kills, restarts, interrupts,
closes, focuses or writes to a worker.** Its only effect is one `escalation` message in
the owning Run's mailbox. Every decision stays with the coordinator.

## What counts as progress

Progress is positive evidence, collected per dispatch:

| Evidence | Source |
| --- | --- |
| `agent_turn_boundary` | harness hook state change for the worker's pane |
| `agent_hook_event` | any harness hook event for that pane |
| `terminal_output` | the pane's PTY produced output |
| `heartbeat` | an accepted `heartbeat` for that dispatch |
| `worker_message` | any message the worker itself sent in the Run |
| `worker_question` | an `ask` the worker recorded |

The absence of evidence is never proof of a wedge on its own, and it is never read as
progress either. A dispatch classifies as **unknown** — not wedged, not working — when:

- it runs on another Orca server (federated): local evidence says nothing about it;
- this runtime owns no pane for it, or the pane's PTY is disconnected;
- a different process now owns the pane, so the dispatch's worker is already gone;
- no evidence of any kind has ever been recorded, so there is no baseline to measure.

## What is not a wedge

A worker parked on an external wait is alive by definition, and the dispatch preamble
tells workers exactly that ("skip heartbeats only while blocked inside `check --wait`
or `ask` — those calls are themselves liveness signals"). These classify as **blocked**
and never escalate:

- an unanswered `ask` (a pending question thread on the dispatch);
- a live `ask` or `check --wait` parked on the dispatch's mailbox;
- a harness reporting `waiting` or `blocked`, which means it is holding for input.

A settled dispatch is not scanned at all: the detector only looks at dispatches whose
worker state is `ready` and whose dispatch status is `dispatched`.

## Cadence

| Setting | Default | Environment variable |
| --- | --- | --- |
| Quiet time before a wedge | 15 min | `ORCA_WEDGED_WORKER_THRESHOLD_MS` |
| Gap before re-escalating | 30 min | `ORCA_WEDGED_WORKER_REESCALATION_MS` |
| Scan period | 60 s | `ORCA_WEDGED_WORKER_SCAN_INTERVAL_MS` |
| Detection on or off | on | `ORCA_WEDGED_WORKER_DETECTION` |

15 minutes is three missed heartbeats at the preamble's 5-minute cadence, so a long
model turn or a slow tool call never trips it. Values are clamped: the threshold cannot
go under a minute, a re-escalation never fires sooner than one full threshold, and the
scan never runs faster than 5 seconds or slower than the threshold itself.

The first wedge produces exactly one escalation. Every repeat waits a full
re-escalation gap and carries a higher `escalationCount`, so a coordinator can tell a
repeat from a new report. Resumed progress clears the count; the next wedge starts at 1
again. The count survives a runtime restart because it is read back from the last
escalation the detector wrote.

## Message shape

The escalation is addressed to `run:<runId>` and attributed to `dispatch:<dispatchId>`,
at `high` priority. Its payload is namespaced:

```json
{
  "kind": "wedged_worker_signal",
  "wedgedWorker": {
    "dispatchId": "ctx_...",
    "runId": "run_...",
    "taskId": "task_...",
    "escalationCount": 1,
    "quietMs": 2400000,
    "lastProgressAt": "2026-08-11T09:04:11.000Z",
    "observed": ["terminal_output"],
    "absent": ["agent_turn_boundary", "heartbeat"],
    "agentState": "working",
    "thresholdMs": 900000,
    "reEscalateAfterMs": 1800000,
    "detectionOnly": true
  }
}
```

`taskId` is deliberately nested rather than top level. The retired coordinator loop
fails a dispatch when it reads a top-level `payload.taskId` on an escalation, and this
signal must never cause an effect.

## Remote wire compatibility

Nothing here changes an RPC shape or a stream opcode. It publishes new content of an
existing message type on an existing path, which is a Rule 3 concern in
[remote-wire-compatibility.md](./remote-wire-compatibility.md): an older paired client
receives an ordinary `escalation` it can read, print and acknowledge, and it ignores the
payload key it does not know. Federated dispatches never produce this signal, so a
mixed-version pair cannot see one attributed to a worker its own server does not own.

## Where the code lives

- `src/main/runtime/orchestration/worker-progress-evidence.ts` — evidence collection and
  the pure classifier.
- `src/main/runtime/orchestration/wedged-worker-escalation.ts` — cadence decision and the
  message text.
- `src/main/runtime/orchestration/wedged-worker-detector.ts` — one scan pass over
  candidate dispatches.
- `src/main/runtime/orchestration/wedged-worker-runtime-monitor.ts` — the timer and the
  runtime adapter. Armed when a supervised worker becomes ready and when workers are
  adopted after a restart; it stops itself as soon as a scan finds no candidate, so a
  runtime with no supervised workers pays nothing.
