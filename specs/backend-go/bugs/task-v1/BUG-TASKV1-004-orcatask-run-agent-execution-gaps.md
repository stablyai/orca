# BUG-TASKV1-004: Run Agent skips permission pre-check, and `ComplexExecutor` remains a pure stub — a designed-but-unbuilt gap, not an undesigned one

**Business Logic:** [BL-TG-04](../../../../docs/logic/task-graph/BL-TG-04-task-agent-execution.md) — Task Prompt → Agent Execution
**Service:** `task-service`
**File:** `backend-go/services/task-service/internal/usecase/execute_task.go`
**Priority:** P0
**Status:** PARTIAL
**Severity:** Critical
**Symptom:** `ExecuteTask.Execute` never calls `ResolvePermission` before dispatching, and never reverts a task's status if dispatch fails — a task whose dev server is offline is left `in_progress` forever. `ComplexExecutor` (`complex_executor.go:24-26`) is still a pure stub returning a fabricated `"stub-orchestration-exec:..."` string — any task with subtasks or dependencies "succeeds" without ever actually running.

---

## Spec summary

BL-TG-04 specifies "Run Agent from Task": a pre-check (permission + dev-server-online), worktree reuse-or-create, a rich task-context preamble, task-scoped env vars, session/worktree linkage back onto the task, PTY output streaming into a Task Activity Feed, auto-advance to `review` on completion, and batch multi-task execution in dependency order.

## What backend-go has (confirmed current)

- `ExecuteTask.Execute` (`backend-go/services/task-service/internal/usecase/execute_task.go:48-76`) still: (1) marks the task `StatusInProgress` via `repo.UpdateStatus` **before** determining complexity (`execute_task.go:57-59`), (2) branches simple-vs-complex via `isComplex` (`execute_task.go:80-94`, a real, unit-tested check for outgoing `parent_child`/`depends_on` edges), (3) dispatches to `uc.simple`/`uc.complex`, and (4) never reverts the `in_progress` status if the dispatch call errors (`execute_task.go:72-74`: the error is wrapped and returned, no compensating status write). This exact bug (a permanently "false in_progress" task on any dispatch failure) is confirmed still present.
- No call to `ResolvePermission` (or any permission check) exists anywhere in `ExecuteTask.Execute` — confirmed by reading the full current file: it only calls `tenant.RequireTenantID`, `repo.UpdateStatus`, `uc.isComplex`, and the two executors. A caller with zero grants on a task can still dispatch a real agent run against it.
- `SimpleExecutor.Execute` (`backend-go/services/task-service/internal/adapter/grpcclient/simple_executor.go:132-193`) is confirmed still real (not a stub): it resolves the task's dev-server connection via `ProjectExecutionResolver.ResolveConnection` (`simple_executor.go:137`) and relays a prompt via `infrafleetv1.InfraFleetServiceClient` — genuinely reaching the Dev Server Agent. `buildExecutePrompt` (`simple_executor.go:187-193`) still sends only the task's bare title — no description/`aiContext`/parent/completed-dependency context, because `domain.Task` still has none of those fields (see BUG-TASKV1-001).
- `StubComplexExecutor.Execute` (`backend-go/services/task-service/internal/adapter/grpcclient/complex_executor.go:24-26`) is confirmed byte-for-byte unchanged: `return fmt.Sprintf("stub-orchestration-exec:%s:%s", taskID, requestID), nil` — no call to `orchestration-service`, no worker dispatch, nothing.
- `task.execute`/`task.list`/`task.update`/`task.delete`/`task.getDependencies`/`task.aiDecompose`/`task.aiApply` are now all wired into `wscompat` — confirmed at `backend-go/services/api-gateway/internal/adapter/wscompat/channels_automation_task.go:223,239,258,282,296,311,326` — so the WS-wiring gap `missing-v1/BUG-034` originally reported is now closed; the RPCs are reachable end-to-end, they are simply not fully functional for a complex task.

