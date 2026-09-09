# FE-TASK-EVM-007: Mount/copy-out worktree↔VM — khảo sát (KHÔNG PHẢI TASK CODE)

**Solution:** [FE-SOL-EVM-005](../solutions/FE-SOL-EVM-005-worktree-mount-decision-memo.md) | **CR:** CR-EVM-009
**Depends on:** Không
**Status:** ⛔ BLOCKED — chờ quyết định sản phẩm, AI không tự thực thi code

---

## Mục tiêu

Task khảo sát/chuẩn bị, không code tính năng. AI thực thi task này chỉ
được:

1. Đọc `ephemeral-vm-worktree-creation.ts`/`ephemeral-vm-workspace-target.ts:42-142`
   xác nhận lại chính xác mô hình hiện tại (đã mô tả trong solution, xác
   nhận không đổi từ lúc viết solution).
2. Chuẩn bị 2 phương án hành động dạng draft (không merge):
   - Nhánh A: draft PR sửa `docs/features/F18-ephemeral-vm.md:44-47`.
   - Nhánh B: outline sơ bộ composer flow mới (không code).
3. Trình bày 2 draft này cho quyết định sản phẩm — KHÔNG tự chọn nhánh.

## Không được làm

Merge bất kỳ thay đổi nào vào `docs/features/F18-ephemeral-vm.md` hay
code composer — chờ quyết định trước.

## Kết quả khảo sát (2026-09-09)

### 1. Xác nhận lại mô hình hiện tại (khớp solution, không đổi)

`ephemeral-vm-workspace-target.ts:prepareEphemeralVmWorkspaceTarget` (đọc
lại toàn bộ hàm) xác nhận đúng mô tả trong FE-SOL-EVM-005: gọi
`window.api.ephemeralVm.provision` → lấy `provisioned.runtime.recipeResult`
→ `getEphemeralVmRecipeResultProjectRoot(...)` → gọi
`args.setupExistingFolder({hostId, path: <project root trong VM>, setupMethod:
'imported-existing-folder'})`. Không dòng nào copy nội dung worktree cục
bộ vào đâu cả — `setupMethod: 'imported-existing-folder'` tự nói rõ:
đây là "import 1 folder đã tồn tại", không phải "tạo mới từ nội dung cục
bộ".

### 2. Phối hợp với TASK-AG-EVM-012's phát hiện (phía agent)

Khảo sát phía agent (song song, xem
[TASK-AG-EVM-012](../../../../agent/crs/v3/ephemeral-vm/tasks/TASK-AG-EVM-012-worktree-mount-decision.md))
cho kết luận quan trọng: mount/copy-out **chỉ có ý nghĩa kỹ thuật cho
`connection_type: 'ssh'`** — với `orca-server`, VM và agent chia sẻ
cùng 1 filesystem, không có "khoảng cách" nào để mount/copy. Điều này
ảnh hưởng trực tiếp tới Nhánh B's phạm vi UI (mục dưới).

### 3. Draft Nhánh A (spec-correction) — KHÔNG merge trong task này

Nếu được chọn, thay đổi cần thiết ở `docs/features/F18-ephemeral-vm.md:44-47`:
đổi mô tả "worktree được mount trong VM... Kết quả được copy ra" thành mô
tả đúng mô hình đã ship: "Orca trỏ workspace vào project root mà chính
recipe's `create` command tạo ra bên trong VM/container — với
`connection_type: orca-server`, VM và agent chia sẻ cùng filesystem nên
không cần đồng bộ; với `connection_type: ssh`, đây vẫn là giới hạn hiện
tại (worktree không tự động đồng bộ 2 chiều)."

### 4. Draft Nhánh B (feature thật) — KHÔNG merge trong task này, outline sơ bộ

Nếu được chọn — theo phát hiện mục 2, **chỉ cần áp dụng cho
`connection_type: 'ssh'`**:
- UI mới: option "Start from an existing local worktree" khi tạo
  ephemeral VM workspace kiểu SSH (khác luồng hiện tại — luôn tạo mới
  trong VM qua recipe's `create`).
- Cần: bước copy nội dung worktree cục bộ lên VM SSH SAU KHI provision
  (agent-side ghi qua hidden target — TASK-AG-EVM-012 xác nhận đây là
  gap thật, chưa có khả năng ghi).
- Copy-out: cần định nghĩa "VM xong" (phụ thuộc CR-EVM-010) trước khi
  biết trigger ở đâu; UI cần hiển thị tiến trình copy-out.
- Effort ước lượng: lớn (composer flow mới + agent-side write capability
  mới) — không nhỏ như "sửa spec".

### Khuyến nghị trình bày cho quyết định sản phẩm

Với phát hiện mục 2 (mount/copy-out chỉ liên quan `ssh`, không liên
quan `orca-server` — phần lớn recipe thực tế dùng), khuyến nghị nghiêng
về **Nhánh A** (spec-correction) trừ khi có nhu cầu cụ thể cho use case
"bắt đầu từ worktree cục bộ có sẵn" trên riêng nhánh SSH — nhưng đây là
khuyến nghị, không phải quyết định tự động chọn.
