# TASK-TASKV1-005-04: Ports — new `CoordinatorRunRepository`/`WorkerDispatcher`/`TaskServiceReporter`, extend `OrchestrationTaskRepository`/`DispatchContextRepository`/`GateRepository`

**From Solution:** SOL-TASKV1-005
**Priority:** P1
**Service:** `orchestration-service` (usecase-layer ports only — no implementation)
**File:** `backend-go/services/orchestration-service/internal/usecase/ports.go`
**Depends on:** TASK-TASKV1-005-03 (domain types referenced by these signatures)
**Status:** `[ ]` TODO

---

## Context

`ports.go` (124 lines, read in full) currently defines `HandleSerializer`,
`OrchestrationTaskRepository` (2 methods: `Create`, `Get`,
`UpdateStatusAndPromote`), `DispatchContextRepository` (4 methods), and
`GateRepository` (2 methods) — no `CoordinatorRunRepository` port exists at
all today, confirmed by grep. This task adds the 3 new ports the tick loop
and lifecycle usecases need, plus extends the 3 existing ports with the
methods those same usecases call. This is a pure interface-definition task
— concrete implementations land in `TASK-TASKV1-005-05` (Postgres) and
`TASK-TASKV1-005-08` (infra-fleet-service/task-service clients).

## Changes to make

In `backend-go/services/orchestration-service/internal/usecase/ports.go`,
add near the top with the other sentinel errors (after line 23):

```go
// ErrRunNotFound is CoordinatorRunRepository's not-found sentinel, mirroring
// ErrTaskNotFound/ErrDispatchContextNotFound/ErrGateNotFound's existing shape.
var ErrRunNotFound = errors.New("usecase: coordinator run not found")
```

Add a new import for `encoding/json` (used by `CoordinatorRunRepository.Complete`'s
`result json.RawMessage` parameter):

```go
import (
	"context"
	"encoding/json"
	"errors"

	"github.com/stablyai/orca-go/services/orchestration-service/internal/domain"
)
```

Extend `OrchestrationTaskRepository` (after the existing
`UpdateStatusAndPromote` method, before its closing `}`):

```go
	// ListReadyUnclaimed returns 'ready' orchestration_tasks across ALL
	// tenants/runs that have no dispatch_contexts row yet — the tick
	// loop's (TASK-TASKV1-005-10) outer scan. "Claim" (transition ready ->
	// dispatched) happens per-task inside ClaimReady below via a CAS
	// UPDATE, not here, so two concurrent tick instances listing the same
	// task is safe: only one's claim UPDATE succeeds.
	ListReadyUnclaimed(ctx context.Context) ([]domain.OrchestrationTask, error)

	// ClaimReady atomically transitions ONE task from 'ready' to
	// 'dispatched' (UPDATE ... WHERE status='ready' RETURNING, i.e.
	// compare-and-swap) — returns (task, true, nil) on success, (zero,
	// false, nil) if another tick instance already claimed it (not an
	// error: expected under concurrent ticks, same "ok to lose the race"
	// shape as sql.ErrNoRows-as-a-bool elsewhere in this codebase).
	ClaimReady(ctx context.Context, tenantID, taskID string) (domain.OrchestrationTask, bool, error)

	// CountNonTerminalByRun returns how many orchestration_tasks under
	// coordinatorRunID are NOT in a terminal status (completed/failed) —
	// UpdateTaskStatusAndPromote's extended transaction
	// (TASK-TASKV1-005-07) uses this to decide "is this run done" without
	// a second round-trip after COMMIT, which would reopen the exact
	// torn-read race §8 exists to close.
	CountNonTerminalByRun(ctx context.Context, tenantID, coordinatorRunID string) (int, error)
```

