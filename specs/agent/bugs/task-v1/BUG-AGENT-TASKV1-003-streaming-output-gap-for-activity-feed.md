# BUG-AGENT-TASKV1-003: Không có RPC nào push incremental output cho `agent.execPrompt`/`shell.exec`/`ai.complete` — 3 hệ Task chỉ nhận kết quả 1 lần khi xong (xác nhận vẫn thiếu, chưa implement)

## Mức độ: 🟠 HIGH (chặn Activity Feed thời gian thực — không chặn chức năng chạy task)

## Tóm tắt

`docs/crs/v3/flow-task/CR-FLOW-TASK-003-unified-task-activity-event-catalog.md`
tự flag rõ ở mục "Rủi ro/Không thuộc phạm vi": *"Không giải quyết streaming
stdout liên tục (PTY output real-time) — đã bị SOL-TG-04 flag là cần đổi
`agent/` + `infra-fleet-service`, ngoài phạm vi CR này."* Audit này xác nhận
lại bằng code thật: **đúng, vẫn thiếu, chưa có PR/thay đổi nào implement**.

**Điều CR-FLOW-TASK-003 và SOL-AG-PW-001 CHƯA nói rõ (bổ sung của audit
này):** gap không nằm ở "agent/ thiếu khả năng streaming nói chung" — agent/
**đã có ít nhất 3 cơ chế streaming thật, đang chạy production** cho các mục
đích khác (`pty.data` qua `AttachPty`, `git.execStream`, `git.responseChunk`
cho diff lớn). Gap thật là: **không có RPC nào trong số các RPC mà 3 hệ Task
thực sự gọi hôm nay (`agent.execPrompt`, `shell.exec`, `agent.exec`,
`ai.complete`) dùng bất kỳ cơ chế nào trong số đó** — cả 4 đều thiết kế
buffer-toàn-bộ-rồi-trả-1-lần, không phải vì thiếu hạ tầng streaming mà vì
chưa ai nối chúng vào hạ tầng đó.

## Bảng đối chiếu — RPC nào stream thật, RPC nào buffer toàn bộ

| RPC | 3 hệ Task nào dùng | Streaming thật? | Bằng chứng |
|---|---|---|---|
| `agent.execPrompt` | OrcaTask Run-Agent (`SimpleExecutor`, [BUG-AGENT-TASKV1-001](./BUG-AGENT-TASKV1-001-orcatask-run-agent-execprompt-verification.md)) | ❌ Buffer toàn bộ | `agent-print-mode-exec.ts:126-165` — `child.stdout.on('data', d => stdout += d...)`, chỉ `resolve()` 1 lần ở `child.on('close', ...)`. Trả `{stdout, stderr, exitCode, timedOut}` — 1 response duy nhất |
| `agent.exec` (workflow-service, backend-go — xem [BUG-AGENT-TASKV1-004](./BUG-AGENT-TASKV1-004-workflow-service-agent-step-executor-still-broken.md)) | Workflow step `agent` (path sai hiện tại) | ❌ Buffer toàn bộ | `agent-rpc-dispatch-agent-exec.ts:72` case `agent.exec` — dùng `execFile`-kiểu capture, xem `agent-rpc-catalog-runtime.md` dòng 90 |
| `shell.exec` | Workflow step `shell` | ❌ Buffer toàn bộ (cap 4MB) | `agent-rpc-catalog-runtime.md` dòng 169: `handleShellExec` — `spawn('sh',['-c',script])`, trả `{stdout,stderr,exitCode,truncated?}` sau khi process thoát; không có notification nào trong lúc chạy |
| `ai.complete` | OrcaTask AI-decompose (`TaskAIPlanner.ts`) | ❌ Buffer toàn bộ | `agent-rpc-catalog-runtime.md` dòng 94 — "Single-shot completion", 120s timeout, trả `{content, model?}` 1 lần |
| `agent.spawn` (Task Execute worker, nếu dùng — xem [BUG-AGENT-TASKV1-002](./BUG-AGENT-TASKV1-002-task-execute-worker-dispatch-primitives-unwired.md)) | Task Execute (chưa wired) | ✅ Có streaming thật ở tầng agent/ (notification `agent.output`) | Nhưng không có ai nhận ở backend-go (Gap 2 của BUG-AGENT-TASKV1-002) — streaming tồn tại nhưng "rơi vào hư không" |
| `pty.data` (qua `pty.create`+`AttachPty`) | Không hệ Task nào dùng trực tiếp hôm nay (chỉ Terminal UI) | ✅ Streaming thật, đã production | `agent-rpc-catalog-runtime.md` — "Part A/daemon PTY output — unbatched, immediate" |
| `git.execStream`/`git.responseChunk` | Không liên quan 3 hệ Task (git operations) | ✅ Streaming thật | `agent-rpc-catalog-git-fs.md` — credit-window ack/cancel đầy đủ |

