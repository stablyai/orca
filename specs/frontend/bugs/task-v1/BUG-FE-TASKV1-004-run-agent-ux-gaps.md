# BUG-FE-TASKV1-004 — "Run with Agent": input người dùng bị bỏ qua, không Activity Feed, không batch, không comment UI

**Mức độ:** 🟠 High
**Status:** 🔴 Open
**Module:** `frontend/src/renderer/src/components/task/TaskPromptEditor.tsx`, `TaskDetail.tsx`
**Phát hiện:** 2026-09-08 (audit frontend vs 3 hệ Task: OrcaTask/Task Execute/Workflow Orchestration)

---

## Mô tả

### 1. Prompt người dùng gõ bị bỏ qua hoàn toàn

`TaskPromptEditor.tsx` cho user gõ 1 đoạn hướng dẫn agent vào `<textarea>`
(state `prompt`, dòng 11, 43-49), nút "Run with Agent" bị disable khi
`!prompt.trim()` (dòng 52) — UI trông như thể nội dung gõ sẽ được gửi đi. Nhưng
`runWithAgent()` (dòng 15-39) gọi `task.execute` với `{ taskId, projectId,
worktreePath, traceId }` — **không có field `prompt` nào trong payload gửi
đi**. Comment tự thú ngay tại chỗ (dòng 24-25):

> `// task.execute has no 'prompt' param — the executor builds the agent
> prompt server-side from the task's own promptTemplate
> (TaskAgentExecutor.buildPrompt).`

Nghĩa là: dù user gõ gì vào textarea, agent luôn chạy theo `promptTemplate`
đã lưu sẵn của task (field tồn tại từ trước, đọc lúc mount ở dòng 11:
`useState(task.promptTemplate ?? '')`) — nội dung gõ **mới** trong phiên này
chỉ tồn tại trong local state React, biến mất khi unmount, không bao giờ tới
backend. Đây là 1 UX-lie nghiêm trọng: nút bị disable dựa theo nội dung
textarea (ngụ ý nó quan trọng) nhưng nội dung đó hoàn toàn không ảnh hưởng gì
tới hành vi thật của agent.

### 2. Không có Activity Feed streaming

Cả `TaskPromptEditor.tsx` và `TaskDetail.tsx`'s `handleRunAgent()` (dòng
64-87) chỉ `await` 1 lần gọi `task.execute` rồi `toast.success`/`toast.error`
— không `subscribeRuntimeEvent` nào được đăng ký để theo dõi tiến trình agent
sau khi dispatch (0 kết quả grep `subscribeRuntimeEvent` trong toàn bộ
`components/task/`). Sau khi bấm Run, UI không có cách nào biết agent đang
làm gì, xong chưa, lỗi gì — phải tự refetch task thủ công để thấy `status`
đổi (nếu có đổi).

### 3. Không có UI batch execute

`TaskGraph.tsx`/`TaskTreeView.tsx` không hỗ trợ chọn nhiều task (không có
checkbox multi-select, không có nút "Run Selected") — mỗi lần chỉ chạy được
1 task qua `TaskDetail`/`TaskPromptEditor`, dù cả 2 backend hỗ trợ chạy nhiều
task độc lập cùng lúc.

### 4. `task.addComment` mồ côi

`task.addComment` tồn tại ở backend Node (`desktop/src/main/task/task-rpc-handler.ts:304`,
bản sao `backend/src/main/task/task-rpc-handler.ts:304`) nhưng không tồn tại
trên `backend-go`'s `task.proto` (grep xác nhận 0 kết quả `AddComment` trong
proto) — và dù ở Node, `frontend/src` không có UI comment nào cho task (0 kết
quả grep "comment" trong `components/task/*.tsx`). `TaskDetail.tsx` chỉ có 3
tab: Details/Subtasks/AI — không tab Comments.

## Hậu quả

