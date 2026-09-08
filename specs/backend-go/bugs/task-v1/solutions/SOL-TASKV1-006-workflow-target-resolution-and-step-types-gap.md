# SOL-TASKV1-006: Workflow target resolution and step-types gap — see SOL-WF-02

**Resolves:** [BUG-TASKV1-006](../BUG-TASKV1-006-workflow-target-resolution-and-step-types-gap.md)
**Full solution:** [SOL-WF-02-execution-server-provider-interpolation-streaming](../../logic-v1/solutions/SOL-WF-02-execution-server-provider-interpolation-streaming.md)
**Status:** 📋 Proposed — not yet implemented

Giải pháp đầy đủ đã được thiết kế tại solution gốc ở trên — KHÔNG lặp lại nội
dung ở đây. Bug này (task-v1 framing) chỉ là xác nhận lại từ góc nhìn "3 hệ
Task" rằng solution gốc vẫn là hướng fix đúng, chưa implement (re-verified:
`StepType`'s 5-value enum at `step.go:14-22`, no `action`/`parallel`
variants, confirmed unchanged; zero `fleet:tag`/`ServerResolver` matches
across `workflow-service`, `orchestration-service`, `infra-fleet-service`).

## Tóm tắt điểm chính

SOL-WF-02 adds a `ServerResolver` port (project/server/fleet-tag target
resolution, with `infra-fleet-service` gaining a `DevServer.tags` column +
tag-filtered list RPC), a `ProviderResolver` port for `agent` steps, a
`{{...}}` variable-interpolation engine, two new step executors
(`action_step_executor.go`, `parallel_step_executor.go`), and a live
`StreamExecutionEvents` gRPC + `workflow.execution.subscribe` WS channel to
replace point-in-time polling.

## Điều chỉnh/bổ sung cần lưu ý

Không có, áp dụng nguyên vẹn solution gốc.
