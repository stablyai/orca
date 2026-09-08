# BUG-TASKV1-001: OrcaTask data model has 4 statuses (no backlog/todo/review/blocked), no recursive progress, and a dead `task_comments` table

**Business Logic:** [BL-TG-01](../../../../docs/logic/task-graph/BL-TG-01-task-graph-crud.md) — Task Graph CRUD & Structural Management
**Service:** `task-service`
**File:** `backend-go/services/task-service/internal/domain/task.go`
**Priority:** P0
**Status:** PARTIAL
**Severity:** High
**Symptom:** A task can only ever be `open`/`in_progress`/`done`/`cancelled` — there is no `backlog`, `todo`, `review`, or `blocked` state, so a task can never be represented as "blocked on a dependency" even though `AddEdge` lets a caller create a `depends_on` edge that should imply exactly that. Progress is never computed for a parent task from its subtasks. A `task.task_comments` table exists in the schema (with RLS) but zero lines of Go code anywhere in `task-service` reference it.

---

## Spec summary

BL-TG-01 defines a `orca_tasks` table with ~20 fields (description, type, priority, labels, assignee/reporter/owner, due_date, estimated/actual hours, prompt_template, ai_context, ai_plan_json, visibility, worktree_id, agent_session_id, workflow_exec_id) plus a 7-value status enum (`backlog/todo/in_progress/blocked/review/done/cancelled`), `orca_task_edges`, `orca_task_grants`, `orca_task_comments`, a `loadTaskTree(rootId)` BFS subtree read, and `calculateProgress()` — a subtask-completion percentage that cascades up to parent tasks.

## What backend-go has (confirmed current)

- `domain.Task` is still exactly `{ID, TenantID, Title, Status, ParentID, ProjectID}` — 6 fields, confirmed at `backend-go/services/task-service/internal/domain/task.go:52-69`, matching the generated proto's `Task` message one-for-one.
- Status is still a closed 4-value enum — `StatusOpen`, `StatusInProgress`, `StatusDone`, `StatusCancelled` (`backend-go/services/task-service/internal/domain/task.go:12-17`). No `StatusBlocked`/`StatusReview`/`StatusBacklog`/`StatusTodo` constant exists anywhere in the package.
- `validStatus` (`task.go:71-78`) only accepts those same 4 values — a `blocked`/`review` status string is rejected as `ErrInvalidStatus` at the domain layer, not merely "unused."
- `task.task_comments` table still exists, unchanged, at `backend-go/services/task-service/migrations/0001_init.up.sql:82-93` (with `ENABLE ROW LEVEL SECURITY` and a tenant-isolation policy), but `grep -rn "TaskComment" backend-go/services/task-service/` returns **0 matches** — confirmed dead schema, not merely under-used.
- CRUD (`CreateTask`, `GetTask`, `ListTasks`, `UpdateTask`, `DeleteTask`) plus `AddEdge` (real cycle-checked `depends_on`/`parent_child` edges) and `GetAncestors` (recursive CTE) are all real and unchanged since the prior audit — none of this bug's "missing" list has been closed since.

## What's missing (re-confirmed against current code, no change since prior audit)

- No `blocked` status value in `domain.Task`'s enum at all — adding a `depends_on` edge never inspects or changes the dependent task's status, and there is no representation for "task A is blocked because task B isn't done" (`task.go:12-17`, `add_edge.go`).
- No `calculateProgress()`/cascade of any kind — `grep -rn "progress\|CalculateProgress" backend-go/services/task-service/internal/` returns no hits outside the literal `"in_progress"` status string.
- No `GetSubtree`/`loadTaskTree`-equivalent RPC — only the ancestor-direction walk (`GetAncestors`, internal-only) exists; a client cannot load "this epic + all its subtasks" in one call.
- Missing ~15 of ~20 spec fields on `domain.Task`/the proto: `description`, `type`, `priority`, `labels`, `assignee_id`, `reporter_id`, `owner_id`, `due_date`, `estimated_hours`, `actual_hours`, `prompt_template`, `ai_context`, `ai_plan_json`, `visibility`, `worktree_id`, `agent_session_id`, `workflow_exec_id` — none exist yet on `domain.Task` or `task.proto`'s `Task` message.
- `task_comments` remains entirely unimplemented — table exists, nothing reads or writes it.

## See also

- [`logic-v1/BUG-TG-01-task-graph-structural-management-partial.md`](../logic-v1/BUG-TG-01-task-graph-structural-management-partial.md) — full original audit (subtree BFS algorithm, access-filtered tree read, `AddEdge`'s non-atomic cycle-check-then-write race) with complete `file:line` citations; this report only re-confirms the status quo is unchanged, it does not restate that audit's full findings.
- [`logic-v1/solutions/SOL-TG-01-task-graph-structural-management.md`](../logic-v1/solutions/SOL-TG-01-task-graph-structural-management.md) — proposed design for the missing fields (referenced by [SOL-TG-04](../logic-v1/solutions/SOL-TG-04-task-agent-execution.md) as the source of `worktree_id`/`agent_session_id`/`active_execution_id`/`actual_hours` this bug's gaps block).

## References

- `backend-go/services/task-service/internal/domain/task.go:12-17,52-69,71-78` — status enum, `Task` struct, `validStatus`
- `backend-go/services/task-service/migrations/0001_init.up.sql:82-93` — `task.task_comments` table (RLS enabled, unused)
- `backend-go/proto/orca/task/v1/task.proto:59-65` — `Task` message, 6 fields
- `backend-go/services/task-service/internal/usecase/add_edge.go` — `depends_on` edge creation never touches dependent task's status
