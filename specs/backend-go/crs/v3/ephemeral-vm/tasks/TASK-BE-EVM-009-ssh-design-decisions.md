# TASK-BE-EVM-009: Quyết định kiến trúc cần chốt trước khi implement `ssh`-type backend

**Solution:** [BE-SOL-EVM-004](../solutions/BE-SOL-EVM-004-ssh-connection-type-backend.md) | **CR:** CR-EVM-005
**Service:** `infra-fleet-service`
**Depends on:** [SOL-AG-EVM-003](../../../../agent/crs/v3/ephemeral-vm/solutions/SOL-AG-EVM-003-outbound-ssh-client.md) (thiết kế agent, chưa phải code)
**Status:** ✅ DONE — 3 quyết định đã chốt, ghi trong
[BE-SOL-EVM-004 §"Quyết định đã chốt (TASK-BE-EVM-009)"](../solutions/BE-SOL-EVM-004-ssh-connection-type-backend.md#quyết-định-đã-chốt-task-be-evm-009):
(1) credential material đi qua RPC param trên kênh agent↔`infra-fleet-service`
hiện có, agent KHÔNG tự gọi Vault — **cần TASK-AG-EVM-004 (agent-side,
chạy song song) xác nhận khớp**; (2) `infra.ephemeral_vm_ssh_targets` nằm
trong phạm vi ngoại lệ Vault-direct-call hiện có của `infra-fleet-service`,
dùng Vault path riêng (không tái dùng path của `ssh_targets`); (3) fs/git
cho "máy thứ 5" đi qua 1 route dispatch mới trong `git-gateway-service`
(tham số `hiddenTargetID` trực giao với `connectionId`), KHÔNG mở rộng
khái niệm "host" của `ResolveConnection` — giữ nguyên invariant
1-connectionId-1-DevServer.

---

## Mục tiêu

Khác các task khác trong nhóm này, task này **không sinh ra code** — nó
chốt 3 quyết định kiến trúc mà BE-SOL-EVM-004 cố tình để mở, bắt buộc
phải xong trước khi bất kỳ task code nào cho `ssh`-type backend có thể
viết được đúng.

## Quyết định cần chốt

1. **Credential material cho `identityFile`/`identityAgent` đi qua kênh
   nào tới agent?** (tham số RPC `vm.exec`-style, hay 1 lần fetch riêng
   qua Vault trực tiếp từ agent?) — ảnh hưởng cả schema bảng hidden-target
   mới lẫn agent's `dialOutboundSshTarget` (SOL-AG-EVM-003 §2a).
2. **Bảng `infra.ephemeral_vm_ssh_targets` (mới) có nằm trong phạm vi
   ngoại lệ Vault-direct-call hiện có của `infra-fleet-service` không?**
   — cần review theo đúng `06-secrets-vault-architecture.md`'s quy tắc
   mặc định "no other service talks to Vault directly" (BE-SOL-EVM-004 §2
   đã nêu, chưa xác nhận).
3. **fs/git surface cho "máy thứ 5" đi qua route nào?** — mở rộng
   `ResolveConnection`'s khái niệm host, hay 1 route dispatch hoàn toàn
   khác trong `git-gateway-service` (BE-SOL-EVM-004 §4, quyết định kiến
   trúc lớn nhất, ảnh hưởng nhiều service).

## Files liên quan (đọc để chốt quyết định, không sửa)

- `backend-go/services/infra-fleet-service/internal/usecase/ephemeral_vm_relay.go` (guard hiện tại)
- `specs/backend-go/tdd/architecture/06-secrets-vault-architecture.md`
- `specs/backend-go/tdd/architecture/08-inter-service-communication.md` (repo→host dispatch hiện có)
- `agent/src/relay/ssh-outbound-client.ts` (chưa tồn tại — SOL-AG-EVM-003 §2a's sketch)

## Kết quả mong đợi

1 tài liệu quyết định (hoặc cập nhật trực tiếp vào
[BE-SOL-EVM-004](../solutions/BE-SOL-EVM-004-ssh-connection-type-backend.md)/
[SOL-AG-EVM-003](../../../../agent/crs/v3/ephemeral-vm/solutions/SOL-AG-EVM-003-outbound-ssh-client.md))
ghi rõ 3 quyết định trên, sau đó tách thành các task code cụ thể
(TASK-BE-EVM-010+, đặt tên khi task này đóng) — theo đúng tinh thần
`TASK-AG-STORAGE-005`'s tiền lệ ("liệt kê quyết định cần người có thẩm
quyền sản phẩm/kiến trúc chốt, không tự chọn thay").

## Verify

Không có lệnh build/test — task này đóng khi có quyết định bằng văn bản
cho cả 3 mục, không phải khi có code chạy được.

## Blocking

Mọi task code cho CR-EVM-005 phần backend-go (chưa được đánh số) phụ
thuộc task này.
