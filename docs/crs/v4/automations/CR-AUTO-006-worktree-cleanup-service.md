# CR-AUTO-006 — `WorktreeCleanupService.ts`: wire thật hoặc xoá

| Trường | Giá trị |
|--------|---------|
| **CR ID** | CR-AUTO-006 |
| **Tên** | Quyết định số phận `WorktreeCleanupService.ts` — dead code trông sound nhưng chưa từng chạy |
| **Loại** | Bug Fix (dead code) / Feature (nếu chọn wire) |
| **Priority** | P2 |
| **Phiên bản** | v1.0 |
| **Ngày tạo** | 2026-09-09 |
| **Trạng thái** | 🔲 Proposed — chưa triển khai |
| **Tác giả** | Audit trực tiếp mã nguồn theo yêu cầu "rà soát F14 ở frontend và backend-go" |
| **Tác động HLD** | Automation domain, worktree lifecycle |
| **Tác động Features** | F14 (Automations), tương tác với F01 (Parallel Worktrees) |

---

## Bối cảnh & Vấn đề gốc

`desktop/src/main/automations/WorktreeCleanupService.ts` implement 1
daemon dọn worktree cũ: filter theo tuổi/status, kiểm tra an toàn qua
`git status --porcelain` trước khi xoá, gọi `git worktree remove --force`.
Logic **trông hợp lệ và gọi đúng RPC thật** (`git.exec`, `worktree.list`
— cả 2 tồn tại thật, verified tại
`desktop/src/main/runtime/rpc/methods/worktree.ts:31` và nhiều call site
khác). Nhưng cùng pattern với `AutomationEventBridge.ts`
([CR-AUTO-005](./CR-AUTO-005-real-event-triggers.md)):
`grep -rn "new WorktreeCleanupService"` toàn repo chỉ khớp chính
doc-comment ví dụ của file (dòng 18) — **không composition root nào khởi
tạo class này**. Không giống `AutomationEventBridge.ts` (sẽ throw nếu
gọi), file này *có thể* chạy đúng nếu được wire — nhưng hiện tại đơn
giản là không ai gọi.

Không rõ đây là: (a) tính năng dự định nhưng bị bỏ dở giữa chừng, hay (b)
đã được thay thế bởi cơ chế khác (vd. cleanup thủ công qua UI, hoặc 1
service khác đã đảm nhiệm việc này) và code này lẽ ra phải xoá cùng lúc.
CR này bắt đầu bằng việc xác định câu hỏi đó trước khi chọn hướng.

## Giải pháp đề xuất

### Bước 1 — Xác định có cleanup mechanism nào khác đã thay thế chưa

Khảo sát: worktree cleanup hôm nay được làm thế nào trong sản phẩm (thủ
công qua UI xoá worktree, hay có tự động nào khác)? Nếu đã có cơ chế
khác đủ dùng, `WorktreeCleanupService.ts` là code thừa từ 1 thiết kế cũ
— xoá thẳng, không cần bước 2.

### Bước 2 (nếu chọn wire thật) — Đưa vào làm 1 automation action hoặc scheduled job

Cách hợp lý nhất theo đúng mô hình action-chain (nếu
[CR-AUTO-002](./CR-AUTO-002-multi-action-chain-data-model.md) đã có):
biến `WorktreeCleanupService`'s logic thành **1 action type** riêng
(`CLEANUP_WORKTREES`) mà user tự tạo 1 automation cron (vd. "mỗi Chủ nhật
lúc 2h sáng") để chạy — nhất quán với cách F14 đã thiết kế các action
khác, thay vì 1 daemon ẩn chạy ngầm không cấu hình được từ UI.

Nếu không muốn chờ CR-AUTO-002, phương án tối thiểu: wire
`WorktreeCleanupService` như 1 scheduled job độc lập trong
`desktop/src/main`'s composition root, với config (`maxAgeMs`, filter
status) đọc từ settings — nhưng đây là giải pháp tạm, nên ưu tiên nhánh
"1 action type" ở trên nếu timeline cho phép.

### Bước 3 — Test

Class hiện chưa có file test riêng (khác các file automation khác đều có
`.test.ts` song song) — bất kể chọn nhánh nào ở bước 2, cần thêm test
trước khi coi là "wire xong", đặc biệt cho safety check
(`git status --porcelain` phải chặn xoá worktree có uncommitted changes).

## Rủi ro / Phụ thuộc

| Hạng mục | Rủi ro | Ghi chú |
|---|---|---|
| Xoá nhầm worktree đang có việc dở dang nếu safety check có bug chưa test | Cao (nếu chọn wire) | Bắt buộc có test cho nhánh an toàn trước khi bật thật cho user, dù chọn nhánh action-type hay scheduled-job |
| Bước 1 kết luận sai (tưởng có cơ chế khác nhưng thực ra không) | Trung bình | Khảo sát kỹ, không chỉ dựa vào UI hiện có — kiểm tra cả automation/backlog docs xem có đề cập worktree cleanup ở nơi khác |
| Nếu chọn xoá thẳng nhưng thực ra tính năng có giá trị sản phẩm thật | Thấp | Trước khi xoá hẳn, xác nhận với product/roadmap — CR này chỉ đề xuất kỹ thuật, quyết định giữ/xoá final nên có sign-off |

## Không thuộc phạm vi CR này

- Nếu chọn nhánh "action type mới", phần định nghĩa action-chain framework
  chung thuộc CR-AUTO-002, CR này chỉ định nghĩa nội dung riêng của
  `CLEANUP_WORKTREES`.

## Liên quan

- `desktop/src/main/automations/WorktreeCleanupService.ts`
- `desktop/src/main/runtime/rpc/methods/worktree.ts:31` (`worktree.list`, RPC thật)
- `desktop/src/main/automations/AutomationEventBridge.ts` (dead code cùng dạng, xem CR-AUTO-005 để so sánh cách xử lý)
- [CR-AUTO-002](./CR-AUTO-002-multi-action-chain-data-model.md) (nếu chọn nhánh action-type)
