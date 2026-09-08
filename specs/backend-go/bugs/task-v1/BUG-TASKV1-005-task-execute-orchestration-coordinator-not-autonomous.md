# BUG-TASKV1-005: `orchestration-service` has no coordinator run lifecycle, no background loop, and a dead `messages` table — it is a passive CRUD-on-gates service, not an autonomous coordinator

**Business Logic:** [BL-TG-04](../../../../docs/logic/task-graph/BL-TG-04-task-agent-execution.md) — Task Prompt → Agent Execution (complex path)
**Service:** `orchestration-service`
**File:** `backend-go/services/orchestration-service/cmd/server/main.go`
**Priority:** P0
**Status:** NOT_IMPLEMENTED (new finding — not previously documented in `logic-v1`)
**Severity:** Critical
**Symptom:** `orchestration-service` has no `StartCoordinatorRun` RPC, no `time.Ticker`/poll loop, and no code path that ever autonomously advances an `orchestration_tasks` row from `pending`→`ready`→`dispatched`→`completed` on its own. It only exposes 7 request/response RPCs that a caller must drive one at a time (create a gate, resolve a gate, mark a dispatch failed, promote ready tasks) — there is no "coordinator" in the sense of a process that runs a DAG to completion by itself. `orchestration.messages` — the table meant to carry `status`/`dispatch`/`worker_done`/`merge_ready`/`escalation`/`handoff`/`decision_gate`/`heartbeat` events between workers and the coordinator — has zero RPCs that read or write it; it is entirely dead schema.

---

## Spec summary

`specs/backend-go/tdd/services/orchestration-service.md` §3's API sketch specifies an 11-RPC surface for a real, stateful multi-agent coordinator:

```
StartCoordinatorRun, GetCoordinatorRun, CompleteCoordinatorRun, FailCoordinatorRun,
CreateDispatchContext, RecordHeartbeat, FailDispatch,
CreateDecisionGate, ResolveDecisionGate, ListPendingDecisionGates,
UpdateTaskStatusAndPromote
```

`StartCoordinatorRun` is the entry point `task-service` calls for a "complex" task (`orchestration-service.md:65`: `ts -->|"StartCoordinatorRun(taskId, spec)"| orch`) — an async call that starts a coordinator run and returns immediately, with the coordinator then autonomously ticking the run's state machine (dispatching ready tasks, recording heartbeats, promoting dependents on completion, opening/resolving decision gates) until the whole DAG finishes or fails.

## What backend-go has (confirmed by reading the code)

Only **7 of the 11 sketched RPCs** are implemented, and none of them is an autonomous loop — every one is a synchronous request the caller must issue explicitly:

- `orchestration.proto:11-42` — the real, shipped RPC surface: `CreateDispatchContext`, `CreateGate`, `ResolveGate`, `UpdateTaskStatusAndPromote`, `GetDispatchContextForTask`, `ListActiveDispatchContextsForUser`, `FailDispatch`. Backing usecases confirmed present and real for each: `internal/usecase/create_dispatch_context.go`, `create_gate.go`, `resolve_gate.go`, `update_task_status_and_promote.go`, `get_dispatch_context_for_task.go`, `list_active_dispatch_contexts_for_user.go`, `fail_dispatch.go` — all with matching `_test.go` files, so this half is genuinely built, not stubbed.
- `cmd/server/main.go` (full file read): the only two goroutines started are a gRPC listener (`main.go:112-122`) and an HTTP health-check listener (`main.go:124-129`) — confirmed via `grep -n "time.Ticker\|time.NewTicker\|for {" cmd/server/main.go` returning **zero matches**. There is no scheduler, no scan loop, no background worker of any kind.
- `orchestration.messages` (`backend-go/services/orchestration-service/migrations/0001_init.up.sql:101-115`) still has its 8-value `message_type` CHECK constraint (`status/dispatch/worker_done/merge_ready/escalation/handoff/decision_gate/heartbeat`) but `grep -rn "orchestration\.messages\|PostMessage\|ListMessages\|RecordHeartbeat" backend-go/proto/orca/orchestration/v1/orchestration.proto backend-go/services/orchestration-service/internal/` returns **zero matches** — confirmed no RPC, usecase, or repository method ever touches this table.

## What's missing — TDD-sketched but not implemented

Comparing `orchestration-service.md` §3's 11-RPC sketch line-by-line against the actual `orchestration.proto` (`backend-go/proto/orca/orchestration/v1/orchestration.proto:10-43`, full file read):

