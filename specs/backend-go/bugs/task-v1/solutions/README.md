# task-v1 Solutions — Index

Solutions for the 8 bugs in [`../`](../README.md) (`BUG-TASKV1-001..008`).
Per this directory's own framing (`../README.md`: "this is not a new
independent audit"), most of these bugs already have a full solution
designed elsewhere — those get a short **Type A pointer** file here rather
than a re-derived design. Only one bug (`BUG-TASKV1-005`) had no solution
anywhere in the repo and gets a **Type B full design** here.

| Bug | Solution | Type | Status |
|---|---|---|---|
| [BUG-TASKV1-001](../BUG-TASKV1-001-orcatask-data-model-and-state-machine-gap.md) — data model has 4 statuses, no progress cascade, dead `task_comments` | [SOL-TASKV1-001](./SOL-TASKV1-001-orcatask-data-model-and-state-machine-gap.md) → [SOL-TG-01](../../logic-v1/solutions/SOL-TG-01-task-graph-structural-management.md) | A (pointer) | 📋 Proposed |
| [BUG-TASKV1-002](../BUG-TASKV1-002-orcatask-ai-decompose-incomplete.md) — AI Decompose only parses a bare title | [SOL-TASKV1-002](./SOL-TASKV1-002-orcatask-ai-decompose-incomplete.md) → [SOL-TG-02](../../logic-v1/solutions/SOL-TG-02-ai-task-planning.md) | A (pointer) | 📋 Proposed |
| [BUG-TASKV1-003](../BUG-TASKV1-003-orcatask-access-control-model-mismatch.md) — grantee-kind model, dead team grants | [SOL-TASKV1-003](./SOL-TASKV1-003-orcatask-access-control-model-mismatch.md) → [SOL-TG-03](../../logic-v1/solutions/SOL-TG-03-task-access-control.md) | A (pointer) | 📋 Proposed |
| [BUG-TASKV1-004](../BUG-TASKV1-004-orcatask-run-agent-execution-gaps.md) — no permission pre-check, `ComplexExecutor` a pure stub | [SOL-TASKV1-004](./SOL-TASKV1-004-orcatask-run-agent-execution-gaps.md) → [SOL-TG-04](../../logic-v1/solutions/SOL-TG-04-task-agent-execution.md) + [TASK-TG-04-01..08](../../logic-v1/tasks/) | A (pointer) | 📋 Proposed — blocked on SOL-TASKV1-005 for TASK-04 only |
| [BUG-TASKV1-005](../BUG-TASKV1-005-task-execute-orchestration-coordinator-not-autonomous.md) — `orchestration-service` has no `StartCoordinatorRun`, no autonomous loop | [SOL-TASKV1-005](./SOL-TASKV1-005-task-execute-orchestration-coordinator-not-autonomous.md) | **B (new design)** | 📋 Proposed |
| [BUG-TASKV1-006](../BUG-TASKV1-006-workflow-target-resolution-and-step-types-gap.md) — no server-target resolution, no `action`/`parallel` steps | [SOL-TASKV1-006](./SOL-TASKV1-006-workflow-target-resolution-and-step-types-gap.md) → [SOL-WF-02](../../logic-v1/solutions/SOL-WF-02-execution-server-provider-interpolation-streaming.md) | A (pointer) | 📋 Proposed |
| [BUG-TASKV1-007](../BUG-TASKV1-007-workflow-sharing-not-implemented.md) — scope still company/team/personal, no public/share/fork | [SOL-TASKV1-007](./SOL-TASKV1-007-workflow-sharing-not-implemented.md) → [SOL-WF-01](../../logic-v1/solutions/SOL-WF-01-template-authoring-fields.md) + [SOL-WF-03](../../logic-v1/solutions/SOL-WF-03-workflow-sharing-library.md) | A (pointer) | 📋 Proposed |
| [BUG-TASKV1-008](../BUG-TASKV1-008-dual-backend-routing-and-postgres-compliance.md) — production still Node/SQLite, backend-go only in `deploy/dev` | [SOL-TASKV1-008](./SOL-TASKV1-008-dual-backend-routing-and-postgres-compliance.md) → [CR-FLOW-TASK-004](../../../../../docs/crs/v3/flow-task/CR-FLOW-TASK-004-backend-go-cutover-and-node-sqlite-retirement.md) | A (pointer) | 🔵 Proposed |

## Reading order / dependency notes

None of the 8 solutions above are implemented yet. Sequencing worth
noting when planning implementation (not a new finding — each point is
already stated inside its own solution file, collected here for
convenience):

- **SOL-TASKV1-001 before 002/003/004**: SOL-TG-02/03/04 all read
  `domain.Task` fields (`Description`/`AIContext`, `OwnerID`,
  `worktree_id`/`agent_session_id`/`active_execution_id`) that
  SOL-TASKV1-001/SOL-TG-01 adds.
- **SOL-TASKV1-005 before SOL-TASKV1-004's TASK-TG-04-04**: the real
  `ComplexExecutor` (TASK-TG-04-04) calls `orchestration-service.StartCoordinatorRun`,
  which does not exist until SOL-TASKV1-005 lands. Every other
  TASK-TG-04 unit (01/02/03/06/07/08) is unblocked today.
- **SOL-TASKV1-007's own two halves are ordered**: SOL-WF-01's
  `0007_template_authoring_fields` migration must land before SOL-WF-03's
  `0008_template_visibility_sharing` migration.
- **SOL-TASKV1-008 (CR-FLOW-TASK-004) is gated on all of the above**: its
  own Phase 1 acceptance criterion is every ❌/🟡 row in
  [`../README.md`](../README.md) reaching ✅ — it is intentionally the
  last item to close, not a parallel-track item.

## What this index doesn't do

It does not re-litigate whether the *original* audits in `BUG-TASKV1-001..008`
are still accurate — each pointer file above re-confirms its bug's status
against the live `backend-go` source as of 2026-09-08 but does not repeat
the full cross-check; see each bug file's own "What backend-go has
(confirmed current)" section for that.
