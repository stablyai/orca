# FE-SOL-STORAGE-005: Xoá `bug-fe-pty-001-diagnostic-log.ts` và `remove-project-diagnostic-log.ts`

> **🔲 Designed — chưa implement.** Không phụ thuộc solution nào khác
> trong nhóm CR-STORAGE — có thể làm độc lập, bất kỳ lúc nào. Khác các
> solution khác trong nhóm này, đây **không phải** thiết kế trừu tượng —
> đủ cụ thể để thực thi trực tiếp, chỉ cần xác nhận điều kiện tiên quyết ở
> mục 1 trước.

**CR:** [CR-STORAGE-005](../../../../../../docs/crs/v3/storage/CR-STORAGE-005-cleanup-diagnostic-modules.md)

---

## 1. Điều kiện tiên quyết — PHẢI xác nhận trước khi xoá, không suy đoán

| Module | Bug liên quan | Trạng thái cần xác nhận |
|---|---|---|
| `bug-fe-pty-001-diagnostic-log.ts` | `BUG-FE-PTY-001` | Theo memory dự án: **RESOLVED** (fix #13 confirmed live) — đối chiếu lại `specs/frontend/bugs/` để xác nhận không còn theo dõi tái phát |
| `remove-project-diagnostic-log.ts` | "Remove Project no-op" | **CHƯA xác nhận được** trong audit này — tra `specs/frontend/bugs/project-workspace/` hoặc tương đương trước khi xoá module này |

**Nếu bug thứ 2 chưa đóng: chỉ xoá `bug-fe-pty-001-diagnostic-log.ts` trong
lượt này, để `remove-project-diagnostic-log.ts` lại cho tới khi xác nhận
được.**

## 2. Impact analysis bắt buộc trước khi xoá (theo CLAUDE.md/AGENTS.md)

```
codegraph explore "logBugFePty001Diagnostic bug-fe-pty-001-diagnostic-log"
codegraph explore "logRemoveProjectDiagnostic remove-project-diagnostic-log"
```

(tên hàm export chính xác cần xác nhận khi đọc file — audit trước đó chỉ
xác nhận file path và call site, chưa trích xuất tên hàm export). Dựa trên
số lượng call site đã biết (4 file cho module 1, 2 file cho module 2), rủi
ro dự kiến **THẤP** — nhưng bắt buộc chạy để xác nhận, không giả định.

## 3. Thứ tự xoá

1. Xoá lời gọi hàm log tại từng call site đã xác nhận:
   - `renderer/src/components/terminal-pane/pty-connection.ts`
   - `renderer/src/components/terminal-pane/remote-runtime-pty-transport.ts`
   - `renderer/src/runtime/web-runtime-session.ts`
   - `renderer/src/store/slices/worktrees.ts`
   - (nếu bug 2 đã đóng) `renderer/src/components/sidebar/RemoveFolderDialog.tsx`
   - (nếu bug 2 đã đóng) `renderer/src/store/slices/repos.ts`
2. Xoá import tương ứng ở mỗi file trên (tránh unused-import lint error).
3. Xoá file `frontend/src/renderer/src/lib/bug-fe-pty-001-diagnostic-log.ts`
   (và `remove-project-diagnostic-log.ts` nếu điều kiện ở mục 1 thoả).
4. Chạy `detect_changes({scope: "compare", base_ref: "main"})` — xác nhận
   không có execution flow nào bị ảnh hưởng ngoài dự kiến (chỉ mất 1 vài
   symbol, không đổi flow logic nào).
5. Chạy test suite hiện có của các file bị sửa (không cần test case mới —
   đây là xoá code, không phải thêm tính năng).

## Files cần sửa

| File | Action |
|------|--------|
| `frontend/src/renderer/src/lib/bug-fe-pty-001-diagnostic-log.ts` | XOÁ |
| `frontend/src/renderer/src/lib/remove-project-diagnostic-log.ts` | XOÁ (nếu điều kiện mục 1 thoả) |
| `frontend/src/renderer/src/components/terminal-pane/pty-connection.ts` | MODIFY — xoá call site + import |
| `frontend/src/renderer/src/components/terminal-pane/remote-runtime-pty-transport.ts` | MODIFY — xoá call site + import |
| `frontend/src/renderer/src/runtime/web-runtime-session.ts` | MODIFY — xoá call site + import |
| `frontend/src/renderer/src/store/slices/worktrees.ts` | MODIFY — xoá call site + import |
| `frontend/src/renderer/src/components/sidebar/RemoveFolderDialog.tsx` | MODIFY (nếu điều kiện mục 1 thoả) |
| `frontend/src/renderer/src/store/slices/repos.ts` | MODIFY (nếu điều kiện mục 1 thoả) |

## Không thuộc phạm vi solution này

- Xây cơ chế thu thập/upload diagnostic log tập trung thay thế — ngoài
  phạm vi (xem CR).
- Bất kỳ thay đổi logic nào khác trong các file bị sửa ngoài việc xoá lời
  gọi log.

## Liên quan

- `specs/frontend/storage/browser-storage-catalog.md` (mục 5)
- User's project memory: "BUG-FE-PTY-001 investigation — RESOLVED (fix #13 confirmed live)"
