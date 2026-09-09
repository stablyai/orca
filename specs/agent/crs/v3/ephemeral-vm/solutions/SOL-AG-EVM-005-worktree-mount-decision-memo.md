# SOL-AG-EVM-005: Mount/copy-out worktree↔VM — decision memo (agent phần)

> **🔲 Blocked on product decision — không thiết kế kỹ thuật chi tiết.**
> Theo đúng tinh thần CR-EVM-009: không code trước khi có quyết định sản
> phẩm.

**CR:** [CR-EVM-009](../../../../../../docs/crs/v3/ephemeral-vm/CR-EVM-009-worktree-mount-copy-out-reconciliation.md)
**Frontend counterpart:** [FE-SOL-EVM-005](../../../../frontend/crs/v3/ephemeral-vm/solutions/FE-SOL-EVM-005-worktree-mount-decision-memo.md)

---

## 1. Trạng thái hiện tại

Không code nào cho "mount worktree cục bộ vào VM" hay "copy-out kết quả"
tồn tại ở agent. Mô hình đã ship (`ephemeral-vm-workspace-target.ts`) là
"trỏ vào folder VM tự tạo", không đụng tới agent's filesystem/git
provider theo hướng mount.

## 2. Nếu CR-EVM-009's Nhánh B được chọn (cần mount/copy-out thật) — sơ bộ vai trò agent

**Không thiết kế chi tiết trong solution này** — chỉ ghi lại các câu hỏi
kỹ thuật agent cần trả lời NẾU Nhánh B được chốt, để CR-EVM-009's bước
quyết định sản phẩm có đủ thông tin ước lượng effort:

- Nếu VM là `connection_type: 'ssh'` (Hướng A/B): agent cần khả năng
  copy file 2 chiều tới host thứ 3 — `ssh-outbound-filesystem-provider.ts`
  (đã tồn tại từ CR-EVM-005) có thể là điểm khởi đầu (đã có khả năng đọc/
  ghi file trên host SSH đó), nhưng "mount" (đồng bộ liên tục, không phải
  1 lần copy) là khả năng khác hẳn — cần rsync-like logic hoặc filesystem
  watch 2 chiều, subsystem mới thật sự.
- Nếu VM là `connection_type: 'orca-server'`: "mount" có thể đơn giản
  hơn nếu VM và agent chia sẻ cùng host (docker container trên cùng Dev
  Server) — cần xác nhận giả định này trước khi ước lượng.
- Copy-out: cần định nghĩa rõ "VM xong" (liên quan
  [CR-EVM-010](../../../../../../docs/crs/v3/ephemeral-vm/CR-EVM-010-auto-destroy-on-task-completion.md))
  trước khi biết trigger copy-out ở đâu.

## Rủi ro / Phụ thuộc

| Hạng mục | Rủi ro | Ghi chú |
|---|---|---|
| Code trước khi có quyết định sản phẩm | Cao | Đây là lý do chính solution này dừng ở decision memo |

## Không thuộc phạm vi solution này

- Mọi thiết kế kỹ thuật cụ thể — chờ CR-EVM-009's Bước 1.

## Liên quan

- `agent/src/relay/ssh-outbound-filesystem-provider.ts` (điểm khởi đầu tiềm năng nếu Nhánh B)
- [CR-EVM-009](../../../../../../docs/crs/v3/ephemeral-vm/CR-EVM-009-worktree-mount-copy-out-reconciliation.md)
- [FE-SOL-EVM-005](../../../../frontend/crs/v3/ephemeral-vm/solutions/FE-SOL-EVM-005-worktree-mount-decision-memo.md)
