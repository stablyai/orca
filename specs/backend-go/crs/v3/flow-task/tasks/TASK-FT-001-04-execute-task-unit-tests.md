# TASK-FT-001-04: Unit tests — `selectEngine` branches, `execution_links` writes, `ExecutionLink` repository round-trip

**From Solution:** BE-SOL-001
**Priority:** P0
**Service:** `task-service`
**File:** `backend-go/services/task-service/internal/usecase/execute_task_test.go` (extend), `backend-go/services/task-service/internal/usecase/fakes_test.go` (extend), `backend-go/services/task-service/internal/domain/execution_engine_test.go` (new), `backend-go/services/task-service/internal/adapter/postgres/execution_links_test.go` (new)
**Depends on:** TASK-FT-001-01, TASK-FT-001-02, TASK-FT-001-03
**Status:** `[ ]` TODO

---

## Context

Verified against the real, current test file
(`internal/usecase/execute_task_test.go:1-60`, `fakes_test.go:21-160,320-330`):
every existing `TestExecuteTask_*` case constructs `NewExecuteTask` with
**4** arguments (`repo, edges, simple, complex`) and asserts on a bare
`ref`/`called` bool via `fakeExecutor`. TASK-FT-001-03 changes
`NewExecuteTask` to take a 5th argument (`links
ExecutionLinkRepository`) — every existing call site in this test file
needs that argument added, and a new `fakeExecutionLinkRepository` needs
to exist in `fakes_test.go` for them to pass. CR-FLOW-TASK-001's own
acceptance criteria explicitly requires "no regression on existing tests"
— this task's job is exactly that: port every existing case forward
without changing which branch a given edge configuration selects.

## Changes to make

**1. `fakes_test.go`** — add a `fakeExecutionLinkRepository` next to the
existing `fakeTaskRepository`/`fakeEdgeRepository`/`fakeExecutor`:

```go
type fakeExecutionLinkRepository struct {
	created []domain.ExecutionLink
	nextID  int
}

func (f *fakeExecutionLinkRepository) Create(ctx context.Context, tenantID, taskID string, engine domain.ExecutionEngine, externalRefID string) (domain.ExecutionLink, error) {
	f.nextID++
	link := domain.ExecutionLink{ID: fmt.Sprintf("link-%d", f.nextID), TenantID: tenantID, TaskID: taskID, Engine: engine, ExternalRefID: externalRefID, StatusMirror: "in_progress"}
	f.created = append(f.created, link)
	return link, nil
}

func (f *fakeExecutionLinkRepository) SetExternalRef(ctx context.Context, tenantID, linkID, externalRefID string) error {
	for i := range f.created {
		if f.created[i].ID == linkID {
			f.created[i].ExternalRefID = externalRefID
		}
	}
	return nil
}

func (f *fakeExecutionLinkRepository) Complete(ctx context.Context, tenantID, linkID, statusMirror string) error {
	for i := range f.created {
		if f.created[i].ID == linkID {
			f.created[i].StatusMirror = statusMirror
		}
	}
	return nil
}
```

**2. `execute_task_test.go`** — mechanical update: add `links :=
&fakeExecutionLinkRepository{}` and pass it as `NewExecuteTask`'s 5th
argument in every existing test (`TestExecuteTask_RequiresTenantContext`,
`TestExecuteTask_SimplePath_NoSubtasksNoDependencies`,
`TestExecuteTask_ComplexPath_HasSubtasks`,
`TestExecuteTask_ComplexPath_HasDependencies`,
`TestExecuteTask_IgnoresEdgesToTheTaskWhenDecidingComplexity`,
`TestExecuteTask_ExecutorFailurePropagates`,
`TestExecuteTask_RequiresTaskID`,
`TestExecuteTask_MarksTaskInProgressBeforeDispatching`,
`TestExecuteTask_StatusUpdateFailurePropagatesAndSkipsDispatch` — the full
list confirmed present in the current file via codegraph). No existing
assertion's expected branch changes.

New cases, per BE-SOL-001's test plan:

