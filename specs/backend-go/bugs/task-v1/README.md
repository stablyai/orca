# Task-v1 Bug Reports — `backend-go`'s 3 Task Systems, Cross-Checked Against `logic-v1`

This directory is a **focused, current-state cross-reference** covering
exactly 3 systems — **OrcaTask** (task graph CRUD/state/AI-planning/access
control), **Task Execute** (Run Agent dispatch + orchestration coordination),
and **Workflow Orchestration** (templates, execution, sharing) — re-verified
directly against the live `backend-go` source as of 2026-09-08.

**This is not a new independent audit.** `../logic-v1/` already contains a
much more detailed, line-cited audit of these same systems
(`BUG-TG-01..04`, `BUG-WF-01..03`, plus `BUG-AT-03`/`BUG-PW-04` for the
cross-cutting event/integration gaps). Every bug below is a **short
cross-reference + current-status confirmation** — it re-reads the actual
code, confirms whether the original finding still holds, and points to the
original report (and its paired `solutions/`/`tasks/` design where one
exists) for full detail. **No content from `logic-v1` is duplicated here.**

One bug (BUG-TASKV1-005) is a genuinely new finding not previously
documented anywhere: `orchestration-service` has no autonomous coordinator
loop and is missing 5 of the 11 RPCs its own TDD sketches. One bug
(BUG-TASKV1-008) is a meta-finding about production deployment topology,
not a code-level gap.

## Index

| ID | Title | System | Severity | Status | See also |
|----|-------|--------|----------|--------|----------|
| [BUG-TASKV1-001](./BUG-TASKV1-001-orcatask-data-model-and-state-machine-gap.md) | Data model has 4 statuses (no backlog/todo/review/blocked), no recursive progress, dead `task_comments` table | OrcaTask | High | 🟡 PARTIAL | [BUG-TG-01](../logic-v1/BUG-TG-01-task-graph-structural-management-partial.md) |
| [BUG-TASKV1-002](./BUG-TASKV1-002-orcatask-ai-decompose-incomplete.md) | AI Decompose only parses a bare title — no dependencies/estimates/prompt templates | OrcaTask | Medium | 🟡 PARTIAL | [BUG-TG-02](../logic-v1/BUG-TG-02-ai-task-planning-partial.md) |
| [BUG-TASKV1-003](./BUG-TASKV1-003-orcatask-access-control-model-mismatch.md) | Grant model is Owner/Admin/User/Team/Company (grantee-kind), not view<comment<edit<execute<manage; team grants still dead | OrcaTask | High | 🟡 PARTIAL | [BUG-TG-03](../logic-v1/BUG-TG-03-task-access-control-partial.md) |
| [BUG-TASKV1-004](./BUG-TASKV1-004-orcatask-run-agent-execution-gaps.md) | No permission pre-check, no status revert on failure, `ComplexExecutor` still a pure stub (design exists, unbuilt) | Task Execute | Critical | 🟡 PARTIAL | [BUG-TG-04](../logic-v1/BUG-TG-04-task-agent-execution-partial.md) + [SOL-TG-04](../logic-v1/solutions/SOL-TG-04-task-agent-execution.md) + [TASK-TG-04-01..05](../logic-v1/tasks/) |
| [BUG-TASKV1-005](./BUG-TASKV1-005-task-execute-orchestration-coordinator-not-autonomous.md) | **New finding**: `orchestration-service` has no `StartCoordinatorRun`, no background loop, dead `messages` table — 5-6 of 11 TDD-sketched RPCs missing | Task Execute | Critical | ❌ NOT_IMPLEMENTED | none (new) |
| [BUG-TASKV1-006](./BUG-TASKV1-006-workflow-target-resolution-and-step-types-gap.md) | No `project:<id>`/`server:<id>`/`fleet:tag:<tag>` target resolution; no `action`/`parallel` step types | Workflow Orchestration | High | 🟡 PARTIAL | [BUG-WF-02](../logic-v1/BUG-WF-02-workflow-execution-partial.md) |
| [BUG-TASKV1-007](./BUG-TASKV1-007-workflow-sharing-not-implemented.md) | Scope still company/team/personal only — no public visibility, share link, or fork/clone | Workflow Orchestration | High | ❌ NOT_IMPLEMENTED | [BUG-WF-01](../logic-v1/BUG-WF-01-workflow-template-sharing-fields-missing.md) + [BUG-WF-03](../logic-v1/BUG-WF-03-workflow-sharing-not-implemented.md) |
| [BUG-TASKV1-008](./BUG-TASKV1-008-dual-backend-routing-and-postgres-compliance.md) | backend-go is 100% Postgres (compliant), but production still runs Node/SQLite for all 3 systems | All 3 (meta) | High | 🔵 OPEN | [CR-FLOW-TASK-004](../../../../docs/crs/v3/flow-task/CR-FLOW-TASK-004-backend-go-cutover-and-node-sqlite-retirement.md) |

