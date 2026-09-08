# SOL-AGENT-TASKV1-004: `workflow-service.AgentExecutor` phải đổi `agent.exec` → `agent.execPrompt` — đã có thiết kế đầy đủ ở backend-go (`SOL-PRF-04`/`TASK-PRF-04-06`), không phải gap mới

**Giải quyết:** [BUG-AGENT-TASKV1-004](../BUG-AGENT-TASKV1-004-workflow-service-agent-step-executor-still-broken.md)

## Gap này nằm ở đâu?

**✅ Không nằm ở `agent/`.** Cả 2 RPC (`agent.exec` và `agent.execPrompt`)
đã tồn tại đúng, đủ, và hoạt động — xác nhận đọc trực tiếp
`agent/src/relay/agent-rpc-dispatch-agent-exec.ts:72` (`agent.exec`, params
`{binary, args?, cwd?, stdin?, env?, timeoutMs?}`) và `:176`
(`agent.execPrompt`, params `{prompt, worktreePath, trustPreset?, model?,
accountId?, stepId?, env?, timeoutMs?}` — xem chi tiết ở
`agent-print-mode-exec.ts:39-58`). Gap 100% ở **backend-go**:
`workflow-service`'s `AgentExecutor` (`agent_step_executor.go:22,26-29`) gọi
`agent.exec` nhưng gửi params shape của `agent.execPrompt`
(`{prompt, worktreePath, trustPreset}`) — mọi step `agent` sẽ fail
`InvalidParams` vì `agent.exec` yêu cầu field `binary` (bắt buộc) mà request
không có.

## Đối chiếu backend-go đã track chưa — ĐÃ TRACK, có thiết kế đầy đủ

Nhiệm vụ audit yêu cầu kiểm tra xem gap này đã được backend-go ghi nhận
chưa trước khi kết luận "gap chưa track". Kết quả tra cứu thực tế (đọc
`specs/backend-go/bugs/logic-v1/`, KHÔNG chỉ giới hạn ở `task-v1/` như audit
gốc — đây là phát hiện bổ sung của solution này):

