# Worker teardown

A worker has three distinct endings: **settled** (attempt/Task outcome),
**ended** (dormant session), and **destroyed** (process proven gone). Keep Task
outcome, Dispatch attempt, and process/resource liveness separate. Silence, a
timeout, or `unverifiable` liveness supplies no proof of exit; a settled Task
can still have live or unverifiable resources.

## Settled: attempt and Task outcome

- `worker_done` settles the Dispatch and its Task: `succeeded` completes both,
  `failed` fails both. A reported failure is a conclusion; never mark it
  completed.
- If a terminal worker exits without reporting, Orca fails the Dispatch (the
  Task ordinarily returns to `ready`, or becomes `failed` at the circuit
  breaker) and mails the coordinator; a remote worker's stop relay carries the
  report home. A pending or unknown stop takes a separate path and can suppress
  the exit escalation.
- `exited` and `lost` are `stopReason` values; `unverifiable` is a liveness
  verdict. `exited` confirms process exit. `lost` is non-exhaustive — it can
  follow a deliberate pane close, restart recovery that cannot confirm exit or
  continuation (including a chat with no terminal), a failed start, or an
  app-server drop. The original agent may still be running: inspect
  `worker-show` before sending mail or retrying, and if liveness remains
  `unverifiable`, stop automatic recovery and report the uncertainty rather than
  launching a second agent.
- Three consecutive Dispatch failures in one `--retry-of` chain trip
  `circuit_broken` and fail the Task (a worker's own `worker_done --outcome
  failed` report does not advance that count); see
  [Recovery and cleanup](recovery-and-cleanup.md).

## Ended: the session is dormant, not destroyed

- An accepted report can arm automatic release when supported; auto-close runs
  only while the agent rests, while a working or needs-input agent keeps its
  terminal. `--keep-open` (or `worker-keep-open`) prevents automatic close.
  Auto-close and keep-open never change the Task's outcome.
- Records persist after close. A plain `send --to dispatch:<id>` (without
  `--on`) on local Orca or a paired server advertising
  `orchestration.remote-owned-workers.v1` can reuse an eligible open agent,
  reopen a resumable session, start fresh with prior context, or refuse when the
  workspace or restartable agent is missing; the receipt says what occurred.
- Only legacy paired-server attachments refuse `send` with `dispatch_inactive`;
  on that refusal, start new work there with `worker-start --on <server>`.

## Destroyed: the process is proven gone

- `worker-stop` settles an unsettled worker on confirmed stop or observed exit
  (a context-only `dispatch` is fenced with `processAction: none`). Otherwise
  it exits 1 with `stop_unknown` (which may coexist with
  `closed_agent_terminal`). A later observed exit or restart recovery can
  reconcile a pending stop; read the receipt and `worker-show` before acting
  again.
- `worker-release` performs post-completion cleanup for a settled worker and
  can also reclaim an eligible live terminal left by a failed start (which
  `worker-stop` / `worker-abandon` do not close), respecting custody and
  returning `retained` or `already_released` when no close is performed.
  `release_pending` exits 0 and recovery retries after inventory or reconnect.
  `release_unknown` exits 1: inspect `worker-show` and retry without
  `--retry-request` (a fresh request ID; reusing the ID replays the receipt),
  never with a broad `terminal close`.
- `worker-abandon` fences and settles the assignment while retaining
  possibly-live resources; it performs no process or filesystem action, refuses
  a same-runtime in-flight stop, and can leave the Task blocked.
- The settled-worker sweep releases only on a proven process exit; a live or
  unverifiable process keeps its terminal.

`ORCA orchestration worker-list --run <run_id> --include-remote` (paginated;
remote coverage is capability-dependent) reports each worker's liveness
(`live`, `exited`, `unverifiable`) and conditional `next` action; follow it.
