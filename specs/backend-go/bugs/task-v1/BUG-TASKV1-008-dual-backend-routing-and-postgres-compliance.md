# BUG-TASKV1-008: backend-go itself is 100% Postgres (compliant), but production still runs the Node/SQLite backend for all 3 Task systems — backend-go only reaches `deploy/dev`

**Business Logic:** cross-cutting (OrcaTask, Task Execute, Workflow Orchestration) — infrastructure/deployment finding, not a single `BL-*` doc
**Service:** `task-service`, `workflow-service`, `orchestration-service` (backend-go) vs. `desktop/src/main/task|workflow/*-rpc-handler.ts` (Node/SQLite)
**File:** `deploy/prod/docker-compose.yml`
**Priority:** P0
**Status:** OPEN
**Severity:** High
**Symptom:** The user-facing requirement "mọi thông tin phải lưu Postgres tập trung, không SQLite" is satisfied **inside backend-go itself** (confirmed: zero SQLite references anywhere in `backend-go/`) but **not satisfied in production**, because production (`deploy/prod/docker-compose.yml`) still runs the old Node backend (`orca-server` image) backed by a local SQLite file, and backend-go is only reachable from `deploy/dev`. The two backends have diverged in RPC coverage (`workflow.template.update`/`pause`/`resume` exist only in backend-go; `orchestration.*` is nearly empty in backend-go).

---

## Spec summary

There is no single `BL-*` doc for this — it is a meta-finding synthesizing the user's Postgres-centralization requirement against the actual current deployment topology for the 3 Task systems (OrcaTask/task-service, Task Execute/orchestration-service, Workflow Orchestration/workflow-service).

## (a) backend-go itself: fully Postgres-compliant — confirmed

```
grep -rli sqlite backend-go/   →  0 matches (verified directly, excluding .git/)
```

Every `backend-go` service — including all three Task-domain services — persists exclusively to Postgres via `pgx`-based repositories (`internal/adapter/postgres/`). This part of the requirement is **already satisfied** inside backend-go's own codebase; no gap to file here.

## (b) database-per-service on one shared Postgres instance — confirmed, and this is by design, not a violation

`backend-go/deploy/postgres-init-databases.sh:8` creates 16 separate Postgres databases (`auth`, `tenant`, `project`, ..., `workflow`, `task`, `orchestration`, ...) on **one** Postgres server instance — a genuine database-per-service architecture, but centralized on a single Postgres deployment, not scattered across separate database engines or embedded stores. The script's own header comment cites `architecture/05-data-architecture.md`'s database-per-service rule explicitly (`postgres-init-databases.sh:1-4`), and `specs/backend-go/tdd/architecture/05-data-architecture.md:53,78` independently documents this as a deliberate architectural choice (rejecting a single shared schema because "it doesn't compose well with database-per-service"). **This is the intended design, not a compliance gap** — flagging it only so it is not mistaken for one during a future audit.

## (c) Production still runs the Node/SQLite backend — the actual gap

- `deploy/prod/docker-compose.yml` (full file read) defines exactly one service, `orca-server`, whose only persistence volume comment reads "Persistent data: **SQLite database**, encryption keys, relay binaries" (`docker-compose.yml:46-48`), with commented-out `ORCA_DB_URL` alternatives for MySQL/Postgres/TiDB that are **not** enabled by default. There is no `task-service`/`workflow-service`/`orchestration-service` container, no Postgres container, anywhere in this compose file — confirmed by `grep` for `task-service|workflow-service|orchestration-service|backend-go` returning zero matches.
- `deploy/dev/docker-compose.yml` is the **only** compose file referencing backend-go services (confirmed: it is the sole match for `task-service|workflow-service|orchestration-service|backend-go` across every file under `deploy/`).
- The desktop app's Node/SQLite RPC handlers for all 3 systems are confirmed still present and unremoved: `desktop/src/main/task/task-rpc-handler.ts`, `desktop/src/main/workflow/workflow-rpc-handler.ts`.
- Net effect: every production deployment and the entire Desktop Electron app today serve `task.*`/`workflow.*`/`orchestration.*` from the Node/SQLite backend, not backend-go/Postgres — the centralized-Postgres requirement is unmet at the point that actually matters (what production and the desktop app actually run), despite being fully met inside backend-go's own source.

## What's missing

- A written, actionable cutover plan from Node/SQLite to backend-go/Postgres for production and desktop. This does not need to be invented here: [`docs/crs/v3/flow-task/CR-FLOW-TASK-004-backend-go-cutover-and-node-sqlite-retirement.md`](../../../../docs/crs/v3/flow-task/CR-FLOW-TASK-004-backend-go-cutover-and-node-sqlite-retirement.md) already exists and specifies a 4-phase plan (freeze RPC-shape divergence → close functional gaps → dual-read/shadow traffic → flip production → retire Node code). **That CR's own acceptance gate is this very directory**: its dependency table explicitly requires every ❌/🟡 item in `specs/backend-go/bugs/task-v1/` (this directory) to reach ✅ before Phase 3 (flip production) may proceed — confirmed by reading the CR directly (`CR-FLOW-TASK-004-...md`, "Phụ thuộc" row).
- Until BUG-TASKV1-001 through 007 above are closed, cutover is explicitly blocked by the CR's own stated logic ("không cutover sớm hơn mốc này — cutover khi còn gap chức năng nghĩa là giảm chức năng cho người dùng").

## See also

- [`docs/crs/v3/flow-task/CR-FLOW-TASK-004-backend-go-cutover-and-node-sqlite-retirement.md`](../../../../docs/crs/v3/flow-task/CR-FLOW-TASK-004-backend-go-cutover-and-node-sqlite-retirement.md) — the existing cutover plan; do not re-derive one here, reference this CR directly.
- [BUG-TASKV1-001 through 007](./README.md) — the specific functional gaps CR-FLOW-TASK-004 names as its Phase-1 exit criteria.

## References

- `backend-go/deploy/postgres-init-databases.sh:1-15` — database-per-service creation script, all Postgres
- `specs/backend-go/tdd/architecture/05-data-architecture.md:53,78` — database-per-service rationale, cited as deliberate architecture
- `deploy/prod/docker-compose.yml:1-79` — full production compose file, single Node/SQLite `orca-server` service, no backend-go container
- `deploy/dev/docker-compose.yml` — the only compose file wiring backend-go's task/workflow/orchestration services
- `desktop/src/main/task/task-rpc-handler.ts`, `desktop/src/main/workflow/workflow-rpc-handler.ts` — still-present Node/SQLite handlers serving production and desktop today
- `docs/crs/v3/flow-task/CR-FLOW-TASK-004-backend-go-cutover-and-node-sqlite-retirement.md` — full cutover plan and this-directory-as-acceptance-gate dependency
