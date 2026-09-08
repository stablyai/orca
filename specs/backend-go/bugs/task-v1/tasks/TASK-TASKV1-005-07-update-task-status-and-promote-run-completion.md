# TASK-TASKV1-005-07: Extend `UpdateStatusAndPromote`'s transaction to detect run completion and report it to `task-service`

**From Solution:** SOL-TASKV1-005
**Priority:** P1
**Service:** `orchestration-service` (`internal/adapter/postgres` + `internal/usecase`)
**File:** `backend-go/services/orchestration-service/internal/adapter/postgres/repository.go` (extend `UpdateStatusAndPromote`), `backend-go/services/orchestration-service/internal/usecase/update_task_status_and_promote.go` (extend)
**Depends on:** TASK-TASKV1-005-01 (migration), TASK-TASKV1-005-04 (`TaskServiceReporter` port, `CoordinatorRunRepository.MarkReported`)
**Status:** `[ ]` TODO

---

## Context

This is the piece that turns "promotion happens when asked" into "the run
finishes itself" — the actual autonomy gap BUG-TASKV1-005 names. Read in
full: `UpdateStatusAndPromote` (`repository.go:99-135`) today ends its
transaction right after `promoteReadySiblings` — nothing checks whether the
just-updated task was the LAST non-terminal task in its
`coordinator_run_id`. This task folds that check into the SAME atomic
transaction (per §8's reasoning for the promote saga itself: a torn read
between "promotion committed" and "check if the run is now done" could
leave a fully-completed run stuck `running` forever if the process crashes
between the two steps), then extends the usecase layer to report the
run's terminal state to `task-service` **after** the transaction commits
(a cross-service gRPC call must never hold a DB transaction open, per
`05-data-architecture.md`'s no-cross-service-call-in-txn rule).

## Changes to make

### Repository: `UpdateStatusAndPromote`'s new tail

In `backend-go/services/orchestration-service/internal/adapter/postgres/repository.go`,
change `UpdateStatusAndPromote`'s signature and insert new logic before its
`COMMIT` (i.e. before the `if err := tx.Commit(ctx); err != nil` line at
what is currently line ~132):

```go
// UpdateStatusAndPromoteResult adds RunFinalized to the existing
// (task, promotedIDs) return shape — a *domain.RunFinalization is non-nil
// only when this call's status write made it the LAST non-terminal task
// in its coordinator_run_id, i.e. the run just finished.
type UpdateStatusAndPromoteResult struct {
	Task         domain.OrchestrationTask
	PromotedIDs  []string
	RunFinalized *RunFinalization
}

// RunFinalization carries what the usecase layer needs to call
// TaskServiceReporter.ReportResult — deliberately NOT domain.CoordinatorRun
// itself (this tail only knows the run id, its origin_task_id, and whether
// it succeeded — it does not re-fetch the full run row inside the same
// transaction, avoiding an extra round-trip for data the reporter call
// doesn't need).
type RunFinalization struct {
	CoordinatorRunID string
	OriginTaskID     string
	Success          bool
}

func (r *Repository) UpdateStatusAndPromote(ctx context.Context, tenantID, taskID string, newStatus domain.TaskStatus) (UpdateStatusAndPromoteResult, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return UpdateStatusAndPromoteResult{}, fmt.Errorf("postgres: begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// ... existing update + scanTask + promoteReadySiblings body unchanged,
	// producing `task` and `promotedIDs` exactly as today ...

	var finalized *RunFinalization
	// Only a completed/failed leaf transition can possibly finish a run —
	// skip the extra query on every other status write (ready/dispatched/
	// blocked transitions can never be the LAST event of a run).
	if newStatus == domain.TaskStatusCompleted || newStatus == domain.TaskStatusFailed {
		var nonTerminal int
		if err := tx.QueryRow(ctx, `
			SELECT count(*) FROM orchestration.orchestration_tasks
			WHERE coordinator_run_id = $1 AND tenant_id = $2
			  AND status NOT IN ('completed', 'failed')`,
			task.CoordinatorRunID, tenantID).Scan(&nonTerminal); err != nil {
			return UpdateStatusAndPromoteResult{}, fmt.Errorf("postgres: count non-terminal: %w", err)
		}
		if nonTerminal == 0 {
			// Every sibling in this run is now terminal. A single failed
			// leaf fails the WHOLE run (fail-closed: a partially-succeeded
			// multi-agent DAG is not a usable result for task-service's
			// ReportTaskExecutionResult, which only accepts success/
			// failure, not partial).
			var anyFailed bool
			if err := tx.QueryRow(ctx, `
				SELECT exists(SELECT 1 FROM orchestration.orchestration_tasks
					WHERE coordinator_run_id = $1 AND tenant_id = $2 AND status = 'failed')`,
				task.CoordinatorRunID, tenantID).Scan(&anyFailed); err != nil {
				return UpdateStatusAndPromoteResult{}, fmt.Errorf("postgres: check any-failed: %w", err)
			}
			runStatus := "completed"
			if anyFailed {
				runStatus = "failed"
			}
			var originTaskID string
			err := tx.QueryRow(ctx, `
				UPDATE orchestration.coordinator_runs SET status = $1, completed_at = now()
				WHERE id = $2 AND tenant_id = $3 AND status = 'running'
				RETURNING origin_task_id`,
				runStatus, task.CoordinatorRunID, tenantID).Scan(&originTaskID)
			switch {
			case errors.Is(err, pgx.ErrNoRows):
				// The run was already completed/failed by a racing
				// concurrent call (or is not 'running' for some other
				// reason) — do not double-finalize, do not error the
				// whole transaction, just skip setting `finalized`.
			case err != nil:
				return UpdateStatusAndPromoteResult{}, fmt.Errorf("postgres: finalize run: %w", err)
			default:
				finalized = &RunFinalization{
					CoordinatorRunID: task.CoordinatorRunID,
					OriginTaskID:     originTaskID,
					Success:          !anyFailed,
				}
			}
			// Reporting to task-service happens OUTSIDE this transaction
			// (see the usecase layer change below) — a cross-service gRPC
			// call must never hold a DB transaction open.
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return UpdateStatusAndPromoteResult{}, fmt.Errorf("postgres: commit tx: %w", err)
	}
	return UpdateStatusAndPromoteResult{Task: task, PromotedIDs: promotedIDs, RunFinalized: finalized}, nil
}
```

Update the `OrchestrationTaskRepository.UpdateStatusAndPromote` port
signature in `ports.go` (from `TASK-TASKV1-005-04`) to return
`(postgres.UpdateStatusAndPromoteResult, error)` — since `postgres` cannot
be imported from `usecase` (dependency-inversion direction), move
`UpdateStatusAndPromoteResult`/`RunFinalization` into the `usecase` package
itself (`ports.go`, alongside the interface) instead of `postgres`, and
have `internal/adapter/postgres` construct `usecase.UpdateStatusAndPromoteResult`/
`usecase.RunFinalization` values. Adjust the code above accordingly:
`import "github.com/stablyai/orca-go/services/orchestration-service/internal/usecase"`
in `repository.go` already exists (used for its sentinel errors), so this
adds no new import.

### Usecase: report the finalized run after commit

In `backend-go/services/orchestration-service/internal/usecase/update_task_status_and_promote.go`,
add a `reporter TaskServiceReporter` field and a `markReported CoordinatorRunRepository`
dependency (reuses the same `CoordinatorRunRepository` the lifecycle
usecases already depend on — `MarkReported`, from `TASK-TASKV1-005-04`):

```go
type UpdateTaskStatusAndPromote struct {
	repo         OrchestrationTaskRepository
	serializer   HandleSerializer
	reporter     TaskServiceReporter
	runs         CoordinatorRunRepository // only for MarkReported after a successful report
}

func NewUpdateTaskStatusAndPromote(repo OrchestrationTaskRepository, serializer HandleSerializer, reporter TaskServiceReporter, runs CoordinatorRunRepository) *UpdateTaskStatusAndPromote {
	return &UpdateTaskStatusAndPromote{repo: repo, serializer: serializer, reporter: reporter, runs: runs}
}
```

Change `UpdateTaskStatusAndPromoteOutput` and `Execute`'s tail:

```go
type UpdateTaskStatusAndPromoteOutput struct {
	Task            domain.OrchestrationTask
	PromotedTaskIDs []string
}

func (uc *UpdateTaskStatusAndPromote) Execute(ctx context.Context, in UpdateTaskStatusAndPromoteInput) (UpdateTaskStatusAndPromoteOutput, error) {
	// ... tenant/empty-id/status validation unchanged ...

	var result UpdateStatusAndPromoteResult
	err = uc.serializer.Do(ctx, in.OrchestrationTaskID, func() error {
		r, err := uc.repo.UpdateStatusAndPromote(ctx, tenantID, in.OrchestrationTaskID, newStatus)
		if err != nil {
			return err
		}
		result = r
		return nil
	})
	if err != nil {
		if errors.Is(err, ErrTaskNotFound) {
			return UpdateTaskStatusAndPromoteOutput{}, apperrors.New(apperrors.KindNotFound, "ORCH_TASK_NOT_FOUND", "orchestration task not found", err)
		}
		return UpdateTaskStatusAndPromoteOutput{}, apperrors.New(apperrors.KindInternal, "ORCH_UPDATE_TASK_STATUS_FAILED", "failed to update task status and promote", err)
	}

	// Reporting happens AFTER the transaction has committed — per
	// ReportTaskExecutionResult's own idempotence note (SOL-TG-04:
	// "ignored, not an error... at-least-once consumer idempotence"), a
	// reporter-call failure here is logged and left for the tick loop's
	// retry pass (TASK-TASKV1-005-10, ListUnreportedTerminal) rather than
	// failing this whole RPC — the task-status write itself already
	// committed successfully and must not be rolled back by a downstream
	// notification failure.
	if result.RunFinalized != nil {
		f := result.RunFinalized
		if err := uc.reporter.ReportResult(ctx, f.OriginTaskID, f.CoordinatorRunID, f.Success, ""); err != nil {
			slog.Error("report coordinator run result failed, will retry via tick loop",
				slog.String("coordinator_run_id", f.CoordinatorRunID), slog.Any("error", err))
		} else if err := uc.runs.MarkReported(ctx, tenantID, f.CoordinatorRunID); err != nil {
			slog.Error("mark coordinator run reported failed", slog.String("coordinator_run_id", f.CoordinatorRunID), slog.Any("error", err))
		}
	}

	return UpdateTaskStatusAndPromoteOutput{Task: result.Task, PromotedTaskIDs: result.PromotedIDs}, nil
}
```

Add `"log/slog"` to this file's imports.

Update the `NewUpdateTaskStatusAndPromote(...)` call site in
`cmd/server/main.go` (also touched by `TASK-TASKV1-005-09`) to pass the new
`reporter`/`runs` arguments.

## Verify

```bash
cd /opt/repos/orca/backend-go
go build ./services/orchestration-service/...
go test ./services/orchestration-service/internal/usecase/... -run TestUpdateTaskStatusAndPromote -v
go test ./services/orchestration-service/internal/adapter/postgres/... -run TestRepository_UpdateStatusAndPromote -v
```

Expected new cases (every existing case in both test files must still pass
unmodified — regression guard):
- Completing the LAST non-terminal task in a run triggers `RunFinalized`
  with `Success=true`, `ReportResult` called exactly once with
  `success=true`, and `MarkReported` called once on success.
- Completing a task while siblings remain `pending`/`ready`/`dispatched`
  does NOT trigger `RunFinalized` (no `ReportResult` call).
- A run where one task ends `failed` and all others `completed` finalizes
  the run as `failed` (`Success=false`), not `completed`.
- A `ReportResult` error is logged and swallowed (`Execute` still returns
  success for the task-status write itself) and `MarkReported` is NOT
  called in that case.
- Postgres-level: `UpdateStatusAndPromote`'s new tail correctly reads
  `coordinator_runs.origin_task_id` via the `RETURNING` clause and only
  transitions a run whose current status is `running` (a run already
  `completed`/`failed` from a racing concurrent call is not double-finalized
  — the `WHERE ... AND status = 'running'` guard's `RETURNING` returns zero
  rows in that case, which must not error the whole transaction, only skip
  setting `finalized`).