## Vì sao đây không phải "cần code mới hoàn toàn ở agent/"

agent/ đã tự chứng minh nó BIẾT CÁCH làm streaming đúng chuẩn (JSON-RPC
notification, không lẫn với response — bài học chính là BUG-AG-ORCH-006 đã
sửa) và đã làm 3 lần cho 3 mục đích khác nhau
(`pty.data`/`git.execStream`/`git.responseChunk`, mỗi cái có cơ chế
ack/credit-window riêng phù hợp use case). Việc còn thiếu là: **áp dụng
đúng pattern đã có** cho `agent.execPrompt`/`shell.exec` — tức là thêm 1
`onData`/`onChunk` callback bên trong `handleAgentExecPrompt`/
`handleShellExec` để gửi notification `agent.execPrompt.output {stepId,
chunk}` (tên ví dụ) song song với việc buffer để build response cuối, giống
hệt cách `pty.create`'s `pty.onData` vừa append vào scrollback buffer vừa
gửi `pty.data` ngay lập tức (`agent-rpc-catalog-runtime.md`, "Part A/daemon
PTY output — unbatched, immediate").

**Nhưng việc thêm notification phía agent/ chỉ giải quyết được 1 nửa** — nửa
còn lại (ai nhận notification đó ở backend-go) đụng đúng gap đã ghi ở
[BUG-AGENT-TASKV1-002](./BUG-AGENT-TASKV1-002-task-execute-worker-dispatch-primitives-unwired.md)
Gap 2: `infra-fleet-service.Relay` là unary, không có cơ chế nhận notification
ngoài luồng response. **Đây chính là lý do SOL-AG-PW-001 tự đánh giá đây là
"Phase D — rủi ro cao nhất, cross-repo"** và cố tình dừng ở thiết kế, không
code — audit này xác nhận đánh giá đó vẫn đúng hôm nay (agent/ không có code
workflow-execution nào mới kể từ SOL-AG-PW-001 được viết — xem xác nhận bên
dưới).

## Xác nhận SOL-AG-PW-001's checklist vẫn đúng hôm nay

```
$ find agent/src -iname "*workflow*"
agent/src/shared/workflow-types.ts
```

Chỉ 1 file, đúng như SOL-AG-PW-001 §1 mô tả ("pure type definitions...
imported by nothing that dispatches or executes a step") — xác nhận **chưa
có tiến triển nào** kể từ khi solution đó được viết. Câu hỏi mở #3 của
SOL-AG-PW-001 (mismatch `agent.exec` vs `agent.execPrompt` ở
`agent_step_executor.go`) **vẫn CHƯA được giải quyết** — xem
[BUG-AGENT-TASKV1-004](./BUG-AGENT-TASKV1-004-workflow-service-agent-step-executor-still-broken.md)
cho xác nhận chi tiết bằng code thật (khác với `task-service.SimpleExecutor`
đã tự sửa, `workflow-service.AgentExecutor` thì chưa).

## Ảnh hưởng tới CR-FLOW-TASK-003

CR-FLOW-TASK-003 tự giới hạn phạm vi đúng: nó chỉ hợp nhất **sự kiện rời
rạc** (status/step/message qua outbox mới ở `orchestration-service`/
`workflow-service`), không đụng tới stdout stream. Nghĩa là ngay cả khi
CR-FLOW-TASK-003 được implement đầy đủ, `task.activity:{taskId}` frame sẽ
báo được "step X đang chạy" / "step X xong" nhưng **không báo được nội dung
agent đang in ra real-time** — người dùng vẫn phải đợi tới khi step hoàn
tất mới thấy output. Đây là giới hạn SẢN PHẨM cần biết trước khi launch
Activity Feed, không phải điều CR-FLOW-TASK-003 làm sai.

## Đề xuất (theo đúng khuyến nghị của SOL-AG-PW-001 §3, xác nhận lại)

Thứ tự bắt buộc, không đảo được:
1. Sửa `agent_step_executor.go` dùng đúng `agent.execPrompt`
   ([BUG-AGENT-TASKV1-004](./BUG-AGENT-TASKV1-004-workflow-service-agent-step-executor-still-broken.md))
   — nếu không, mọi thiết kế streaming sau đó xây trên 1 RPC mà backend-go
   còn đang gọi sai shape.
2. Thêm 1 RPC streaming mới ở `infra-fleet-service` (giống `AttachPty`) bọc
   `agent.execPrompt`/`shell.exec`'s tiến độ — quyết định wire shape (frame
   mới multiplex trên connection hiện có, theo đúng ràng buộc SOL-AG-PW-001
   §2 mục 1 đã nêu: KHÔNG mở kết nối thứ 2).
3. agent/: thêm notification `chunk` bên trong `handleAgentExecPrompt`/
   `handleShellExec`, tái dùng đúng convention `pty.data` đã có (immediate,
   không cần batch phức tạp vì output CLI-print thường không lớn bằng
   terminal tương tác).
4. Nối vào outbox của CR-FLOW-TASK-003 nếu muốn hợp nhất vào cùng 1 kênh
   `task.activity:{taskId}` — hoặc để riêng như 1 kênh phụ nếu tần suất
   chunk quá cao cho outbox pattern (outbox thường thiết kế cho sự kiện rời
   rạc, không phải byte-stream mật độ cao).

## Tham khảo

- [`docs/crs/v3/flow-task/CR-FLOW-TASK-003-unified-task-activity-event-catalog.md`](../../../../docs/crs/v3/flow-task/CR-FLOW-TASK-003-unified-task-activity-event-catalog.md) — mục "Rủi ro/Không thuộc phạm vi".
- [`specs/agent/crs/v3/project-workspace/solutions/SOL-AG-PW-001-execution-progress-reporting-design.md`](../../crs/v3/project-workspace/solutions/SOL-AG-PW-001-execution-progress-reporting-design.md) — thiết kế đầy đủ, chưa code; audit này xác nhận checklist của nó vẫn đúng nguyên trạng.
- [`specs/agent/bugs/agent-orchestration/BUG-AG-ORCH-006-agent-output-stream-handler-missing.md`](../agent-orchestration/BUG-AG-ORCH-006-agent-output-stream-handler-missing.md) — bài học JSON-RPC notification vs response, đã áp dụng đúng cho `agent.spawn`, chưa áp dụng cho `agent.execPrompt`/`shell.exec`.
- [BUG-AGENT-TASKV1-002](./BUG-AGENT-TASKV1-002-task-execute-worker-dispatch-primitives-unwired.md) — Gap 2 (infra-fleet-service.Relay unary) là nút thắt chung cho cả streaming Task Execute lẫn streaming này.
- [BUG-AGENT-TASKV1-004](./BUG-AGENT-TASKV1-004-workflow-service-agent-step-executor-still-broken.md) — prerequisite phải sửa trước theo SOL-AG-PW-001 §3.

## Trích dẫn file:line

- `agent/src/relay/agent-print-mode-exec.ts:126-165` — `handleAgentExecPrompt`'s buffer-only stdout/stderr capture.
- `specs/agent/api/agent-rpc-catalog-runtime.md` dòng 90,94,169,306-310 — bảng `agent.exec`/`ai.complete`/`shell.exec` (buffer) vs "AI-agent spawn output" (streaming, không consumer).
- `agent/src/shared/workflow-types.ts` — file workflow-liên-quan duy nhất trong `agent/src`, xác nhận SOL-AG-PW-001 §1 vẫn đúng.
- `backend-go/proto/orca/infrafleet/v1/infrafleet.proto:47,104` — `Relay` (unary) vs `AttachPty` (streaming) — hạ tầng đã có nhưng chưa áp dụng cho agent-exec.