- Người dùng tưởng đang custom hoá lệnh gửi cho agent nhưng thực ra luôn chạy
  `promptTemplate` cũ — dễ dẫn tới kết quả agent sai mong đợi mà không hiểu vì
  sao, vì UI không cảnh báo gì (không disable textarea, không thông báo "input
  này bị bỏ qua").
- Không biết tiến trình agent real-time → phải đoán hoặc F5 liên tục.
- Không chạy song song nhiều task được từ UI → giảm năng suất khi cần dispatch
  hàng loạt task cho agent.
- Tính năng thảo luận/ghi chú theo task (`addComment`) hoàn toàn không dùng
  được dù backend Node đã implement.

## Bằng chứng

```
frontend/src/renderer/src/components/task/TaskPromptEditor.tsx:11        → state `prompt` từ textarea, có vẻ quan trọng
frontend/src/renderer/src/components/task/TaskPromptEditor.tsx:24-31     → comment tự thú "task.execute has no `prompt` param... discarded", payload gửi đi KHÔNG có prompt
frontend/src/renderer/src/components/task/TaskPromptEditor.tsx:52        → nút Run bị disable theo `!prompt.trim()` dù prompt không được dùng
frontend/src/renderer/src/components/task/TaskDetail.tsx:64-87           → handleRunAgent() chỉ await 1 lần task.execute, không subscribe event nào sau đó
frontend/src/renderer/src/components/task/TaskGraph.tsx:8-26             → toolbar không có multi-select/"Run Selected"
desktop/src/main/task/task-rpc-handler.ts:304                            → task.addComment tồn tại ở Node, không tồn tại ở backend-go's task.proto, không UI nào gọi
```

## Đề xuất fix

1. Theo `CR-FLOW-TASK-005` mục 3: bổ sung field `prompt` (tuỳ chọn, override `promptTemplate` cho riêng lần chạy này) vào `task.proto`'s `ExecuteRequest` — việc backend, theo dõi ở `specs/backend-go/bugs/task-v1`. Sau khi có field này, `TaskPromptEditor.tsx`'s `runWithAgent()` gửi thêm `prompt` vào payload.
2. Nếu backend chưa hỗ trợ field `prompt` ngay, tối thiểu disable/ẩn textarea và thay bằng text tĩnh hiển thị `promptTemplate` hiện tại — tránh UX-lie.
3. Thêm `useTaskActivity` (theo thiết kế CR-FLOW-TASK-005 mục 2) subscribe kênh `task.activity:<taskId>` (phụ thuộc CR-FLOW-TASK-003 hoàn tất ở backend) để hiển thị tiến trình real-time; tạm thời có thể fallback polling `task.get` mỗi vài giây nếu kênh WS chưa sẵn sàng.
4. Thêm multi-select trong `TaskTreeView`/`TaskGraph` + nút "Run Selected" gọi `task.execute` tuần tự/song song có giới hạn concurrency.
5. Thêm tab "Comments" trong `TaskDetail.tsx` gọi `task.addComment` — lưu ý RPC này hiện chỉ tồn tại ở Node, cần bổ sung tương đương ở backend-go trước khi cutover (xem CR-FLOW-TASK-004).

## Tham khảo

- Backend liên quan: [BUG-TASKV1-004](../../../backend-go/bugs/task-v1/BUG-TASKV1-004-orcatask-run-agent-execution-gaps.md) (field `prompt` cho ExecuteRequest, ComplexExecutor stub, AddComment RPC chưa có ở backend-go)
- CR liên quan: docs/crs/v3/flow-task/CR-FLOW-TASK-005-frontend-unified-task-execution-ui.md mục 3 (chính xác ghi nhận gap field `prompt`)
- CR liên quan: docs/crs/v3/flow-task/CR-FLOW-TASK-003-unified-task-activity-event-catalog.md (điều kiện tiên quyết cho Activity Feed thật)
- Liên quan: BUG-FE-TASKV1-005 (không subscribe event nào — root cause chung với mục 2 ở đây)
