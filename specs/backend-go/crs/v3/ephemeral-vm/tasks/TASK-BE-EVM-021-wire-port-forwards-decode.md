# TASK-BE-EVM-021: Bỏ "deliberately omitted" — wire `port_forwards` thật

**Solution:** [BE-SOL-EVM-005](../solutions/BE-SOL-EVM-005-ssh-target-port-forwards.md) | **CR:** CR-EVM-008
**Depends on:** [TASK-BE-EVM-020](./TASK-BE-EVM-020-port-forwards-proto.md)
**Status:** ✅ DONE (2026-09-09)

---

## Mục tiêu

2 điểm decode hiện bỏ qua `portForwards` có chủ đích (comment
"deliberately omitted") — đổi để pass field qua thật.

## Files cần sửa

1. `backend-go/.../usecase/ports.go:497` (MODIFY)
2. `backend-go/.../devserveragent/client.go:704` (MODIFY)

## Nội dung

Xoá comment "deliberately omitted, see message doc comment", thêm decode
`port_forwards` vào struct/params tương ứng, forward tới nơi cần dùng
(Hướng A: params gửi cho agent's `vm.sshDial`; Hướng B: params cho
`ephemeralsshconn`/`backendrelaysshprovisioner` — xem TASK-BE-EVM-022).

## Test cases cần cover

- `port_forwards` có giá trị → xuất hiện đúng trong params gửi đi (không còn bị lọc bỏ).
- `port_forwards` rỗng → không đổi hành vi so với trước (regression test).

## Verify

```bash
cd backend-go/services/infra-fleet-service && go test ./internal/usecase/...
```

## gitnexus

`impact({target: "ports.go", direction: "downstream"})` trước khi sửa.

---

## ✅ Kết quả thực tế (2026-09-09)

**Lệch so với sketch gốc**: task gốc chỉ nêu 2 điểm decode
(`ports.go:497`, `client.go:704`), nhưng đọc kỹ luồng dữ liệu thật phát
hiện **cần 1 điểm thứ 3**: `ephemeral_vm_relay.go`'s
`buildEphemeralVmSshTarget` — hàm chuyển `usecase.EphemeralVmRecipeSshTarget`
(kết quả decode từ agent) thành `domain.EphemeralVmSshTarget` (type
`EphemeralVmSshProvisioner.Provision` thực sự nhận) — đây mới là nơi
"forward tới nơi cần dùng" mà solution mô tả, không phải chỉ dừng ở
decode JSON. Không có điểm này, `PortForwards` decode được nhưng
"chết" giữa đường, không tới được Hướng A/B.

3 điểm đã sửa (chuỗi đầy đủ agent JSON → Hướng A/B):
1. `ports.go`: thêm `EphemeralVmRecipeSshTarget.PortForwards
   []PortForward` + `type PortForward struct` (usecase layer).
2. `client.go`: `vmProvisionSshTargetWire` thêm field `PortForwards
   []vmProvisionPortForwardWire` (JSON tag `portForwards`) +
   `toUsecasePortForwards()` helper.
3. `server_ephemeral_vm.go`: `toProtoPortForwards()` helper, map
   `usecase.PortForward` → proto `infrafleetv1.PortForward` (chiều
   ngược — trả kết quả provision về renderer).
4. **Mới phát hiện**: `ephemeral_vm_relay.go`'s `buildEphemeralVmSshTarget`
   + `domain/ephemeral_vm_ssh_target.go`: thêm
   `domain.EphemeralVmSshTarget.PortForwards []EphemeralVmSshPortForward`
   + `toDomainPortForwards()` helper — đây là chỗ dữ liệu thực sự chảy
   tới `EphemeralVmSshProvisioner.Provision`, nơi Hướng A
   (TASK-AG-EVM-011) và Hướng B (TASK-BE-EVM-022) sẽ đọc để setup
   forward thật.

**Verify**: `gofmt -l` sạch cả 5 file. `go build` cho
`internal/domain`, `internal/usecase`, `internal/adapter/devserveragent`,
`internal/adapter/grpc` — sạch. `go vet ./services/infra-fleet-service/...`
— sạch. `go test` cho 3 package trên — pass, cộng 1 test case mới
(`TestStreamVmProvision_EmitsResultEventOnStreamEnd/new_connection_ssh_shape`
mở rộng assert `PortForwards` round-trip qua toàn bộ chuỗi wire→usecase).

**Phát hiện phụ, KHÔNG do task này gây ra**: `go build
./services/infra-fleet-service/...` (bao gồm `cmd/server`) lỗi —
`*postgres.SshTargetStore` thiếu method `Delete` cho
`usecase.SshTargetRepository`. Xác nhận qua `git status`: file
`internal/usecase/delete_ssh_target.go` (untracked) và
`create_ssh_target_test.go` (modified) — **không phải do tôi sửa**,
có vẻ là 1 thay đổi khác đang làm dở song song trong cùng working tree
(SSH target delete feature). Build/test của mọi package tôi thực sự
sửa (domain/usecase/devserveragent/grpc, không gồm cmd/server) đều
sạch — không liên quan tới port-forwards.

**Files đã sửa:**
- `backend-go/services/infra-fleet-service/internal/usecase/ports.go` (MODIFY)
- `backend-go/services/infra-fleet-service/internal/adapter/devserveragent/client.go` (MODIFY)
- `backend-go/services/infra-fleet-service/internal/adapter/devserveragent/client_stream_vm_provision_test.go` (MODIFY)
- `backend-go/services/infra-fleet-service/internal/adapter/grpc/server_ephemeral_vm.go` (MODIFY)
- `backend-go/services/infra-fleet-service/internal/domain/ephemeral_vm_ssh_target.go` (MODIFY)
- `backend-go/services/infra-fleet-service/internal/usecase/ephemeral_vm_relay.go` (MODIFY)
