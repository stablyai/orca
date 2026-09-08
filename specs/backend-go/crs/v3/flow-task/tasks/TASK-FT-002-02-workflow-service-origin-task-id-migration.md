# TASK-FT-002-02: Migration — `workflow.executions.origin_task_id` + `domain.WorkflowExecution.OriginTaskID`

**From Solution:** BE-SOL-002
**Priority:** P0
**Service:** `workflow-service`
**File:** `backend-go/services/workflow-service/migrations/0007_origin_task_id.up.sql` (new), `backend-go/services/workflow-service/migrations/0007_origin_task_id.down.sql` (new), `backend-go/services/workflow-service/internal/domain/execution.go` (extend), `backend-go/services/workflow-service/internal/adapter/postgres/repository.go` (widen `executions` read/write columns)
**Depends on:** TASK-FT-002-01 (`origin_task_id` proto field this column backs)
**Status:** `[ ]` TODO

---

## Context

Verified against the real, current migrations directory: `0001` through
`0006_template_version` exist, so `0007` is the genuinely next-free
number — confirmed by `ls
backend-go/services/workflow-service/migrations/`. Re-check this at
implementation time in case another task has claimed `0007` first.

## Changes to make

`backend-go/services/workflow-service/migrations/0007_origin_task_id.up.sql`:

```sql
ALTER TABLE workflow.executions ADD COLUMN origin_task_id TEXT NOT NULL DEFAULT '';
```

`backend-go/services/workflow-service/migrations/0007_origin_task_id.down.sql`:

```sql
ALTER TABLE workflow.executions DROP COLUMN origin_task_id;
```

`NOT NULL DEFAULT ''` (not nullable) matches this solution's "empty =
standalone workflow run" convention (`runToCompletion`'s later check is
`if exec.OriginTaskID != ""`, TASK-FT-002-05) and needs no backfill
migration for existing rows.

`internal/domain/execution.go` — verified against the real, current
struct (`execution.go:55-63`: `ID`, `TenantID`, `TemplateID`, `Status`,
`RootTraceID`, `PausedAt`, `ProjectID`) — add `OriginTaskID` and widen
`NewWorkflowExecution`'s constructor (the real call site is
`execute.go:109`: `domain.NewWorkflowExecution(uuid.NewString(),
tenantID, tmpl.ID, rootTraceID, in.ProjectID)` — this task widens that
signature to also accept `originTaskID string`, defaulting to `""` for
any existing caller that doesn't pass one yet):

```go
type WorkflowExecution struct {
	ID           string
	TenantID     string
	TemplateID   string
	Status       Status
	RootTraceID  string
	PausedAt     *time.Time
	ProjectID    string
	OriginTaskID string // NEW (BE-SOL-002) — logical FK to task-service.Task.id, empty for a standalone run
}

func NewWorkflowExecution(id, tenantID, templateID, rootTraceID, projectID, originTaskID string) (WorkflowExecution, error) {
	if tenantID == "" {
		return WorkflowExecution{}, ErrExecutionEmptyTenant
	}
	if templateID == "" {
		return WorkflowExecution{}, ErrExecutionEmptyTemplate
	}
	return WorkflowExecution{
		ID: id, TenantID: tenantID, TemplateID: templateID, Status: StatusRunning,
		RootTraceID: rootTraceID, ProjectID: projectID, OriginTaskID: originTaskID,
	}, nil
}
```

Update `execute.go:109`'s call site and `ExecuteInput`
(`execute.go:19-24`) to carry `OriginTaskID` through from
`ExecuteRequest.origin_task_id` (TASK-FT-002-01) — this task only adds the
domain/DB plumbing; wiring `ExecuteInput.OriginTaskID` from the gRPC
adapter and using it in `runToCompletion`'s callback is TASK-FT-002-05's
scope.

Widen `internal/adapter/postgres/repository.go`'s `CreateExecution`/
`GetExecution`/`UpdateExecution`/`ListRunning` column lists (wherever
`project_id` is currently read/written for `workflow.executions`, per
`ExecuteInput`'s doc comment citing `usecase.HasActiveExecutions`) to
also read/write `origin_task_id`. Confirm the exact column list at
implementation time against the real `repository.go` — do not guess the
SQL text without reading it first.

## Verify

```bash
cd /opt/repos/orca/backend-go
go build ./services/workflow-service/...
go test ./services/workflow-service/internal/adapter/postgres/... -run TestRepository -v
```

Expected: migration applies cleanly on top of `0001`-`0006`; a
`CreateExecution` call with a non-empty `OriginTaskID` round-trips through
`GetExecution` unchanged; an execution created before this migration
(or via a caller that never sets it) reads back `OriginTaskID == ""`, not
NULL/an error.
