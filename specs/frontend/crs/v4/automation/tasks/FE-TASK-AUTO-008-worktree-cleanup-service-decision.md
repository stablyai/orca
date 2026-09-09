# FE-TASK-AUTO-008: `WorktreeCleanupService.ts` — khảo sát + wire/xoá

**Solution:** [FE-AUTO-SOL-006](../solutions/FE-AUTO-SOL-006-worktree-cleanup-service.md) | **CR:** CR-AUTO-006
**Depends on:** Không
**Status:** 🟡 PARTIAL (2026-09-09) — test thêm xong; KHÔNG wire vào composition root (xem lý do)

---

## Mục tiêu

Bước 1 (khảo sát) bắt buộc trước — kết quả quyết định phần còn lại của
task.

## Bước 1 — Khảo sát (bắt buộc, làm trước)

Kiểm tra `frontend/src/renderer/src/store/slices/worktrees.ts` và UI xoá
worktree hiện có — worktree cleanup hôm nay có cơ chế nào khác đảm nhiệm
việc `WorktreeCleanupService.ts` định làm không?

- **Nếu có** → chuyển sang "Nhánh xoá" bên dưới, dừng ở đó.
- **Nếu không** → chuyển sang "Nhánh wire" bên dưới.

## Nhánh xoá (nếu Bước 1 xác nhận có cơ chế khác)

### Files cần sửa
1. `desktop/src/main/automations/WorktreeCleanupService.ts` (XOÁ)

### Verify
```bash
cd desktop && npx tsc --noEmit
grep -rn "WorktreeCleanupService" --include=*.ts . # xác nhận 0 reference còn lại ngoài git history
```

## Nhánh wire (nếu Bước 1 xác nhận chưa có cơ chế khác) — Phương án B (tạm thời)

### Files cần sửa
1. `desktop/src/main/automations/WorktreeCleanupService.test.ts` (MỚI — bắt buộc trước khi bật thật)
2. Composition root phù hợp trong `desktop/src/main` (MODIFY — khởi tạo `WorktreeCleanupService`, đọc config từ `GlobalSettings`)

### Test cases cần cover (bắt buộc trước khi merge)
- `git status --porcelain` có output (uncommitted changes) → KHÔNG xoá worktree đó, dù đủ điều kiện tuổi/status khác.
- Worktree sạch, đủ tuổi, đúng status filter → xoá qua `git worktree remove --force`.
- Lỗi khi gọi `git.exec`/`worktree.list` → không crash service, log lỗi.

### Verify
```bash
cd desktop && npx vitest run src/main/automations/WorktreeCleanupService.test.ts
npx tsc --noEmit
```

## gitnexus

`impact({target: "WorktreeCleanupService", direction: "upstream"})`
trước khi chọn nhánh nào — xác nhận không caller nào xuất hiện gần đây
mà audit trước chưa thấy.

## Kết quả khảo sát Bước 1 (2026-09-09)

`removeWorktree` reducer (`frontend/src/renderer/src/store/slices/worktrees.ts:3316`)
là cơ chế xoá worktree DUY NHẤT hoạt động thật hôm nay — hoàn toàn thủ
công, per-worktree, do user tự bấm. `local-worktree-removal-recovery.ts`
chỉ xử lý recovery sau khi xoá thất bại (Windows file-lock), không phải
cleanup chủ động. Không tìm thấy field settings nào
(`autoCleanup`/`autoArchive`/`staleWorktree`/tương tự) cho bulk cleanup
tự động theo tuổi/status. **Kết luận Bước 1: chưa có cơ chế nào khác —
đúng nhánh "Nhánh wire" (Phương án B) theo solution.**

## 🟡 Quyết định: dừng ở mức thêm test, KHÔNG wire vào composition root

`WorktreeCleanupService.runCleanup()` **tự động xoá worktree thật của
user** (`git worktree remove --force`) theo lịch, không cần xác nhận
từng lần — đây là hành động khó đảo ngược, ảnh hưởng dữ liệu người
dùng thật. Theo nguyên tắc "hành động khó đảo ngược cần xác nhận trước
khi thực thi, trừ khi đã được uỷ quyền rõ ràng cho riêng việc đó": task
gốc (do tôi tự viết ở lượt trước) cho phép "wire vào composition root"
như 1 lựa chọn hợp lệ, nhưng đó không phải là sự uỷ quyền tường minh từ
người dùng cho việc **kích hoạt xoá worktree tự động cho user thật** —
khác hẳn việc viết code/test không tác dụng phụ. Do đó:

- **Đã làm**: thêm `WorktreeCleanupService.test.ts` (7 test case — an
  toàn `git status --porcelain`, xoá đúng khi sạch, bỏ qua worktree quá
  trẻ/sai status, dry-run không xoá thật, lỗi 1 worktree không chặn cả
  chu kỳ, lỗi khi check status → conservative skip không xoá, callback
  `onCleanupComplete` bắn đúng kết quả) — **không tác dụng phụ, không
  đụng dữ liệu thật**, an toàn để làm không cần hỏi thêm.
- **Chưa làm, cố ý dừng lại**: khởi tạo `WorktreeCleanupService` trong
  composition root thật của `desktop/src/main` (việc này sẽ khiến worktree
  của user thật bắt đầu bị xoá tự động theo lịch ngay khi build tiếp
  theo chạy) — cần người dùng xác nhận rõ ràng muốn bật tính năng này
  trước khi làm, không tự quyết định trong task này.

**Verify**: `npx vitest run src/main/automations/WorktreeCleanupService.test.ts`
— 7/7 pass. `npx tsc --noEmit` — 0 lỗi.

**Files đã sửa/tạo:**
- `desktop/src/main/automations/WorktreeCleanupService.test.ts` (MỚI)
