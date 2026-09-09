# FE-TASK-AUTO-005: Xoá `AutomationEventBridge.ts` (dead code)

**Solution:** [FE-AUTO-SOL-005](../solutions/FE-AUTO-SOL-005-real-event-triggers.md) | **CR:** CR-AUTO-005
**Depends on:** Không
**Status:** ✅ DONE (2026-09-09)

---

## Mục tiêu

Xoá dead code (không composition root nào khởi tạo, gọi method không
tồn tại nếu chạy) — sửa bug doc claim sai "đã fix".

## Files cần sửa

1. `desktop/src/main/automations/AutomationEventBridge.ts` (XOÁ)
2. `desktop/src/main/automations/AutomationEventBridge.test.ts` (XOÁ, nếu tồn tại — xác nhận trước, README nói không có test cho file này)
3. `specs/backend/bugs/automation/BUG-BE-AT-001-event-based-automation-not-implemented.md` (MODIFY — sửa status về đúng thực tế, trỏ sang CR-AUTO-005)

## Bước 1 — Xác nhận lại dead code trước khi xoá (bắt buộc, đừng tin lại kết luận cũ mù quáng)

```bash
grep -rn "new AutomationEventBridge" --include=*.ts .
```
Xác nhận CHỈ khớp doc-comment của chính file đó (dòng 13) — nếu phát
hiện 1 call site thật đã xuất hiện từ lúc CR được viết, DỪNG, báo cáo,
không xoá.

## Verify

```bash
cd desktop && npx tsc --noEmit
npx vitest run src/main/automations/
```
Xác nhận build/test suite `desktop/src/main/automations/` không đổi kết
quả sau khi xoá (không import nào còn trỏ tới file đã xoá).

## gitnexus

`impact({target: "AutomationEventBridge", direction: "upstream"})` —
xác nhận 0 caller thật trước khi xoá (bằng chứng cụ thể, không chỉ tin
lại solution doc).

---

## ✅ Kết quả thực tế (2026-09-09)

- Bước 1 xác nhận lại: `grep -rn "new AutomationEventBridge" --include=*.ts .`
  chỉ khớp `.claude/worktrees/*` (worktree khác, không liên quan) và
  chính doc-comment của file — 0 caller thật. Không file `.test.ts` nào
  tồn tại cho class này (đúng như README đã ghi).
- Xoá `desktop/src/main/automations/AutomationEventBridge.ts`.
- Sửa `specs/backend/bugs/automation/BUG-BE-AT-001-event-based-automation-not-implemented.md`'s
  status từ "✅ FIXED" sai về "🔴 REOPENED", trỏ sang CR-AUTO-005.
- **Verify**: `npx tsc --noEmit` trong `desktop/` — 0 lỗi liên quan tới
  `AutomationEventBridge` hay `automations/`. `npx vitest run
  src/main/automations/` — 6/7 test file pass, 34/34 test pass; 1 file
  (`service.test.ts`) fail vì lỗi **không liên quan** (`app-icon.ts`'s
  `electron` CJS/ESM import — pre-existing trong working tree, xác nhận
  qua `git status` không nằm trong diff của task này).

**Files đã sửa:**
- `desktop/src/main/automations/AutomationEventBridge.ts` (XOÁ)
- `specs/backend/bugs/automation/BUG-BE-AT-001-event-based-automation-not-implemented.md` (MODIFY)
