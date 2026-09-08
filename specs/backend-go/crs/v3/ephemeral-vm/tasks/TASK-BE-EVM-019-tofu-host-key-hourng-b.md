# TASK-BE-EVM-019: Gap 4 — TOFU host-key verification cho Hướng B

**Solution:** [BE-SOL-EVM-004](../solutions/BE-SOL-EVM-004-ssh-connection-type-backend.md) §6d | **CR:** CR-EVM-005
**Service:** `infra-fleet-service`
**Depends on:** [TASK-BE-EVM-013](./TASK-BE-EVM-013-backend-relay-deploy-provisioner.md) (đã DONE)
**Status:** ✅ DONE (2026-09-08) — chỉ áp dụng cho `ephemeralsshconn.Connector` (Hướng B), KHÔNG đụng `sshconn.Connector` dùng chung cho `ssh_targets` thường (ngoài phạm vi)

---

## Mục tiêu

Thay `ssh.InsecureIgnoreHostKey()` trong `ephemeralsshconn.Connector`
bằng TOFU: lần dial đầu lưu fingerprint, lần sau so khớp.

## Files cần sửa

1. `internal/adapter/ephemeralsshconn/connector.go` (MODIFY — `HostKeyCallback` thật thay vì insecure)
2. `migrations/00XX_ephemeral_vm_ssh_target_host_key.up.sql` (MỚI — thêm cột `host_key_fingerprint` vào `infra.ephemeral_vm_ssh_targets`)
3. `internal/usecase/ports.go` (MODIFY — `EphemeralVmSshTargetRepository` thêm `GetHostKeyFingerprint`/`SetHostKeyFingerprint`, hoặc gộp vào `Upsert`/`Get` hiện có)
4. `internal/adapter/backendrelaysshprovisioner/provisioner.go` (MODIFY — đọc fingerprint đã lưu trước khi dial, truyền vào `Connector.Connect`, lưu lại nếu là lần đầu)

## Nội dung

```go
// ephemeralsshconn/connector.go
func (c *Connector) Connect(ctx context.Context, target domain.EphemeralVmSshTarget, knownFingerprint string) (*sshconn.Connection, error) {
  var observedFingerprint string
  hostKeyCallback := func(hostname string, remote net.Addr, key ssh.PublicKey) error {
    observedFingerprint = ssh.FingerprintSHA256(key)
    if knownFingerprint == "" {
      return nil // lần đầu — chấp nhận, caller lưu lại observedFingerprint sau khi Connect thành công
    }
    if observedFingerprint != knownFingerprint {
      return fmt.Errorf("INFRA_EPHEMERAL_VM_HOST_KEY_MISMATCH: host key changed for %s (expected %s, got %s)", hostname, knownFingerprint, observedFingerprint)
    }
    return nil
  }
  // ... dùng hostKeyCallback thay ssh.InsecureIgnoreHostKey() ...
}
```

Caller (`backendrelaysshprovisioner`) đọc `knownFingerprint` từ
`EphemeralVmSshTargetRepository.Get(runtimeID)` trước khi gọi
`Connect`, và SAU khi `Connect` trả về thành công lần đầu (không có
`knownFingerprint` cũ), lưu `observedFingerprint` vào DB.

## Test cases cần cover

- `TestEphemeralSshConnector_FirstDial_AcceptsAndReturnsFingerprint`
- `TestEphemeralSshConnector_SecondDial_MatchingFingerprint_Succeeds`
- `TestEphemeralSshConnector_SecondDial_MismatchedFingerprint_FailsClearError` (dùng 2 fake SSH server key khác nhau)
- `TestBackendRelaySshProvisioner_PersistsFingerprintAfterFirstDial`

## Verify

```bash
cd backend-go/services/infra-fleet-service && go build ./... && go test ./internal/adapter/ephemeralsshconn/... ./internal/adapter/backendrelaysshprovisioner/...
```

## gitnexus

Module mới trong phạm vi hẹp — `impact({target: "Connector", direction: "upstream", file_path: "internal/adapter/ephemeralsshconn/connector.go"})` xác nhận chỉ 1 caller (`backendrelaysshprovisioner`).

## Blocking

