# TASK-FT-002-04: `ReportTaskExecutionResult` usecase — shared inbound callback for Engine 2 and Engine 3

**From Solution:** BE-SOL-002 (generalizes SOL-TG-04's Engine-2-only design)
**Priority:** P0
**Service:** `task-service`
**File:** `backend-go/services/task-service/internal/usecase/report_execution_result.go` (new), `backend-go/services/task-service/internal/adapter/grpc/server.go` (new handler)
**Depends on:** TASK-FT-002-01 (proto), TASK-FT-001-01/03 (`execution_links` table this validates staleness against)
**Status:** `[ ]` TODO

---

## Context

**Reconciliation with a sibling, also-unimplemented task**: see
TASK-FT-002-01's Context section in full before writing this file —
[`TASK-TG-04-05`](../../../../bugs/logic-v1/tasks/TASK-TG-04-05-report-task-execution-result.md)
(SOL-TG-04) independently proposes a narrower, Engine-2-only version of
this exact usecase, comparing `coordinator_run_id` against a bare
`task.tasks.active_execution_id TEXT` column. This task implements the
generalized, engine-neutral version instead — comparing
`execution_ref`/`engine` against **TASK-FT-001-01's `execution_links`
table** (via `task.tasks.active_execution_link_id` →
`execution_links.external_ref_id`), not a bare column. If TASK-TG-04-05's
narrower version lands in the codebase first, this task's job becomes
**replacing** that file's body with the version below (same filename,
same RPC), not adding a second, competing usecase — confirm
`report_execution_result.go`'s current state before writing.

The staleness/idempotence guard follows the same shape SOL-TG-04 already
designed: a callback whose `execution_ref` doesn't match the task's
currently-active execution link is a no-op, not an error — at-least-once
consumer idempotence, per `05-data-architecture.md`'s outbox-consumer
convention.

**Security note** (carried over from TASK-TG-04-05, still applicable):
this RPC is called by `orchestration-service`/`workflow-service`, never a
browser/mobile client — `api-gateway` never routes to it. The handler
must validate the calling service's mesh identity via whatever
`common/grpcmw` interceptor already extracts service identity from mTLS
for other internal-only RPCs in this codebase — confirm the exact
interceptor at implementation time rather than guessing one.

## Changes to make

`backend-go/services/task-service/internal/usecase/report_execution_result.go`:

```go
package usecase

import (
	"context"

	"github.com/stablyai/orca-go/common/apperrors"
	"github.com/stablyai/orca-go/common/tenant"
	"github.com/stablyai/orca-go/services/task-service/internal/domain"
)

type ReportTaskExecutionResultInput struct {
	TaskID        string
	ExecutionRef  string
	Success       bool
	ActualHours   float64
	ErrorMessage  string
	Engine        string // "orchestration" | "workflow"
}

// ReportTaskExecutionResult is the shared inbound completion callback for
// Engine 2 (orchestration-service) and Engine 3 (workflow-service) — see
// TASK-FT-002-01's Context for why this generalizes SOL-TG-04's
// Engine-2-only design rather than adding a second RPC.
type ReportTaskExecutionResult struct {
	tasks TaskRepository
	links ExecutionLinkRepository
}

func NewReportTaskExecutionResult(tasks TaskRepository, links ExecutionLinkRepository) *ReportTaskExecutionResult {
	return &ReportTaskExecutionResult{tasks: tasks, links: links}
}

func (uc *ReportTaskExecutionResult) Execute(ctx context.Context, in ReportTaskExecutionResultInput) error {
	tenantID, err := tenant.RequireTenantID(ctx)
	if err != nil {
		return apperrors.New(apperrors.KindUnauthenticated, "TASK_NO_TENANT", "no tenant in request context", err)
	}
	task, err := uc.tasks.Get(ctx, tenantID, in.TaskID)
	if err != nil {
		return apperrors.New(apperrors.KindNotFound, "TASK_NOT_FOUND", "task not found", err)
	}
	if task.ActiveExecutionLinkID == "" {
		// No active link recorded at all — a callback arriving after the
		// task was already re-dispatched (its link cleared) or for a task
		// that never went through ExecuteTask. Ignored, not an error, same
		// idempotence posture as the staleness case below.
		return nil
	}
	link, err := uc.links.Get(ctx, tenantID, task.ActiveExecutionLinkID)
	if err != nil {
		return apperrors.New(apperrors.KindInternal, "TASK_EXECUTION_LINK_LOOKUP_FAILED", "failed to load active execution link", err)
	}
	if link.ExternalRefID != in.ExecutionRef || string(link.Engine) != in.Engine {
		// Stale/duplicate callback (retried delivery, or a callback for a
		// run this task was re-dispatched away from) — ignored, not an
		// error, per at-least-once consumer idempotence (same rule
		// SOL-TG-04 already established for Engine 2).
		return nil
	}

	status := "completed"
	if !in.Success {
		status = "failed"
	}
	if err := uc.links.Complete(ctx, tenantID, link.ID, status); err != nil {
		return apperrors.New(apperrors.KindInternal, "TASK_EXECUTION_LINK_COMPLETE_FAILED", "failed to complete execution link", err)
	}

	if in.Success {
		return uc.tasks.CompleteExecution(ctx, tenantID, in.TaskID, domain.StatusReview, in.ActualHours)
	}
	// Failed complex/workflow execution -> Blocked, not silently left
	// in_progress or auto-Done — same terminal-status choice SOL-TG-04
	// made for Engine 2's failure path.
	return uc.tasks.CompleteExecution(ctx, tenantID, in.TaskID, domain.StatusBlocked, in.ActualHours)
}
```

