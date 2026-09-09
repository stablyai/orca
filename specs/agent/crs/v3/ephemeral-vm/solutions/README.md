# agent Solutions — Ephemeral VM

**CRs:** [docs/crs/v3/ephemeral-vm/](../../../../../../docs/crs/v3/ephemeral-vm/README.md)
**backend-go counterpart:** [specs/backend-go/crs/v3/ephemeral-vm/solutions/](../../../../backend-go/crs/v3/ephemeral-vm/solutions/README.md)
**Frontend counterpart:** [specs/frontend/crs/v3/ephemeral-vm/solutions/](../../../../frontend/crs/v3/ephemeral-vm/solutions/README.md)
**TDD tham chiếu:** [TDD-AG-07](../../../../tdd/v5/07-jsonrpc-dispatch.md) (dispatch + streaming protocol); [TDD-AG-03](../../../../tdd/v5/03-connection-modes.md) (lưu ý: đã lỗi thời ở phần reconnect, xem mục "Cảnh báo TDD lỗi thời" bên dưới)

## Solutions

| Solution | CR | Status |
|---|---|---|
| [SOL-AG-EVM-001](./SOL-AG-EVM-001-vm-exec-handler.md) | CR-EVM-001 | 🔲 Designed — chưa implement |
| [SOL-AG-EVM-002](./SOL-AG-EVM-002-vm-provision-streaming-handler.md) | CR-EVM-003 (phần agent) | 🔲 Designed — chưa implement |
| [SOL-AG-EVM-003](./SOL-AG-EVM-003-outbound-ssh-client.md) | CR-EVM-005 (phần agent) | 🔲 Designed — sketch, chưa committed |

> **Cập nhật 2026-09-09 — SOL-AG-EVM-001..003 đã ✅ Done.** CR-EVM-001..005
> (mà 3 solution trên tương ứng) được xác nhận đã code xong trong
> `80ffe57cd`/`591de6951` — xem
> [docs/crs/v3/ephemeral-vm/README.md](../../../../../../docs/crs/v3/ephemeral-vm/README.md)'s
> "Cập nhật 2026-09-09". 2 solution mới dưới đây (004, 005) là cho
> CR-EVM-006..011 — nhóm audit mới, chưa triển khai.

| [SOL-AG-EVM-004](./SOL-AG-EVM-004-ssh-target-port-forwards.md) | CR-EVM-008 (phần agent, Hướng A) | 🔲 Designed — chưa implement |
| [SOL-AG-EVM-005](./SOL-AG-EVM-005-worktree-mount-decision-memo.md) | CR-EVM-009 (phần agent, decision memo) | 🔲 Blocked — chờ quyết định sản phẩm |

CR-EVM-006/007 (frontend-only), CR-EVM-010 (frontend, xem
`AgentDetector` — Electron main, không phải Dev Server Agent), CR-EVM-011
(chưa xác nhận scope) không có solution ở đây.

## Cảnh báo TDD lỗi thời — đã xác nhận, không giả định

`specs/agent/tdd/v5/03-connection-modes.md`/`04-handshake-session.md` mô
tả `connectDirect()` **`process.exit(2)`** khi mất kết nối, không tự
retry — nhưng `SOL-AG-STORAGE-002` (nhóm CR-STORAGE, đọc source thật
2026-09-07) đã xác nhận: `connectDirect()` thật hiện tại chạy 1 vòng lặp
tự reconnect (`RECONNECT_DELAYS_MS`), không `exit()` trừ khi đóng sạch
(`code===1000`) hoặc `SIGINT`/`SIGTERM`. 3 solution dưới đây tiếp tục
tham chiếu TDD-AG-03/07 cho phần **shape dispatch/streaming vẫn đúng**
(§1 JSON-RPC Method Router, §7 Streaming Protocol), nhưng **không** dựa
vào TDD-AG-03's mô tả reconnect khi thiết kế `vm.provision`'s vòng đời
dài (SOL-AG-EVM-002 mục 3) — dùng hành vi thật đã xác nhận.

`07-jsonrpc-dispatch.md §9`'s `route()` mô tả 1 file dispatch duy nhất
(`agent-rpc-dispatch.ts`) — mã nguồn thật hiện đã tách thành nhiều file
theo domain (`agent-rpc-dispatch-misc.ts`, `agent-rpc-dispatch-browser.ts`,
`agent-rpc-dispatch-git.ts`, ...). 3 solution dưới đây dùng cấu trúc file
thật, không dùng tên file TDD liệt kê.

## Thứ tự implement

```
SOL-AG-EVM-001 → độc lập, sửa lỗi runtime đang chạy sai hôm nay — P0, làm NGAY
SOL-AG-EVM-002 → dùng chung agent-ephemeral-vm-handler.ts với 001 — nên
                 làm SAU 001 để tránh 2 PR cùng sửa 1 file mới song song
SOL-AG-EVM-003 → độc lập kỹ thuật (subsystem SSH2 hoàn toàn mới), nhưng
                 chỉ có ý nghĩa sau khi SOL-AG-EVM-002's provision flow
                 tồn tại để route vào nhánh {type:'ssh', target} — làm sau

── nhóm 004-005 (CR-EVM-006..011, sau khi 001-003 đã Done) ──────────────

SOL-AG-EVM-004 → phụ thuộc kỹ thuật vào SOL-AG-EVM-003 (đã Done, dùng
                 chung `ssh-outbound-client.ts`) — đồng bộ CỨNG với
                 BE-SOL-EVM-005 (field `portForwards` phải khớp 2 phía)
SOL-AG-EVM-005 → BLOCKED — không code cho tới khi CR-EVM-009's quyết
                 định sản phẩm chốt
```
