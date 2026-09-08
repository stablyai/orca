# BE-SOL-002: `WorkflowExecutor` (Engine 3) and the `ReportTaskExecutionResult` callback extension

**Resolves:** [CR-FLOW-TASK-002](../../../../../docs/crs/v3/flow-task/CR-FLOW-TASK-002-workflow-as-task-execution-engine.md)
**Depends on:** [BE-SOL-001](./BE-SOL-001-three-engine-execution-linkage.md) (`ExecutionEngine`, `execution_links`, `selectEngine()`)
**Service:** `task-service` (new `WorkflowExecutor` client, `selectEngine`'s Engine 3 dispatch) + `workflow-service` (new `origin_task_id` column, completion callback)
**Affected files (proposed):**
- `backend-go/proto/orca/task/v1/task.proto` (`workflow_template_id` on `Task`; new `ReportTaskExecutionResult` RPC — shared with SOL-TG-04's Engine 2 design, see below)
- `backend-go/proto/orca/workflow/v1/workflow.proto` (`origin_task_id` on `ExecuteRequest`/`WorkflowExecution`)
- `backend-go/services/task-service/internal/adapter/grpcclient/workflow_executor.go` (new)
- `backend-go/services/task-service/internal/usecase/report_execution_result.go` (extended — shared RPC with SOL-TG-04, see below)
- `backend-go/services/task-service/internal/usecase/execute_task.go` (Engine 3 dispatch branch)
- `backend-go/services/task-service/internal/usecase/ports.go` (`WorkflowExecutor` port)
- `backend-go/services/task-service/cmd/server/main.go` (dial `workflow-service`)
- `backend-go/services/workflow-service/migrations/0007_origin_task_id.{up,down}.sql` (new)
- `backend-go/services/workflow-service/internal/domain/workflow_execution.go` (extend `WorkflowExecution` with `OriginTaskID`)
- `backend-go/services/workflow-service/internal/usecase/execute.go` (`runToCompletion` — callback call site)
**Status:** 📋 Proposed — not yet implemented

---

## Design rationale (grounded in TDD + real code, building on SOL-TG-04)

This CR's callback design is explicitly **not a new mechanism** —
CR-FLOW-TASK-002 itself says so: "Mẫu y hệt SOL-TG-04's
`ReportTaskExecutionResult` (không phát minh cơ chế mới)"
(`CR-FLOW-TASK-002.md:96`). [SOL-TG-04](../../../../bugs/logic-v1/solutions/SOL-TG-04-task-agent-execution.md)
already designed this exact RPC for Engine 2:

```protobuf
// task.proto — new RPC, service-to-service only
rpc ReportTaskExecutionResult(ReportTaskExecutionResultRequest) returns (google.protobuf.Empty);
message ReportTaskExecutionResultRequest {
  string task_id = 1;
  string coordinator_run_id = 2; // must match the active_execution_id task-service recorded
  bool success = 3;
  double actual_hours = 4;
  string error_message = 5;
}
```

(SOL-TG-04 §"`ReportTaskExecutionResult`", `SOL-TG-04-task-agent-execution.md:204-254`).
Since **neither SOL-TG-04 nor this solution is implemented yet**, this
solution defines the RPC's Engine-3-compatible shape directly rather than
patching an already-shipped message — the two solutions must agree on one
final shape before either is implemented, and this document is that
agreement point, per the CR's own instruction to reuse the RPC "request
thêm field `engine` để usecase phân biệt log nguồn, KHÔNG tạo RPC riêng"
(`CR-FLOW-TASK-002.md:100-103`):

```protobuf
message ReportTaskExecutionResultRequest {
  string task_id = 1;
  string execution_ref = 2;   // renamed from SOL-TG-04's coordinator_run_id
                               // to stay engine-neutral: coordinator_run_id
                               // for Engine 2, workflow execution_id for
                               // Engine 3 — matches BE-SOL-001's
                               // execution_links.external_ref_id column name
  bool success = 3;
  double actual_hours = 4;
  string error_message = 5;
  // NEW for this solution — lets ReportTaskExecutionResult's usecase
  // distinguish which BE-SOL-001 execution_links row to update/validate
  // staleness against, per CR-FLOW-TASK-002.md:100-103's explicit instruction.
  string engine = 6; // "orchestration" | "workflow"
}
```

The staleness/idempotence guard SOL-TG-04 designed (compare against
`task.active_execution_id`, no-op on mismatch,
`SOL-TG-04-task-agent-execution.md:219-235`) carries over unchanged, just
compared against BE-SOL-001's `task.tasks.active_execution_link_id` →
`execution_links.external_ref_id` instead of a bare column, since
BE-SOL-001 already generalized that single-column sketch into a table.

## Design rationale — why `origin_task_id` lives on `ExecuteRequest`/`executions`, not a lookup table

`orchestration-service.md` §2.1's distinct-id-space rule ("Neither
enforces a cross-database SQL FK... Do not merge these id spaces") is the
same rule this CR cites for `workflow.executions.origin_task_id`
(`CR-FLOW-TASK-002.md:54-59`) — `workflow-service` and `task-service` each
own a separate Postgres database (`05-data-architecture.md`'s
database-per-service rule), so `origin_task_id` here is a logical FK
(`TEXT`, no `REFERENCES`), the same shape `orchestration_tasks.origin_task_id`
already uses today (`specs/backend-go/tdd/services/orchestration-service.md:143`).

Confirmed against the real, current schema and proto — `workflow.executions`
has no such column yet (`services/workflow-service/migrations/0001_init.up.sql:34-36`
only defines `template_id`; the most recent migration is
`0006_template_version.up.sql`, so this solution's migration is `0007`), and
`ExecuteRequest` currently has exactly four fields, no `origin_task_id`:

```protobuf
// backend-go/proto/orca/workflow/v1/workflow.proto:84-89 (current, real)
message ExecuteRequest {
  string template_id = 1;
  string project_id = 2;
  string root_trace_id = 3;
  string request_id = 4;
}
```

## Design — proto additions

```protobuf
// task.proto
message Task {
  // ... existing fields (task.proto:50-56: id, tenant_id, title, status,
  // parent_id, project_id) ...
  string workflow_template_id = 7; // next free field number; empty = unchanged behavior
}

// workflow.proto
message ExecuteRequest {
  string template_id = 1;
  string project_id = 2;
  string root_trace_id = 3;
  string request_id = 4;
  string origin_task_id = 5; // NEW — logical FK back to task-service.Task.id, empty for a standalone workflow run
}

message WorkflowExecution {
  string id = 1;
  string template_id = 2;
  string status = 3;
  string root_trace_id = 4;
  string project_id = 5;
  string origin_task_id = 6; // NEW, mirrors ExecuteRequest
}
```

## Design — `task-service`'s `WorkflowExecutor`

Same shape as `SimpleExecutor`/`ComplexExecutor`'s existing ports
(`ports.go:109-129`) — a new port + `internal/adapter/grpcclient/` file,
not a variant of either existing one:

```go
// internal/usecase/ports.go (extended)
type WorkflowExecutor interface {
	Execute(ctx context.Context, tenantID, taskID, requestID, workflowTemplateID string) (executionRef string, err error)
}
```

```go
// internal/adapter/grpcclient/workflow_executor.go (new)
type WorkflowExecutor struct {
	workflow workflowv1.WorkflowServiceClient
}

func (w *WorkflowExecutor) Execute(ctx context.Context, tenantID, taskID, requestID, workflowTemplateID string) (string, error) {
	resp, err := w.workflow.Execute(ctx, &workflowv1.ExecuteRequest{
		TemplateId:   workflowTemplateID,
		RequestId:    requestID,
		OriginTaskId: taskID,
		// project_id/root_trace_id: left unset in this solution — task-service
		// has no ProjectID-to-workflow-inputs mapping designed yet, and
		// interpolating task.title/description into workflow inputs is
		// explicitly named as workflow-service's own open gap (BUG-WF-02),
		// not something this solution should invent inline. Matches
		// CR-FLOW-TASK-002.md:78-81's own "if SOL-WF-02 chưa implement,
		// inputs rỗng, không chặn CR này" instruction.
	})
	if err != nil {
		return "", fmt.Errorf("workflow_executor: execute: %w", err)
	}
	return resp.GetExecution().GetId(), nil
}
```

`selectEngine`'s `EngineWorkflow` branch in `execute_task.go` (BE-SOL-001)
calls this executor instead of `simple`/`complex`, writes the returned
execution id into `execution_links.external_ref_id`
(BE-SOL-001's table), and — per the CR's explicit instruction
(`CR-FLOW-TASK-002.md:88-92`) — returns immediately, the same
`Async: true` shape the complex path uses, since `Execute`'s real
implementation (`execute.go:70-126`) already dispatches its wave loop on a
detached goroutine (`go uc.runToCompletion(dispatchCtx, exec, waves)`,
`execute.go:123`) and returns `exec` (status `pending`/`running`) well
before the DAG finishes — confirmed non-blocking behavior, not assumed.

## Design — `workflow-service`'s callback call site

`runToCompletion` (`internal/usecase/execute.go:128-142`, current, real
code) is exactly the point the CR names (`CR-FLOW-TASK-002.md:105-111`):

```go
// backend-go/services/workflow-service/internal/usecase/execute.go:132-142 (current)
func (uc *Execute) runToCompletion(ctx context.Context, exec domain.WorkflowExecution, waves [][]domain.Step) {
	succeeded := uc.dispatcher.dispatchWaves(ctx, exec.ID, waves)

	exec.Status = domain.StatusCompleted
	if !succeeded {
		exec.Status = domain.StatusFailed
	}
	if err := uc.executions.UpdateExecution(ctx, exec); err != nil {
		slog.ErrorContext(ctx, "workflow: persisting final execution status failed", ...)
	}
}
```

extended, additively, with one more step after `UpdateExecution` succeeds:

```go
	if err := uc.executions.UpdateExecution(ctx, exec); err != nil {
		slog.ErrorContext(ctx, "workflow: persisting final execution status failed", ...)
		return // do not call back with a result that was never durably persisted
	}
	if exec.OriginTaskID != "" { // NEW — only workflow runs started FROM a task report back
		if err := uc.taskClient.ReportTaskExecutionResult(ctx, task.ReportTaskExecutionResultRequest{
			TaskID: exec.OriginTaskID, ExecutionRef: exec.ID,
			Success: exec.Status == domain.StatusCompleted, Engine: "workflow",
		}); err != nil {
			slog.ErrorContext(ctx, "workflow: reporting execution result to task-service failed", slog.String("execution_id", exec.ID), slog.Any("error", err))
			// Best-effort, same posture as the existing UpdateExecution error
			// handling one line above — a failed callback must not crash the
			// background goroutine or retry inline; task-service's task stays
			// in_progress until a later mechanism (e.g. a reconciliation scan)
			// catches the mismatch. Not designed further here — flagged as an
			// honest gap, same category SOL-TG-04 already flags for its own
			// Engine 2 callback failure mode.
		}
	}
```

`uc.taskClient` is a new `TaskClient`-shaped port on `Execute`
(`workflow-service/internal/usecase/ports.go`), a plain gRPC client dial to
`task-service` added in `workflow-service/cmd/server/main.go` — the first
outbound dependency `workflow-service` would have on `task-service`; this
is a new edge not previously drawn in `02-microservices-decomposition.md`'s
dependency graph for this direction (`wf --> ts` is new; only `ts --> wf`
existed before, per `workflow-service.md:278-280`'s "Called by
`task-service`"). Flagged for the architecture doc set to catch up to, not
resolved by editing that doc in this pass.

`actual_hours` is not computed by this callback (`workflow.executions` has
no `started_at`/timing field read here beyond what SOL-TG-04 already
designed for Engine 2) — left as `0` for the workflow path in this
solution; a real duration would need `exec.StartedAt`, which
`domain.WorkflowExecution` does not yet expose to this call site without a
further read. Flagged, not solved, since the CR does not name this as an
acceptance criterion.

## Test plan

- `adapter/grpcclient/workflow_executor_test.go` — fake
  `WorkflowServiceClient`: `Execute` forwards `OriginTaskId`/`TemplateId`
  correctly, returns the execution id from the response.
- `usecase/execute_task_test.go` (extends BE-SOL-001's cases) —
  `WorkflowTemplateID` set → `WorkflowExecutor.Execute` is called (not
  `simple`/`complex`), result is `Async: true`, `execution_links` row has
  `engine='workflow'`.
- `workflow-service/internal/usecase/execute_test.go` — extend the
  existing `runToCompletion` test coverage (file already tests this
  function per `execute_test.go:126`'s `blockingExecutor.Execute`
  fixture): an execution with `OriginTaskID` set calls
  `TaskClient.ReportTaskExecutionResult` exactly once on completion
  (success and failure both covered, per the CR's acceptance criteria);
  an execution with `OriginTaskID == ""` (a standalone workflow run) calls
  it zero times — the CR's explicit regression guard
  (`CR-FLOW-TASK-002.md:130`: "không phá hành vi hiện tại của Workflow
  Orchestration đứng riêng").
- `usecase/report_execution_result_test.go` — a callback with
  `engine="workflow"` and a stale `execution_ref` (mismatched against
  `execution_links.external_ref_id`) is a no-op, same idempotence rule
  SOL-TG-04 already specifies for Engine 2 (shared usecase, shared test
  shape).

## Not in scope (per the CR)

- Workflow-side gaps this CR explicitly disclaims: input interpolation
  (`{{feature_description}}`), `project:`/`server:`/`fleet:tag:` target
  resolution, `action`/`parallel` step types — all `BUG-WF-02`/
  `BUG-TASKV1-006`'s scope, not this CR's (`CR-FLOW-TASK-002.md:115-118`).
- Cycle detection for a workflow step that could create a task pointing
  back at the same template — explicitly deferred by the CR
  (`CR-FLOW-TASK-002.md:119-123`) since no step type can call
  `task.create` today.

## References

- `docs/crs/v3/flow-task/CR-FLOW-TASK-002-workflow-as-task-execution-engine.md` — full CR text
- [BE-SOL-001](./BE-SOL-001-three-engine-execution-linkage.md) — `ExecutionEngine`, `execution_links`, `selectEngine()` this solution's Engine 3 branch plugs into
- `specs/backend-go/bugs/logic-v1/solutions/SOL-TG-04-task-agent-execution.md:204-254` — the `ReportTaskExecutionResult` design this solution generalizes to Engine 3
- `backend-go/proto/orca/workflow/v1/workflow.proto:84-97` (current `ExecuteRequest`/`WorkflowExecution`, confirmed no `origin_task_id`)
- `backend-go/services/workflow-service/internal/usecase/execute.go:70-142` (current, real `Execute`/`runToCompletion` — the async dispatch confirmed, the callback call site)
- `backend-go/services/workflow-service/migrations/0001_init.up.sql:34-36`, `0006_template_version.up.sql` (current schema; this solution's migration is `0007`)
- `specs/backend-go/tdd/services/orchestration-service.md:32-46` (§2.1 distinct-id-space rule, the precedent `origin_task_id`'s logical-FK shape follows)
- `specs/backend-go/tdd/services/workflow-service.md:278-285` (§7 current dependency direction — `wf --> ts` from this solution's callback is a new edge)
