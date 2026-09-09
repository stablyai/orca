# TASK-AG-EVM-012: Mount/copy-out worktree↔VM — khảo sát kỹ thuật (KHÔNG PHẢI TASK CODE)

**Solution:** [SOL-AG-EVM-005](../solutions/SOL-AG-EVM-005-worktree-mount-decision-memo.md) | **CR:** CR-EVM-009
**Depends on:** Không
**Status:** ⛔ BLOCKED — chờ quyết định sản phẩm ở CR-EVM-009's Bước 1, AI không tự thực thi code

---

## Mục tiêu

Task khảo sát, không code. AI thực thi task này chỉ được:

1. Xác nhận `ssh-outbound-filesystem-provider.ts`'s khả năng thật hiện
   có (đọc/ghi file 1 lần trên host SSH) — có đủ làm nền cho "copy-out
   1 lần" hay không, và khoảng cách tới "mount liên tục" lớn tới đâu.
2. Với `connection_type: 'orca-server'`: xác nhận VM và agent có chia sẻ
   filesystem host không (đọc `EphemeralVmRelay`/`ephemeral-vm-recipe-runner.ts`
   để xác nhận, không giả định).
3. Ghi báo cáo (mục "Kết quả khảo sát" dưới) — KHÔNG viết code mount/
   copy-out nào.

## Không được làm

Viết `ssh-outbound-filesystem-provider.ts` mở rộng, thêm RPC mount mới,
hay bất kỳ thay đổi hành vi nào — chờ CR-EVM-009's quyết định sản phẩm
trước.

## Kết quả khảo sát (2026-09-09)

### 1. `ssh-outbound-filesystem-provider.ts` — chỉ đọc, không ghi

`agent/src/relay/ssh-outbound-filesystem-provider.ts` export đúng 2 hàm
đọc: `validateReadDirViaHiddenTargetParams`/
`validateReadFileViaHiddenTargetParams`, dùng `ssh2`'s SFTP subsystem
qua `openSftp(session)`. **Không có hàm ghi/upload nào** (`grep` "writeFile\|upload"
trong file: 0 kết quả). Kết luận:
- **Copy-out** (đọc file từ VM SSH về local): khả năng đọc đã có, nhưng
  chưa có bước "lưu về local filesystem của agent" — cần thêm logic gọi
  `readFileViaHiddenTarget` rồi ghi ra local path, không phức tạp nếu
  cần (SFTP read → Node `fs.writeFile` local, cả 2 nguyên liệu đã có
  sẵn riêng lẻ).
- **Mount** (ghi nội dung worktree cục bộ VÀO VM SSH): cần khả năng ghi
  qua hidden target — **hoàn toàn chưa tồn tại**, đây là gap thật sự
  cần code mới nếu Nhánh B được chọn (không phải chỉ nối dây).

### 2. `connection_type: 'orca-server'` — VM và agent CÙNG HOST filesystem

`ephemeral-vm-recipe-runner.ts`'s `validateRepoPath` gọi `statSync`
(Node `fs`, đồng bộ, **trực tiếp trên filesystem cục bộ của chính agent
process**) — xác nhận: với `connection_type: 'orca-server'`, recipe's
`create`/`suspend`/... chạy như subprocess ngay trên host của agent (dev
server), không phải dial tới máy khác. **Không có "khoảng cách" nào giữa
agent và "VM" trong trường hợp này** — `repoPath` agent thấy được và
"VM" thấy được là CÙNG 1 filesystem.

### Kết luận tổng hợp

- Với `connection_type: 'orca-server'`: khái niệm "mount"/"copy-out" gần
  như **không có ý nghĩa kỹ thuật** — không có 2 filesystem tách biệt để
  đồng bộ. Mô hình hiện tại (trỏ workspace vào folder VM tự tạo) là lựa
  chọn hợp lý nhất cho connection type này, không phải thiếu sót.
- Với `connection_type: 'ssh'`: đây là trường hợp DUY NHẤT "mount"/
  "copy-out" có ý nghĩa thật (VM là 1 host khác biệt thật sự) — và đây
  cũng là trường hợp cần code mới nhiều nhất (ghi qua hidden target chưa
  tồn tại).
- **Khuyến nghị cho CR-EVM-009's quyết định sản phẩm**: nếu chọn Nhánh B
  (cần mount/copy-out thật), giới hạn phạm vi CHỈ cho `connection_type:
  'ssh'` — không áp dụng cho `orca-server` (không cần, không có ý
  nghĩa). Đây là thông tin quan trọng để ước lượng effort đúng: Nhánh B
  không phải "sửa 1 chỗ cho cả 2 connection type", mà chỉ liên quan 1
  trong 2.

Không code gì trong task này, theo đúng yêu cầu — chỉ khảo sát.