This assumes `ExecutionLinkRepository` gains a `Get(ctx, tenantID, id
string) (domain.ExecutionLink, error)` method beyond the
`Create`/`SetExternalRef`/`Complete` trio TASK-FT-001-03 defined — add it
to that port/adapter as part of this task (small, additive: a single
`SELECT ... WHERE id = $1 AND tenant_id = $2` in
`internal/adapter/postgres/execution_links.go`). This also assumes
`domain.Task` gains `ActiveExecutionLinkID string` (backed by
TASK-FT-001-01's `task.tasks.active_execution_link_id` column) and
`TaskRepository` gains a `CompleteExecution(ctx, tenantID, taskID string,
status string, actualHours float64) error` method — confirm neither
already exists under a different name (e.g. from a partially-landed
TASK-TG-04-01/-05) before adding a duplicate; if `CompleteExecution` (or
an equivalent) already exists from that series, reuse it rather than
adding a second status-completion path.

`domain.StatusReview`/`domain.StatusBlocked` do not exist in the current,
real `domain/task.go` (confirmed: today's four statuses are `StatusOpen`,
`StatusInProgress`, `StatusDone`, `StatusCancelled`, per
`domain/task.go:12-17`) — adding a richer status set is
`BUG-TASKV1-001`'s scope per that bug's own README entry, not this CR's.
**Do not add `StatusReview`/`StatusBlocked` as part of this task** —
either wait for `BUG-TASKV1-001` to land those statuses first, or (if it
hasn't) substitute the closest existing status this codebase already has
(`StatusDone` on success, and — since there is no "blocked" state yet —
leave the task in `StatusInProgress` on failure with a clearly logged
warning, flagged as an honest, temporary gap) rather than inventing new
status strings unilaterally in this task. Document whichever choice is
made in the PR description.

`internal/adapter/grpc/server.go` — add the handler:

```go
func (s *Server) ReportTaskExecutionResult(ctx context.Context, req *taskv1.ReportTaskExecutionResultRequest) (*emptypb.Empty, error) {
	// Service-identity check: this RPC must only be callable by
	// orchestration-service/workflow-service (mTLS mesh identity), never
	// api-gateway/a user session — confirm the exact common/grpcmw
	// interceptor call at implementation time; a placeholder guard is
	// intentionally NOT substituted here since asserting the wrong thing
	// would be worse than flagging it as an open wiring detail.
	if err := s.reportExecutionResult.Execute(ctx, usecase.ReportTaskExecutionResultInput{
		TaskID: req.GetTaskId(), ExecutionRef: req.GetExecutionRef(),
		Success: req.GetSuccess(), ActualHours: req.GetActualHours(),
		ErrorMessage: req.GetErrorMessage(), Engine: req.GetEngine(),
	}); err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &emptypb.Empty{}, nil
}
```

Wire `reportExecutionResult := usecase.NewReportTaskExecutionResult(repo,
repo)` in `cmd/server/main.go` and add it to `taskgrpc.New(...)`'s
argument list alongside the other usecases (`main.go:136-139`).

## Verify

```bash
cd /opt/repos/orca/backend-go
go build ./...
go test ./services/task-service/internal/usecase/... -run TestReportTaskExecutionResult -v
```

Expected: a callback whose `execution_ref`/`engine` doesn't match the
task's currently-active execution link is a silent no-op, not an error;
a callback for a task with no active link at all is also a silent no-op;
a matching, successful callback marks the link complete and transitions
the task per whichever status-substitution decision was documented above;
a matching, failed callback does the same with the failure status.
