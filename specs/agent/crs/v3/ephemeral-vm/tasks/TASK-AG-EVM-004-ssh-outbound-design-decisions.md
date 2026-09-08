# TASK-AG-EVM-004: Quyết định kiến trúc cần chốt trước khi implement outbound SSH client

**Solution:** [SOL-AG-EVM-003](../solutions/SOL-AG-EVM-003-outbound-ssh-client.md) | **CR:** CR-EVM-005
**Depends on:** Không (nhưng nên chờ [TASK-AG-EVM-003](./TASK-AG-EVM-003-dispatch-wire-vm-provision.md) xong để có điểm nối `{type:'ssh',...}` thật)
**Status:** ✅ DONE — 4 quyết định đã chốt, xem
[SOL-AG-EVM-003 §"Quyết định đã chốt (TASK-AG-EVM-004)"](../solutions/SOL-AG-EVM-003-outbound-ssh-client.md#quyết-định-đã-chốt-task-ag-evm-004).
Tóm tắt: (1) credential material qua RPC parameter (backend-go resolve
Vault trước, gửi theo giá trị) — **cần TASK-BE-EVM-009 (còn TODO) xác
nhận khớp**; (2) `ssh2@1.17.0` không có `jumpHost`/`proxyCommand` sẵn,
nhưng có đủ primitive (`ConnectConfig.sock` + `Client#forwardOut`) để tự
lắp — cần code adapter thêm; (3) hidden-target registry không persist
qua restart, backend-go tự động retry-dial 1 lần (transparent) trước khi
báo lỗi user; (4) dial thật ở `AttachWorkspace` xác nhận là quyết định
cuối, không đổi. Task code kế tiếp (TASK-AG-EVM-005+) chưa được đánh số.

---

## Mục tiêu

`SOL-AG-EVM-003` là sketch, không có tiền lệ code để mirror trực tiếp
(khác toàn bộ 3 task trước). Task này chốt các quyết định thiết kế bắt
buộc trước khi có thể viết task code cho subsystem SSH2 outbound mới.

## Quyết định cần chốt

1. **Kênh nhận `identityFile`/`identityAgent` credential material** —
   phối hợp với
   [TASK-BE-EVM-009](../../../../backend-go/crs/v3/ephemeral-vm/tasks/TASK-BE-EVM-009-ssh-design-decisions.md)'s
   quyết định 1 (2 phía phải khớp).
2. **`ssh2` npm package có hỗ trợ đủ `jumpHost`/`proxyCommand`
   (`EphemeralVmRecipeSshTargetSchema`'s field) sẵn có, hay cần code
   thêm?** — cần 1 phiên đọc tài liệu/source `ssh2` thật, không giả định.
3. **Hidden-target registry (agent-local, in-memory) có cần persist qua
   agent restart không?** — nếu không (SOL-AG-EVM-003 §2b's mặc định),
   xác nhận UX khi agent restart giữa lúc có outbound SSH session đang mở
   (báo lỗi rõ cho user, hay tự động thử dial lại) — quyết định này ảnh
   hưởng cả agent lẫn `BE-SOL-EVM-004`'s error handling.
4. **Thời điểm dial thật** — SOL-AG-EVM-003 §3 đề xuất dial khi
   `AttachWorkspace` (không phải ngay sau `provision`) — xác nhận đây là
   quyết định cuối, không phải 1 trong nhiều lựa chọn còn mở.

## Files liên quan (đọc để chốt quyết định, không sửa)

- `agent/package.json` (`ssh2`/`@types/ssh2` — xác nhận version, đọc changelog/type định nghĩa cho `jumpHost`/`proxyCommand` support)
- `agent/src/main/ssh/ssh-filesystem-stream-reader.ts`, `ssh-git-response-stream-reader.ts` (kiến trúc inbound để đối chiếu, không phải code tái dùng)
- `frontend/src/shared/ephemeral-vm-recipes.ts:47-` (`EphemeralVmRecipeSshTargetSchema`, contract không đổi)

## Kết quả mong đợi

Cập nhật trực tiếp vào
[SOL-AG-EVM-003](../solutions/SOL-AG-EVM-003-outbound-ssh-client.md)
với 4 quyết định trên đã chốt, đồng bộ với
[TASK-BE-EVM-009](../../../../backend-go/crs/v3/ephemeral-vm/tasks/TASK-BE-EVM-009-ssh-design-decisions.md)'s
kết quả — sau đó tách thành các task code cụ thể (TASK-AG-EVM-005+, đặt
tên khi task này đóng).

## Verify

Không có lệnh build/test.

## Blocking

Mọi task code cho CR-EVM-005 phần agent (chưa được đánh số) phụ thuộc
task này VÀ `TASK-BE-EVM-009` (2 phía phải chốt đồng bộ, đặc biệt quyết
định 1).
