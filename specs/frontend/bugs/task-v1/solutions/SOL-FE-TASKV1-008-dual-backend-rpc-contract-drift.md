# SOL-FE-TASKV1-008 — Root cause tổng hợp: frontend viết pha trộn theo 2 shape backend khác nhau

**Bug:** [BUG-FE-TASKV1-008](../BUG-FE-TASKV1-008-dual-backend-rpc-contract-drift.md)
**Loại giải pháp:** A — Pointer (biểu hiện cụ thể đã giải quyết bởi 1 solution khác; root cause hệ thống thì chưa)
**Status:** 📋 Proposed — chưa triển khai

---

## Tóm tắt

Biểu hiện cụ thể, nghiêm trọng nhất của root cause này (`runWorkflow()`
lệch shape) được vá bởi:

> [`specs/frontend/crs/v3/flow-task/solutions/FE-SOL-001-unified-task-execution-ui.md`](../../../../crs/v3/flow-task/solutions/FE-SOL-001-unified-task-execution-ui.md)
> (xem chi tiết + đánh đổi ở [SOL-FE-TASKV1-007](./SOL-FE-TASKV1-007-workflow-builder-rpc-shape-mismatch.md))

**Nhưng đây là bug "tổng hợp/root cause" — vá 1 điểm lệch cụ thể (007)
không đóng được bug này.** Bug gốc tự nói rõ: *"Sửa từng bug lẻ (như
BUG-FE-TASKV1-007) không ngăn được lệch mới phát sinh — cần 1 quy tắc/gate ở
tầng review, không chỉ vá từng chỗ."* FE-SOL-001 (1 PR code) không thể tự nó
tạo ra 1 quy tắc review hay 1 cơ chế type-safety dùng chung — đó là việc
process/tooling, không phải việc sửa code 1 lần.

## Phần đã được FE-SOL-001 đóng góp (gián tiếp)

- Chọn shape `backend-go` cho `runWorkflow()` — tuân theo đề xuất #1 của bug
  gốc ("Pha 0": mọi RPC mới viết theo shape `backend-go`).

## Phần CHƯA được giải quyết — cần theo dõi riêng, không tự làm trong solution này

1. **Quy tắc "Pha 0" chưa được ghi thành văn bản thực thi được** — đề xuất
   #1 của bug gốc yêu cầu ghi quy tắc này vào `specs/backend-go/api/` +
   checklist review PR. Đây là việc tài liệu hoá/quy trình, không phải code
   frontend — không có file source nào để "sửa" cho mục này.
2. **2 bản Node (`desktop/src/main` vs `backend/src/main`) vẫn lệch nhau**
   (`workflow.template.update`/`pause`/`resume` chỉ có ở 1 bên) — đây là việc
   sửa ở phía backend Node, ngoài phạm vi `frontend/`.
3. **Không có codegen/type dùng chung giữa FE/BE** — đề xuất #4 của bug gốc
   (sinh types từ `.proto`/Zod schema) là 1 hạng mục tooling lớn, cần 1 CR
   riêng đánh giá chi phí/lợi ích (ảnh hưởng cả `useTask.ts`, `useWorkflow.ts`
   và mọi hook RPC khác), không phải phạm vi của bộ bug `task-v1` này.
4. **`useTask.ts`/`TaskDetail.tsx`/`TaskPromptEditor.tsx`'s RPC calls** —
   bug gốc xác nhận các RPC này hiện tương thích cả 2 backend (không phát
   hiện lệch ở phạm vi audit gốc), nhưng cảnh báo "không có gì đảm bảo lệch
   trạng thái này được duy trì" — solution này không thêm được cơ chế bảo vệ
   tự động nào (mục 3 ở trên là điều kiện tiên quyết); trong lúc chờ, mọi PR
   sửa `task.*`/`workflow.*` cần review thủ công đối chiếu cả 2 backend theo
   đúng bảng so sánh trong bug gốc.

## Khuyến nghị hành động (ngoài phạm vi code 1 PR)

- Người sở hữu quy trình review PR nên thêm mục checklist thủ công (tạm
  thời, cho tới khi có mục 3/4 ở trên): "PR này có thêm/sửa RPC `task.*`,
  `workflow.*`, hay `orchestration.*` không? Nếu có, đã đối chiếu shape với
  CẢ 2 backend (Node đang chạy prod + backend-go) chưa?"
- Theo dõi tiến độ `CR-FLOW-TASK-004` (cutover 4 pha) — khi Pha 3 hoàn tất
  (production chuyển hẳn sang backend-go), phần lớn rủi ro "lệch tuỳ deploy
  target" của bug này tự nhiên biến mất vì chỉ còn 1 backend phục vụ traffic
  thật.

## Tham khảo

- [BUG-TASKV1-008](../../../../backend-go/bugs/task-v1/BUG-TASKV1-008-dual-backend-routing-and-postgres-compliance.md) — đối chiếu đầy đủ RPC surface 2 backend
- `docs/crs/v3/flow-task/CR-FLOW-TASK-004-backend-go-cutover-and-node-sqlite-retirement.md`
