# TASK-TASKV1-005-10: `TickDispatch` usecase + `main.go` ticker goroutine + full autonomy integration test

**From Solution:** SOL-TASKV1-005
**Priority:** P1
**Service:** `orchestration-service` (`internal/usecase`, `cmd/server`)
**File:** `backend-go/services/orchestration-service/internal/usecase/tick_dispatch.go` (new), `backend-go/services/orchestration-service/cmd/server/main.go` (extend)
**Depends on:** TASK-TASKV1-005-05 (`ListReadyUnclaimed`/`ClaimReady`/`ListUnreportedTerminal`), TASK-TASKV1-005-06 (`CreateDispatchContext` reused), TASK-TASKV1-005-07 (`FailDispatch` reused), TASK-TASKV1-005-08 (`WorkerDispatcher`/`TaskServiceReporter`), TASK-TASKV1-005-09 (main.go wiring this extends)
**Status:** `[ ]` TODO

---

## Context

This is the final piece: the actual "autonomously ticking the run's state
machine" `orchestration-service.md` §2.2 describes and BUG-TASKV1-005
confirms does not exist as any kind of background loop today (`main.go`
today has exactly two goroutines — gRPC and HTTP listeners,
`main.go:112-129`, confirmed by reading the file in full: no `ticker`,
`time.Tick`, or third goroutine anywhere). `TickDispatch` is the ONE
usecase the loop calls per interval — it has no gRPC-facing counterpart.
It reuses `usecase.CreateDispatchContext` and `usecase.FailDispatch`
UNMODIFIED (both already real, tested — this task's job is calling them
from a new caller, not touching their internals), per this solution's own
"what already exists and must not be redesigned" note. This task also adds
the `ListUnreportedTerminal` retry pass (`TASK-TASKV1-005-04`/`-05`/`-07`'s
`reported_at` mechanism) into the same tick cycle, since nothing else in
this breakdown drives that retry.

## Changes to make

Create `backend-go/services/orchestration-service/internal/usecase/tick_dispatch.go`:

```go
package usecase

import (
	"context"
	"fmt"
	"log/slog"

	"google.golang.org/grpc/status"

	"github.com/stablyai/orca-go/services/orchestration-service/internal/domain"
)

// TickDispatch is the ONE usecase the tick loop (cmd/server/main.go) calls
// per interval — the internal engine orchestration-service.md §2.2
// describes as "the coordinator then autonomously ticking the run's state
// machine." No gRPC-facing counterpart exists for this usecase.
type TickDispatch struct {
	tasks    OrchestrationTaskRepository
	runs     CoordinatorRunRepository
	dispatch *CreateDispatchContext // reused as-is, not reimplemented
	worker   WorkerDispatcher
	fail     *FailDispatch // reused as-is for a dispatch call that errors
	reporter TaskServiceReporter
}

func NewTickDispatch(tasks OrchestrationTaskRepository, runs CoordinatorRunRepository, dispatch *CreateDispatchContext, worker WorkerDispatcher, fail *FailDispatch, reporter TaskServiceReporter) *TickDispatch {
	return &TickDispatch{tasks: tasks, runs: runs, dispatch: dispatch, worker: worker, fail: fail, reporter: reporter}
}

func (uc *TickDispatch) Execute(ctx context.Context) error {
	if err := uc.dispatchReady(ctx); err != nil {
		return err
	}
	uc.retryUnreported(ctx) // best-effort; never fails the whole tick
	return nil
}

// dispatchReady claims and dispatches every ready-unclaimed task this
// instance can see. A ready task with an unresolved decision gate never
// reaches this scan (gate resolution/CreateGate already transitions the
// owning task to blocked, per §4/§8 — see decision_gates' own atomicity
// contract), so this loop does not need its own gate check.
func (uc *TickDispatch) dispatchReady(ctx context.Context) error {
	ready, err := uc.tasks.ListReadyUnclaimed(ctx)
	if err != nil {
		return fmt.Errorf("tick: list ready tasks: %w", err)
	}
	for _, task := range ready {
		claimed, ok, err := uc.tasks.ClaimReady(ctx, task.TenantID, task.ID)
		if err != nil {
			slog.Error("tick: claim failed", slog.String("task_id", task.ID), slog.Any("error", err))
			continue // one task's claim failure must not abort the whole batch
		}
		if !ok {
			continue // lost the race to another tick/instance — not an error
		}
		// one worker per orchestration_task, per orchestration-service.md
		// §4's DispatchContext.assignee_handle shape
		handle := "worker:" + claimed.ID
		dc, err := uc.dispatch.Execute(ctx, CreateDispatchContextInput{
			Handle: handle, CoordinatorRunID: claimed.CoordinatorRunID, OrchestrationTaskID: claimed.ID,
		})
		if err != nil {
			slog.Error("tick: create dispatch context failed", slog.String("task_id", claimed.ID), slog.Any("error", err))
			continue // task stays 'dispatched' with no dispatch_context row; a reconciliation pass is a flagged follow-up, not solved here (see solution's "Not in scope")
		}
		if err := uc.worker.Dispatch(ctx, claimed.TenantID, claimed, handle); err != nil {
			// Real, permanent-until-retried dispatch failure — record it
			// via the EXISTING FailDispatch usecase (circuit-breaker logic
			// reused unmodified).
			_, ferr := uc.fail.Execute(ctx, FailDispatchInput{
				DispatchContextID: dc.ID, ErrorMessage: err.Error(), GRPCStatusCode: uint32(status.Code(err)),
			})
			if ferr != nil {
				slog.Error("tick: record dispatch failure also failed", slog.String("dispatch_context_id", dc.ID), slog.Any("error", ferr))
			}
			continue
		}
	}
	return nil
}

// retryUnreported re-attempts TaskServiceReporter.ReportResult for any run
// whose terminal state was persisted (UpdateTaskStatusAndPromote's tail,
// TASK-TASKV1-005-07) but never successfully reported — closes the retry
// gap that tail's own doc comment flags. Best-effort: a retry failure here
// is logged and left for the NEXT tick, same as the first attempt's own
// failure handling.
func (uc *TickDispatch) retryUnreported(ctx context.Context) {
	unreported, err := uc.runs.ListUnreportedTerminal(ctx)
	if err != nil {
		slog.Error("tick: list unreported terminal runs failed", slog.Any("error", err))
		return
	}
	for _, run := range unreported {
		success := run.Status == domain.RunStatusCompleted
		if err := uc.reporter.ReportResult(ctx, run.OriginTaskID, run.ID, success, run.ErrorMessage); err != nil {
			slog.Error("tick: retry report result failed", slog.String("coordinator_run_id", run.ID), slog.Any("error", err))
			continue
		}
		if err := uc.runs.MarkReported(ctx, run.TenantID, run.ID); err != nil {
			slog.Error("tick: mark reported failed", slog.String("coordinator_run_id", run.ID), slog.Any("error", err))
		}
	}
}
```

