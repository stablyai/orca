# SOL-TASKV1-002: AI Decompose incomplete — see SOL-TG-02

**Resolves:** [BUG-TASKV1-002](../BUG-TASKV1-002-orcatask-ai-decompose-incomplete.md)
**Full solution:** [SOL-TG-02-ai-task-planning](../../logic-v1/solutions/SOL-TG-02-ai-task-planning.md)
**Status:** 📋 Proposed — not yet implemented

Giải pháp đầy đủ đã được thiết kế tại solution gốc ở trên — KHÔNG lặp lại nội
dung ở đây. Bug này (task-v1 framing) chỉ là xác nhận lại từ góc nhìn "3 hệ
Task" rằng solution gốc vẫn là hướng fix đúng, chưa implement (re-verified:
`ai_decompose.go`'s `buildDecomposePrompt`/`parseSubtaskProposals` and
`domain.SubtaskProposal{Title, Description}` are confirmed byte-for-byte
unchanged from the state SOL-TG-02 was designed against).

## Tóm tắt điểm chính

SOL-TG-02 widens the decompose context bundle (description/`aiContext`/
project tech-stack via a new `git-gateway-service`-backed
`TechStackDetector`/velocity data), switches `parseSubtaskProposals` to
structured JSON parsing so `SubtaskProposal` can carry `type`/
`estimated_hours`/`depends_on`/`prompt_template`, makes `AIApply` create
real `depends_on` edges between siblings (not just `parent_child`), and
adds a pure `CalculateCriticalPath` DAG algorithm plus a new
`GenerateAgentPrompt` RPC.

## Điều chỉnh/bổ sung cần lưu ý

Không có, áp dụng nguyên vẹn solution gốc. Depends on
[SOL-TASKV1-001](./SOL-TASKV1-001-orcatask-data-model-and-state-machine-gap.md)
landing first for `domain.Task.Description`/`AIContext`, which this
solution's richer context bundle reads from.