## What's missing — but already fully designed

This is a "not yet implemented" gap, not a "not yet designed" one: [SOL-TG-04](../logic-v1/solutions/SOL-TG-04-task-agent-execution.md) already specifies, in concrete Go/proto form, everything below, broken into buildable units in [TASK-TG-04-01 through 08](../logic-v1/tasks/):

- Permission pre-check + status-revert-on-failure ([TASK-TG-04-01](../logic-v1/tasks/TASK-TG-04-01-execute-task-permission-precheck-and-status-revert.md))
- Worktree reuse-or-create adapter ([TASK-TG-04-02](../logic-v1/tasks/TASK-TG-04-02-worktree-provisioner-adapter.md), [TASK-TG-04-03](../logic-v1/tasks/TASK-TG-04-03-execute-task-worktree-and-inline-completion.md))
- A real `ComplexExecutor` calling `orchestration-service.StartCoordinatorRun` ([TASK-TG-04-04](../logic-v1/tasks/TASK-TG-04-04-real-complex-executor.md)) — **note**: `StartCoordinatorRun` itself does not exist in `orchestration-service` yet either (see BUG-TASKV1-005), so this task-service-side change alone cannot land without that RPC first.
- A `ReportTaskExecutionResult` inbound completion callback for the complex path ([TASK-TG-04-05](../logic-v1/tasks/TASK-TG-04-05-report-task-execution-result.md))
- Context preamble + env-var injection, reusing the Dev Server Agent's already-supported `env` param — no `agent/` change needed ([TASK-TG-04-06](../logic-v1/tasks/TASK-TG-04-06-context-preamble-env-injection.md))
- Batch/topological-wave execution ([TASK-TG-04-07](../logic-v1/tasks/TASK-TG-04-07-execute-batch-topological-waves.md))
- PTY output streaming is explicitly flagged as needing cross-repo `agent/` + `infra-fleet-service` work, deliberately left undesigned in detail pending prioritization ([TASK-TG-04-08](../logic-v1/tasks/TASK-TG-04-08-flag-pty-streaming-gap.md))

None of these tasks show any evidence of having landed in the current codebase — `execute_task.go`, `complex_executor.go`, and `simple_executor.go` are all confirmed identical in shape to what BUG-TG-04/SOL-TG-04 describe as the pre-solution state.

## See also

- [`logic-v1/BUG-TG-04-task-agent-execution-partial.md`](../logic-v1/BUG-TG-04-task-agent-execution-partial.md) — full original audit with complete citations.
- [`logic-v1/solutions/SOL-TG-04-task-agent-execution.md`](../logic-v1/solutions/SOL-TG-04-task-agent-execution.md) — the detailed implementation design referenced above. **Do not re-derive this design** — implement against it directly.
- [`logic-v1/tasks/TASK-TG-04-01..05.md`](../logic-v1/tasks/) — buildable task breakdown named explicitly in this bug's originating brief.
- [BUG-TASKV1-005](./BUG-TASKV1-005-task-execute-orchestration-coordinator-not-autonomous.md) — `StartCoordinatorRun`, the RPC TASK-TG-04-04's real `ComplexExecutor` needs to call, does not exist in `orchestration-service` today.

## References

- `backend-go/services/task-service/internal/usecase/execute_task.go:48-94` — `ExecuteTask.Execute` (no permission check, no status revert)
- `backend-go/services/task-service/internal/adapter/grpcclient/complex_executor.go:8-26` — `StubComplexExecutor` (unchanged pure stub)
- `backend-go/services/task-service/internal/adapter/grpcclient/simple_executor.go:132-193` — `SimpleExecutor.Execute` (real relay, minimal prompt)
- `backend-go/services/api-gateway/internal/adapter/wscompat/channels_automation_task.go:223-326` — confirms all 7 `task.*` methods are now WS-wired
