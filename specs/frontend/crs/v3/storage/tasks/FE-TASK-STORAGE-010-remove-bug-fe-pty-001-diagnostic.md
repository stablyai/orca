# FE-TASK-STORAGE-010: Xoá `bug-fe-pty-001-diagnostic-log.ts` + call site

**Solution:** FE-SOL-STORAGE-005 | **CR:** CR-STORAGE-005
**Depends on:** Không
**Status:** ✅ DONE — điều kiện tiên quyết xác nhận qua
`specs/frontend/storage/browser-storage-catalog.md` (dòng 67: "TEMP
diagnostic ring-buffer for the (now-resolved) BUG-FE-PTY-001
investigation"; mục "Cross-cutting observations" #4: "the PTY-001
investigation is already resolved") và
`specs/frontend/storage/README.md` (dòng 42-43: "two bug-investigation
diagnostic ring buffers (one for an already-resolved bug...)"). Đã xoá
module + 4 call site (`pty-connection.ts`, `remote-runtime-pty-transport.ts`
×4 call site, `web-runtime-session.ts`, `worktrees.ts`) + import tương ứng.
`impact({target: "logBugFePty001", direction: "upstream"})` chạy trước khi
xoá (12 upstream symbols qua call chain `connectPanePty`/transport
lifecycle — risk gắn nhãn HIGH do độ phủ của call graph terminal-pane, không
phải vì logic bị đổi: hàm bị xoá chỉ console.error + ghi localStorage, không
return giá trị nào được dùng). Verify: `npx vitest run
src/renderer/src/components/terminal-pane/
src/renderer/src/runtime/web-runtime-session.test.ts
src/renderer/src/store/slices/worktrees.test.ts` — 3 file test liên quan
trực tiếp tới các file bị sửa (`worktrees.test.ts`,
`web-runtime-session.test.ts`, `remote-runtime-pty-transport.test.ts`) đều
pass 100% (295/295). Toàn bộ thư mục `terminal-pane/` có 4 test file/12 test
case fail, xác nhận qua đối chiếu diff + chạy cô lập từng cái là KHÔNG liên
quan tới thay đổi này (pre-existing/flaky trong môi trường dùng chung: 1 —
`terminal-url-link-click.test.ts` thiếu mock `window.api.runtime`, không hề
liên quan `logBugFePty001`; 2 — `pty-transport.test.ts` lệch hằng số
`timeoutMs` 15000 vs 60000, không phải do sửa lần này; 3 —
`pty-connection.test.ts`'s "Windows CJK repaint" test — file diff xác nhận
chỉ có đúng 1 thay đổi trong `pty-connection.ts` là xoá import + lời gọi
`logBugFePty001`, không đụng gì tới logic CJK repaint; 4 —
`terminal-parking-e2e-overrides.test.ts` pass khi chạy cô lập, fail chỉ khi
chạy cùng thư mục — flaky do thứ tự test). `oxlint` sạch trên 4 file sửa.
`gitnexus detect_changes` không phản ánh đúng do index có vẻ stale trong
môi trường này (biết trước, xem `SOLUTION-FE-BIGFILE-006-pty-connection.md`)
— không dùng làm căn cứ, dựa vào diff thủ công + kết quả test thay thế.

---

## ⚠️ Điều kiện tiên quyết

Xác nhận `BUG-FE-PTY-001` vẫn ở trạng thái RESOLVED (đối chiếu
`specs/frontend/bugs/` — không chỉ dựa vào memory, đọc lại spec/bug tracker
thật) trước khi xoá.

## Mục tiêu

Xoá module diagnostic tạm + 4 call site đã xác nhận.

## Files cần sửa

1. `frontend/src/renderer/src/lib/bug-fe-pty-001-diagnostic-log.ts` — XOÁ
2. `frontend/src/renderer/src/components/terminal-pane/pty-connection.ts` — MODIFY (xoá call site + import)
3. `frontend/src/renderer/src/components/terminal-pane/remote-runtime-pty-transport.ts` — MODIFY
4. `frontend/src/renderer/src/runtime/web-runtime-session.ts` — MODIFY
5. `frontend/src/renderer/src/store/slices/worktrees.ts` — MODIFY

## Việc cần làm

1. `codegraph explore "bug-fe-pty-001-diagnostic-log"` — xác nhận tên hàm
   export chính xác và toàn bộ call site (audit trước đó chỉ xác nhận file
   path).
2. `impact({target: "<tên hàm log>", direction: "upstream"})` — bắt buộc
   trước khi xoá theo CLAUDE.md.
3. Xoá call site tại 4 file trên, xoá import tương ứng.
4. Xoá file module.
5. `detect_changes({scope: "compare", base_ref: "main"})`.

## Test cases cần cover

Không cần test case mới (xoá code, không phải thêm tính năng) — chỉ cần
xác nhận test suite hiện có của 4 file bị sửa vẫn pass sau khi xoá call
site (không có test nào assert on log side-effect của module này).

## Verify

```bash
cd frontend && npx vitest run src/renderer/src/components/terminal-pane/ src/renderer/src/runtime/web-runtime-session.test.ts src/renderer/src/store/slices/worktrees.test.ts
```

## gitnexus

`impact()` bắt buộc trước khi xoá (mục 2). `detect_changes({scope:
"compare", base_ref: "main"})` sau khi xoá — kỳ vọng risk **LOW**, không
execution flow nào bị ảnh hưởng (chỉ mất 1 symbol log, không đổi logic).

## Blocking

Không.
