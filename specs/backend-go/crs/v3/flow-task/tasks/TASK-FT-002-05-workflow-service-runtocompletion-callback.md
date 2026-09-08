# TASK-FT-002-05: `workflow-service`'s `runToCompletion` reports back to `task-service` via `ReportTaskExecutionResult`

**From Solution:** BE-SOL-002
**Priority:** P0
**Service:** `workflow-service`
**File:** `backend-go/services/workflow-service/internal/usecase/execute.go` (`ExecuteInput`, `runToCompletion`), `backend-go/services/workflow-service/internal/usecase/ports.go` (new `TaskClient` port), `backend-go/services/workflow-service/internal/adapter/taskclient/` (new), `backend-go/services/workflow-service/cmd/server/main.go` (dial `task-service`), `backend-go/services/workflow-service/internal/config/config.go` (new `TaskServiceAddr`), `backend-go/services/workflow-service/internal/adapter/grpc/server.go` (`ExecuteInput.OriginTaskID` wiring)
**Depends on:** TASK-FT-002-01 (proto), TASK-FT-002-02 (`OriginTaskID` on `WorkflowExecution`/`ExecuteInput`), TASK-FT-002-04 (`ReportTaskExecutionResult` this calls)
**Status:** `[ ]` TODO

---

## Context

Verified against the real, current `execute.go` (confirmed by reading the
file directly): `runToCompletion` is exactly `execute.go:132-142`:

```go
func (uc *Execute) runToCompletion(ctx context.Context, exec domain.WorkflowExecution, waves [][]domain.Step) {
	succeeded := uc.dispatcher.dispatchWaves(ctx, exec.ID, waves)

	exec.Status = domain.StatusCompleted
	if !succeeded {
		exec.Status = domain.StatusFailed
	}
	if err := uc.executions.UpdateExecution(ctx, exec); err != nil {
		slog.ErrorContext(ctx, "workflow: persisting final execution status failed", slog.String("execution_id", exec.ID), slog.String("status", string(exec.Status)), slog.Any("error", err))
	}
}
```

`Execute` itself (`execute.go:70-126`) confirms the async dispatch this
solution relies on is real, current behavior — not an assumption: it
persists the execution row, then `go uc.runToCompletion(dispatchCtx, exec,
waves)` (`execute.go:123`) and returns immediately.

