# BUG-FE-TASKV1-005 — Không có real-time event subscription nào cho Task/Agent/Workflow — mọi nơi đều polling hoặc refetch thủ công

**Mức độ:** 🟠 High
**Status:** 🔴 Open
**Module:** `frontend/src/renderer/src/components/task/`, `hooks/useWorkflowExecution.ts`, `hooks/useTasks.ts`
**Phát hiện:** 2026-09-08 (audit frontend vs 3 hệ Task: OrcaTask/Task Execute/Workflow Orchestration)

---

## Mô tả

Grep toàn bộ `frontend/src/renderer/src/components/task/` và các hook liên
quan (`useTask.ts`, `useTasks.ts`, `TaskDetail.tsx`, `TaskPromptEditor.tsx`)
cho `subscribeRuntimeEvent(` — **0 kết quả**. Grep cho tên event cụ thể
(`task.created`, `agent_output`, `agent_completed`, `status_changed`) trong
cùng phạm vi — cũng **0 kết quả**. Không nơi nào trong cụm Task UI đăng ký
lắng nghe sự kiện đẩy (push) từ backend.

Cơ chế cập nhật dữ liệu hiện tại hoàn toàn dựa vào 1 trong 2 kiểu:

1. **Refetch thủ công theo action của chính người dùng** — ví dụ
   `useTasks.ts` chỉ gọi lại `task.list` khi `projectId` đổi (dòng 29-55,
   dependency `[projectId, setTasks]`), không tự refetch khi có task khác
   (do agent, do user khác) thay đổi ở backend.
2. **Polling cố định** — `useWorkflowExecution.ts` (dòng 8, 23-57) poll
   `workflow.getExecution` mỗi `EXECUTION_POLL_INTERVAL_MS = 4_000` (4 giây)
   trong lúc execution đang `running`. Comment tại chỗ (dòng 10-22) tự thú
   đây là "interim, pre-Phase-D" stopgap: trước đây dùng
   `window.api.on('workflow:stepStatus' | ...)` — 1 bridge chỉ hoạt động
   trên Electron; ở Web mode `window.api` là 1 Proxy fallback nên `.on()`
   luôn trả về 1 no-op unsubscribe **âm thầm**, không báo lỗi — nghĩa là ở
   Web mode, sự kiện real-time từng bị mất hoàn toàn mà không ai biết, cho
   tới khi polling được thêm vào làm giải pháp tạm (CR-PW-005) thay thế.

Polling này CHỈ tồn tại cho Workflow execution (Engine 3) và chỉ báo cáo
`status` cấp execution (không có per-step detail, theo đúng comment dòng 21).
OrcaTask (Engine 1) và Task Execute/Orchestration (Engine 2) **không có cả
polling lẫn push** — sau khi bấm "Run with Agent" (`TaskDetail.tsx`/
`TaskPromptEditor.tsx`), UI hoàn toàn im lặng cho tới khi người dùng tự làm
gì đó khác kích hoạt 1 lần `task.list`/`useTask` refetch mới (ví dụ chuyển
tab, đổi project).

## Hậu quả

- Task/Agent (Engine 1, 2): người dùng không biết agent có đang chạy hay đã
  xong/failed — trải nghiệm "chạy xong không biết", phải tự bấm F5 hoặc
  chuyển qua chuyển lại tab để trigger refetch.
- Workflow (Engine 3): cập nhật trễ tối đa 4 giây, không có chi tiết per-step
  (step nào đang chạy, step nào fail) — chỉ biết execution tổng thể đang
  chạy hay xong.
- Root cause đã biết từ trước (`CR-PW-006`, dẫn ở comment `useWorkflowExecution.ts`)
  nhưng giải pháp đầy đủ (push-based, cross-platform) chưa được triển khai —
  đây chính là điều kiện tiên quyết mà `CR-FLOW-TASK-003` (event catalog hợp
  nhất) và `CR-FLOW-TASK-005` mục 2 (`useTaskActivity`) đặt ra.

## Bằng chứng

```
frontend/src/renderer/src/hooks/useWorkflowExecution.ts:8, 23-57  → EXECUTION_POLL_INTERVAL_MS = 4_000, setInterval poll workflow.getExecution khi status === 'running'
frontend/src/renderer/src/hooks/useWorkflowExecution.ts:10-22     → comment tự thú: window.api.on(...) từng silent-fail hoàn toàn ở Web mode, polling là "interim, pre-Phase-D" stopgap
frontend/src/renderer/src/hooks/useTasks.ts:29-55                 → chỉ refetch task.list khi projectId đổi — không poll, không subscribe, không tự cập nhật khi có thay đổi từ nơi khác
grep -rn "subscribeRuntimeEvent(" frontend/src/renderer/src/components/task/  → 0 kết quả
grep -rn "'task.created'\|agent_output\|agent_completed\|status_changed" frontend/src/renderer/src/components/task/ → 0 kết quả
```

## Đề xuất fix

1. Triển khai `useTaskActivity.ts` như thiết kế ở `CR-FLOW-TASK-005` mục 2 — subscribe 1 kênh WS hợp nhất `task.activity:<taskId>`, dùng chung reducer cho cả 3 engine (không cần biết `orchestration.messages` hay `workflow.step_executions` tồn tại).
2. Kênh WS hợp nhất phụ thuộc `CR-FLOW-TASK-003` (outbox/eventbus mở rộng sang Engine 2 + 3) hoàn tất ở backend trước — theo dõi tiến độ ở `specs/backend-go/bugs/task-v1`.
3. Trong lúc chờ CR-003: tối thiểu thêm polling tương tự `useWorkflowExecution.ts` cho `task.get` sau khi `task.execute` được gọi, để không im lặng hoàn toàn (đỡ hơn 0 feedback, dù chưa lý tưởng).
4. Khi `useTaskActivity` sẵn sàng, thay thế polling của `useWorkflowExecution.ts` bằng subscribe kênh mới, giữ polling chỉ làm fallback (đúng theo rủi ro đã ghi trong CR-FLOW-TASK-005).

## Tham khảo

- CR liên quan: docs/crs/v3/flow-task/CR-FLOW-TASK-003-unified-task-activity-event-catalog.md (điều kiện tiên quyết)
- CR liên quan: docs/crs/v3/flow-task/CR-FLOW-TASK-005-frontend-unified-task-execution-ui.md mục 2 (thiết kế `useTaskActivity`)
- Backend liên quan: [BUG-TASKV1-005](../../../backend-go/bugs/task-v1/BUG-TASKV1-005-task-execute-orchestration-coordinator-not-autonomous.md) (outbox/eventbus cho Engine 2/3 chưa mở rộng — SOL-PW-04 mới có nền tảng)
- Liên quan: BUG-FE-TASKV1-004 mục 2 (hệ quả trực tiếp của bug này lên UX "Run with Agent")
