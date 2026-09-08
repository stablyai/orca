# TASK-FT-001-02: `ExecutionEngine` domain type + `selectEngine()` replacing `isComplex`

**From Solution:** BE-SOL-001
**Priority:** P0
**Service:** `task-service`
**File:** `backend-go/services/task-service/internal/domain/execution_engine.go` (new), `backend-go/services/task-service/internal/domain/task.go` (extend `Task`), `backend-go/services/task-service/internal/usecase/execute_task.go` (`isComplex` → `selectEngine`)
**Depends on:** TASK-FT-001-01 (`workflow_template_id` column this reads)
**Status:** `[ ]` TODO

---

## Context

Verified against the real, current code
(`backend-go/services/task-service/internal/usecase/execute_task.go:78-94`):

```go
// isComplex implements task-service.md §3.1's branch: "a complex task has
// subtasks and/or dependency edges."
func (uc *ExecuteTask) isComplex(ctx context.Context, tenantID, taskID string) (bool, error) {
	children, err := uc.edges.ListFrom(ctx, tenantID, taskID, domain.EdgeKindParentChild)
	if err != nil {
		return false, err
	}
	if len(children) > 0 {
		return true, nil
	}
	deps, err := uc.edges.ListFrom(ctx, tenantID, taskID, domain.EdgeKindDependsOn)
	if err != nil {
		return false, err
	}
	return len(deps) > 0, nil
}
```

called from `Execute` at `execute_task.go:61-71`, which dispatches to
`uc.complex.Execute(...)` or `uc.simple.Execute(...)` — both currently
4-arg ports, `Execute(ctx, tenantID, taskID, requestID string)
(executionRef string, err error)`
(`internal/usecase/ports.go:119-121`, `:129-131`).

**Grounding correction versus the CR's own illustrative code**
(`CR-FLOW-TASK-001.md:94-104`): the CR's `selectEngine` sketch takes a
`domain.Task` and calls `uc.edges.HasChildren(ctx, task.ID)`. Neither a
`HasChildren` method (the real `EdgeRepository` port only exposes
`ListFrom`, confirmed at `ports.go:53-70`) nor a `WorkflowTemplateID` field
on `domain.Task` exist yet (current `Task` struct, confirmed at
`domain/task.go:52-69`: `ID`, `TenantID`, `Title`, `Status`, `ParentID`,
`ProjectID` only). This task writes `selectEngine` against the **real**
port shape (two `ListFrom` calls, exactly as `isComplex` already does) and
adds `WorkflowTemplateID` as a plain domain field backed by
TASK-FT-001-01's `workflow_template_id` column.

## Changes to make

**1. New file `backend-go/services/task-service/internal/domain/execution_engine.go`:**

```go
package domain

// ExecutionEngine names which of the three dispatch targets ExecuteTask
// selected for one Execute call — see task-service.md §3.1 and
// CR-FLOW-TASK-001. This is a naming/bookkeeping addition only: it does not
// change SimpleExecutor/ComplexExecutor's existing behavior (execute_task.go
// still calls them the same way), and Engine 3 (EngineWorkflow) has no
// executor at all until BE-SOL-002 builds WorkflowExecutor.
type ExecutionEngine string

const (
	EngineDirectAgent   ExecutionEngine = "direct_agent"  // Engine 1 — SimpleExecutor, real (TASK-224)
	EngineOrchestration ExecutionEngine = "orchestration" // Engine 2 — ComplexExecutor, still StubComplexExecutor (SOL-TG-04 not yet implemented)
	EngineWorkflow      ExecutionEngine = "workflow"       // Engine 3 — no executor exists yet, see BE-SOL-002
)
```

**2. `internal/domain/task.go`** — add `WorkflowTemplateID` to `Task`
(alongside the existing `ID`/`TenantID`/`Title`/`Status`/`ParentID`/
`ProjectID` fields at `task.go:52-69`):

