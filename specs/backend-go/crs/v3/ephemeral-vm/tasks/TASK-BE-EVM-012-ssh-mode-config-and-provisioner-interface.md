# TASK-BE-EVM-012: Config `EPHEMERAL_VM_SSH_MODE` + `EphemeralVmSshProvisioner` interface + gỡ guard

**Solution:** [BE-SOL-EVM-004](../solutions/BE-SOL-EVM-004-ssh-connection-type-backend.md) §5a | **CR:** CR-EVM-005
**Service:** `infra-fleet-service`
**Depends on:** Không
**Status:** ✅ DONE (2026-09-08)

---

## Mục tiêu

Nền tảng cho cả Hướng A và Hướng B — 1 interface chung + 1 config chọn
implementation, và điểm gỡ guard `connection_type == "ssh"` duy nhất
trong `EphemeralVmRelay`.

## Files cần sửa

1. `backend-go/services/infra-fleet-service/internal/usecase/ports.go` (MODIFY — thêm interface)
2. `backend-go/services/infra-fleet-service/internal/config/config.go` (MODIFY — thêm `EphemeralVmSshMode`)
3. `backend-go/services/infra-fleet-service/internal/usecase/ephemeral_vm_relay.go` (MODIFY — gỡ guard `connection_type=="ssh"`, dispatch qua `EphemeralVmSshProvisioner`)
4. `backend-go/services/infra-fleet-service/cmd/server/main.go` (MODIFY — wire implementation theo config)

## Nội dung

```go
// ports.go
type EphemeralVmSshTarget struct {
  Host, Username string
  Port int
  PrivateKeyPEM string          // resolved từ Vault, chỉ tồn tại trong RAM
  IdentityAgentSocket string     // optional, local ssh-agent path
  JumpHost, ProxyCommand string  // optional
}

// Provision dial/thiết lập kết nối tới target theo đúng strategy đã cấu
// hình (Hướng A hoặc B), trả về connectionID thật (infra.connections row)
// — caller (EphemeralVmRelay) không cần biết implementation nào đang chạy.
type EphemeralVmSshProvisioner interface {
  Provision(ctx context.Context, tenantID, runtimeID string, target EphemeralVmSshTarget) (connectionID string, err error)
}
```

```go
// config.go
type Config struct {
  // ... field hiện có ...
  EphemeralVmSshMode string // "agent-outbound" | "backend-relay-deploy", mặc định "backend-relay-deploy"
}
```

```go
// ephemeral_vm_relay.go — gỡ guard hiện tại, thay bằng:
func (uc *EphemeralVmRelay) AttachWorkspace(ctx context.Context, runtimeID, workspaceID string) (domain.EphemeralVmRuntime, error) {
  // ... đọc runtime.ConnectionType ...
  if runtime.ConnectionType == "ssh" {
    connectionID, err := uc.sshProvisioner.Provision(ctx, tenantID, runtimeID, buildEphemeralVmSshTarget(runtime))
    // ... cập nhật workspace_id + trả kết quả, KHÔNG còn trả
    // INFRA_EPHEMERAL_VM_SSH_UNSUPPORTED nữa ...
  }
  // ... nhánh orca-server hiện có, không đổi ...
}
```

`buildEphemeralVmSshTarget` cần đọc `EphemeralVmSshTarget` recipe đã trả
về (`VmProvisionResult.SshTarget`, proto field đã có từ TASK-BE-EVM-002)
— audit lại chỗ lưu trữ kết quả `ssh`-type provision hiện tại (domain
`EphemeralVmRuntime` không có field nào lưu `sshTarget` — cần audit/bổ
sung nếu thiếu, đây có thể là 1 gap giống TASK-BE-EVM-006 đã gặp, không
giả định đã có sẵn).

## Test cases cần cover

- `TestAttachWorkspace_SshType_DispatchesToConfiguredProvisioner`
- `TestAttachWorkspace_SshType_NoLongerReturnsPermanentUnsupportedError` (regression-guard: xác nhận guard cũ đã gỡ đúng chỗ, không xoá nhầm case khác)
- `TestEphemeralVmSshProvisioner_InterfaceSatisfiedByBothImplementations` (compile-time check, có thể chỉ là 1 dòng `var _ EphemeralVmSshProvisioner = (*backendrelaysshprovisioner.Provisioner)(nil)` mỗi implementation — nhưng cả 2 chưa tồn tại ở task này, để trống/stub tạm nếu cần chạy test độc lập trước TASK-BE-EVM-013/014)

## Verify

```bash
cd backend-go/services/infra-fleet-service && go build ./... && go test ./internal/usecase/... -run EphemeralVm
```

## gitnexus

`impact({target: "EphemeralVmRelay", direction: "upstream"})` — đã audit nhiều lần ở các task trước, chạy lại vì đổi guard logic.

## Blocking