This creates a new outbound dependency: `workflow-service` calling
`task-service`, an edge not previously drawn in
`02-microservices-decomposition.md`'s dependency graph for this direction
(`workflow-service.md:278-285`'s §7 lists only `ts --> wf`, "Called by
task-service" — `wf --> ts` is new). This task adds the edge in code;
updating the architecture doc set to catch up is flagged, not resolved
here.

## Changes to make

**1. `internal/usecase/ports.go`** — new port:

```go
// TaskClient is workflow-service's first outbound dependency on
// task-service — see this file's doc comment / BE-SOL-002's Context for
// why this edge is new. Used only by runToCompletion's Engine-3 callback.
type TaskClient interface {
	ReportTaskExecutionResult(ctx context.Context, in ReportTaskExecutionResultInput) error
}

type ReportTaskExecutionResultInput struct {
	TaskID       string
	ExecutionRef string
	Success      bool
	ActualHours  float64
	ErrorMessage string
	Engine       string
}
```

**2. New `internal/adapter/taskclient/report_execution_result.go`** —
same convention as `internal/adapter/infrafleetclient`'s existing dial
pattern in this service:

```go
package taskclient

import (
	"context"
	"fmt"

	taskv1 "github.com/stablyai/orca-go/proto/gen/go/orca/task/v1"
	"github.com/stablyai/orca-go/services/workflow-service/internal/usecase"
)

type Client struct {
	task taskv1.TaskServiceClient
}

func New(task taskv1.TaskServiceClient) *Client {
	return &Client{task: task}
}

func (c *Client) ReportTaskExecutionResult(ctx context.Context, in usecase.ReportTaskExecutionResultInput) error {
	_, err := c.task.ReportTaskExecutionResult(ctx, &taskv1.ReportTaskExecutionResultRequest{
		TaskId: in.TaskID, ExecutionRef: in.ExecutionRef, Success: in.Success,
		ActualHours: in.ActualHours, ErrorMessage: in.ErrorMessage, Engine: in.Engine,
	})
	if err != nil {
		return fmt.Errorf("taskclient: report execution result: %w", err)
	}
	return nil
}
```

**3. `internal/usecase/execute.go`** — extend `ExecuteInput` (confirmed
current shape, `execute.go:19-24`: `TemplateID`, `ProjectID`,
`RootTraceID`, `RequestID`) and `Execute`/`runToCompletion`:

```go
type ExecuteInput struct {
	TemplateID   string
	ProjectID    string
	RootTraceID  string
	RequestID    string
	OriginTaskID string // NEW (BE-SOL-002) — threaded from ExecuteRequest.origin_task_id (TASK-FT-002-01)
}

type Execute struct {
	templates      TemplateRepository
	executions     ExecutionRepository
	stepExecutions StepExecutionRepository
	dispatcher     *waveDispatcher
	taskClient     TaskClient // NEW
}

func NewExecute(templates TemplateRepository, executions ExecutionRepository, stepExecutions StepExecutionRepository, registry StepExecutorRegistry, taskClient TaskClient) *Execute {
	return &Execute{
		templates: templates, executions: executions, stepExecutions: stepExecutions,
		dispatcher: newWaveDispatcher(stepExecutions, registry, defaultMaxConcurrentSteps),
		taskClient: taskClient,
	}
}
```

`Execute`'s body (`execute.go:70-126`) passes `in.OriginTaskID` through to
`domain.NewWorkflowExecution` (TASK-FT-002-02's widened constructor,
`execute.go:109`):

```go
exec, err := domain.NewWorkflowExecution(uuid.NewString(), tenantID, tmpl.ID, rootTraceID, in.ProjectID, in.OriginTaskID)
```

`runToCompletion` extended, additively, with one step after
`UpdateExecution` succeeds:

```go
func (uc *Execute) runToCompletion(ctx context.Context, exec domain.WorkflowExecution, waves [][]domain.Step) {
	succeeded := uc.dispatcher.dispatchWaves(ctx, exec.ID, waves)

	exec.Status = domain.StatusCompleted
	if !succeeded {
		exec.Status = domain.StatusFailed
	}
	if err := uc.executions.UpdateExecution(ctx, exec); err != nil {
		slog.ErrorContext(ctx, "workflow: persisting final execution status failed", slog.String("execution_id", exec.ID), slog.String("status", string(exec.Status)), slog.Any("error", err))
		return // do not call back with a result that was never durably persisted
	}
	if exec.OriginTaskID == "" {
		return // standalone workflow run — no task-service caller to report back to
	}
	if err := uc.taskClient.ReportTaskExecutionResult(ctx, ReportTaskExecutionResultInput{
		TaskID: exec.OriginTaskID, ExecutionRef: exec.ID,
		Success: exec.Status == domain.StatusCompleted, Engine: "workflow",
	}); err != nil {
		// Best-effort, same posture as the UpdateExecution error handling
		// one line above — a failed callback must not crash the background
		// goroutine or retry inline; task-service's task stays in_progress
		// until a later mechanism (e.g. a reconciliation scan) catches the
		// mismatch. Not designed further here — an honest, flagged gap,
		// the same category SOL-TG-04 already flags for its own Engine 2
		// callback failure mode.
		slog.ErrorContext(ctx, "workflow: reporting execution result to task-service failed", slog.String("execution_id", exec.ID), slog.Any("error", err))
	}
}
```

`actual_hours` is not computed by this callback — left as `0` for the
workflow path, since `domain.WorkflowExecution` has no `StartedAt` field
exposed to this call site today. Flagged, not solved (the CR does not
name this as an acceptance criterion).

Also check `recover_executions.go`'s boot-time recovery path (its own
`UpdateExecution` call site, separate from `runToCompletion`) — decide,
and document the decision in this task's PR, whether a recovered
execution's terminal transition should also trigger this same callback.
The honest answer is probably yes (a downstream `task-service` that
missed the original event because this process crashed mid-run still
needs to learn the execution finished), but this task's minimum scope is
`runToCompletion` only — extending `recover_executions.go` identically is
a one-line-different follow-up, not blocking this task.

**4. `cmd/server/main.go`** — dial `task-service`:

```go
taskConn, err := grpc.NewClient(cfg.TaskServiceAddr, grpc.WithTransportCredentials(insecure.NewCredentials()))
if err != nil {
	return fmt.Errorf("dialing task-service: %w", err)
}
defer func() { _ = taskConn.Close() }()
taskClient := taskclient.New(taskv1.NewTaskServiceClient(taskConn))
```

```go
executeUC := usecase.NewExecute(repo, repo, repo, registry, taskClient)
```

Confirm whether this service already has a shared `Dial` helper
equivalent to `task-service`'s `grpcclient.Dial` before inlining
`grpc.NewClient` directly — `infrafleetclient.Dial` (used at
`main.go:81`) is the existing precedent in this service; reuse it (move it
to a shared location, or add an equivalent one-liner in
`internal/adapter/taskclient`) rather than duplicating the insecure-dial
boilerplate a third way.

**5. `internal/config/config.go`** — add `TaskServiceAddr string`,
same convention as the existing `InfraFleetServiceAddr` field
(`config.go:20-24`).

**6. `internal/adapter/grpc/server.go`** — thread `OriginTaskId` from the
inbound `ExecuteRequest` (TASK-FT-002-01) into `ExecuteInput`:

```go
uc.executeUC.Execute(ctx, usecase.ExecuteInput{
	TemplateID: req.GetTemplateId(), ProjectID: req.GetProjectId(),
	RootTraceID: req.GetRootTraceId(), RequestID: req.GetRequestId(),
	OriginTaskID: req.GetOriginTaskId(),
})
```

## Verify

```bash
cd /opt/repos/orca/backend-go
go build ./...
go test ./services/workflow-service/internal/usecase/... -run TestExecute -v
```

Expected: clean build; extends the existing `runToCompletion` test
coverage (the file already exercises this function per
`execute_test.go`'s `blockingExecutor.Execute` fixture) — an execution
with `OriginTaskID` set calls `TaskClient.ReportTaskExecutionResult`
exactly once on completion (success and failure both covered); an
execution with `OriginTaskID == ""` (a standalone workflow run) calls it
zero times — the CR's explicit regression guard ("does not break the
existing behavior of Workflow Orchestration standing alone").
