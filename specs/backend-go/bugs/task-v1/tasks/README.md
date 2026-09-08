# task-v1 Tasks — Index

Task breakdowns for the 8 bugs in [`../`](../README.md) (`BUG-TASKV1-001..008`),
one level below their [`../solutions/`](../solutions/README.md) designs.
Per `../solutions/README.md`'s own framing, 6 of the 8 solutions are **Type
A pointers** to a solution already fully broken into tasks elsewhere in
this repo — those get a one-line pointer row below, **no task file is
duplicated here**. One (`SOL-TASKV1-008`) is a meta-finding with no
code-level task at all. Only `SOL-TASKV1-005` — the one genuinely new
design in this series — gets real task files, written in this directory.

| Bug | Solution | Task breakdown | Type |
|---|---|---|---|
| [BUG-TASKV1-001](../BUG-TASKV1-001-orcatask-data-model-and-state-machine-gap.md) | [SOL-TASKV1-001](../solutions/SOL-TASKV1-001-orcatask-data-model-and-state-machine-gap.md) → SOL-TG-01 | Task breakdown đã có sẵn tại [`../../logic-v1/tasks/TASK-TG-01-01..08`](../../logic-v1/tasks/) (8 task) — không tạo lại ở đây. | A (pointer) |
| [BUG-TASKV1-002](../BUG-TASKV1-002-orcatask-ai-decompose-incomplete.md) | [SOL-TASKV1-002](../solutions/SOL-TASKV1-002-orcatask-ai-decompose-incomplete.md) → SOL-TG-02 | Task breakdown đã có sẵn tại [`../../logic-v1/tasks/TASK-TG-02-01..06`](../../logic-v1/tasks/) (6 task) — không tạo lại ở đây. | A (pointer) |
| [BUG-TASKV1-003](../BUG-TASKV1-003-orcatask-access-control-model-mismatch.md) | [SOL-TASKV1-003](../solutions/SOL-TASKV1-003-orcatask-access-control-model-mismatch.md) → SOL-TG-03 | Task breakdown đã có sẵn tại [`../../logic-v1/tasks/TASK-TG-03-01..08`](../../logic-v1/tasks/) (8 task) — không tạo lại ở đây. | A (pointer) |
| [BUG-TASKV1-004](../BUG-TASKV1-004-orcatask-run-agent-execution-gaps.md) | [SOL-TASKV1-004](../solutions/SOL-TASKV1-004-orcatask-run-agent-execution-gaps.md) → SOL-TG-04 | Task breakdown đã có sẵn tại [`../../logic-v1/tasks/TASK-TG-04-01..08`](../../logic-v1/tasks/) (8 task) — không tạo lại ở đây. **Lưu ý**: `TASK-TG-04-04` (real `ComplexExecutor`) blocked on this directory's own `TASK-TASKV1-005-02` (`StartCoordinatorRun` proto) + `-09` (server handler) landing first — see `../solutions/SOL-TASKV1-004-*.md`'s own note. | A (pointer) |
| **BUG-TASKV1-005** | [SOL-TASKV1-005](../solutions/SOL-TASKV1-005-task-execute-orchestration-coordinator-not-autonomous.md) | **New breakdown, this directory**: [`TASK-TASKV1-005-01`](./TASK-TASKV1-005-01-coordinator-run-lifecycle-migration.md) through [`-10`](./TASK-TASKV1-005-10-tick-dispatch-loop-and-integration-tests.md) (10 task) — see table below. | **B (new)** |
| [BUG-TASKV1-006](../BUG-TASKV1-006-workflow-target-resolution-and-step-types-gap.md) | [SOL-TASKV1-006](../solutions/SOL-TASKV1-006-workflow-target-resolution-and-step-types-gap.md) → SOL-WF-02 | Task breakdown đã có sẵn tại [`../../logic-v1/tasks/TASK-WF-02-01..08`](../../logic-v1/tasks/) (8 task) — không tạo lại ở đây. | A (pointer) |
| [BUG-TASKV1-007](../BUG-TASKV1-007-workflow-sharing-not-implemented.md) | [SOL-TASKV1-007](../solutions/SOL-TASKV1-007-workflow-sharing-not-implemented.md) → SOL-WF-01 + SOL-WF-03 | Task breakdown đã có sẵn tại [`../../logic-v1/tasks/TASK-WF-01-01..07`](../../logic-v1/tasks/) (7 task) + [`TASK-WF-03-01..08`](../../logic-v1/tasks/) (8 task) — không tạo lại ở đây. `TASK-WF-01-*` phải land trước `TASK-WF-03-*` (migration ordering, đã ghi trong `SOL-WF-03` gốc). | A (pointer) |
| [BUG-TASKV1-008](../BUG-TASKV1-008-dual-backend-routing-and-postgres-compliance.md) | [SOL-TASKV1-008](../solutions/SOL-TASKV1-008-dual-backend-routing-and-postgres-compliance.md) → [CR-FLOW-TASK-004](../../../../../docs/crs/v3/flow-task/CR-FLOW-TASK-004-backend-go-cutover-and-node-sqlite-retirement.md) / [BE-SOL-004](../../../crs/v3/flow-task/solutions/BE-SOL-004-cutover-readiness-confirmation.md) | **Không có task code-level nào** — checked `specs/backend-go/crs/v3/flow-task/` directly: no `tasks/` directory exists there, and `BE-SOL-004` (backend-go's own part of CR-FLOW-TASK-004, written independently in that directory) self-confirms "no backend-go code changes proposed." CR-FLOW-TASK-004's Pha 1 acceptance gate CHÍNH LÀ việc hoàn thành các task ở trên (001-007, i.e. every row of `../README.md` reaching ✅), không phải một task riêng. | A (pointer, no code) |

## BUG-TASKV1-005 task breakdown (this directory)

Ordered by dependency — migration/schema first, then domain, then
usecase/RPC wiring, then the ticker loop + integration tests last, matching
`../../logic-v1/tasks/TASK-TG-04-*`'s existing sequencing convention for
this series.

| Task | Title | Depends on |
|---|---|---|
| [TASK-TASKV1-005-01](./TASK-TASKV1-005-01-coordinator-run-lifecycle-migration.md) | Migration `0004_coordinator_run_lifecycle` — `worktree_id`/`result`/`error_message`/`reported_at` on `coordinator_runs` | none |
| [TASK-TASKV1-005-02](./TASK-TASKV1-005-02-proto-six-new-rpcs.md) | `orchestration.proto` — add 6 missing RPCs (`StartCoordinatorRun`, `GetCoordinatorRun`, `CompleteCoordinatorRun`, `FailCoordinatorRun`, `RecordHeartbeat`, `ListPendingDecisionGates`) | none |
| [TASK-TASKV1-005-03](./TASK-TASKV1-005-03-domain-coordinator-run-transitions-and-spec-expansion.md) | Domain — `CoordinatorRun.Complete`/`Fail` transitions + new `ExpandSpec` DAG materialization | none |
| [TASK-TASKV1-005-04](./TASK-TASKV1-005-04-ports-coordinator-run-worker-dispatcher-task-service-reporter.md) | Ports — new `CoordinatorRunRepository`/`WorkerDispatcher`/`TaskServiceReporter`; extend `OrchestrationTaskRepository`/`DispatchContextRepository`/`GateRepository` | -03 |
| [TASK-TASKV1-005-05](./TASK-TASKV1-005-05-postgres-repository-coordinator-run-and-task-extensions.md) | Postgres — implement `CoordinatorRunRepository` + task/dispatch/gate repository extensions | -01, -03, -04 |
| [TASK-TASKV1-005-06](./TASK-TASKV1-005-06-usecases-coordinator-run-lifecycle-rpcs.md) | Usecases — `StartCoordinatorRun`, `GetCoordinatorRun`, `CompleteCoordinatorRun`, `FailCoordinatorRun`, `RecordHeartbeat`, `ListPendingDecisionGates` | -04, -05 |
| [TASK-TASKV1-005-07](./TASK-TASKV1-005-07-update-task-status-and-promote-run-completion.md) | Extend `UpdateStatusAndPromote`'s transaction to detect run completion and report it to `task-service` | -01, -04 |
| [TASK-TASKV1-005-08](./TASK-TASKV1-005-08-worker-dispatcher-and-task-service-reporter-adapters.md) | Adapters — `infrafleetclient.WorkerDispatcher` + `taskserviceclient.TaskServiceReporter` | -04 |
| [TASK-TASKV1-005-09](./TASK-TASKV1-005-09-grpc-handlers-and-main-wiring.md) | `grpc/server.go` — 6 new handlers; `main.go` — dial `infra-fleet-service`/`task-service`, wire lifecycle usecases | -02, -06, -07, -08 |
| [TASK-TASKV1-005-10](./TASK-TASKV1-005-10-tick-dispatch-loop-and-integration-tests.md) | `TickDispatch` usecase + `main.go` ticker goroutine + full autonomy integration test | -05, -06, -07, -08, -09 |

**Flagged cross-repo dependency, not a design gap**: `TASK-TASKV1-005-08`'s
`taskserviceclient.Reporter` and `TASK-TASKV1-005-09`/`-10`'s wiring of it
call `task-service`'s `ReportTaskExecutionResult` RPC — that RPC does not
exist yet (it is `SOL-TG-04`'s `TASK-TG-04-05`, part of the `BUG-TASKV1-004`
pointer row above, not built here). `TASK-TASKV1-005-08` writes the client
stub against `SOL-TG-04`'s already-fixed request/response shape regardless,
but confirm `TASK-TG-04-05` lands before wiring
`taskserviceclient.Reporter` into `orchestration-service`'s production
composition root — the same "design complete, blocked on the other
service's own build" relationship `TASK-TG-04-04`/`SOL-TASKV1-004` already
documents in the other direction (task-service's `ComplexExecutor` blocked
on `TASK-TASKV1-005-02`/`-09` landing here).

## What this index doesn't do

- It does not re-litigate `../solutions/README.md`'s own confirmation that
  6 of the 8 solutions are unchanged pointers — see that file for the
  per-bug re-verification detail.
- It does not write any task file for `BUG-TASKV1-008`: `BE-SOL-004`
  (`specs/backend-go/crs/v3/flow-task/solutions/`) is itself the
  authoritative confirmation that no backend-go code change is proposed
  for that bug, and no `specs/backend-go/crs/v3/flow-task/tasks/`
  directory exists to point to.
