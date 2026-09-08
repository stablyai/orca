# SOL-TASKV1-004: Run Agent execution gaps — see SOL-TG-04 + TASK-TG-04-01..08

**Resolves:** [BUG-TASKV1-004](../BUG-TASKV1-004-orcatask-run-agent-execution-gaps.md)
**Full solution:** [SOL-TG-04-task-agent-execution](../../logic-v1/solutions/SOL-TG-04-task-agent-execution.md), broken into buildable units in [TASK-TG-04-01 through 08](../../logic-v1/tasks/)
**Status:** 📋 Proposed — not yet implemented

Giải pháp đầy đủ đã được thiết kế tại solution gốc ở trên — KHÔNG lặp lại nội
dung ở đây. Bug này (task-v1 framing) chỉ là xác nhận lại từ góc nhìn "3 hệ
Task" rằng solution gốc vẫn là hướng fix đúng, chưa implement: `execute_task.go`,
`complex_executor.go`, and `simple_executor.go` are all confirmed identical
in shape to what SOL-TG-04 describes as its pre-solution state (no
permission pre-check, no status-revert-on-failure, `StubComplexExecutor`
still a byte-for-byte pure stub).

## Tóm tắt điểm chính

SOL-TG-04 is split into 8 buildable tasks: permission pre-check +
status-revert-on-failure (TASK-01), a worktree reuse-or-create adapter
(TASK-02/03), a real `ComplexExecutor` that calls
`orchestration-service.StartCoordinatorRun` (TASK-04), an inbound
`ReportTaskExecutionResult` completion callback for the complex path
(TASK-05), context-preamble/env-var injection (TASK-06), batch
topological-wave execution (TASK-07), and an explicit flag (not a fix) for
the PTY-streaming gap needing cross-repo `agent/` work (TASK-08).

## Điều chỉnh/bổ sung cần lưu ý

**Hard sequencing dependency, not a design change**: TASK-TG-04-04's real
`ComplexExecutor` calls `orch.StartCoordinatorRun(...)` — that RPC does not
exist in `orchestration-service` today (see
[BUG-TASKV1-005](./SOL-TASKV1-005-task-execute-orchestration-coordinator-not-autonomous.md),
this directory's own new finding). TASK-TG-04-04 cannot land — even though
its own design is already complete — until SOL-TASKV1-005's
`StartCoordinatorRun` server-side handler exists in `orchestration-service`.
Every other TASK-TG-04 unit (01, 02, 03, 06, 07, 08) has no such blocker and
can proceed independently. TASK-TG-04-05's `ReportTaskExecutionResult` is
the `task-service`-side inbound callback; it does not itself require
`orchestration-service` changes to land (it is `task-service` receiving a
call), but it has nothing to receive from until SOL-TASKV1-005's coordinator
loop actually calls it on run completion.