| Sketched (TDD) | Implemented? |
|---|---|
| `StartCoordinatorRun` | ❌ No such RPC anywhere in the proto |
| `GetCoordinatorRun` | ❌ Missing |
| `CompleteCoordinatorRun` | ❌ Missing |
| `FailCoordinatorRun` | ❌ Missing |
| `RecordHeartbeat` | ❌ Missing — `DispatchContext.last_heartbeat_at` (`orchestration.proto:59`) is a readable field with no RPC that ever writes it |
| `FailDispatch` | ✅ Implemented (`orchestration.proto:42`) |
| `CreateDecisionGate` | ⚠️ Only `CreateGate` exists (`orchestration.proto:12`) — narrower name/shape than the TDD's sketched `CreateDecisionGateRequest`; not confirmed to be the same message shape without a deeper proto diff |
| `ResolveDecisionGate` | ⚠️ Only `ResolveGate` exists (`orchestration.proto:13`) — same caveat as above |
| `ListPendingDecisionGates` | ❌ Missing — no read RPC for pending gates exists; `orchestration.dispatchShow`'s own gap (see `missing-v1/BUG-018`) already established that `orchestration-service` had no read RPCs at all until `GetDispatchContextForTask`/`ListActiveDispatchContextsForUser` were added later, and neither of those is a gate-listing RPC |
| `UpdateTaskStatusAndPromote` | ✅ Implemented (`orchestration.proto:16`) |
| `CreateDispatchContext` | ✅ Implemented (`orchestration.proto:11`) |

Net: **6 of 11 sketched RPCs confirmed implemented** (`CreateDispatchContext`, `CreateGate`, `ResolveGate`, `UpdateTaskStatusAndPromote`, `FailDispatch`, plus the two later reads `GetDispatchContextForTask`/`ListActiveDispatchContextsForUser` that go beyond the original sketch) — **5 confirmed missing** (`StartCoordinatorRun`, `GetCoordinatorRun`, `CompleteCoordinatorRun`, `FailCoordinatorRun`, `RecordHeartbeat`, `ListPendingDecisionGates` — 6 if `ListPendingDecisionGates` is counted separately from the `CreateDecisionGate`/`ResolveDecisionGate` naming question).

The practical consequence: **there is no entry point for `task-service`'s complex-execution path to call at all.** [SOL-TG-04](../logic-v1/solutions/SOL-TG-04-task-agent-execution.md)'s real `ComplexExecutor` design (see [BUG-TASKV1-004](./BUG-TASKV1-004-orcatask-run-agent-execution-gaps.md)) calls `orch.StartCoordinatorRun(...)` — that RPC must be designed and built in `orchestration-service` first; `task-service` cannot close its own gap without it. Even if it existed, nothing would then advance the run: no ticker, cron, or event-driven scan loop exists to promote `pending`→`ready` tasks, dispatch them, or detect a completed run — `UpdateTaskStatusAndPromote` performs one promotion pass per call, but nothing calls it automatically; a caller (today, nothing) must invoke it after every task-status change to keep a run moving.

## See also

- [BUG-TASKV1-004](./BUG-TASKV1-004-orcatask-run-agent-execution-gaps.md) — the task-service side of the same gap (`ComplexExecutor` stub); this bug documents why building a real `ComplexExecutor` alone is insufficient — the RPC it needs to call doesn't exist on the other end.
- [`missing-v1/BUG-018-orchestration-channels-not-implemented.md`](../missing-v1/BUG-018-orchestration-channels-not-implemented.md) — narrower, already-resolved WS-wiring gap for `orchestration.dispatchShow`; unrelated to this bug's finding (this is a service-capability gap, not a channel-wiring gap).

## References

- `specs/backend-go/tdd/services/orchestration-service.md:74-90` — §3's full 11-RPC API sketch
- `backend-go/proto/orca/orchestration/v1/orchestration.proto:10-43` — actual 7-RPC `OrchestrationService` surface
- `backend-go/services/orchestration-service/cmd/server/main.go:39-136` — full `main()`, confirms no ticker/poll/scheduler goroutine
- `backend-go/services/orchestration-service/migrations/0001_init.up.sql:101-115` — `orchestration.messages` table, 8-value `message_type` CHECK, zero RPC coverage
- `backend-go/services/orchestration-service/internal/usecase/` — full usecase directory listing (`classify_dispatch_failure.go`, `create_dispatch_context.go`, `create_gate.go`, `fail_dispatch.go`, `get_dispatch_context_for_task.go`, `list_active_dispatch_contexts_for_user.go`, `resolve_gate.go`, `update_task_status_and_promote.go` — 8 files, none named `start_coordinator_run`/`record_heartbeat`/`list_pending_decision_gates`)
