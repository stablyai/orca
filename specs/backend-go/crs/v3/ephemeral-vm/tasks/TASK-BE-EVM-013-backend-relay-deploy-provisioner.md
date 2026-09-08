# TASK-BE-EVM-013: Hướng B — `backendrelaysshprovisioner` (tái dùng `sshconn`/`sshrelay`)

**Solution:** [BE-SOL-EVM-004](../solutions/BE-SOL-EVM-004-ssh-connection-type-backend.md) §5b-5d | **CR:** CR-EVM-005
**Service:** `infra-fleet-service`
**Depends on:** [TASK-BE-EVM-012](./TASK-BE-EVM-012-ssh-mode-config-and-provisioner-interface.md) (interface — dùng đúng chữ ký đã ghi nếu chạy trước khi 012 xong)
**Status:** ✅ DONE (2026-09-08)

---

## Mục tiêu

Implement `EphemeralVmSshProvisioner` bằng cách tái dùng nguyên vẹn
`sshrelay.Provisioner`'s pipeline (deploy agent bundle qua SFTP, launch
qua SSH exec, chờ handshake) — chỉ thay auth (recipe-provided key thay
vì Vault-signed cert). Credential **không bao giờ rời `infra-fleet-service`**.

## Files cần sửa

1. `backend-go/services/infra-fleet-service/internal/domain/ephemeral_vm_ssh_target.go` (MỚI — `domain.EphemeralVmSshTarget`, KHÔNG phải `domain.SshTarget`, không có invariant "VaultSSHRole required")
2. `backend-go/services/infra-fleet-service/internal/adapter/sshconn/connector.go` (MODIFY — thêm `func WrapClient(client *ssh.Client) *Connection`, KHÔNG đổi `Connect()` hiện có)
3. `backend-go/services/infra-fleet-service/internal/adapter/ephemeralsshconn/connector.go` (MỚI — implement `sshrelay.Connector` interface, auth bằng `PrivateKeyPEM`/`IdentityAgentSocket`, xử lý `JumpHost`/`ProxyCommand` qua `sock`/`forwardOut`)
4. `backend-go/services/infra-fleet-service/internal/usecase/backend_relay_ssh_provisioner.go` (MỚI — implement `EphemeralVmSshProvisioner`, gọi `sshrelay.Provisioner.Provision`, rồi đăng ký `dev_servers`/`connections` row + set `environment_id = runtimeID` ngay lập tức)
5. `backend-go/services/infra-fleet-service/cmd/server/main.go` (MODIFY — wire khi `EphemeralVmSshMode == "backend-relay-deploy"`)

## Nội dung (xem BE-SOL-EVM-004 §5b-5d cho sketch đầy đủ)

**Bước 1 — audit trước khi code** (bắt buộc, sketch chưa đọc hết body thật):
- Đọc kỹ `sshrelay/provisioner.go`'s `Provision(ctx, devServer domain.DevServer)` — xác nhận chính xác nó cần gì từ `domain.DevServer` (chỉ `ID` + resolve `ssh_target_id` qua `SshTargetResolver`, hay còn field nào khác). Nếu `SshTargetResolver.Get` chỉ cần trả về đủ để `Connector.Connect` dùng, có thể KHÔNG cần tạo `domain.DevServer` thật — chỉ cần 1 `SshTargetResolver` implementation trả thẳng `domain.EphemeralVmSshTarget` đã convert (bỏ qua bước "tra `ssh_target_id`" nếu interface cho phép). Điều chỉnh sketch theo đúng những gì đọc được, không ép theo thiết kế đã viết nếu sai.
- Đọc `deploy.go`/`launch.go` xác nhận `*sshconn.Connection` là input duy nhất cần (không có dependency ẩn khác vào `domain.SshTarget`/`domain.DevServer`).

