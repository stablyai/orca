# TASK-TASKV1-005-02: `orchestration.proto` — add 6 missing RPCs (`StartCoordinatorRun`, `GetCoordinatorRun`, `CompleteCoordinatorRun`, `FailCoordinatorRun`, `RecordHeartbeat`, `ListPendingDecisionGates`)

**From Solution:** SOL-TASKV1-005
**Priority:** P1
**Service:** `orchestration-service` (proto only — no handler implementation in this task)
**File:** `backend-go/proto/orca/orchestration/v1/orchestration.proto`
**Depends on:** none (proto-only; can land in parallel with TASK-01, both are prerequisites for TASK-03..10)
**Status:** `[ ]` TODO

---

## Context

Read in full and confirmed: `orchestration.proto` (179 lines) currently
declares exactly 7 RPCs — `CreateDispatchContext`, `CreateGate`,
`ResolveGate`, `UpdateTaskStatusAndPromote`, `GetDispatchContextForTask`,
`ListActiveDispatchContextsForUser`, `FailDispatch`
(`orchestration.proto:10-43`). `orchestration-service.md` §3's API sketch
names 11 RPCs total — the 6 missing ones are exactly what this task adds.
This task is proto-shape only: it does not implement any server handler
(that is `TASK-TASKV1-005-09`) or client caller (`TASK-TASKV1-005-06`/`-08`).

## Changes to make

In `backend-go/proto/orca/orchestration/v1/orchestration.proto`, add to the
`service OrchestrationService` block (after the existing `FailDispatch` RPC,
before the closing `}` at line 43):

```protobuf
  // StartCoordinatorRun is task-service's entry point into the complex
  // execution path (orchestration-service.md §2.2/§3): starts a
  // coordinator_run for a spec_json-described DAG and returns immediately —
  // this call does NOT block for the DAG to finish. orchestration-service's
  // own tick loop (TASK-TASKV1-005-10) autonomously advances the run and
  // calls back into task-service (ReportTaskExecutionResult, SOL-TG-04) to
  // report the terminal result.
  rpc StartCoordinatorRun(StartCoordinatorRunRequest) returns (CoordinatorRun);

  // GetCoordinatorRun is a plain point-in-time read, used by any caller
  // polling a run's current status/result.
  rpc GetCoordinatorRun(GetCoordinatorRunRequest) returns (CoordinatorRun);

  // CompleteCoordinatorRun and FailCoordinatorRun are exposed as
  // caller-invokable RPCs (not only internal transitions the tick loop
  // triggers) so an operator/admin path can force-finalize a stuck run
  // without waiting for the autonomous loop — orchestration-service.md §3
  // lists both as part of the RPC surface, not only as an internal detail.
  rpc CompleteCoordinatorRun(CompleteCoordinatorRunRequest) returns (CoordinatorRun);
  rpc FailCoordinatorRun(FailCoordinatorRunRequest) returns (CoordinatorRun);

  // RecordHeartbeat sits in the coordinator's tight poll loop
  // (orchestration-service.md §8: "p99 < 30ms, no cross-service calls on
  // that path") — reuses DispatchContext, no new message type needed,
  // matching GetDispatchContextForTaskResponse's existing convention.
  rpc RecordHeartbeat(RecordHeartbeatRequest) returns (DispatchContext);

  // ListPendingDecisionGates: every pending decision_gates row for the
  // calling tenant (tenant from identity, not a request field) — matches
  // ListActiveDispatchContextsForUserRequest's pattern.
  rpc ListPendingDecisionGates(ListPendingDecisionGatesRequest) returns (ListPendingDecisionGatesResponse);
```

Add new messages after the existing `FailDispatchResponse` message (end of
file):

```protobuf
message CoordinatorRun {
  string id = 1;
  string origin_task_id = 2;      // logical FK -> task-service.Task.id, per §2.1
  string spec_json = 3;           // round-trips the caller-supplied spec verbatim
  string status = 4;              // idle|running|completed|failed
  string coordinator_handle = 5;
  int32 poll_interval_ms = 6;
  string worktree_id = 7;         // caller-supplied, same optional/nullable pattern as DispatchContext.worktree_id
  string result_json = 8;         // set when status=completed
  string error_message = 9;       // set when status=failed
}

// StartCoordinatorRunRequest.spec_json is an OPAQUE payload from
// task-service's ComplexExecutor (SOL-TG-04's buildOrchestrationSpec) —
// this service does not interpret task-service's shape, only the
// {tempId, title, spec, deps: [tempId,...]}[] array domain.ExpandSpec
// requires (TASK-TASKV1-005-03), matching §2.1's "distinct id space...
// task-service.Task.ID rides along as each node's origin reference, not
// as the primary key here."
message StartCoordinatorRunRequest {
  string origin_task_id = 1;
  string spec_json = 2;
  string worktree_id = 3; // optional
}

message GetCoordinatorRunRequest { string id = 1; }

message CompleteCoordinatorRunRequest {
  string id = 1;
  string result_json = 2;
}

message FailCoordinatorRunRequest {
  string id = 1;
  string error_message = 2;
}

message RecordHeartbeatRequest { string dispatch_context_id = 1; }

message ListPendingDecisionGatesRequest {}  // tenant from identity, matches ListActiveDispatchContextsForUserRequest's pattern

message ListPendingDecisionGatesResponse {
  repeated DecisionGate gates = 1;
}
```

## Regenerate stubs

```bash
cd /opt/repos/orca/backend-go
buf generate proto
```

## Verify

```bash
cd /opt/repos/orca/backend-go
go build ./proto/...
```

Expected: `proto/gen/go/orca/orchestration/v1/orchestration.pb.go` and
`orchestration_grpc.pb.go` regenerate with `CoordinatorRun`,
`StartCoordinatorRunRequest`, `GetCoordinatorRunRequest`,
`CompleteCoordinatorRunRequest`, `FailCoordinatorRunRequest`,
`RecordHeartbeatRequest`, `ListPendingDecisionGatesRequest`,
`ListPendingDecisionGatesResponse` types and an
`OrchestrationServiceServer`/`OrchestrationServiceClient` interface widened
to 13 methods; `go build ./proto/...` succeeds. Nothing else in the repo
implements the widened server interface yet at this point — that is
expected until `TASK-TASKV1-005-09` lands (the existing `Server` struct in
`internal/adapter/grpc/server.go` embeds
`orchestrationv1.UnimplementedOrchestrationServiceServer`, so this alone
does not break the build of `internal/adapter/grpc`).
