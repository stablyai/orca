# FE-SOL-EVM-005: Mount/copy-out worktree↔VM — decision memo (frontend phần)

> **🔲 Blocked on product decision — không thiết kế kỹ thuật chi tiết.**

**CR:** [CR-EVM-009](../../../../../../docs/crs/v3/ephemeral-vm/CR-EVM-009-worktree-mount-copy-out-reconciliation.md)
**Agent counterpart:** [SOL-AG-EVM-005](../../../../agent/crs/v3/ephemeral-vm/solutions/SOL-AG-EVM-005-worktree-mount-decision-memo.md)

---

## 1. Trạng thái hiện tại

`ephemeral-vm-worktree-creation.ts`/`ephemeral-vm-workspace-target.ts:42-142`
đã trỏ workspace vào folder recipe tự tạo trong VM
(`getEphemeralVmRecipeResultProjectRoot`) — không mount, không copy-out.
Đây là toàn bộ code liên quan hiện có.

## 2. Việc thật cần làm trước khi có solution kỹ thuật

Đưa CR-EVM-009's câu hỏi ("mô hình hiện tại là v1 đúng ý, hay cần
mount/copy-out thật") lên product/roadmap. Solution này **không** đề
xuất trước 1 trong 2 hướng.

### Nếu Nhánh A được chọn (mô hình hiện tại đúng ý)

Việc frontend cần làm: sửa `docs/features/F18-ephemeral-vm.md:44-47`
khớp thực tế, có thể thêm 1 dòng giải thích trong UI (help text ở
composer khi chọn recipe ephemeral VM) làm rõ "workspace này sống trong
VM, không phải worktree cục bộ được mount vào" — tránh user hiểu nhầm
theo spec cũ.

### Nếu Nhánh B được chọn (cần mount/copy-out thật)

Việc frontend cần làm (sơ bộ, không chi tiết): UI cho user chọn "bắt đầu
từ worktree cục bộ có sẵn" khi tạo ephemeral VM workspace (khác luồng
hiện tại — luôn tạo mới trong VM); UI hiển thị tiến trình copy-out khi
VM "xong" (liên quan
[CR-EVM-010](../../../../../../docs/crs/v3/ephemeral-vm/CR-EVM-010-auto-destroy-on-task-completion.md)'s
định nghĩa "xong"). Đây là feature lớn, cần thiết kế composer flow mới,
không ước lượng chi tiết cho tới khi Nhánh B được xác nhận.

## Rủi ro / Phụ thuộc

| Hạng mục | Rủi ro | Ghi chú |
|---|---|---|
| Code trước khi có quyết định sản phẩm | Cao | Lý do chính solution này dừng ở decision memo |

## Không thuộc phạm vi solution này

- Mọi thiết kế UI cụ thể cho Nhánh B — chờ xác nhận trước.

## Liên quan

- `frontend/src/renderer/src/lib/ephemeral-vm-worktree-creation.ts`
- `frontend/src/renderer/src/lib/ephemeral-vm-workspace-target.ts:42-142`
- `docs/features/F18-ephemeral-vm.md:44-47`
- [SOL-AG-EVM-005](../../../../agent/crs/v3/ephemeral-vm/solutions/SOL-AG-EVM-005-worktree-mount-decision-memo.md)