**Bước 2** — `ephemeralsshconn.Connector.Connect`: implement theo sketch BE-SOL-EVM-004 §5b, dùng `golang.org/x/crypto/ssh` trực tiếp (không qua `sshconn.Connector`'s Vault flow) — `jumpHost`/`proxyCommand` dùng đúng kỹ thuật `sock`/`forwardOut()` đã audit ở SOL-AG-EVM-003 §"Quyết định" mục 2 (port sang Go, cùng ý tưởng: double-hop cho jumpHost, spawn `child_process`/`os/exec` cho proxyCommand).

**Bước 3** — sau `sshrelay.Provisioner.Provision` trả về `(Transport, HandshakeInfo, error)` thành công: đăng ký `dev_servers` row (mirror đúng path `RegisterDevServer`/`ResolveDirectWebSocketDevServer` hiện có dùng cho relay-ssh mode thường — audit trước khi viết lại logic) + `connections` row + gọi `SetEnvironmentID(ctx, tenantID, runtimeID, newDevServerID)` (method đã có từ TASK-BE-EVM-006) — trả `connectionID` cho `EphemeralVmRelay`.

**Bước 4** — `sshconn.WrapClient`: 3 dòng, export 1 constructor mới, không đổi gì khác trong file.

## Test cases cần cover

- `TestBackendRelaySshProvisioner_DialsDeploysLaunchesAndRegistersDevServer`
- `TestBackendRelaySshProvisioner_SetsEnvironmentIdImmediately` (khác TASK-BE-EVM-006's correlation phức tạp — ở đây biết ngay, không cần polling/token-endpoint hook)
- `TestEphemeralSshConnector_AuthenticatesWithPrivateKeyPEM`
- `TestEphemeralSshConnector_AuthenticatesWithIdentityAgentSocket`
- `TestEphemeralSshConnector_JumpHost_DoubleHopViaForwardOut`
- `TestEphemeralSshConnector_CredentialNeverLoggedOrPersisted` (regression-guard bảo mật — grep log statements không chứa `PrivateKeyPEM`)

## Verify

```bash
cd backend-go/services/infra-fleet-service && go build ./... && go test ./internal/usecase/... ./internal/adapter/ephemeralsshconn/... ./internal/adapter/sshconn/... -run 'EphemeralVm|Ephemeral'
```

## gitnexus

`impact({target: "sshrelay.Provisioner", direction: "upstream"})` — xác nhận không phá 2 caller hiện có (relay-ssh mode thường) khi tái dùng cho ephemeral VM.

## Blocking

Không task nào khác phụ thuộc cứng — đây là điểm hoàn thành Hướng B.

## Kết quả thực tế (2026-09-08)

Implement xong, build/test pass. "Bước 1" audit (bắt buộc theo task) phát
hiện sketch sai ở đúng chỗ nó tự nghi ngờ — dưới đây là toàn bộ quyết định
kỹ thuật khác sketch, theo đúng audit thật:

### 1. `sshrelay.Connector` KHÔNG phải "interface hẹp, không khoá vào `domain.SshTarget`"

Đọc thật `sshrelay/provisioner.go`: package tự khai báo lại 2 interface hẹp
(`Connector`, `SshTargetResolver`) — nhưng `Connector.Connect`'s chữ ký
CỤ THỂ là `Connect(ctx, target domain.SshTarget) (*sshconn.Connection,
error)`, không tổng quát hoá được. `domain.SshTarget` chỉ có
`ID/TenantID/Host/UserName/VaultSSHRole` — không có chỗ cho
`PrivateKeyPEM`/`IdentityAgentSocket`/`JumpHost`/`ProxyCommand`/`Port`. Hệ
quả: **không thể** truyền credential thật qua tham số `Connect` nhận được
từ `resolver.Get()`.

**Giải quyết:** `ephemeralsshconn.Connector` build 1 instance MỚI cho MỖI
lần gọi `Provision` (không share), mang theo `domain.EphemeralVmSshTarget`
đầy đủ (bao gồm credential) làm field riêng — `Connect(ctx, _
domain.SshTarget)` **bỏ qua** tham số nhận được, dial bằng field nội bộ.
`ephemeralsshconn.SingleTargetResolver` (cũng per-call) trả về 1
`domain.SshTarget` placeholder (chỉ Host/UserName, không có credential) chỉ
để thoả mãn chữ ký gọi hàm — `sshrelay.Provisioner.Provision`'s
`resolver.Get()` → `connector.Connect()` chain vẫn chạy đúng, nhưng dữ liệu
thật đi qua construction-time field, không qua tham số runtime.

### 2. `domain.DevServer` tạm — đúng như "nếu bị block" đã lường trước

Xác nhận `Provision(ctx, devServer)` chỉ cần `devServer.SSHTargetID != ""`
(để gọi `resolver.Get`) và `devServer.ID` (truyền vào `launch()` làm
`DEV_SERVER_ID` env) — không có dependency ẩn nào khác. Dùng
`"ephemeral:"+runtimeID` làm placeholder `SSHTargetID` (thoả invariant
`domain.NewDevServer`, không bao giờ tra cứu thật qua
`SshTargetRepository`), ID dev server sinh bằng `uuid.NewString()` (qua
constructor's `newID` param, giống pattern `RegisterDevServer`/
`EstablishConnection` đã dùng) — **đăng ký thật (`devServers.Register`)
CHỈ SAU KHI** `relayProvisioner.Provision` trả về thành công, đúng gợi ý
fallback trong task's chỉ dẫn.

### 3. Package đặt ở `internal/adapter/`, không phải `internal/usecase/` như file list gốc

`backend_relay_ssh_provisioner.go`'s dependency thật (`sshrelay.Provisioner`,
`ephemeralsshconn.Connector`, `devserveragent.Client.AttachTransport`,
`sshconn.Connection`) đều là type ở tầng adapter. Đặt trong
`internal/usecase/` sẽ vi phạm Dependency Inversion convention của chính
codebase này (`ports.go`'s doc comment: "the usecase layer must not depend
on its concrete package"). Chuyển sang
`internal/adapter/backendrelaysshprovisioner/provisioner.go` — theo đúng
tiền lệ `adapter/devserveragent` đã có (nó cũng import `internal/usecase`
để implement `usecase.DevServerAgentClient`). File thật:
`internal/adapter/backendrelaysshprovisioner/provisioner.go` (không phải
`internal/usecase/backend_relay_ssh_provisioner.go`).

### 4. `devserveragent.Client.AttachTransport` — file phát sinh ngoài danh sách gốc

`Client.sshProvisioner` (field nội bộ, wired 1 lần lúc khởi động qua
`WithRelaySSH`) là provisioner DÙNG CHUNG cho mọi relay-ssh dev server
thường (Vault-cert). Ephemeral VM's Hướng B build 1 `sshrelay.Provisioner`
RIÊNG cho mỗi lần `Provision` (không thể tái dùng field đó — credential
khác nhau mỗi VM) — nghĩa là `relayProvisioner.Provision(...)` ở đây được
gọi TRỰC TIẾP, không qua `Client.getOrProvisionSession`. Hệ quả: Transport
trả về cần 1 cách đăng ký vào `Client.sessions` để các lệnh
`Exec`/`Health` sau này tìm thấy session sống — copy nguyên mẫu
`AttachInboundSession` (dùng cho direct-websocket) thành
`AttachTransport(devServerID, host string, transport Transport, info
HandshakeInfo)`, nhận thẳng `Transport` thay vì `*websocket.Conn`. Thêm
vào `internal/adapter/devserveragent/client.go` (KHÔNG đổi gì khác trong
file này).

### 5. Credential (`identityFile`) — gap Vault-resolution CHƯA implement, ghi rõ

Task's "Nội dung" ghi `PrivateKeyPEM` là "resolved từ Vault" nhưng KHÔNG
file Vault adapter nào nằm trong "Files cần sửa" của cả TASK-012 lẫn
TASK-013. Quyết định: `buildEphemeralVmSshTarget` (trong
`ephemeral_vm_relay.go`) truyền thẳng `EphemeralVmRecipeSshTarget.IdentityFile`
(chuỗi thô từ recipe) vào `domain.EphemeralVmSshTarget.PrivateKeyPEM`,
KHÔNG gọi Vault. Đã ghi rõ gap này trong
`domain.EphemeralVmSshTarget`'s doc comment — cần 1 task riêng (Vault SSH
secrets engine hoặc KV v2 resolution) trước khi Hướng B sẵn sàng production
với credential thật. Không chặn phần còn lại của pipeline (dial/deploy/
launch/register) — pipeline chạy đúng với bất kỳ PEM hợp lệ nào đưa vào.

### Khác — JumpHost/ProxyCommand

Implement thật bằng `golang.org/x/crypto/ssh` trực tiếp:
`(*ssh.Client).Dial("tcp", targetAddr)` cho double-hop qua jump host (mở
kênh `direct-tcpip` — tương đương `forwardOut()` bên TS), `os/exec` +
`net.Conn` wrapper cho `ProxyCommand` (stdin/stdout của process con làm
transport pipe, đúng ngữ nghĩa OpenSSH `ProxyCommand`).

### Test cases — tất cả PASS, kể cả bảo mật

`go test ./internal/usecase/... ./internal/adapter/ephemeralsshconn/...
./internal/adapter/sshconn/... ./internal/adapter/backendrelaysshprovisioner/...
-v` → toàn bộ PASS:

- `TestBackendRelaySshProvisioner_DialsDeploysLaunchesAndRegistersDevServer`
- `TestBackendRelaySshProvisioner_SetsEnvironmentIdImmediately`
- `TestBackendRelaySshProvisioner_FailsFastWhenHostEmpty` (thêm, không có trong list gốc)
- `TestEphemeralSshConnector_AuthenticatesWithPrivateKeyPEM`
- `TestEphemeralSshConnector_AuthenticatesWithIdentityAgentSocket`
- `TestEphemeralSshConnector_JumpHost_DoubleHopViaForwardOut` (2 fake SSH
  server thật — 1 jump forward `direct-tcpip`, 1 target — xác nhận lệnh
  chạy chạm đúng TARGET, không phải jump host)
- `TestEphemeralSshConnector_FailsWhenNoCredentialConfigured` (thêm)
- `TestEphemeralSshConnector_CredentialNeverLoggedOrPersisted` — grep
  source thật (`connector.go`): không import `log`/`log/slog`, không format
  giá trị `.PrivateKeyPEM`/`.IdentityAgentSocket` vào bất kỳ
  `Errorf`/`Sprintf`/`Print*` nào, không `%+v` nguyên struct target.
- `TestWrapClient_BuildsAWorkingConnection` (sshconn, thêm)

`go build ./...`, `go vet ./...`, `gofmt -l` (toàn bộ file đã sửa) đều sạch.
`go test ./...` (toàn service infra-fleet-service, gồm cả 2 agent song
song đang sửa) → tất cả `ok`, không regression.

### gitnexus

MCP `mcp__gitnexus__impact`/`detect_changes` trả "Connection closed" mọi
lần gọi trong session này (không dùng được) — thay bằng audit thủ công:
đọc trực tiếp `sshrelay/provisioner.go`, `deploy.go`, `launch.go` xác nhận
KHÔNG sửa file nào trong package `sshrelay` (chỉ thêm hàm mới,
`sshconn.WrapClient`, ở 1 file khác, không đổi `Connect()` hiện có); grep
xác nhận 2 caller thật của `sshrelay.NewProvisioner`
(`internal/adapter/postgres/repository.go` — thực ra không gọi, chỉ
`cmd/server/main.go` và `devserveragent/client.go`'s `WithRelaySSH` option
type) không đổi. `go test ./internal/adapter/sshrelay/...` (cached OK) +
toàn bộ `go test ./...` xác nhận không regression — thay thế hợp lý cho
`impact()` khi MCP không kết nối được.

### Files đã sửa/thêm

- `internal/domain/ephemeral_vm_ssh_target.go` (mới — merge với
  `EphemeralVmSshTargetRecord` của TASK-BE-EVM-014, xem TASK-012's "Kết quả
  thực tế" mục 1)
- `internal/adapter/sshconn/connector.go` (`WrapClient`, thêm)
- `internal/adapter/sshconn/connector_test.go` (`TestWrapClient_...`, thêm)
- `internal/adapter/ephemeralsshconn/connector.go` (mới)
- `internal/adapter/ephemeralsshconn/connector_test.go` (mới)
- `internal/adapter/devserveragent/client.go` (`AttachTransport`, thêm —
  ngoài danh sách file gốc, xem mục 4)
- `internal/adapter/backendrelaysshprovisioner/provisioner.go` (mới — path
  khác danh sách gốc, xem mục 3)
- `internal/adapter/backendrelaysshprovisioner/provisioner_test.go` (mới)
- `cmd/server/main.go` (wire `EPHEMERAL_VM_SSH_MODE` else-nhánh, cùng lúc
  với TASK-012's wiring)