### `cmd/server/main.go` — the ticker goroutine

After constructing `tickDispatchUC := usecase.NewTickDispatch(repo, repo,
createDispatchContextUC, workerDispatcher, failDispatchUC,
taskServiceReporter)` (added alongside the other usecase constructions from
`TASK-TASKV1-005-09`), add a third background goroutine — additive,
matching this file's existing goroutine+errCh pattern
(`main.go:112-129`) — placed after the existing HTTP-listener goroutine,
before the `select { case <-ctx.Done(): ... }` block:

```go
tickCtx, tickCancel := context.WithCancel(context.Background())
defer tickCancel()
go func() {
	// matches domain.defaultPollIntervalMs; a per-run poll_interval_ms is
	// stored on CoordinatorRun but this scaffold's tick loop runs one
	// global cadence for every run — see SOL-TASKV1-005's "Not in scope"
	// section for the per-run-interval refinement, deliberately deferred.
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-tickCtx.Done():
			return
		case <-ticker.C:
			if err := tickDispatchUC.Execute(context.Background()); err != nil {
				logger.Error("tick dispatch failed", slog.Any("error", err))
				// Deliberately does NOT stop the ticker or exit the
				// process — one failed tick (e.g. a transient Postgres
				// blip) must not take down the whole coordinator; the
				// next tick retries the same ClaimReady scan.
			}
		}
	}
}()
```

Add `tickCancel()` to the existing graceful-shutdown sequence (alongside
`grpcServer.GracefulStop()`), so the ticker goroutine is stopped before
`run()` returns rather than leaking past process shutdown in tests that
call `run()` in-process.

## Verify

```bash
cd /opt/repos/orca/backend-go
go build ./services/orchestration-service/...
go test ./services/orchestration-service/internal/usecase/... -run TestTickDispatch -v
go test ./services/orchestration-service/... -v
```

Write `internal/usecase/tick_dispatch_test.go` (fakes for
`OrchestrationTaskRepository`/`CoordinatorRunRepository`/`WorkerDispatcher`/
`TaskServiceReporter`, reusing `CreateDispatchContext`/`FailDispatch` with
their own existing fakes) covering:
- A ready+unclaimed task gets `ClaimReady`'d, dispatched, and
  `CreateDispatchContext`'d exactly once.
- Two tasks racing for the same `ClaimReady` (fake returns `ok=false` on
  the second call) results in exactly one dispatch.
- A `WorkerDispatcher.Dispatch` error routes to `FailDispatch` with the
  task's dispatch-context id, not left silently dropped.
- A `ListReadyUnclaimed` error surfaces from `Execute` without dispatching
  anything and without attempting `retryUnreported`.
- `retryUnreported`: an unreported `completed` run calls `ReportResult`
  with `success=true` then `MarkReported`; an unreported `failed` run calls
  it with `success=false` and the run's `ErrorMessage`; a `ReportResult`
  failure does NOT call `MarkReported` and does not fail `Execute` overall
  (best-effort).

Add one new integration-level test (new file, e.g.
`internal/usecase/coordinator_run_integration_test.go`, using this
package's existing real-Postgres-test-container convention plus fakes for
`WorkerDispatcher`/`TaskServiceReporter` — the two genuinely
cross-service ports, per this solution's own test-plan section): a full
`StartCoordinatorRun` (single-node spec, no deps) → `TickDispatch.Execute`
claims and dispatches the ready root → a fake `WorkerDispatcher.Dispatch`
immediately calls back `UpdateTaskStatusAndPromote` with `completed` →
assert the run auto-finalizes to `completed` in Postgres → assert the fake
`TaskServiceReporter.ReportResult` was called exactly once with
`success=true` and `MarkReported` set `reported_at`. This is the concrete
end-to-end proof that BUG-TASKV1-005's core finding ("the coordinator does
not autonomously advance a run") is closed.
