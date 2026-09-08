# CR-STORAGE-005 — Dọn dẹp module diagnostic tạm (localStorage ring-buffer)

| Trường | Giá trị |
|--------|---------|
| **CR ID** | CR-STORAGE-005 |
| **Tên** | Xoá `bug-fe-pty-001-diagnostic-log.ts` và `remove-project-diagnostic-log.ts` + toàn bộ call site |
| **Loại** | Cleanup / Tech Debt |
| **Priority** | P3 |
| **Phiên bản** | v1.0 |
| **Ngày tạo** | 2026-09-07 |
| **Trạng thái** | 🔲 Proposed — chưa triển khai |
| **Tác giả** | Yêu cầu user: "dọn dẹp các module diagnostic tạm" |
| **Tác động HLD** | Không — thuần dọn dẹp code, không đổi hành vi sản phẩm |
| **Tác động Features** | Terminal PTY connection, Remove Project dialog (chỉ mất log chẩn đoán nội bộ, không đổi UX) |

---

## Bối cảnh & Vấn đề gốc

Audit storage ([`specs/frontend/storage/browser-storage-catalog.md`](../../../../specs/frontend/storage/browser-storage-catalog.md#5-misc--dev-tooling--diagnostics))
phát hiện 2 module ghi log chẩn đoán vào `localStorage`, cả 2 tự đánh dấu
TEMP trong comment đầu file, dùng để điều tra 2 bug cụ thể:

1. **`frontend/src/renderer/src/lib/bug-fe-pty-001-diagnostic-log.ts`** —
   ring buffer `{t,msg}[]` (cap 300) dưới key `orca.diag.bugFePty001`, phục
   vụ điều tra `BUG-FE-PTY-001` (`SSH_SESSION_EXPIRED` terminal saga). Theo
   memory của dự án, bug này **đã RESOLVED** (fix #13 đã xác nhận chạy ổn
   định trên production). Được gọi từ:
   - `renderer/src/components/terminal-pane/pty-connection.ts`
   - `renderer/src/components/terminal-pane/remote-runtime-pty-transport.ts`
   - `renderer/src/runtime/web-runtime-session.ts`
   - `renderer/src/store/slices/worktrees.ts`
2. **`frontend/src/renderer/src/lib/remove-project-diagnostic-log.ts`** —
   ring buffer `{t,msg}[]` (cap 100) dưới key `orca.diag.removeProject`,
   phục vụ điều tra 1 bug "Remove Project no-op". Được gọi từ:
   - `renderer/src/components/sidebar/RemoveFolderDialog.tsx`
   - `renderer/src/store/slices/repos.ts`

Cả 2 module đều **ghi log vào localStorage của người dùng thật** trong môi
trường production — tồn tại lâu dài sau khi mục đích điều tra đã kết thúc
là lãng phí (dù nhỏ) dung lượng localStorage của người dùng, và là tín hiệu
nhiễu cho bất kỳ ai đọc lại code sau này (tưởng đây là instrumentation lâu
dài, không phải tạm thời).

## Giải pháp đề xuất

1. **Xác nhận trạng thái bug trước khi xoá** (bắt buộc, không suy đoán):
   - `BUG-FE-PTY-001`: memory dự án ghi "RESOLVED (fix #13 confirmed
     live)" — cần đối chiếu lại `specs/frontend/bugs/` (hoặc tương đương)
     để xác nhận không còn theo dõi tái phát trước khi xoá hẳn log.
   - Bug "Remove Project no-op": cần xác nhận trạng thái tương tự (audit
     này **không** xác nhận được bug đã đóng hay chưa — chỉ xác nhận
     module tự nhận là TEMP).
2. **Chạy `gitnexus impact`/`codegraph explore` trên từng hàm log
   (`logBugFePty001Diagnostic`/tương đương, `logRemoveProjectDiagnostic`/
   tương đương) trước khi xoá** — theo đúng yêu cầu bắt buộc của
   `CLAUDE.md`/`AGENTS.md` ("MUST run impact analysis before editing any
   symbol"). Dựa trên số lượng call site đã liệt kê ở trên (4 và 2 file),
   rủi ro dự kiến **THẤP** (thuần call site gọi 1 hàm log, không có logic
   rẽ nhánh phụ thuộc kết quả trả về) — nhưng vẫn cần chạy để xác nhận,
   không giả định.
3. **Xoá theo thứ tự**: xoá lời gọi tại từng call site trước → xoá file
   module → chạy `detect_changes({scope: "compare", base_ref: "main"})` để
   xác nhận không có execution flow nào bị ảnh hưởng ngoài dự kiến.
4. **Không thay thế bằng cơ chế logging khác** trong CR này — nếu đội phát
   triển vẫn cần theo dõi các luồng này, đó là 1 quyết định instrumentation
   lâu dài riêng (ví dụ dùng `shared/trace/browser.ts`'s `ORCA_TRACE` cơ
   chế đã có sẵn thay vì tự chế ring-buffer mới mỗi lần điều tra bug) — ghi
   nhận như gợi ý, không bắt buộc trong CR này.

## Rủi ro / Phụ thuộc

| Hạng mục | Rủi ro | Ghi chú |
|---|---|---|
| Bug "Remove Project no-op" có thể **chưa** thực sự đóng | Trung bình | Khác với BUG-FE-PTY-001 (đã xác nhận RESOLVED trong memory dự án), audit này không tìm thấy xác nhận tương đương cho bug thứ 2 — PHẢI tra cứu `specs/frontend/bugs/` trước khi xoá, không xoá theo suy đoán |
| Mất khả năng chẩn đoán nếu bug tái phát sau khi xoá | Thấp | Cả 2 log chỉ ghi ring-buffer cục bộ trên máy người dùng — thực tế hiếm khi được thu thập lại (không thấy cơ chế upload log này lên đâu cả trong audit) — giá trị chẩn đoán thực tế của việc giữ lại là thấp |

## Không thuộc phạm vi CR này

- Xây cơ chế thu thập/upload diagnostic log tập trung (nếu đội phát triển
  muốn thay thế pattern "ring-buffer cục bộ" bằng thứ gì đó tốt hơn cho lần
  điều tra tiếp theo) — ngoài phạm vi 1 CR dọn dẹp.
- Bất kỳ thay đổi nào khác trong `pty-connection.ts`/`worktrees.ts`/
  `repos.ts`/`RemoveFolderDialog.tsx` ngoài việc xoá lời gọi log.

## Liên quan

- `specs/frontend/storage/browser-storage-catalog.md` (mục 5)
- `frontend/src/renderer/src/lib/bug-fe-pty-001-diagnostic-log.ts`
- `frontend/src/renderer/src/lib/remove-project-diagnostic-log.ts`
- User's project memory: "BUG-FE-PTY-001 investigation — RESOLVED (fix #13 confirmed live)"