Add a new `CoordinatorRunRepository` port (after the `OrchestrationTaskRepository`
interface's closing `}`):

```go
// CoordinatorRunRepository is the persistence port for the top-level
// "complex path" coordination session — new port, mirrors the existing
// repositories' naming/atomicity discipline (ports.go's DispatchContextRepository/
// GateRepository doc comments).
type CoordinatorRunRepository interface {
	// CreateWithTasks atomically inserts the coordinator_runs row (status
	// running) AND every OrchestrationTask domain.ExpandSpec(run.Spec)
	// produces — resolving each task's Deps from SpecNode TempIDs to the
	// freshly-minted real ids WITHIN the same transaction. A torn write
	// here would leave a run with unresolvable deps, permanently stuck
	// (same class of bug §8 guards UpdateStatusAndPromote against).
	CreateWithTasks(ctx context.Context, tenantID string, run domain.CoordinatorRun) (domain.CoordinatorRun, error)
	Get(ctx context.Context, tenantID, id string) (domain.CoordinatorRun, error)
	// Complete/Fail are single-row updates (no cross-table write), unlike
	// CreateWithTasks — simple, not wrapped in the txn helper.
	Complete(ctx context.Context, tenantID, id string, result json.RawMessage) (domain.CoordinatorRun, error)
	Fail(ctx context.Context, tenantID, id, errMsg string) (domain.CoordinatorRun, error)
	// ListRunning backs the tick loop's outer scan — every run this
	// instance should be advancing. Scoped by status only (not tenant):
	// the tick loop runs as the service's own internal identity, not a
	// per-request caller, so it must see every tenant's running runs.
	ListRunning(ctx context.Context) ([]domain.CoordinatorRun, error)
	// MarkReported sets reported_at = now() once TaskServiceReporter.ReportResult
	// succeeds for a terminal run — a single-column update, called from
	// UpdateTaskStatusAndPromote's post-commit reporting step
	// (TASK-TASKV1-005-07), never inside the same transaction that
	// finalized the run (a cross-service report must already have
	// succeeded before this is called).
	MarkReported(ctx context.Context, tenantID, id string) error
	// ListUnreportedTerminal returns every completed/failed run with
	// reported_at still NULL — backs the tick loop's retry pass
	// (TASK-TASKV1-005-10) for a ReportResult call that failed the first
	// time. Reuses idx_coordinator_runs_unreported (TASK-TASKV1-005-01),
	// scoped by status only, same "internal identity, not tenant-scoped"
	// reasoning as ListRunning.
	ListUnreportedTerminal(ctx context.Context) ([]domain.CoordinatorRun, error)
}

// WorkerDispatcher is the port the tick loop (TASK-TASKV1-005-10) calls to
// hand a ready OrchestrationTask to a terminal-hosted AI-agent worker via
// infra-fleet-service -> Dev Server Agent — orchestration-service.md §7's
// "resolve connectionId for assignee_handle... sync gRPC per dispatch."
// This does not decide WHICH handle to assign (the tick loop does) — it
// only performs the dispatch call for an already-chosen handle. Concrete
// adapter: TASK-TASKV1-005-08.
type WorkerDispatcher interface {
	Dispatch(ctx context.Context, tenantID string, task domain.OrchestrationTask, handle string) error
}

// TaskServiceReporter is the outbound port for reporting a coordinator
// run's terminal state back to task-service — the SERVER side of SOL-TG-04's
// ReportTaskExecutionResult RPC is task-service's own scope (TASK-TG-04-05,
// not yet built as of this writing — grep confirms no
// ReportTaskExecutionResult symbol exists anywhere in backend-go yet);
// this is orchestration-service's client stub calling it. Concrete
// adapter: TASK-TASKV1-005-08.
type TaskServiceReporter interface {
	ReportResult(ctx context.Context, taskID, coordinatorRunID string, success bool, errMsg string) error
}
```

Extend `DispatchContextRepository` (after the existing
`RecordDispatchFailure` method, before its closing `}`):

```go
	// RecordHeartbeat updates last_heartbeat_at = now() for
	// dispatchContextID — a single-column UPDATE, no transaction needed
	// (§8: "no cross-service calls on that path," p99 < 30ms budget rules
	// out wrapping this in the heavier per-usecase txn+serializer pattern
	// used elsewhere in this file).
	RecordHeartbeat(ctx context.Context, tenantID, dispatchContextID string) (domain.DispatchContext, error)
```

Extend `GateRepository` (after the existing `ResolveGate` method, before
its closing `}`):

```go
	// ListPending returns every pending decision_gates row for tenantID,
	// backing ListPendingDecisionGates and reusing the existing
	// idx_gates_pending partial index (0001_init.up.sql:91) — that index
	// was created for exactly this query and has had zero callers until now.
	ListPending(ctx context.Context, tenantID string) ([]domain.DecisionGate, error)
```

## Verify

```bash
cd /opt/repos/orca/backend-go
go build ./services/orchestration-service/...
```

Expected: this alone breaks the build of `internal/adapter/postgres`
(the concrete `Repository` type no longer satisfies the widened
`OrchestrationTaskRepository`/`DispatchContextRepository`/`GateRepository`
interfaces, and `CoordinatorRunRepository` has zero implementations) — that
is expected and resolved by `TASK-TASKV1-005-05`; do not attempt to make
`go build` pass at this task's boundary alone.
