# FE-AUTO-SOL-006: `WorktreeCleanupService.ts` — quyết định wire hoặc xoá

> **🔲 Designed — chưa implement.** Bắt đầu bằng khảo sát, không code
> trước.

**CR:** [CR-AUTO-006](../../../../../../docs/crs/v4/automations/CR-AUTO-006-worktree-cleanup-service.md)
**Layer:** Electron main (`desktop/src/main/automations/`)

---

## 1. Trạng thái hiện tại

`WorktreeCleanupService.ts` — dead code (không composition root nào
khởi tạo), logic trông sound (age/status filter, `git status --porcelain`
safety check, gọi `git.exec`/`worktree.list` — RPC thật).

## 2. Bước 1 — Khảo sát (bắt buộc trước khi chọn hướng)

Kiểm tra: worktree cleanup hôm nay có cơ chế nào khác đảm nhiệm (UI xoá
thủ công, hay tính năng nào đã thay thế) — tìm trong
`frontend/src/renderer/src/store/slices/worktrees.ts` và UI liên quan
tới xoá/dọn worktree. Nếu có cơ chế đủ dùng → xoá thẳng
`WorktreeCleanupService.ts`, dừng ở đây.

## 3. Nếu chọn wire — 2 phương án

### Phương án A (khuyến nghị): action type `CLEANUP_WORKTREES` trong automation chain

Sau khi FE-AUTO-SOL-002 (actions[]) ship, thêm 1 action type mới dùng
`WorktreeCleanupService`'s logic — user tự tạo automation cron ("mỗi Chủ
nhật 2h sáng") để chạy. Nhất quán với cách F14 thiết kế mọi action khác,
cấu hình được từ UI thay vì daemon ẩn.

### Phương án B (tạm thời, nếu không muốn chờ FE-AUTO-SOL-002)

Wire như scheduled job độc lập trong `desktop/src/main`'s composition
root, config (`maxAgeMs`, status filter) đọc từ `GlobalSettings`.

## 4. Test bắt buộc trước khi bật thật (cả 2 phương án)

`WorktreeCleanupService.ts` hiện không có file test — thêm test cho
safety check (`git status --porcelain` phải chặn xoá worktree có
uncommitted changes) trước khi coi là sẵn sàng cho user thật, theo đúng
yêu cầu CR-AUTO-006.

## Rủi ro / Phụ thuộc

| Hạng mục | Rủi ro | Ghi chú |
|---|---|---|
| Xoá nhầm worktree có việc dở dang nếu safety check chưa test | Cao | Bắt buộc test trước khi bật, không phụ thuộc chọn phương án nào |
| Bước 1 kết luận sai | Trung bình | Khảo sát kỹ cả code lẫn docs/backlog trước khi quyết định |
| Phương án A phụ thuộc FE-AUTO-SOL-002 | Trung bình | Nếu cần gấp, dùng Phương án B tạm thời |

## Không thuộc phạm vi solution này

- Nếu chọn Phương án A, phần khung action-chain chung thuộc
  FE-AUTO-SOL-002/BE-AUTO-SOL-002 — solution này chỉ định nghĩa nội dung
  riêng `CLEANUP_WORKTREES`.

## Liên quan

- `desktop/src/main/automations/WorktreeCleanupService.ts`
- `desktop/src/main/runtime/rpc/methods/worktree.ts:31` (`worktree.list`)
- `frontend/src/renderer/src/store/slices/worktrees.ts`
- [FE-AUTO-SOL-002](./FE-AUTO-SOL-002-actions-type-plumbing.md) (Phương án A)
