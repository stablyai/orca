# BE-SOL-001: `ExecutionEngine` naming, `task.execution_links`, and `selectEngine()`

**Resolves:** [CR-FLOW-TASK-001](../../../../../docs/crs/v3/flow-task/CR-FLOW-TASK-001-three-engine-execution-architecture.md)
**Service:** `task-service` only (per the CR's own "Tác động" row — `orchestration-service`/`workflow-service` are not touched by this solution)
**Affected files (proposed):**
- `backend-go/services/task-service/internal/domain/execution_engine.go` (new)
- `backend-go/services/task-service/internal/domain/task.go` (extend `Task` with `WorkflowTemplateID`, `ActiveExecutionLinkID`)
- `backend-go/services/task-service/internal/usecase/execute_task.go` (`isComplex` → `selectEngine`)
- `backend-go/services/task-service/internal/usecase/ports.go` (`ExecutionLinkRepository`)
- `backend-go/services/task-service/internal/adapter/postgres/` (new repository for `execution_links`)
- `backend-go/services/task-service/migrations/0003_execution_links.{up,down}.sql` (new)
- `backend-go/services/task-service/internal/usecase/execute_task_test.go` (extend)
**Status:** 📋 Proposed — not yet implemented

---

## Design rationale (grounded in TDD + real code)

`task-service.md` §3.1 names the branch this CR formalizes: "a **simple**
task... relays directly to `infra-fleet-service`... a **complex** task...
hands off to `orchestration-service`'s coordinator... `task-service` records
a logical FK (`active_execution_id`)... it does not track live execution
state itself" (`task-service.md:76-85`).

Reading the actual current code confirms the CR's own claim that the branch
already exists and is real, not a stub:

```go
// backend-go/services/task-service/internal/usecase/execute_task.go:80-94
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
`uc.complex.Execute(...)` (`ports.go:123-129`'s `ComplexExecutor` — still
backed by `StubComplexExecutor`,
`internal/adapter/grpcclient/complex_executor.go:24-26`, exactly the stub
the CR cites) or `uc.simple.Execute(...)` (`ports.go:109-121`'s
`SimpleExecutor` — real, per `TASK-224`'s doc comment on that same port).
This solution's job, per the CR, is **naming** this existing decision and
adding the linkage table — not changing `isComplex`'s logic, not
implementing `ComplexExecutor` for real (that is
[SOL-TG-04](../../../../bugs/logic-v1/solutions/SOL-TG-04-task-agent-execution.md),
already designed, not repeated here).

**Important grounding correction versus the CR's illustrative code**: the
CR's `selectEngine` sketch (`CR-FLOW-TASK-001.md:94-104`) takes a
`domain.Task` and calls `uc.edges.HasChildren(ctx, task.ID)`. Neither
`domain.Task` (`domain/task.go:47-64`, current fields: `ID`, `TenantID`,
`Title`, `Status`, `ParentID`, `ProjectID` — no `WorkflowTemplateID` today)
nor a `HasChildren` method (the real `EdgeRepository` port only exposes
`ListFrom`, per `isComplex` above) exist yet. This solution's `selectEngine`
is therefore written against the **real** port shape (`ListFrom` twice,
exactly as `isComplex` already does), and `Task.WorkflowTemplateID` is
added here as a plain domain field — the CR's own field addition to
`task.proto` is [CR-FLOW-TASK-002](./BE-SOL-002-workflow-as-execution-engine.md)'s
job; this solution only adds the domain/DB plumbing `selectEngine` needs to
read it, so BE-SOL-001 does not block on BE-SOL-002's proto change landing
first (the field defaults to `""`, which `selectEngine` already treats as
"no workflow engine selected").

## Design — `ExecutionEngine` enum

```go
// backend-go/services/task-service/internal/domain/execution_engine.go (new)
package domain

// ExecutionEngine names which of the three dispatch targets ExecuteTask
// selected for one Execute call — see task-service.md §3.1 and
// CR-FLOW-TASK-001. This is a naming/bookkeeping addition only: it does not
// change SimpleExecutor/ComplexExecutor's existing behavior (execute_task.go
// still calls them the same way), and Engine 3 (EngineWorkflow) has no
// executor at all until CR-FLOW-TASK-002 builds WorkflowExecutor.
type ExecutionEngine string

const (
	EngineDirectAgent   ExecutionEngine = "direct_agent"  // Engine 1 — SimpleExecutor, real (TASK-224)
	EngineOrchestration ExecutionEngine = "orchestration" // Engine 2 — ComplexExecutor, still StubComplexExecutor (SOL-TG-04 not yet implemented)
	EngineWorkflow      ExecutionEngine = "workflow"       // Engine 3 — no executor exists yet, see CR-FLOW-TASK-002
)
```

## Design — `selectEngine()`, grounded in the real `EdgeRepository` port

```go
// internal/usecase/execute_task.go — replaces isComplex, same call site
// (execute_task.go:61), same signature shape, additive-only change to the
// branch's OUTPUT type (bool -> domain.ExecutionEngine), not its logic.
func (uc *ExecuteTask) selectEngine(ctx context.Context, tenantID string, task domain.Task) (domain.ExecutionEngine, error) {
	// Priority: an explicitly-set workflow_template_id always wins over the
	// automatic subtree/dependency check below — CR-FLOW-TASK-001's own
	// stated rule ("tránh nhập nhằng khi 1 task vừa có subtask vừa có
	// workflow gắn kèm", CR-FLOW-TASK-001.md:107-109).
	if task.WorkflowTemplateID != "" {
		return domain.EngineWorkflow, nil
	}

	// Unchanged logic from isComplex (execute_task.go:80-94) — same two
	// ListFrom calls, same edge kinds, only the return type changes.
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

`Execute` (`execute_task.go:48-76`) is updated to call `selectEngine`
instead of `isComplex`, switch on the three engine values instead of the
current `if complex { ... } else { ... }`, and — per the CR's acceptance
criteria — write one `execution_links` row per call, **including the
synchronous Engine 1 path** (needed so CR-FLOW-TASK-003's Activity Feed has
a history row for every execution, not just the async ones):

```go
link, err := uc.links.Create(ctx, tenantID, task.ID, engine, "" /* external_ref_id filled in after dispatch succeeds, Engine 1 has none */)
// ... dispatch via uc.simple/uc.complex/uc.workflow (Engine 3, BE-SOL-002) as today ...
_ = uc.links.Complete(ctx, tenantID, link.ID, "completed" /* or "failed" */)
```

This solution does **not** change `SimpleExecutor`/`ComplexExecutor`'s
dispatch calls themselves, matching the CR's explicit "Rủi ro" note
(`CR-FLOW-TASK-001.md:113-115`) — the status-revert-on-failure rework and
real `ComplexExecutor` body stay [SOL-TG-04](../../../../bugs/logic-v1/solutions/SOL-TG-04-task-agent-execution.md)'s
scope; this solution only wraps whatever `Execute` does today (and whatever
SOL-TG-04 later makes it do) with one `execution_links` write before and
after dispatch.

## Design — `task.execution_links` migration

Additive-only, following the current numbering
(`0001_init.up.sql`, `0002_task_project_execution_tracking.up.sql` are the
two migrations that exist today — this is `0003`):

```sql
-- backend-go/services/task-service/migrations/0003_execution_links.up.sql
CREATE TABLE task.execution_links (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         UUID NOT NULL,
    task_id           UUID NOT NULL REFERENCES task.tasks(id) ON DELETE CASCADE,
    engine            TEXT NOT NULL CHECK (engine IN ('direct_agent','orchestration','workflow')),
    external_ref_id   TEXT NOT NULL DEFAULT '', -- coordinator_run_id (Engine 2) / workflow execution_id (Engine 3, BE-SOL-002); empty for Engine 1
    status_mirror     TEXT NOT NULL DEFAULT 'in_progress', -- updated by BE-SOL-003's consumer for Engine 2/3, written directly here for Engine 1
    started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at      TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_execution_links_task ON task.execution_links (task_id, started_at DESC);

ALTER TABLE task.execution_links ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON task.execution_links
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE task.tasks
  ADD COLUMN active_execution_link_id UUID REFERENCES task.execution_links(id),
  ADD COLUMN workflow_template_id UUID; -- CR-FLOW-TASK-002 field; added here (same migration) since selectEngine reads it — see "Important grounding correction" above
```

**Reconciliation note the CR itself flags** (`CR-FLOW-TASK-001.md:116-119`):
[SOL-TG-04](../../../../bugs/logic-v1/solutions/SOL-TG-04-task-agent-execution.md)
independently proposes an `ActiveExecutionID` field on `Task` (its own
§"`ReportTaskExecutionResult`" design). Neither solution is implemented yet
(both are 📋 Proposed), so there is no live column to reconcile against
today — but whichever of the two migrations lands **second** must not
re-add a colliding column. This solution's migration uses the name
`active_execution_link_id` (pointing at the new `execution_links` row, not
a bare coordinator-run string) specifically so it cannot collide
byte-for-byte with SOL-TG-04's `active_execution_id` even if both land
independently; if SOL-TG-04 is implemented first, its migration should be
revised at that time to point at `execution_links` instead of inventing a
second, redundant tracking column — flagged for whoever implements second,
not resolved here.

`task.tasks.status` values are unaffected (`domain/task.go:9-15`'s existing
four-value CHECK constraint is untouched by this solution) — CR-001 is
"add a linkage table," not "redesign task status," and `BUG-TASKV1-001`'s
richer-status-machine gap is explicitly out of this CR's scope.

## Test plan

- `domain/execution_engine_test.go` — trivial: the three constants are
  distinct, non-empty strings (guards against a future accidental typo
  breaking the `CHECK` constraint's string match).
- `usecase/execute_task_test.go` — new/extended cases, per the CR's
  acceptance criteria:
  - a task with `WorkflowTemplateID` set AND child edges → `EngineWorkflow`
    (priority rule, regression guard against the exact ambiguity the CR
    calls out).
  - a task with only `parent_child` edges → `EngineOrchestration`.
  - a task with only `depends_on` edges → `EngineOrchestration`.
  - a task with neither → `EngineDirectAgent`.
  - every branch above enqueues exactly one `execution_links` row via a
    fake `ExecutionLinkRepository` (assert `engine` field matches).
  - the pre-existing `isComplex`-derived test cases in
    `execute_task_test.go` are ported to assert on `ExecutionEngine` values
    instead of a bare `bool`, with no change to which branch a given edge
    configuration selects (regression guard the CR's acceptance criteria
    explicitly requires: "Không có regression trên test hiện có").
- `adapter/postgres/execution_link_repository_test.go` (or the closest
  existing repository-test convention in this package) — `Create` then
  `Complete` round-trips `status_mirror`/`completed_at`; `idx_execution_links_task`
  ordering returns most-recent-first for a task run more than once.

## Not in scope (per the CR)

- `SimpleExecutor`/`ComplexExecutor`'s dispatch bodies — unchanged
  (SOL-TG-04's scope).
- Any `orchestration-service`/`workflow-service` change — the CR's own
  "Tác động" row states this CR does not touch either service's API.
- Any UI — CR-FLOW-TASK-005's scope (not covered by this solutions batch).

## References

- `docs/crs/v3/flow-task/CR-FLOW-TASK-001-three-engine-execution-architecture.md` — full CR text
- `specs/backend-go/tdd/services/task-service.md:76-85` (§3.1 dispatch branch)
- `specs/backend-go/bugs/logic-v1/solutions/SOL-TG-04-task-agent-execution.md` (`ActiveExecutionID` field this solution's migration must not collide with)
- `backend-go/services/task-service/internal/usecase/execute_task.go:48-94` (real, current `Execute`/`isComplex`)
- `backend-go/services/task-service/internal/usecase/ports.go:109-129` (`SimpleExecutor`/`ComplexExecutor` port definitions)
- `backend-go/services/task-service/internal/adapter/grpcclient/complex_executor.go:1-26` (`StubComplexExecutor`, unchanged by this solution)
- `backend-go/services/task-service/internal/domain/task.go:47-64` (current `Task` struct, no `WorkflowTemplateID` yet)
- `backend-go/services/task-service/migrations/0001_init.up.sql:12-23`, `0002_task_project_execution_tracking.up.sql` (existing schema this migration extends)