Không task nào khác phụ thuộc — hoàn thành Gap 4 phía backend-go (song song [TASK-AG-EVM-010](../../../../agent/crs/v3/ephemeral-vm/tasks/TASK-AG-EVM-010-tofu-host-key-hourng-a.md) cho Hướng A).

## Kết quả thực tế (2026-09-08)

**Audit chữ ký thật trước khi sửa (code sketch trong task doc không khớp
100% — đã điều chỉnh theo đúng chỉ dẫn "không ép theo sketch nếu sai"):**
task doc sketch đề xuất `Connect(ctx, target, knownFingerprint)` — SAI, vì
`ephemeralsshconn.Connector.Connect` phải giữ chữ ký
`Connect(ctx, domain.SshTarget) (*sshconn.Connection, error)` để thoả mãn
`sshrelay.Connector` interface (đã audit + ghi rõ trong package's doc
comment từ TASK-BE-EVM-013 — target thật được bake vào struct qua
`NewConnector`, không qua tham số `Connect`). Sửa thật: thêm
`knownFingerprint` làm tham số của `NewConnector` (baked vào struct, y hệt
`target`), thêm `ObservedFingerprint()` — accessor để caller
(`backendrelaysshprovisioner.Provisioner`, người GIỮ tham chiếu `*Connector`
dù không tự gọi `Connect`) đọc lại fingerprint đã quan sát SAU KHI
`relayProvisioner.Provision` (gọi `Connect` gián tiếp bên trong) thành công.

**Đã implement (real, tested):**
1. `migrations/0016_ephemeral_vm_ssh_target_host_key.{up,down}.sql` (MỚI)
   — `ALTER TABLE infra.ephemeral_vm_ssh_targets ADD COLUMN
   host_key_fingerprint TEXT`. Tái dùng ĐÚNG bảng TASK-BE-EVM-014 tạo cho
   Hướng A (không tạo bảng mới) — 1 runtime chỉ chạy 1 trong 2 Hướng theo
   config server-wide, không có xung đột write-owner.
2. `internal/domain/ephemeral_vm_ssh_target.go` —
   `EphemeralVmSshTargetRecord` thêm `HostKeyFingerprint string`.
3. `internal/adapter/postgres/ephemeral_vm_ssh_target_repository.go` —
   `Upsert`/`Get` đọc/ghi cột mới (gộp vào 2 method hiện có, đúng lựa chọn
   task doc gợi ý, KHÔNG thêm `GetHostKeyFingerprint`/`SetHostKeyFingerprint`
   riêng).
4. `internal/adapter/ephemeralsshconn/connector.go` — `Connector` thêm 2
   field `knownFingerprint`/`observedFingerprint`; `NewConnector` thêm
   tham số `knownFingerprint string`; `hostKeyCallback()` method mới thay
   `ssh.InsecureIgnoreHostKey()` trong `Connect`'s `clientConfig` (áp dụng
   cho dial trực tiếp VÀ target's handshake trong `dialViaJumpHost` — jump
   host's RIÊNG handshake (`jumpConfig`) CỐ TÌNH giữ nguyên
   `InsecureIgnoreHostKey()`, ghi rõ lý do trong doc comment: không có slot
   fingerprint riêng cho jump host trong recipe schema, ngoài phạm vi task
   này). `ObservedFingerprint()` accessor mới.
5. `internal/adapter/backendrelaysshprovisioner/provisioner.go` —
   `Provisioner` thêm field `sshTargets usecase.EphemeralVmSshTargetRepository`
   (optional/nil-safe). `Provision`: đọc `knownFingerprint` từ
   `sshTargets.Get(ctx, tenantID, runtimeID)` TRƯỚC khi tạo connector; SAU
   KHI `relayProvisioner.Provision` thành công (= `Connect` chắc chắn đã
   thành công), Upsert `HostKeyFingerprint: connector.ObservedFingerprint()`
   — best-effort, lỗi Upsert không chặn Provision.
6. `cmd/server/main.go` — Hướng B's `NewProvisioner` giờ nhận thêm
   `ephemeralVmSshTargetStore` (biến đã có sẵn từ Hướng A's wiring, dùng
   lại nguyên).
