# agent Tasks — Ephemeral VM

**Solutions:** [../solutions/](../solutions/README.md)

| Task | Solution | Depends on | Status |
|---|---|---|---|
| [TASK-AG-EVM-001](./TASK-AG-EVM-001-vm-exec-handler.md) — `handleVmExec` | SOL-AG-EVM-001 | Không | ✅ DONE |
| [TASK-AG-EVM-002](./TASK-AG-EVM-002-vm-provision-streaming-handler.md) — `handleVmProvision` | SOL-AG-EVM-002 | 001 | ✅ DONE |
| [TASK-AG-EVM-003](./TASK-AG-EVM-003-dispatch-wire-vm-provision.md) — wire `vm.provision`/`vm.cancelProvision` | SOL-AG-EVM-002 | 002 | ✅ DONE |
| [TASK-AG-EVM-004](./TASK-AG-EVM-004-ssh-outbound-design-decisions.md) — chốt quyết định kiến trúc SSH outbound (không phải task code) | SOL-AG-EVM-003 | 003 (khuyến nghị, không cứng) | ✅ DONE |
| [TASK-AG-EVM-005](./TASK-AG-EVM-005-ssh-outbound-client.md) — `ssh-outbound-client.ts` (dial + jumpHost/proxyCommand) | SOL-AG-EVM-003 | Không | ✅ DONE |
| [TASK-AG-EVM-006](./TASK-AG-EVM-006-hidden-target-registry-and-ssh-dial-rpc.md) — hidden-target registry + `vm.sshDial` RPC | SOL-AG-EVM-003 | 005 | ✅ DONE |
| [TASK-AG-EVM-007](./TASK-AG-EVM-007-hidden-target-fs-git-providers.md) — fs/git provider cho hidden target | SOL-AG-EVM-003 | 006 | ✅ DONE |

**005/006/007 chỉ cần thiết khi backend-go's `EPHEMERAL_VM_SSH_MODE=agent-outbound`
(Hướng A)** — xem [TASK-BE-EVM-012](../../../../backend-go/crs/v3/ephemeral-vm/tasks/TASK-BE-EVM-012-ssh-mode-config-and-provisioner-interface.md).
Nếu backend-go chọn Hướng B (`backend-relay-deploy`, mặc định đề xuất),
agent/ không cần đổi gì — 3 task này vẫn nên hoàn thành để config có thể
đổi được, không phải "chỉ 1 trong 2 hướng tồn tại được".

## Thứ tự thực thi

```
001 → 002 → 003 → 004
005 → 006 → 007   (độc lập với 001-004, có thể chạy song song)
```

Tuyến tính trong từng nhóm — 001/002/003 sửa cùng 1 file
(`agent-ephemeral-vm-handler.ts`); 005/006/007 cũng vậy nhưng bắt đầu từ
2 file mới (`ssh-outbound-client.ts`), không đụng file của nhóm 001-004
ngoại trừ 006 mở rộng thêm `agent-ephemeral-vm-handler.ts` (cần merge
cẩn thận nếu 2 nhóm chạy đúng lúc cùng sửa file này).

**Cập nhật 2026-09-08 (006/007 hoàn thành)**: `case 'vm.sshDial'` +
`fs.readDirViaHiddenTarget`/`fs.readFileViaHiddenTarget`/
`git.statusViaHiddenTarget` KHÔNG nằm trong `agent-rpc-dispatch-misc.ts`
như 2 task đó sketch — file này đã vượt ngân sách oxlint `max-lines`
(300) từ trước (thuộc dirty state không liên quan tới CR-EVM-005,
KHÔNG được sửa). Dùng file dispatch mới
`agent-rpc-dispatch-hidden-target.ts` (`dispatchHiddenTargetRpc`), wire
vào `agent-rpc-dispatch.ts`'s `route()` — xem TASK-AG-EVM-006/007's
"Kết quả thực tế" để biết chi tiết. Nếu có task tương lai nào định mở
rộng thêm `agent-rpc-dispatch-misc.ts`, kiểm tra `npx oxlint` trước —
file đó đang ở trạng thái vi phạm sẵn.

## Nguyên tắc chung cho AI thực thi các task này

- **Luôn chạy `impact()`/`codegraph explore` trước khi sửa symbol** —
  đặc biệt `runRecipeCommand` (dùng ở cả 001 và 002) và hàm dispatch
  chính (003) — theo yêu cầu bắt buộc của `CLAUDE.md`/`AGENTS.md`.
- **Không tin `specs/agent/tdd/v5/03-connection-modes.md` cho hành vi
  reconnect** — đã xác nhận lỗi thời (xem
  [../solutions/README.md](../solutions/README.md)'s "Cảnh báo TDD lỗi
  thời"). Đọc source thật (`agent-connection-direct.ts`) nếu 1 task cần
  hiểu hành vi reconnect.
- **Tên file dispatch thật khác TDD-AG-07's mô tả** — dùng
  `agent-rpc-dispatch-misc.ts` (đã xác nhận qua đọc source), không dùng
  tên `agent-rpc-dispatch.ts` TDD liệt kê.
- **Test trước, không giả định pass.**