**Đã được track đầy đủ**, dưới `logic-v1` (không phải `task-v1`), vì gap này
được phát hiện trong lúc audit 1 tính năng rộng hơn ("Profile-Aware Agent
Execution Routing" — `BL-PRF-04`), không phải tính năng Workflow riêng:

1. [`BUG-PRF-04-profile-aware-agent-execution-not-implemented.md`](../../../../backend-go/bugs/logic-v1/BUG-PRF-04-profile-aware-agent-execution-not-implemented.md)
   dòng 31: *"The relay method name itself is flagged unverified:
   `agent_step_executor.go:14-25`'s own doc comment says the `"agent.exec"`
   vs `"agent.execPrompt"` reconciliation ... was not confirmed"* — ghi nhận
   đúng vấn đề, dùng để scope `BUG-PRF-04`.
2. [`SOL-PRF-04-profile-aware-agent-execution.md`](../../../../backend-go/bugs/logic-v1/solutions/SOL-PRF-04-profile-aware-agent-execution.md)
   §"The relay method is `agent.execPrompt`, not `agent.exec`" (dòng 56-76)
   — thiết kế đầy đủ, kết luận **giống hệt** kết luận của
   BUG-AGENT-TASKV1-004 (đối chiếu `agentExecParams`'s field 1:1 với
   `agent.execPrompt`, 0% khớp `agent.exec`), và đưa code sửa cụ thể (dòng
   320-362): đổi `agentExecMethod` → `agentExecPromptMethod = "agent.execPrompt"`,
   build lại `params` gồm `Prompt/WorktreePath/StepID/TrustPreset/Model/Env`.
3. [`TASK-PRF-04-06-workflow-service-agent-executor-env-injection.md`](../../../../backend-go/bugs/logic-v1/tasks/TASK-PRF-04-06-workflow-service-agent-executor-env-injection.md)
   — task thực thi cụ thể, có sẵn regression test plan (dòng 158-162):
   *"assert the relay call's method string is `"agent.execPrompt"`
   unconditionally"* — đúng chính xác test mà BUG-AGENT-TASKV1-004 đề xuất.

**Kết luận: đây KHÔNG PHẢI 1 gap chưa được track ở backend-go.** Task-brief
yêu cầu "nếu CHƯA có, ghi rõ đây là gap chưa track" — nhưng tra cứu cho thấy
NGƯỢC LẠI: gap đã có bug + solution + task thực thi đầy đủ, chỉ nằm ở
`bugs/logic-v1/` thay vì `bugs/task-v1/` (khác thư mục vì lịch sử audit khác
nhau, không phải vì bị bỏ sót). Điểm cần lưu ý duy nhất: `SOL-PRF-04`'s scope
**rộng hơn** BUG-AGENT-TASKV1-004 — nó không chỉ đổi method name mà còn thêm
toàn bộ profile-resolution (resolve `tenant-service.GetResolvedProfile`,
build env/args/preamble theo `BL-PRF-04`'s 8 bước) — nên nếu team muốn fix
**tối thiểu** (chỉ đổi method name, chưa làm profile-aware), có thể cherry-pick
riêng đoạn đổi method name từ `TASK-PRF-04-06` mà không cần đợi toàn bộ
`SOL-PRF-04` triển khai.

## Không cần thay đổi gì ở `agent/`

Giống kết luận gốc của bug: `agent.execPrompt`'s response
(`{stdout, stderr, exitCode, timedOut, stepId}` —
`agent-print-mode-exec.ts:25-31,177`) đã đủ để `AgentExecutor`'s
`toStepResult`/`execResult` parse, miễn là backend-go cập nhật struct decode
đúng field (task này thuộc `SOL-PRF-04`/`TASK-PRF-04-06`'s scope, không phải
`agent/`).

## Đề xuất

- **agent/**: không có action nào.
- **backend-go**: áp dụng đúng `SOL-PRF-04`/`TASK-PRF-04-06`'s thay đổi cho
  `agent_step_executor.go` — ưu tiên P0 vì mọi step `agent` qua
  `workflow-service` hôm nay fail 100%. Nếu profile-aware injection
  (toàn bộ `SOL-PRF-04`) cần thời gian dài hơn để hoàn thiện, tách riêng
  phần đổi method name (`TASK-PRF-04-06`'s phần "Fix `agent.exec` ->
  `agent.execPrompt`") làm hotfix trước, phần profile-resolution làm sau.

## Kết luận / Status

**✅ Không cần action ở `agent/`.** Gap 100% ở `workflow-service`
(backend-go), và **đã có bug + solution + task thực thi đầy đủ** tại
`specs/backend-go/bugs/logic-v1/{BUG-PRF-04,solutions/SOL-PRF-04,tasks/TASK-PRF-04-06}`
— không cần tạo bug mới, chỉ cần backend-go triển khai đúng thiết kế đã có.

## Tham khảo

- [`specs/backend-go/bugs/logic-v1/BUG-PRF-04-profile-aware-agent-execution-not-implemented.md`](../../../../backend-go/bugs/logic-v1/BUG-PRF-04-profile-aware-agent-execution-not-implemented.md)
- [`specs/backend-go/bugs/logic-v1/solutions/SOL-PRF-04-profile-aware-agent-execution.md`](../../../../backend-go/bugs/logic-v1/solutions/SOL-PRF-04-profile-aware-agent-execution.md)
- [`specs/backend-go/bugs/logic-v1/tasks/TASK-PRF-04-06-workflow-service-agent-executor-env-injection.md`](../../../../backend-go/bugs/logic-v1/tasks/TASK-PRF-04-06-workflow-service-agent-executor-env-injection.md)

## Trích dẫn file:line (đọc trực tiếp, 2026-09-08)

- `agent/src/relay/agent-rpc-dispatch-agent-exec.ts:72,176` — 2 handler thật, xác nhận shape khác nhau (không đổi).
- `agent/src/relay/agent-print-mode-exec.ts:25-31,39-58,177` — `agent.execPrompt`'s params/response shape đầy đủ.
- `specs/backend-go/bugs/logic-v1/solutions/SOL-PRF-04-profile-aware-agent-execution.md:56-76,320-362` — thiết kế fix đã có sẵn, đối chiếu 1:1 với kết luận của bug này.