```go
type Task struct {
	ID       string
	TenantID string
	Title    string
	Status   string
	ParentID string
	ProjectID string
	// WorkflowTemplateID, when set, routes ExecuteTask's dispatch to Engine
	// 3 (EngineWorkflow) ahead of the subtask/dependency check — see
	// selectEngine's priority rule below. Empty means "no workflow engine
	// selected", the same default every existing task effectively has
	// today. Backed by task.tasks.workflow_template_id (TASK-FT-001-01).
	WorkflowTemplateID string
}
```

Widen `NewTask`'s constructor / `internal/adapter/postgres`'s
`taskColumns`/`scanTask`/`Update` (wherever `ProjectID` is currently
read/written — the same repository file `TASK-FT-001-01`'s migration
extends) to also read/write `workflow_template_id`. `NewTask` itself does
not need a new required parameter — `WorkflowTemplateID` defaults to `""`
and is set via the same `Update`/`Get` round trip other optional fields
use, not via `NewTask`'s constructor signature, since no create-time RPC
sets it yet.

**3. `internal/usecase/execute_task.go`** — replace `isComplex` with
`selectEngine`, same call site, additive-only change to the branch's
output type:

```go
// selectEngine implements task-service.md §3.1's three-way dispatch
// branch (CR-FLOW-TASK-001) — same two ListFrom calls isComplex already
// made, only the return type and the new priority check are new.
func (uc *ExecuteTask) selectEngine(ctx context.Context, tenantID string, task domain.Task) (domain.ExecutionEngine, error) {
	// Priority: an explicitly-set workflow_template_id always wins over the
	// automatic subtree/dependency check below — CR-FLOW-TASK-001's own
	// stated rule (avoid ambiguity when a task has both a subtask and an
	// attached workflow).
	if task.WorkflowTemplateID != "" {
		return domain.EngineWorkflow, nil
	}

	children, err := uc.edges.ListFrom(ctx, tenantID, task.ID, domain.EdgeKindParentChild)
	if err != nil {
		return "", err
	}
	if len(children) > 0 {
		return domain.EngineOrchestration, nil
	}
	deps, err := uc.edges.ListFrom(ctx, tenantID, task.ID, domain.EdgeKindDependsOn)
	if err != nil {
		return "", err
	}
	if len(deps) > 0 {
		return domain.EngineOrchestration, nil
	}
	return domain.EngineDirectAgent, nil
}
```

`Execute` (`execute_task.go:48-76`) changes from calling `uc.isComplex(ctx,
tenantID, in.TaskID)` (a bare task ID) to first loading the task —
`selectEngine` needs the whole `domain.Task` to read `WorkflowTemplateID`,
which `isComplex`'s ID-only signature never needed. Load it via
`uc.repo.Get(ctx, tenantID, in.TaskID)` (already on `TaskRepository`,
`ports.go:19`) before calling `selectEngine`, and switch on the three
`ExecutionEngine` values instead of the current `if complex { ... } else {
... }` two-way branch. **The Engine 3 (`EngineWorkflow`) dispatch call
itself is BE-SOL-002's scope (TASK-FT-002-03), not this task's** — for
now, leave `EngineWorkflow`'s dispatch branch calling `uc.complex.Execute`
as a placeholder (so the build still compiles and existing behavior for
Engine 1/2 is unchanged) with a `// TODO(BE-SOL-002/TASK-FT-002-03):
dispatch via WorkflowExecutor once it exists` comment — do not invent a
different placeholder behavior.

## Verify

```bash
cd /opt/repos/orca/backend-go
go build ./services/task-service/...
go vet ./services/task-service/...
```

Expected: clean build. This task does not yet add new test cases (that is
TASK-FT-001-04) — but must not break the existing `isComplex`-derived
tests in `execute_task_test.go` at the type level (they will need
mechanical updates in TASK-FT-001-04 to assert on `ExecutionEngine` values
instead of a bare `bool`; do not silently change their assertions here).
