# FE-TASK-STORAGE-011: Xoá `remove-project-diagnostic-log.ts` + call site (điều kiện)

**Solution:** FE-SOL-STORAGE-005 | **CR:** CR-STORAGE-005
**Depends on:** Không
**Status:** ✅ DONE (2026-09-08) — điều kiện tiên quyết nay đã được người
dùng xác nhận trực tiếp: bug "Remove Project no-op" đã đóng. Đã xoá module
`remove-project-diagnostic-log.ts` + 5 call site
(`RemoveFolderDialog.tsx`'s `handleConfirm`, `repos.ts`'s `removeProject` —
4 lời gọi log + import) và import tương ứng. Verify:
`npx vitest run src/renderer/src/store/slices/repos.test.ts
src/renderer/src/store/slices/repos-remove-project-purge-leak.test.ts
src/renderer/src/store/slices/repos-project-groups-delete.test.ts` —
**3 file, 28/28 test pass**.

---

**(Lịch sử — trạng thái trước khi xác nhận, giữ lại để tham khảo):**
🔲 BLOCKED — precondition không thoả, KHÔNG xoá module. Đã tra
`specs/frontend/bugs/project-workspace/` (chỉ có `BUG-FE-PW-001`,
`BUG-FE-PW-002` — không liên quan "Remove Project no-op") và toàn bộ
`specs/frontend/bugs/**` (grep `-rli "remove.project\|remove.folder\|no-op"`
— không có bug doc nào khớp, không có `RemoveFolderDialog`/
`remove-project-diagnostic` xuất hiện ngoài chính
`browser-storage-catalog.md`/`FE-SOL-STORAGE-005`/task doc này). Bằng
chứng phủ định rõ nhất:
`specs/frontend/storage/browser-storage-catalog.md` dòng 68 mô tả module
là "TEMP diagnostic ring-buffer for a 'Remove Project no-op' investigation"
— KHÔNG có tiền tố "(now-resolved)" như dòng 67 (module PTY-001); và
`specs/frontend/storage/README.md` dòng 42-43 nói rõ "two bug-investigation
diagnostic ring buffers (**one** for an already-resolved bug...)" — chỉ 1
trong 2 bug được xác nhận đã đóng (PTY-001), bug "Remove Project no-op"
KHÔNG nằm trong đó. Kết luận: đây là kết quả hợp lệ của task (task tự mô tả
khả năng này ở mục "Blocking"), không phải lỗi — KHÔNG xoá
`remove-project-diagnostic-log.ts` hay bất kỳ call site nào trong lượt
này.

---

## ⚠️ Điều kiện tiên quyết — KHÁC task 010

Bug "Remove Project no-op" **chưa được xác nhận đã đóng** trong toàn bộ
audit trước đó (khác `BUG-FE-PTY-001`, đã xác nhận RESOLVED). **Việc đầu
tiên của task này là tra `specs/frontend/bugs/project-workspace/` hoặc
tương đương** để tìm trạng thái thật. Nếu KHÔNG tìm thấy xác nhận bug đã
đóng — **dừng task này lại, báo cáo, không xoá module**.

## Mục tiêu (chỉ thực hiện nếu điều kiện trên thoả)

Xoá module diagnostic tạm + 2 call site.

## Files cần sửa (nếu điều kiện thoả)

1. `frontend/src/renderer/src/lib/remove-project-diagnostic-log.ts` — XOÁ
2. `frontend/src/renderer/src/components/sidebar/RemoveFolderDialog.tsx` — MODIFY
3. `frontend/src/renderer/src/store/slices/repos.ts` — MODIFY

## Việc cần làm

1. Tra cứu trạng thái bug (bắt buộc, xem điều kiện tiên quyết).
2. Nếu đã đóng: `codegraph explore "remove-project-diagnostic-log"` để xác
   nhận tên hàm export + toàn bộ call site.
3. `impact({target: "<tên hàm log>", direction: "upstream"})`.
4. Xoá call site + import tại 2 file, xoá module.
5. `detect_changes({scope: "compare", base_ref: "main"})`.

## Test cases cần cover

Không cần test case mới — xác nhận test suite hiện có của 2 file bị sửa
vẫn pass.

## Verify

```bash
cd frontend && npx vitest run src/renderer/src/components/sidebar/RemoveFolderDialog.test.tsx src/renderer/src/store/slices/repos.test.ts
```

## gitnexus

`impact()` bắt buộc trước khi xoá (nếu điều kiện thoả).

## Blocking

Không — nhưng bản thân task có thể "block" ở bước điều kiện tiên quyết nếu
bug chưa xác nhận đóng (đây là kết quả hợp lệ của task, không phải lỗi).