```go
func TestExecuteTask_WorkflowTemplateID_TakesPriorityOverSubtasks(t *testing.T) {
	// Regression guard against the exact ambiguity CR-FLOW-TASK-001 calls
	// out: a task with BOTH a workflow_template_id AND child edges must
	// select EngineWorkflow, not EngineOrchestration.
	repo := newFakeTaskRepository()
	repo.tasks["task-1"] = domain.Task{ID: "task-1", TenantID: "tenant-1", WorkflowTemplateID: "wf-tmpl-1"}
	edges := &fakeEdgeRepository{edges: []domain.TaskEdge{
		{FromTaskID: "task-1", ToTaskID: "subtask-1", Kind: domain.EdgeKindParentChild},
	}}
	links := &fakeExecutionLinkRepository{}
	uc := NewExecuteTask(repo, edges, &fakeExecutor{}, &fakeExecutor{}, links)
	ctx := withIdentity(context.Background(), "tenant-1", "user-1")

	if _, err := uc.Execute(ctx, ExecuteTaskInput{TaskID: "task-1", RequestID: "req-1"}); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(links.created) != 1 || links.created[0].Engine != domain.EngineWorkflow {
		t.Fatalf("expected exactly one execution_links row with engine=workflow, got %+v", links.created)
	}
}

func TestExecuteTask_EveryEngineBranch_EnqueuesExactlyOneExecutionLink(t *testing.T) {
	cases := []struct {
		name           string
		edges          []domain.TaskEdge
		workflowTmplID string
		wantEngine     domain.ExecutionEngine
	}{
		{name: "no edges, no template -> direct_agent", wantEngine: domain.EngineDirectAgent},
		{name: "parent_child edge -> orchestration", edges: []domain.TaskEdge{{FromTaskID: "task-1", ToTaskID: "sub-1", Kind: domain.EdgeKindParentChild}}, wantEngine: domain.EngineOrchestration},
		{name: "depends_on edge -> orchestration", edges: []domain.TaskEdge{{FromTaskID: "task-1", ToTaskID: "dep-1", Kind: domain.EdgeKindDependsOn}}, wantEngine: domain.EngineOrchestration},
		{name: "workflow_template_id set -> workflow", workflowTmplID: "wf-1", wantEngine: domain.EngineWorkflow},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			repo := newFakeTaskRepository()
			repo.tasks["task-1"] = domain.Task{ID: "task-1", TenantID: "tenant-1", WorkflowTemplateID: tc.workflowTmplID}
			links := &fakeExecutionLinkRepository{}
			uc := NewExecuteTask(repo, &fakeEdgeRepository{edges: tc.edges}, &fakeExecutor{}, &fakeExecutor{}, links)
			ctx := withIdentity(context.Background(), "tenant-1", "user-1")

			if _, err := uc.Execute(ctx, ExecuteTaskInput{TaskID: "task-1", RequestID: "req-1"}); err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if len(links.created) != 1 {
				t.Fatalf("expected exactly one execution_links row, got %d", len(links.created))
			}
			if links.created[0].Engine != tc.wantEngine {
				t.Errorf("expected engine %q, got %q", tc.wantEngine, links.created[0].Engine)
			}
		})
	}
}
```

Confirm `fakeTaskRepository`'s internal field name for its in-memory task
map (`repo.tasks[...]` above is illustrative — match whatever the real
`fakeTaskRepository` struct at `fakes_test.go:21-41` actually calls it,
e.g. it may seed via a constructor argument instead of direct map access;
adjust the snippet's task-seeding line accordingly, don't invent a new
fake when a seeding mechanism already exists).

**3. New `internal/domain/execution_engine_test.go`:**

```go
package domain

import "testing"

func TestExecutionEngine_ConstantsAreDistinctAndNonEmpty(t *testing.T) {
	values := []ExecutionEngine{EngineDirectAgent, EngineOrchestration, EngineWorkflow}
	seen := make(map[ExecutionEngine]bool, len(values))
	for _, v := range values {
		if v == "" {
			t.Fatalf("ExecutionEngine constant must not be empty")
		}
		if seen[v] {
			t.Fatalf("duplicate ExecutionEngine value: %q", v)
		}
		seen[v] = true
	}
}
```

**4. New `internal/adapter/postgres/execution_links_test.go`** (integration,
testcontainers — same convention as `repository_test.go`):

```go
func TestExecutionLinks_CreateThenComplete_RoundTrips(t *testing.T) {
	// ... testcontainers setup identical to repository_test.go's pattern ...
	repo := New(pool)
	tenantID, taskID := seedTenantAndTask(t, pool) // reuse this file's existing seeding helpers

	link, err := repo.Create(ctx, tenantID, taskID, domain.EngineDirectAgent, "")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if err := repo.SetExternalRef(ctx, tenantID, link.ID, "ref-123"); err != nil {
		t.Fatalf("SetExternalRef: %v", err)
	}
	if err := repo.Complete(ctx, tenantID, link.ID, "completed"); err != nil {
		t.Fatalf("Complete: %v", err)
	}
	// Assert idx_execution_links_task ordering: run a second Create for the
	// same task and confirm a query ordered by (task_id, started_at DESC)
	// returns the most recent row first.
}
```

## Verify

```bash
cd /opt/repos/orca/backend-go
go build ./services/task-service/...
go test ./services/task-service/internal/domain/... -run TestExecutionEngine -v
go test ./services/task-service/internal/usecase/... -run TestExecuteTask -v
go test ./services/task-service/internal/adapter/postgres/... -run TestExecutionLinks -v
```

Expected: every pre-existing `TestExecuteTask_*` case still passes with no
change to which branch it selects (regression guard); the two new cases
above pass; `TestExecutionEngine_ConstantsAreDistinctAndNonEmpty` passes;
the postgres round-trip test passes against a live `task.execution_links`
table.
