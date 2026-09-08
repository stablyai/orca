# TASK-FT-002-01: Proto — `Task.workflow_template_id`, `workflow.proto`'s `origin_task_id`, and the shared `ReportTaskExecutionResult` RPC shape

**From Solution:** BE-SOL-002
**Priority:** P0
**Service:** `task-service` (proto owner), `workflow-service` (proto owner)
**File:** `backend-go/proto/orca/task/v1/task.proto`, `backend-go/proto/orca/workflow/v1/workflow.proto`
**Depends on:** TASK-FT-001-01/02 (`ExecutionEngine`, `workflow_template_id` domain plumbing this RPC's `engine` field and `Task.workflow_template_id` proto field connect to)
**Status:** `[ ]` TODO

---

## Context

**This task is the single agreement point for a shape two independent,
still-unimplemented task series each separately propose** — read this
whole section before writing any proto, since picking the wrong shape here
means TASK-FT-002-04 (this solution) and
[`TASK-TG-04-05`](../../../../bugs/logic-v1/tasks/TASK-TG-04-05-report-task-execution-result.md)
(SOL-TG-04) end up disagreeing about `task.proto`'s wire contract.

Verified against the real, current `task.proto` (confirmed by reading the
file directly): `Task` has exactly 6 fields today (`id`, `tenant_id`,
`title`, `status`, `parent_id`, `project_id` — field numbers 1-6), and
`TaskService` has **no** `ReportTaskExecutionResult` RPC at all yet. Field
number **7** is genuinely free.

Two designs exist for this RPC, neither implemented:

- **TASK-TG-04-05** (SOL-TG-04, Engine 2 only) proposes:
  `ReportTaskExecutionResultRequest{task_id=1, coordinator_run_id=2,
  success=3, actual_hours=4, error_message=5}` (5 fields) plus a bare
  `Task.active_execution_id` (`TEXT`, no FK) column it compares
  `coordinator_run_id` against for staleness.
- **This solution (BE-SOL-002)** generalizes that RPC to also cover Engine
  3 (workflow), per CR-FLOW-TASK-002's explicit instruction to reuse
  SOL-TG-04's RPC "with an added `engine` field, not a separate RPC":
  `ReportTaskExecutionResultRequest{task_id=1, execution_ref=2 (renamed
  from coordinator_run_id), success=3, actual_hours=4, error_message=5,
  engine=6 (NEW)}`, compared against TASK-FT-001-01's
  `execution_links.external_ref_id` (a table, not a bare column) instead
  of SOL-TG-04's bare `active_execution_id` string.

**Decision this task implements**: use BE-SOL-002's 6-field, engine-neutral
shape below as the one real proto message — it is a strict superset of
TASK-TG-04-05's 5-field version (same field numbers 1/3/4/5, `field 2`
renamed `execution_ref`, `field 6` added) and is what both
`TASK-FT-002-04` (this series) and (once it catches up) TASK-TG-04-05 must
target. **If TASK-TG-04-05 is implemented first** with its original
5-field shape, this task's job becomes an additive proto change
(rename `coordinator_run_id` → `execution_ref` is a breaking wire rename —
coordinate a single atomic migration of every caller, don't leave both
names live) plus adding field 6 — flag this explicitly in the PR
description rather than silently landing a second, conflicting RPC.

## Changes to make

**1. `backend-go/proto/orca/task/v1/task.proto`** — add to the `Task`
message (next free field number, confirmed `7`):

```protobuf
message Task {
  string id = 1;
  string tenant_id = 2;
  string title = 3;
  string status = 4;
  string parent_id = 5;
  string project_id = 6;
  string workflow_template_id = 7; // NEW (BE-SOL-001/BE-SOL-002) — empty = unchanged behavior (selectEngine treats "" as "no workflow engine selected")
}
```

Add to `TaskService`'s service block:

```protobuf
  // ReportTaskExecutionResult is called BY orchestration-service (Engine 2)
  // or workflow-service (Engine 3) only — api-gateway never routes to it.
  // See TASK-FT-002-04's usecase doc comment for the service-identity
  // check this handler must perform.
  rpc ReportTaskExecutionResult(ReportTaskExecutionResultRequest) returns (google.protobuf.Empty);
```

```protobuf
message ReportTaskExecutionResultRequest {
  string task_id = 1;
  string execution_ref = 2;   // coordinator_run_id for Engine 2, workflow execution_id for Engine 3 — matches task.execution_links.external_ref_id (TASK-FT-001-01)
  bool success = 3;
  double actual_hours = 4;
  string error_message = 5;   // set iff !success
  string engine = 6;          // "orchestration" | "workflow" — lets the usecase pick which execution_links row to validate staleness against
}
```

**2. `backend-go/proto/orca/workflow/v1/workflow.proto`** — verified
against the real, current message (confirmed by reading the file: exactly
4 fields on `ExecuteRequest`, no `origin_task_id`; `WorkflowExecution` has
5 fields, no `origin_task_id`):

```protobuf
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

`origin_task_id` is a plain string logical FK (no cross-database SQL FK) —
`workflow-service` and `task-service` each own a separate Postgres
database per `05-data-architecture.md`'s database-per-service rule, the
same shape `orchestration_tasks.origin_task_id` already uses today
(`specs/backend-go/tdd/services/orchestration-service.md:143`).

## Regenerate stubs

```bash
cd /opt/repos/orca/backend-go
buf generate proto
go build ./proto/...
```

## Verify

```bash
cd /opt/repos/orca/backend-go
buf lint proto
go build ./proto/...
```

Expected: clean `buf generate`/`buf lint`; `task.pb.go`/`workflow.pb.go`
regenerate with the new fields at the exact field numbers above and no
existing field renumbered (a renumber would break wire compatibility with
any already-deployed caller — there are none yet since nothing here is
implemented, but keep the numbering discipline anyway for the next reader
tracing field history).
