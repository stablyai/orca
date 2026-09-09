# TASK-BE-EVM-022: Port forward cho Hướng B (`ephemeralsshconn`)

**Solution:** [BE-SOL-EVM-005](../solutions/BE-SOL-EVM-005-ssh-target-port-forwards.md) | **CR:** CR-EVM-008
**Depends on:** [TASK-BE-EVM-021](./TASK-BE-EVM-021-wire-port-forwards-decode.md)
**Status:** ✅ DONE (2026-09-09)

---

## Mục tiêu

Implement port forward cho Hướng B (mặc định theo `EPHEMERAL_VM_SSH_MODE`)
— dùng Go's `golang.org/x/crypto/ssh` client API (khác `ssh2` Node, không
copy logic Node sang).

## Files cần sửa

1. `ephemeralsshconn/connector.go` (MODIFY)
2. `backendrelaysshprovisioner/provisioner.go` (MODIFY — nếu forward cần setup ở provisioning time, xem bước 1)
3. Test tương ứng

## Bước 1 — Đọc `provisioner.go` xác nhận điểm chèn

Forward có cần thiết lập 1 lần khi VM sẵn sàng (provisioning time), hay
mỗi lần agent dial? Đọc code thật trước khi quyết định điểm chèn.

## Nội dung (sơ bộ — điều chỉnh theo bước 1)

```go
// ephemeralsshconn/connector.go, sau khi ssh.Client connect thành công
func setupPortForwards(client *ssh.Client, forwards []PortForward) ([]net.Listener, error) {
    listeners := make([]net.Listener, 0, len(forwards))
    for _, fw := range forwards {
        l, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", fw.LocalPort))
        if err != nil { return nil, err }
        go func(fw PortForward, l net.Listener) {
            for {
                conn, err := l.Accept()
                if err != nil { return }
                go func() {
                    remote, err := client.Dial("tcp", fmt.Sprintf("%s:%d", fw.RemoteHost, fw.RemotePort))
                    if err != nil { conn.Close(); return }
                    go io.Copy(remote, conn)
                    io.Copy(conn, remote)
                }()
            }
        }(fw, l)
        listeners = append(listeners, l)
    }
    return listeners, nil
}
```
Cleanup: đóng mọi `net.Listener` khi connection đóng/VM destroy.

## Test cases cần cover

- Forward setup đúng sau connect thành công.
- Cleanup đúng khi connection đóng (không port leak).
- Port conflict → lỗi rõ ràng.

## Verify

```bash
cd backend-go/services/infra-fleet-service && go test ./internal/adapter/ephemeralsshconn/...
```

## gitnexus

`impact({target: "ephemeralsshconn.Connector", direction: "upstream"})`
trước khi sửa — xác nhận mọi caller không bị ảnh hưởng.

---

## ✅ Kết quả thực tế (2026-09-09)

**Bước 1's câu trả lời**: forward setup ngay tại `Connect()` (dial time),
không phải bước riêng ở `Provisioner.Provision` — vì `Connect()` là nơi
duy nhất có `*ssh.Client` sống, và `c.target.PortForwards` đã có sẵn ở
đó (đọc từ `domain.EphemeralVmSshTarget`, xem TASK-BE-EVM-021's kết quả
thực tế). Không cần sửa `backendrelaysshprovisioner/provisioner.go` —
nó chỉ gọi `connector.Connect` gián tiếp qua `sshrelay.Provisioner`,
không cần biết gì về forward.

**Lệch so với sketch gốc — chỗ đặt code**: sketch đề xuất
`setupPortForwards` là hàm rời trong `ephemeralsshconn/connector.go`.
Thực tế đặt là **method `SetupPortForwards` trên `sshconn.Connection`**
(package khác — `internal/adapter/sshconn`, không phải
`ephemeralsshconn`) — lý do: `Connection` đã có `Close()` sẵn, tự nhiên
là nơi đúng để track+cleanup `[]net.Listener` (thêm field
`forwardListeners`, đóng trong `Close()`) — khớp đúng nguyên tắc
"forward không được sống lâu hơn connection nó tunnel qua" mà chính CR
yêu cầu, và tận dụng lifecycle có sẵn (`Transport.Close()` →
`Connection.Close()`, đã xác nhận qua đọc `sshrelay/transport.go:101`)
thay vì phải tự quản lý lifecycle riêng. `ephemeralsshconn.Connector.Connect`
chỉ gọi `conn.SetupPortForwards(...)` sau khi dial thành công.

Lỗi setup forward làm **fail toàn bộ Connect** (không silent-continue)
— nhất quán với cách `Connect()` xử lý lỗi auth/dial khác, vì recipe đã
khai báo rõ port này cần thiết.

**Test mới** (`sshconn/portforward_test.go`, MỚI — không sửa file test
có sẵn vì cần fake SSH server hỗ trợ `direct-tcpip` channel, khác
`sshconn/connector_test.go`'s server hiện có chỉ hỗ trợ `session`):
- `TestConnection_SetupPortForwards_ProxiesTrafficToRemoteHost` — dial
  local forwarded port thật, ghi/đọc qua tunnel SSH thật tới 1 echo
  server thật, xác nhận round-trip đúng.
- `TestConnection_Close_ClosesForwardListeners` — xác nhận listener bị
  đóng thật khi `Connection.Close()`, không leak port.

**Verify**: `gofmt -l` sạch. `go build`/`go vet` cho
`internal/adapter/sshconn`, `ephemeralsshconn`, `backendrelaysshprovisioner`
— sạch. `go test ./internal/...` (toàn bộ `infra-fleet-service`, trừ
`cmd/server` — lỗi build không liên quan, xem TASK-BE-EVM-021's phát
hiện phụ) — tất cả package pass, gồm 2 test mới.

**Files đã sửa/tạo:**
- `backend-go/services/infra-fleet-service/internal/adapter/sshconn/connector.go` (MODIFY — `PortForward` type, `SetupPortForwards`, `Close()` cleanup)
- `backend-go/services/infra-fleet-service/internal/adapter/sshconn/portforward_test.go` (MỚI)
- `backend-go/services/infra-fleet-service/internal/adapter/ephemeralsshconn/connector.go` (MODIFY — gọi `SetupPortForwards` sau dial thành công)