7. Test thật, pass — CẢ 4 test case yêu cầu + 1 bổ sung:
   - `TestEphemeralSshConnector_FirstDial_AcceptsAndReturnsFingerprint`
   - `TestEphemeralSshConnector_SecondDial_MatchingFingerprint_Succeeds`
   - `TestEphemeralSshConnector_SecondDial_MismatchedFingerprint_FailsClearError`
     (2 fake SSH server THẬT, khác host key thật — không mock so sánh)
   - `TestBackendRelaySshProvisioner_PersistsFingerprintAfterFirstDial`
   - `TestBackendRelaySshProvisioner_SecondDial_UsesStoredFingerprint` (bổ sung)
   Fake SSH server helper (`startFakePlainSSHServer` trong
   `ephemeralsshconn`, `startFakeSSHServer` trong
   `backendrelaysshprovisioner`) cả 2 đều mở rộng để trả về/expose host
   public key thật, dùng `ssh.FingerprintSHA256` tính fingerprint mong đợi
   — đúng pattern TASK-BE-EVM-013 đã dùng cho fake SSH server thật (không
   mock `ssh.Dial`).

**Verify thật đã chạy (2026-09-08):**
```
cd backend-go/services/infra-fleet-service
go build ./...                                                                          # OK
go vet ./...                                                                              # OK
gofmt -l <mọi file đã sửa/tạo>                                                             # rỗng — sạch
go test ./internal/adapter/ephemeralsshconn/... ./internal/adapter/backendrelaysshprovisioner/... -v   # 8+8 PASS (6 test mới)
go test ./...                                                                             # PASS toàn bộ service
```

**Không có gap nào để lại trong phạm vi task này.** Phạm vi cố ý KHÔNG sửa
(đã ghi rõ, đúng "chốt phạm vi" của task doc): `sshconn.Connector` (dùng
chung cho `ssh_targets` thường) và jump-host's riêng handshake trong
`ephemeralsshconn.Connector.dialViaJumpHost`.

## 🔧 Fix bổ sung (2026-09-08, sau khi cả 7 task fix-gap DONE) — TOFU Hướng A chỉ mới xong nửa

Đối chiếu contract 2 phía lần cuối (sau khi cả TASK-BE-EVM-016..019 và
TASK-AG-EVM-008..010 đều DONE) phát hiện: **agent's TOFU (TASK-AG-EVM-010)
được implement đầy đủ và trả đúng `hostKeyFingerprint`, nhưng
`AgentOutboundSshProvisioner.DialHiddenSshTarget` (Hướng A) bỏ qua hoàn
toàn giá trị trả về** — không lưu, không gửi lại
`knownHostKeyFingerprint` ở lần dial sau. Kết quả: Hướng A's TOFU chỉ
hoạt động 1 chiều (agent sẵn sàng verify, nhưng backend-go chưa bao giờ
cho nó biết fingerprint cũ để so khớp) — mọi dial nhìn như "lần đầu".

**Đã tự sửa (không qua agent, đủ ngữ cảnh)**: `DialHiddenSshTarget` đổi
chữ ký trả thêm `hostKeyFingerprint`, gửi thêm `knownHostKeyFingerprint`
trong params gửi đi; `AgentOutboundSshProvisioner.Provision` đọc
`EphemeralVmSshTargetRepository.Get`'s `HostKeyFingerprint` trước khi
dial, truyền vào `target.KnownHostKeyFingerprint`, và lưu lại giá trị
agent trả về sau — mirror đúng pattern `knownFingerprint`/
`ObservedFingerprint()` mà `backendrelaysshprovisioner` (Hướng B) đã
dùng. Thêm fallback: nếu agent build cũ không echo fingerprint lại
(rỗng), giữ nguyên fingerprint cũ thay vì để `Upsert` (full-replace, không
merge) xoá mất nó.

Test mới: `TestAgentOutboundSshProvisioner_ThreadsKnownFingerprintOnRepeatDial`,
`TestAgentOutboundSshProvisioner_AgentOmitsFingerprint_PreservesPrevious`
— 7/7 test package `usecase` (`-run AgentOutboundSsh`) PASS, `go build`/
`go vet`/`gofmt` sạch, sweep toàn bộ 19 module `go.work` không vỡ build.
