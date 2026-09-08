# SOL-TASKV1-001: OrcaTask data model gap — see SOL-TG-01

**Resolves:** [BUG-TASKV1-001](../BUG-TASKV1-001-orcatask-data-model-and-state-machine-gap.md)
**Full solution:** [SOL-TG-01-task-graph-structural-management](../../logic-v1/solutions/SOL-TG-01-task-graph-structural-management.md)
**Status:** 📋 Proposed — not yet implemented

Giải pháp đầy đủ đã được thiết kế tại solution gốc ở trên — KHÔNG lặp lại nội
dung ở đây. Bug này (task-v1 framing) chỉ là xác nhận lại từ góc nhìn "3 hệ
Task" rằng solution gốc vẫn là hướng fix đúng, chưa implement (re-verified
against live `backend-go` source as of 2026-09-08 — no line cited in
BUG-TASKV1-001 has changed since SOL-TG-01 was written).

## Tóm tắt điểm chính

SOL-TG-01 widens `domain.Task` with the ~15 missing fields
(`description`/`type`/`priority`/`labels`/`assignee_id`/etc.), adds
`StatusBlocked` to the status enum, adds a pure `CalculateProgress()` +
`GetSubtree` RPC (BFS subtree read), and lands `task_comments` read/write
(`AddComment`/`ListComments`) via a new `0003_task_fields_and_comments`
migration — closing every gap BUG-TASKV1-001 re-confirms. It also adds an
auto-block transition on `AddEdge` for `depends_on` edges, fixing the
"depends_on never touches status" gap this bug calls out.

## Điều chỉnh/bổ sung cần lưu ý

Không có, áp dụng nguyên vẹn solution gốc. One forward-reference worth
noting for sequencing only: [SOL-TG-04](../../logic-v1/solutions/SOL-TG-04-task-agent-execution.md)
(→ [SOL-TASKV1-004](./SOL-TASKV1-004-orcatask-run-agent-execution-gaps.md))
depends on the `worktree_id`/`agent_session_id`/`active_execution_id`/
`actual_hours` fields this solution adds — implement SOL-TG-01 before
SOL-TG-04's field-dependent parts land.
