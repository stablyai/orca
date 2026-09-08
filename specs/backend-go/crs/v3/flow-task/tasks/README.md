# flow-task tasks — index

Executable task breakdown of the `flow-task` CR series' solutions
([`../solutions/`](../solutions/)). Every task below is `Status: [ ] TODO`
— none of this is implemented yet. Each task cites real, current
`backend-go` file:line locations (re-verified against the on-disk source
while writing these tasks, not copied blind from the solutions) and calls
out every place a solution's sketch didn't match the real code, so an
implementing agent can work from the task file alone without re-reading
the parent solution end to end.

## Solution → Task ID map

| Solution | Task IDs | Notes |
|---|---|---|
| [BE-SOL-001](../solutions/BE-SOL-001-three-engine-execution-linkage.md) — `ExecutionEngine`, `execution_links`, `selectEngine()` | `TASK-FT-001-01` (migration), `TASK-FT-001-02` (`ExecutionEngine`/`selectEngine`), `TASK-FT-001-03` (`execution_links` wiring in `ExecuteTask`), `TASK-FT-001-04` (unit tests) | `TASK-FT-001-01` flags a real, unresolved column-name/migration-number collision with `TASK-TG-04-05` (SOL-TG-04) — read its Context before running that migration. |
| [BE-SOL-002](../solutions/BE-SOL-002-workflow-as-execution-engine.md) — `WorkflowExecutor` (Engine 3), `origin_task_id`, shared `ReportTaskExecutionResult` | `TASK-FT-002-01` (proto), `TASK-FT-002-02` (`workflow.executions.origin_task_id` migration), `TASK-FT-002-03` (`WorkflowExecutor` client + dispatch wiring), `TASK-FT-002-04` (`ReportTaskExecutionResult` usecase), `TASK-FT-002-05` (`workflow-service`'s `runToCompletion` callback) | `TASK-FT-002-01`/`-04` flag the same kind of collision with `TASK-TG-04-05` for the RPC's wire shape (`execution_ref`+`engine` vs. `coordinator_run_id`-only) — read before implementing either. |
| [BE-SOL-003](../solutions/BE-SOL-003-unified-activity-event-catalog.md) — `orchestration-service` outbox, `workflow-service` step events, `api-gateway`'s `task.activity` channel, `task-service`'s status-mirror consumer | `TASK-FT-003-01` (`orchestration-service` outbox foundation), `TASK-FT-003-02` (`orchestration.messages` first write + gate events), `TASK-FT-003-03` (`workflow-service` step-level outbox events), `TASK-FT-003-04` (`api-gateway` `task.activity` WS channel), `TASK-FT-003-05` (`task-service` status-mirror consumer) | `TASK-FT-003-01`/`-03` **correct** BE-SOL-003's `OutboxStore.Enqueue(ctx, tx pgx.Tx, ...)` port sketch — the real codebase's transactions are owned entirely inside each service's `internal/adapter/postgres` methods, never exposed to the usecase layer as a `pgx.Tx`. These tasks instead follow `usage-service`'s real, working `SaveSession(ctx, session, event)` pattern (event as a plain value parameter into the existing domain-write method). Read `TASK-FT-003-01`'s Context section before implementing any BE-SOL-003 task. |
| [BE-SOL-004](../solutions/BE-SOL-004-cutover-readiness-confirmation.md) — cutover readiness confirmation | **None** | See "Why BE-SOL-004 has no tasks" below. |

## Dependency order

```
TASK-FT-001-01 (migration)
      │  ⚠ check TASK-TG-04-05 (SOL-TG-04) hasn't already claimed
      │    active_execution_id / migration 0003 first
      ▼
TASK-FT-001-02 (ExecutionEngine + selectEngine)
      ▼
TASK-FT-001-03 (execution_links wiring in ExecuteTask)
      ▼
TASK-FT-001-04 (unit tests)
      ▼
TASK-FT-002-01 (proto: workflow_template_id, origin_task_id, ReportTaskExecutionResult)
      │  ⚠ same collision check against TASK-TG-04-05 for the RPC shape
      ├──────────────┬──────────────────────┐
      ▼              ▼                      ▼
TASK-FT-002-02   TASK-FT-002-03         TASK-FT-002-04
(origin_task_id  (WorkflowExecutor +    (ReportTaskExecutionResult
 migration)       Engine 3 dispatch,     usecase)
      │            depends on -01)             │
      ▼                                        ▼
TASK-FT-002-05 (workflow-service runToCompletion callback —
                depends on -02 AND -04)
      ▼
TASK-FT-003-01 (orchestration-service outbox foundation)
      ▼
TASK-FT-003-02 (orchestration.messages + gate events — depends on -01)
      │
      ├── TASK-FT-003-03 (workflow-service step-level outbox events —
      │    depends on TASK-FT-002-02/-05 for origin_task_id)
      │
      ▼
TASK-FT-003-04 (api-gateway task.activity channel —
                depends on -01, -02, -03: needs all 6 subjects live)
      ▼
TASK-FT-003-05 (task-service status-mirror consumer —
                depends on TASK-FT-001-03, -003-01/-02, -003-03)
```

BE-SOL-001 → BE-SOL-002 → BE-SOL-003 is strictly sequential at the
solution level (matching `../solutions/README.md`'s own dependency
note); within BE-SOL-002 and BE-SOL-003, some tasks fan out in parallel
(e.g. `TASK-FT-002-02`/`-03`/`-04` can proceed concurrently once
`TASK-FT-002-01`'s proto lands) as shown above.

## Why BE-SOL-004 has no tasks

BE-SOL-004 is explicitly a confirmation, not a design — its own text
states "no backend-go code change is proposed." It answers only whether
`backend-go`'s own side is ready for production traffic, and its own
gate condition (every `specs/backend-go/bugs/task-v1/` item at ✅, plus
BE-SOL-001/002/003 actually *implemented*, not just designed) is not met
yet — `task-v1/README.md` still shows several items at 🟡/❌, and every
task in this directory is `[ ] TODO`. Creating implementation tasks for a
solution whose entire content is "don't start Phase 3 yet" would be
inventing work the solution itself says not to do. Once BE-SOL-001-003's
tasks above are all implemented and the remaining `task-v1` bugs reach
✅, re-open BE-SOL-004 to confirm the gate and hand its Phase 0-4 rollout
to `desktop/`/`deploy/`-scoped work outside `specs/backend-go/` (per its
own recommendation) — that rollout work, if and when it's broken into
tasks, belongs in those areas' own task directories, not here.