TASK-BE-EVM-013 (Hướng B) và TASK-BE-EVM-014 (Hướng A) cần interface này tồn tại để implement — nếu chạy song song trước khi task này xong, dùng đúng chữ ký interface đã ghi ở "Nội dung" phía trên (không tự đoán khác).

## Kết quả thực tế (2026-09-08)

Implement xong, build/test pass. 3 điểm khác sketch — cả 3 đều do audit
source thật trước khi sửa (bắt buộc theo `AGENTS.md`/`CLAUDE.md`), không
phải bỏ qua thiết kế:

1. **`EphemeralVmSshTarget` đặt ở `domain` package, không phải `ports.go`.**
   Sketch mục "Nội dung" dán struct trực tiếp trong `ports.go` (không có
   tiền tố `domain.`), nhưng BE-SOL-EVM-004 §5a's cùng đoạn — và
   TASK-BE-EVM-013 — đều ghi rõ `domain.EphemeralVmSshTarget`. Tạo file mới
   `internal/domain/ephemeral_vm_ssh_target.go`, interface trong `ports.go`
   tham chiếu `domain.EphemeralVmSshTarget`. File này bị agent song song
   (TASK-BE-EVM-014, Hướng A) `Write` đè mất nội dung của tôi giữa chừng
   (họ thêm `EphemeralVmSshTargetRecord` vào cùng path) — đã merge lại cả 2
   type vào 1 file, không mất phần nào của bên nào.

2. **Guard `connection_type == "ssh"` KHÔNG nằm trong `AttachWorkspace`.**
   Audit thật cho thấy `AttachWorkspace` hiện tại là pure bookkeeping,
   không hề có nhánh `connection_type` (comment trong code: "AttachWorkspace
   is pure bookkeeping... no agent relay"). Guard thật nằm trong
   `applyProvisionResult`'s `case "ssh"` (gọi từ `Provision`'s xử lý event
   "result" — đây mới là nơi runtime nhận được `SshTarget` từ recipe, và xử
   lý đồng bộ ngay trong 1 lần gọi, không có khoảng trễ nào). Đã gỡ guard
   và dispatch qua `EphemeralVmSshProvisioner` đúng tại điểm này — không
   sửa `AttachWorkspace` (không có gì để sửa). Hệ quả tốt: **không cần**
   thêm field lưu `SshTarget` vào `domain.EphemeralVmRuntime` như sketch lo
   ngại ("domain gap giống TASK-BE-EVM-006") — vì dispatch xảy ra ngay lập
   tức, không phải đợi 1 request `AttachWorkspace` riêng sau đó.

3. **`NewEphemeralVmRelay` không đổi chữ ký 3-tham số** — dùng
   `EphemeralVmRelayOption` (`WithSshProvisioner(...)`) theo đúng pattern
   `devserveragent.Option`/`WithRelaySSH` đã có sẵn trong codebase này,
   thay vì thêm tham số thứ 4 bắt buộc — tránh sửa ~23 test call site hiện
   có không liên quan. Agent song song (Hướng A) độc lập chọn đúng cùng
   API này khi wire `usecase.WithSshProvisioner` trong `main.go` — 2 quyết
   định hội tụ, không xung đột.

Test mới: `TestEphemeralVmRelay_Provision_SshResultDispatchesToConfiguredProvisioner`,
`TestEphemeralVmRelay_Provision_SshProvisionerError_MarksRuntimeError` (đổi
tên khỏi `TestAttachWorkspace_SshType_...` cho khớp điểm dispatch thật —
xem lý do #2 ở trên). Test cũ
`TestEphemeralVmRelay_Provision_SshResultDoesNotAttemptDial` giữ nguyên,
đổi ý nghĩa thành regression-guard cho case "chưa cấu hình provisioner"
(không còn là "permanently blocked").

Compile-time interface check (`var _ EphemeralVmSshProvisioner = ...`) đặt
trong từng implementation's file (không phải 1 test riêng) — cả
`internal/usecase/agent_outbound_ssh_provisioner.go` (Hướng A, agent song
song) và `internal/adapter/backendrelaysshprovisioner/provisioner.go`
(Hướng B, TASK-BE-EVM-013) đều có dòng này.

**Verify thật đã chạy:**
```
cd backend-go/services/infra-fleet-service && go build ./... && go test ./internal/usecase/... -run EphemeralVm
```
→ `ok` — 26 test PASS (đã tính cả 2 test mới), 0 FAIL.
`go test ./...` (toàn service, bao gồm cả file của 2 agent song song) → tất
cả `ok`, không regression.

Files đã sửa: `internal/domain/ephemeral_vm_ssh_target.go` (mới),
`internal/usecase/ports.go`, `internal/config/config.go`,
`internal/usecase/ephemeral_vm_relay.go`,
`internal/usecase/ephemeral_vm_relay_test.go`. `cmd/server/main.go`'s wiring
hoàn tất cùng lúc với TASK-BE-EVM-013 (xem task đó's "Kết quả thực tế") để
tránh 1 lần sửa main.go dở dang không compile được.
