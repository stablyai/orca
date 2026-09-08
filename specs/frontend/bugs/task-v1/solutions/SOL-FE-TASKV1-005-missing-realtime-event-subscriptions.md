# SOL-FE-TASKV1-005 — Không có real-time event subscription cho Task/Agent/Workflow

**Bug:** [BUG-FE-TASKV1-005](../BUG-FE-TASKV1-005-missing-realtime-event-subscriptions.md)
**Loại giải pháp:** A — Pointer (đã giải quyết phần lớn bởi 1 solution khác)
**Status:** 📋 Proposed — chưa triển khai

---

## Tóm tắt

Đây **không phải** 1 solution độc lập. Phần chính của bug này (thiếu kênh
event hợp nhất cho cả 3 engine) được giải quyết bởi:

> [`specs/frontend/crs/v3/flow-task/solutions/FE-SOL-001-unified-task-execution-ui.md`](../../../../crs/v3/flow-task/solutions/FE-SOL-001-unified-task-execution-ui.md)

FE-SOL-001 thiết kế hook `useTaskActivity(taskId)` subscribe 1 kênh WS hợp
nhất `task.activity:<taskId>` (theo `CR-FLOW-TASK-005` mục 2), dùng 1
reducer duy nhất cho cả 3 loại event (task/agent/workflow), thay thế dần
kiểu polling cố định `EXECUTION_POLL_INTERVAL_MS = 4_000` hiện tại của
`frontend/src/renderer/src/hooks/useWorkflowExecution.ts`.

## Xác nhận hiện trạng

- **Cập nhật (2026-09-08, sau khi 2 solution hoàn tất song song):**
  `FE-SOL-001-unified-task-execution-ui.md` đã được publish. Nội dung đã xác
  nhận khớp tóm tắt ở trên: `useTaskActivity` trong đó CHỈ là polling
  fallback (không phải subscribe thật), vì đúng như dòng dưới đây đã xác
  định — `subscribeRuntimeEvent` không tồn tại ở tầng runtime client. Không
  cần đọc lại để xác nhận nữa, bug này coi như đã có hướng fix rõ ràng
  (nhưng vẫn phụ thuộc backend CR-FLOW-TASK-003 + runtime layer bổ sung
  `subscribeRuntimeEvent`/tương đương trước khi thực sự "xong").
- `grep -rn "subscribeRuntimeEvent" frontend/src/` → **0 kết quả** trong
  toàn bộ codebase (không chỉ trong `components/task/`) — hàm này **chưa
  tồn tại ở bất kỳ đâu**, kể cả tầng `runtime/runtime-rpc-client.ts`. Đây là
  tên hàm được đề xuất trong CR-FLOW-TASK-005, chưa phải API thật.
- `grep -rln "onRuntimeEvent\|RuntimeEventBus" frontend/src/renderer/src/`
  → 0 kết quả — không có cơ chế pub/sub runtime-event nào sẵn có để tái sử
  dụng ngay; `useTaskActivity` (khi FE-SOL-001 hiện thực) sẽ phải tự thêm
  cả tầng vận chuyển WS lẫn hook, không chỉ hook.

## Phụ thuộc backend CHƯA sẵn sàng (chặn cứng)

`useTaskActivity` không thể hoạt động thật nếu thiếu kênh event ở backend.
Theo `specs/backend-go/bugs/task-v1/BUG-TASKV1-005-task-execute-orchestration-coordinator-not-autonomous.md`:

- `orchestration.messages` (bảng lưu `status/dispatch/worker_done/merge_ready/escalation/handoff/decision_gate/heartbeat`)
  **hoàn toàn chết** — 0 RPC nào đọc/ghi bảng này.
- `orchestration-service` không có background loop/ticker nào — không có gì
  tự động phát sinh event khi trạng thái coordinator đổi.
- `CR-FLOW-TASK-003` (event catalog hợp nhất — điều kiện tiên quyết của
  `useTaskActivity`) **chưa có bằng chứng triển khai** ở backend-go tại thời
  điểm audit này.

Kết luận: dù FE-SOL-001 hiện thực đúng thiết kế, `useTaskActivity` **sẽ
không nhận được frame thật nào cho Engine 2 (orchestration)** cho tới khi
`CR-FLOW-TASK-003` xong ở backend. Với Engine 3 (workflow), polling hiện tại
(`useWorkflowExecution.ts`) vẫn là kênh cập nhật duy nhất khả dụng cho tới
lúc đó.

## Việc còn lại KHÔNG thuộc phạm vi FE-SOL-001

- Không có gì thêm để thiết kế riêng ở đây cho phần "kênh event" — nếu
  FE-SOL-001 khi hoàn thiện không cover đủ 3 engine hoặc không có fallback
  polling khi WS chưa sẵn sàng (rủi ro CR-FLOW-TASK-005 tự ghi nhận ở mục
  "Rủi ro"), báo cáo lại thành 1 bug riêng thay vì mở rộng solution này.
- Việc chờ `CR-FLOW-TASK-003` hoàn tất ở backend nằm ngoài phạm vi frontend
  — theo dõi tiến độ ở `specs/backend-go/bugs/task-v1`.

## Tham khảo

- [BUG-FE-TASKV1-004](./SOL-FE-TASKV1-004-run-agent-ux-gaps.md) mục 2 — hệ quả trực tiếp của bug này lên UX "Run with Agent" (Activity Feed).
- `docs/crs/v3/flow-task/CR-FLOW-TASK-003-unified-task-activity-event-catalog.md`
- `docs/crs/v3/flow-task/CR-FLOW-TASK-005-frontend-unified-task-execution-ui.md` mục 2
