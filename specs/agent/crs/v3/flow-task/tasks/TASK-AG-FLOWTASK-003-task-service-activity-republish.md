# TASK-AG-FLOWTASK-003: `task-service` consumes `StreamExecOutput`, republishes to `task.activity`

**Task ID:** TASK-AG-FLOWTASK-003
**Priority:** 🔵 P3 (Phase D of CR-FLOW-TASK-003 — design-only, not scheduled)
**Solution Ref:** [SOL-AG-FLOWTASK-001](../solutions/SOL-AG-FLOWTASK-001-execution-activity-streaming-design.md) §2.3
**Depends on:**
- TASK-AG-FLOWTASK-002 (`StreamExecOutput` must exist in `infra-fleet-service` first)
- **CR-FLOW-TASK-001** (`execution_links` — needed as the place to mirror Engine 1's run status)
- **CR-FLOW-TASK-003** (the `task.activity:{taskId}` WS channel + `TaskActivityFrame` shape must
  ship first — this task has nowhere to publish to otherwise)
**Status:** [ ] TODO (chờ quyết định triển khai — không phải TODO ngay)

> **Không bắt đầu code cho tới khi CR-FLOW-TASK-001 và CR-FLOW-TASK-003 đã
> triển khai xong**, và cho tới khi ai đó quyết định lên lịch phần streaming
> này. Xây ống dẫn (task này) trước khi có điểm đến (`task.activity` channel)
> là vô nghĩa — xem SOL-AG-FLOWTASK-001 §4.

---

## Context

**Component:** `task-service`'s `SimpleExecutor` (Engine 1 — direct `agent.execPrompt` one-shot
executor)

**Problem:** Today `SimpleExecutor.Execute` calls `Exec` unary and gets exactly one final
`{stdout, stderr, exitCode, timedOut}` response — no mid-run visibility for the frontend, even
for a run approaching `MAX_TIMEOUT_MS = 15 * 60_000`.

## Implementation Sketch (from SOL-AG-FLOWTASK-001 §2.3 — not final)

`SimpleExecutor.Execute` calls `StreamExecOutput` in parallel with `Exec` (mirroring how
`AttachPty`/`WaitTerminalSession` already consume `StreamPty`), then:

- **Does not** publish every chunk as its own outbox event — CR-FLOW-TASK-003 explicitly scoped
  itself to discrete events, not a byte stream; one-event-per-chunk would flood
  `orchestration.messages`/outbox.
- **Should** batch using one of (decide at implementation time, not here):
  - (a) time-based throttle (e.g. every 2s, publish one `orca.task.agent_output_partial` event
    carrying the buffer accumulated so far), or
  - (b) milestone-based (e.g. an OSC 133 boundary) — **not viable for this path**: `--print` mode
    does not run inside a PTY, so no OSC sequences are emitted (unlike `agent.spawn`'s interactive
    PTY path). Option (a) is the only one that's actually usable here without further design work.
- The final payload lands on `task.activity:{taskId}` (CR-FLOW-TASK-003 §3's `TaskActivityFrame`)
  with `Engine: "direct_agent"`, `EventType: "agent_output_partial"` — reusing the already-designed
  frame, not a new WS channel.

## Open Questions To Resolve Before Coding (SOL-AG-FLOWTASK-001 §5)

1. **Throttle policy** — fixed interval vs. milestone-based. Milestone-based is not viable per
   above; fixed-interval needs real data on typical `agent.execPrompt` output length/duration
   before picking an interval.
2. **Scope limitation to acknowledge in the task, not silently ignore:** this design only applies
   to Task runs pinned to model `claude` via Engine 1 (`agent-print-mode-exec.ts:82-94`) — tasks
   using `gemini`/`codex`/`opencode` through `agent.execPrompt` already fail `InvalidParams`
   independent of this work.
3. Confirm `execution_links`'s `status_mirror` (CR-FLOW-TASK-001) has a field shape that can
   accept partial/in-progress state, not only terminal state, before wiring this in.

## Tests To Add

- `SimpleExecutor.Execute` publishes throttled `agent_output_partial` events to `task.activity`
  while a run is in progress, and the existing terminal event (completion/failure) is unaffected.
- No partial event is published faster than the chosen throttle interval, even under a fast/dense
  `agent.execOutput` stream from TASK-AG-FLOWTASK-002.
- A `gemini`/`codex`/`opencode`-pinned task's pre-existing `InvalidParams` failure path is
  unaffected by this change.

## Verification

```bash
cd backend-go && go build ./services/task-service/...
cd backend-go && go test ./services/task-service/...
```

---

## Acceptance Criteria

- [ ] `SimpleExecutor.Execute` consumes `StreamExecOutput` in parallel with `Exec`, without
      changing `Exec`'s own unary completion contract.
- [ ] Chunks are batched (never 1 outbox event per raw chunk) per the chosen throttle policy,
      documented explicitly in code.
- [ ] Final `task.activity:{taskId}` payload matches CR-FLOW-TASK-003's `TaskActivityFrame` shape
      exactly (`Engine: "direct_agent"`, `EventType: "agent_output_partial"`) — no new channel.
- [ ] Verified only after CR-FLOW-TASK-001 and CR-FLOW-TASK-003 are actually deployed, not against
      a stub.
