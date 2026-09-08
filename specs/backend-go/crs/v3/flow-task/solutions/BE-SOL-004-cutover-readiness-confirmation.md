# BE-SOL-004: backend-go's part of CR-FLOW-TASK-004 — confirmation, not a redesign

**Resolves:** [CR-FLOW-TASK-004](../../../../../docs/crs/v3/flow-task/CR-FLOW-TASK-004-backend-go-cutover-and-node-sqlite-retirement.md) (backend-go-relevant scope only)
**Service:** none — no `backend-go/` code changes proposed
**Status:** 📋 Proposed — not yet implemented (nothing to implement in backend-go)

---
CR-FLOW-TASK-004's "Tác động" row names `deploy/prod/docker-compose.yml`,
`desktop/src/main/task|workflow/*`, `backend/src/main/task|workflow/*` —
all outside `backend-go/`. No 4-phase cutover redesign is written here;
this answers only: **is backend-go's own side ready for production
traffic?**

**Finding**: [`BUG-TASKV1-008`](../../../../bugs/task-v1/BUG-TASKV1-008-dual-backend-routing-and-postgres-compliance.md)
already confirms backend-go itself is 100% Postgres-compliant
(`grep -rli sqlite backend-go/` → 0 matches, `BUG-TASKV1-008.md:17-23`) and
`api-gateway` already serves real traffic in `deploy/dev/docker-compose.yml`.
The only gap is `deploy/prod/docker-compose.yml` still pointing at the
Node/SQLite `orca-server` image (`BUG-TASKV1-008.md:29-34`) — a `deploy/`-only
change, outside `backend-go/` scope.

**No backend-go code change is proposed.** CR-FLOW-TASK-004's own gate
("mọi mục ❌/🟡 trong `specs/backend-go/bugs/task-v1/` phải chuyển ✅, cộng
CR-FLOW-TASK-001..003 đã triển khai") is not yet met: `task-v1/README.md`'s
table still shows BUG-TASKV1-001/002/003/004/006/007 as 🟡/❌, and
[BE-SOL-001](./BE-SOL-001-three-engine-execution-linkage.md)/
[BE-SOL-002](./BE-SOL-002-workflow-as-execution-engine.md)/
[BE-SOL-003](./BE-SOL-003-unified-activity-event-catalog.md) are all
📋 Proposed, none implemented. Per the CR's own Phase 1 rule, Phase 3
(flip production) cannot start yet — this is a gate check, not new work.

**Recommendation**: track Phase 0-4 execution as `desktop/`/`deploy/` work
outside `specs/backend-go/`; re-check this confirmation once BE-SOL-001..003
and the remaining `task-v1` bugs are implemented.

## References

- `docs/crs/v3/flow-task/CR-FLOW-TASK-004-backend-go-cutover-and-node-sqlite-retirement.md`
- `specs/backend-go/bugs/task-v1/BUG-TASKV1-008-dual-backend-routing-and-postgres-compliance.md`
- `specs/backend-go/bugs/task-v1/README.md`
