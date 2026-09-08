# flow-task solutions — index

Implementation solutions for the `flow-task` CR series
([`docs/crs/v3/flow-task/`](../../../../../../docs/crs/v3/flow-task/)).
None of these are implemented yet — every solution below is a design
grounded in the real, current `backend-go` code (file:line citations
throughout) plus the pre-existing designs it builds on
([SOL-TG-04](../../../../bugs/logic-v1/solutions/SOL-TG-04-task-agent-execution.md),
[SOL-PW-04](../../../../bugs/logic-v1/solutions/SOL-PW-04-workspace-integration-event-bus.md)),
not new code.

| CR | Solution | Status |
|----|----------|--------|
| [CR-FLOW-TASK-001](../../../../../../docs/crs/v3/flow-task/CR-FLOW-TASK-001-three-engine-execution-architecture.md) — three-engine execution architecture | [BE-SOL-001](./BE-SOL-001-three-engine-execution-linkage.md) — `ExecutionEngine` enum, `task.execution_links`, `selectEngine()` | 📋 Proposed |
| [CR-FLOW-TASK-002](../../../../../../docs/crs/v3/flow-task/CR-FLOW-TASK-002-workflow-as-task-execution-engine.md) — workflow as Engine 3 | [BE-SOL-002](./BE-SOL-002-workflow-as-execution-engine.md) — `WorkflowExecutor`, `origin_task_id`, shared `ReportTaskExecutionResult` callback | 📋 Proposed |
| [CR-FLOW-TASK-003](../../../../../../docs/crs/v3/flow-task/CR-FLOW-TASK-003-unified-task-activity-event-catalog.md) — unified activity/event catalog | [BE-SOL-003](./BE-SOL-003-unified-activity-event-catalog.md) — `orchestration-service` outbox, `workflow-service` step events, `api-gateway`'s `task.activity` WS channel | 📋 Proposed |
| [CR-FLOW-TASK-004](../../../../../../docs/crs/v3/flow-task/CR-FLOW-TASK-004-backend-go-cutover-and-node-sqlite-retirement.md) — cutover & Node/SQLite retirement (backend-go scope only) | [BE-SOL-004](./BE-SOL-004-cutover-readiness-confirmation.md) — confirms backend-go's own side is Postgres-compliant; no backend-go code change proposed | 📋 Proposed |

## Dependency order

BE-SOL-001 → BE-SOL-002 → BE-SOL-003 are strictly sequential (each depends
on the prior one's schema/type additions). BE-SOL-004 depends on all three
being *implemented* (not just designed) plus the rest of
[`specs/backend-go/bugs/task-v1/`](../../../../bugs/task-v1/README.md)
reaching ✅ before CR-FLOW-TASK-004's own Phase 3 gate can open — see
BE-SOL-004 for the confirmation detail.