## Postgres-compliance summary

The user's standing requirement is: **mọi thông tin phải lưu Postgres tập
trung, không SQLite.** Current status, split by layer:

| Layer | Status | Evidence |
|---|---|---|
| `backend-go` source code (all services, incl. all 3 Task systems) | ✅ **Compliant** | `grep -rli sqlite backend-go/` → 0 matches. All persistence is `pgx`-based Postgres repositories. |
| `backend-go`'s database topology | ✅ **Compliant by design** | Database-per-service (16 databases) on **one** shared Postgres instance (`backend-go/deploy/postgres-init-databases.sh`) — deliberate architecture per `specs/backend-go/tdd/architecture/05-data-architecture.md`, not a violation of "centralized Postgres." |
| Production deployment (`deploy/prod/docker-compose.yml`) | ❌ **Non-compliant** | Still the Node backend, SQLite-backed, zero backend-go containers. |
| Desktop Electron app | ❌ **Non-compliant** | `desktop/src/main/task/task-rpc-handler.ts` / `workflow/workflow-rpc-handler.ts` still serve all 3 systems via the Node/SQLite backend. |

See [BUG-TASKV1-008](./BUG-TASKV1-008-dual-backend-routing-and-postgres-compliance.md)
for full detail and the existing cutover plan
([CR-FLOW-TASK-004](../../../../docs/crs/v3/flow-task/CR-FLOW-TASK-004-backend-go-cutover-and-node-sqlite-retirement.md)),
whose own stated acceptance gate is every ❌/🟡 row in the table above
reaching ✅.

## What this directory doesn't do

- It does not re-litigate or restate `logic-v1`'s detailed findings —
  every bug above cross-references the original and adds only a
  current-code re-verification.
- It does not cover WS-channel wiring — that was `missing-v1`'s scope
  (`BUG-030`/`BUG-034`/`BUG-018`), and this pass independently re-confirmed
  all three are now genuinely resolved: `channels_workflow.go` wires 11
  `workflow.*` methods, `channels_automation_task.go` wires all 7 `task.*`
  methods the frontend calls, and `channels_orchestration.go` wires
  `orchestration.dispatchShow` — none of that wiring gap is re-reported
  here.
- It does not cover the cross-service event-bus integration gap
  (agent-complete → task auto-advance, commit-message → task-close,
  workflow-step → git-sync) — that is `../logic-v1/BUG-PW-04-workspace-integration-not-implemented.md`
  and its paired `SOL-PW-04`/`TASK-PW-04-03/06/07/08`, both already fully
  designed; no new bug is filed here for it since it isn't OrcaTask/Task
  Execute/Workflow-Orchestration-specific in the way this directory's scope
  requires (it's a genuinely cross-cutting gap spanning task-service,
  workflow-service, orchestration-service, git-gateway-service, and
  api-gateway together).
- It does not cover the automation event-trigger gap
  (`../logic-v1/BUG-AT-03-event-trigger-not-implemented.md`) — `automation-service`
  is a distinct system from the 3 this directory scopes to.
