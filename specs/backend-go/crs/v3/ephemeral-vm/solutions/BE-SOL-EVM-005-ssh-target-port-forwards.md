# BE-SOL-EVM-005: `portForwards` — proto field + Hướng B (backend-relay SSH)

> **🔲 Designed — chưa implement.**

**CR:** [CR-EVM-008](../../../../../../docs/crs/v3/ephemeral-vm/CR-EVM-008-ssh-target-port-forwards.md)
**Agent counterpart:** [SOL-AG-EVM-004](../../../../agent/crs/v3/ephemeral-vm/solutions/SOL-AG-EVM-004-ssh-target-port-forwards.md) (Hướng A)
**Service:** `infra-fleet-service`
**TDD tham chiếu:** [`infra-fleet-service.md`](../../../../tdd/services/infra-fleet-service.md)

---

## 1. Trạng thái hiện tại

`EphemeralVmRecipeSshTargetSchema.portForwards` (TS schema,
`frontend/src/shared/ephemeral-vm-recipes.ts:38-44,70`) chấp nhận
`SavedPortForward[]`, nhưng **chưa có mặt trong proto Go**
(`infrafleet.proto`'s `EphemeralVmRecipeSshTarget` message) — đây là lý
do 2 điểm decode (`ports.go:497`, `client.go:704`) phải "deliberately
omit": trường đó chưa từng qua được proto để tới nơi cần dùng.

`EPHEMERAL_VM_SSH_MODE` chọn Hướng A (agent outbound) hay Hướng B
(`backendrelaysshprovisioner`/`ephemeralsshconn`, mặc định) — CR-EVM-005
đã ship cả 2, việc thêm port forward cũng cần cả 2.

## 2. Giải pháp

### Proto — thêm field

```proto
// infrafleet.proto
message PortForward {
  int32 local_port = 1;
  string remote_host = 2;
  int32 remote_port = 3;
}
message EphemeralVmRecipeSshTarget {
  // ... field hiện có ...
  repeated PortForward port_forwards = 12; // số thứ tự tiếp theo còn trống — xác nhận trước khi code
}
```

### `ports.go:497`/`client.go:704` — bỏ "deliberately omitted", forward thật

Đổi 2 điểm decode để pass `port_forwards` qua thay vì bỏ qua — comment
cũ ("deliberately omitted, see message doc comment") cần xoá/sửa khớp
hành vi mới.

### Hướng B — `ephemeralsshconn/connector.go`

Sau khi `Connector` (dial tới VM SSH target) thành công, gọi
`ssh.Client.Listen()`/`net.Dial` tương đương pattern Go's
`golang.org/x/crypto/ssh` cho local port forward (Go's SSH client có
API riêng, khác `ssh2` Node — không copy code Node sang, dùng đúng API
Go tương đương: `sshClient.Dial("tcp", remoteAddr)` + local
`net.Listener`, forward qua goroutine `io.Copy` 2 chiều).

### Hướng B — `backendrelaysshprovisioner/provisioner.go`

Nếu forward cần thiết lập ở provisioning time (không phải mỗi lần dial),
thêm bước setup forward vào flow provision — đọc `provisioner.go` hiện
tại trước khi quyết định điểm chèn chính xác (có thể forward chỉ cần
thiết lập 1 lần khi VM sẵn sàng, không mỗi lần agent dial).

## Rủi ro / Phụ thuộc

| Hạng mục | Rủi ro | Ghi chú |
|---|---|---|
| Đồng bộ CỨNG với SOL-AG-EVM-004 | Cao | Field JSON/proto phải khớp 1:1 cả 2 phía |
| Cần touch cả 2 hướng SSH (A và B) | Trung bình | Bỏ 1 hướng tạo lệch hành vi theo `EPHEMERAL_VM_SSH_MODE` — không chấp nhận được |
| Đổi proto message đã ship | Thấp | Chỉ thêm field mới (`port_forwards`), không đổi field cũ — tương thích ngược |
| Go SSH client's forward API khác Node's `ssh2` | Trung bình | Không copy logic Node sang Go, dùng đúng idiom `golang.org/x/crypto/ssh` |

## Không thuộc phạm vi solution này

- Hướng A (agent outbound) — xem
  [SOL-AG-EVM-004](../../../../agent/crs/v3/ephemeral-vm/solutions/SOL-AG-EVM-004-ssh-target-port-forwards.md).
- UI hiển thị port forward — ngoài phạm vi CR-EVM-008.

## Liên quan

- `frontend/src/shared/ephemeral-vm-recipes.ts:38-44,70`
- `backend-go/.../usecase/ports.go:497`, `backend-go/.../devserveragent/client.go:704`
- `ephemeralsshconn/connector.go`, `backendrelaysshprovisioner/provisioner.go`
- [SOL-AG-EVM-004](../../../../agent/crs/v3/ephemeral-vm/solutions/SOL-AG-EVM-004-ssh-target-port-forwards.md) (đồng bộ cứng)
