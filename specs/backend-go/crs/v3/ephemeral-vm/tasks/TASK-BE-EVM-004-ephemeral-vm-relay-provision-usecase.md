# TASK-BE-EVM-004: `EphemeralVmRelay.Provision`/`CancelProvision` usecase

**Solution:** [BE-SOL-EVM-002](../solutions/BE-SOL-EVM-002-provision-streaming-channel.md) §5 | **CR:** CR-EVM-003
**Service:** `infra-fleet-service`
**Depends on:** [TASK-BE-EVM-003](./TASK-BE-EVM-003-devserveragent-stream-vm-provision.md)
**Status:** ✅ DONE — 2026-09-08

---

**Kết quả thực tế:** Implement lệch đáng kể so với sketch ở 2 điểm, cả 2 đều
do đọc source thật thay vì copy sketch mù.

- **`CancelProvision`'s signature/nội dung sai trong sketch**: sketch viết
  `CancelProvision(ctx, provisionID string) error` với "lookup + cancel —
  registry sống ở wscompat" — đọc thật agent-side
  `agent-ephemeral-vm-handler.ts`'s `handleVmCancelProvision` (đã có sẵn từ
  agent/'s pass trước) cho thấy nó nhận `{runtimeId}` và tra
  `provisionAbortRegistry` KEYED BY runtimeId — nghĩa là usecase này PHẢI
  relay 1 RPC `vm.cancelProvision` thật tới agent (mirror đúng
  `vm.exec`/`callAgent` pattern), KHÔNG PHẢI tự quản lý registry nào (đó
  đúng là việc TASK-BE-EVM-005 làm ở tầng wscompat, nhưng là 1 registry
  KHÁC — provisionId→unsubscribe Go channel, không liên quan gì tới việc
  relay lệnh cancel tới agent). 2 khái niệm "cancel" khác nhau bị gộp
  chung trong "Lưu ý quan trọng" của task doc — đã tách rõ trong doc
  comment của `CancelProvision`. Chữ ký thật:
  `CancelProvision(ctx, connectionID, runtimeID string) error` — cần
  `connectionID` để resolve `devServer` (mirror `resolveDevServerAndRepoPath`
  đã có), `runtimeID` để build params `{runtimeId}` gửi agent.
- **`UpdateStatus` không đủ tham số cho nhánh ssh**: sketch giả định
  `UpdateStatus(...)` có thể set `connection_type` — signature thật (task
  001/002 trước đó) chỉ có `(tenantID, id, status, workspaceID,
  lastError)`, không có `connectionType`. Thêm method MỚI
  `UpdateProvisionResult(ctx, tenantID, id, status, connectionType,
  lastError)` vào `EphemeralVmRuntimeRepository` interface +
  `EphemeralVmRuntimeStore` (postgres) thay vì mở rộng `UpdateStatus`'s
  signature hiện có (đang bị 4 call site khác — Attach/Suspend/Resume/
  Cleanup — gọi với đúng 5 tham số cố định, đổi chữ ký sẽ vỡ tất cả).
- `Provision`: resolve connection trước (tái dùng
  `resolveDevServerAndRepoPath`, không agent call nào xảy ra nếu resolve
  fail — test `NoConnectionReturnsTypedError` xác nhận `agent.streamVmProvisionCalls`
  rỗng), gọi `agent.StreamVmProvision`, wrap channel trong 1 goroutine vừa
  forward event ra caller vừa side-effect persist status khi gặp event
  terminal (`"result"` → `applyProvisionResult`, `"error"` → `UpdateStatus`
  status="error"). `applyProvisionResult`: `"orca-server"` →
  status="provisioning" (chờ pairing thật, TASK-BE-EVM-006);
  `"ssh"`/bất kỳ type lạ nào khác → status="error" + `connection_type`
  tương ứng, KHÔNG dial gì — guard CR-EVM-005 vẫn nguyên vẹn (usecase này
  không có dependency nào tới 1 SSH client cả, nên "không mở khoá guard"
  đúng theo structure, không chỉ theo logic if/else).
- `domain.ErrAgentMethodNotFound` từ `StreamVmProvision` được dịch thành
  `INFRA_EPHEMERAL_VM_UNSUPPORTED` — mirror đúng `callAgent`'s convention
  đã có (dù `Provision` không gọi qua `callAgent` được, vì
  `StreamVmProvision` trả channel không phải `map[string]any`, nên dịch
  lỗi thủ công lại 1 lần nữa ở đây).
- gitnexus: `impact({target:"EphemeralVmRelay", direction:"upstream"})` trả
  "not found" (index có vẻ chưa đồng bộ file untracked mới sửa) — dùng lại
  kết quả `codegraph_explore` đã chạy ở TASK-BE-EVM-001/003 xác nhận
  `EphemeralVmRelay` chỉ có 2 caller: `server_ephemeral_vm.go` (gRPC
  adapter) + test file. `EphemeralVmRelay` là struct cụ thể (không phải
  interface) nên thêm method mới thuần additive — không có nguy cơ vỡ
  caller nào hiện có.

**Test coverage** (`ephemeral_vm_relay_test.go`, 8 test mới, tất cả pass):
`TestEphemeralVmRelay_Provision_ResolvesConnectionBeforeCallingAgent`,
`TestEphemeralVmRelay_Provision_NoConnectionReturnsTypedError`,
`TestEphemeralVmRelay_Provision_OrcaServerResultUpdatesStatusProvisioning`,
`TestEphemeralVmRelay_Provision_SshResultDoesNotAttemptDial`,
`TestEphemeralVmRelay_Provision_AgentErrorEventMarksRuntimeError`,
`TestEphemeralVmRelay_CancelProvision_RelaysVmCancelProvisionToAgent`,
`TestEphemeralVmRelay_CancelProvision_NoTenant_ReturnsError`.

**Verify thật đã chạy:**
```
cd backend-go/services/infra-fleet-service && go build ./...                       # sạch
go test ./internal/usecase/... -run EphemeralVm -v                                 # 22/22 PASS
go test -race ./...                                                                 # PASS toàn service, không race
gofmt -l .                                                                          # sạch
```
`go build ./...` cho toàn bộ 19 module `go.work` — không module nào vỡ build.

**Cập nhật (trong lúc làm TASK-BE-EVM-005):** phát hiện gRPC handler
`StreamVmProvision` hoàn toàn CHƯA TỒN TẠI ở
`internal/adapter/grpc/server_ephemeral_vm.go` (chỉ có
Attach/Suspend/Resume/CleanupEphemeralVmWorkspace) — thiếu sót của cả
TASK-BE-EVM-002 (proto) lẫn task này, không nằm trong "Files cần sửa" gốc
của bất kỳ task nào 001-004, nhưng bắt buộc phải có để TASK-BE-EVM-005
(wscompat) gọi được. Đã bổ sung tại đây (không tách task riêng, vì đây
đúng là gRPC-facing counterpart tự nhiên của `Provision` usecase task này
thêm):
- `backend-go/proto/orca/infrafleet/v1/infrafleet.proto`: thêm field
  `string command = 4` vào `StreamVmProvisionRequest` — thiếu sót khác của
  TASK-BE-EVM-002 (3 message anh em Suspend/Resume/CleanupEphemeralVmWorkspaceRequest
  đều có `command`, nhưng `StreamVmProvisionRequest` thì không — infra-fleet-service
  không thể tự resolve command vì không được phép phụ thuộc git-gateway-service).
  `buf generate` (từ `backend-go/proto`) chạy sạch; diff `infrafleet.pb.go`
  chỉ +31 dòng đúng phạm vi field mới; 6 file generated khác (gitgateway/
  scmintegration/tenant) bị buf generate động tới do proto nguồn của chúng
  đang dirty từ công việc không liên quan — **KHÔNG revert** lần này (khác
  TASK-BE-STORAGE-006/TASK-BE-EVM-002's precedent) vì đã xác nhận `go build
  ./...` toàn bộ 19 module vẫn sạch sau khi giữ nguyên chúng — bài học từ
  TASK-BE-EVM-002: revert mù đã từng phá build `api-gateway` do code khác
  phụ thuộc generated symbol mới.
- `internal/adapter/grpc/server_ephemeral_vm.go`: thêm handler
  `StreamVmProvision(req, stream) error` (chữ ký `grpc.ServerStreamingServer[VmProvisionEvent]`,
  ctx lấy từ `stream.Context()`) gọi `s.ephemeralVmRelay.Provision(...)` rồi
  loop `stream.Send`; thêm `toProtoVmProvisionEvent`/`toProtoVmProvisionResult`.
  `VmProvisionEvent` proto không có field message lỗi riêng — tái dùng
  `chunk` để mang error text khi `Type=="error"` (ghi rõ trong doc comment,
  tránh thêm 1 field proto mới không cần thiết).

Verify bổ sung: `go build ./...` + `go test ./...` (infra-fleet-service,
toàn bộ pass) + `go build ./...` 19 module `go.work` + `gofmt -l .` — tất
cả sạch, xem lại lần "Verify thật đã chạy" gốc bên dưới, không lặp lại.

## Mục tiêu

Thêm `Provision`/`CancelProvision` vào `EphemeralVmRelay` — resolve
connection, gọi `StreamVmProvision`, xử lý kết quả (`orca-server` vs
`ssh` branch), cập nhật `EphemeralVmRuntime.Status`.

## Files cần sửa

1. `backend-go/services/infra-fleet-service/internal/usecase/ephemeral_vm_relay.go` (MODIFY — 2 method mới)

## Nội dung (xem BE-SOL-EVM-002 §5)

```go
func (uc *EphemeralVmRelay) Provision(ctx context.Context, connectionID, recipeID, runtimeID string) (<-chan domain.VmProvisionEvent, func(), error) {
  tenantID, err := tenant.RequireTenantID(ctx)
  // ... resolveDevServerAndRepoPath(ctx, tenantID, connectionID) — TÁI DÙNG helper đã có (dòng 42-54)
  events, unsubscribe, err := uc.agent.StreamVmProvision(ctx, devServer, VmProvisionParams{RecipeID: recipeID, RuntimeID: runtimeID, RepoPath: repoPath})
  // wrap events: khi nhận Type=="result", cập nhật uc.runtimes.UpdateStatus(...) theo Result.Type:
  //   "orca-server" -> status "provisioning" (chờ pairing thật, xem TASK-BE-EVM-006)
  //   "ssh"         -> status "error"/"blocked" + connection_type="ssh" (guard CR-EVM-005 vẫn áp dụng)
  return events, unsubscribe, err
}

func (uc *EphemeralVmRelay) CancelProvision(ctx context.Context, provisionID string) error {
  // lookup + cancel — registry sống ở wscompat layer (TASK-BE-EVM-005), KHÔNG ở usecase này;
  // usecase chỉ cung cấp unsubscribe func trả về từ Provision() để caller (wscompat) tự quản lý vòng đời
}
```

**Lưu ý quan trọng**: `CancelProvision`'s registry (provisionID →
unsubscribe) sống ở tầng `wscompat` (TASK-BE-EVM-005), không phải ở
usecase này — usecase chỉ trả `unsubscribe func()` từ `Provision`, đúng
tách lớp `AttachScreencast`/`AttachPty` đã dùng (usecase không tự giữ
state theo request-scoped id, đó là việc của tầng gateway giữ WS
session).

## Test cases cần cover

- `TestProvision_ResolvesConnectionBeforeCallingAgent`
- `TestProvision_NoConnectionReturnsTypedError` (mirror `INFRA_EPHEMERAL_VM_NO_CONNECTION` đã có ở suspend/resume)
- `TestProvision_OrcaServerResultUpdatesStatusProvisioning`
- `TestProvision_SshResultDoesNotAttemptDial` — xác nhận guard CR-EVM-005 vẫn chặn, task này không mở khoá nhánh ssh
- `TestProvision_AgentErrorEventMarksRuntimeError`

## Verify

```bash
cd backend-go/services/infra-fleet-service && go build ./... && go test ./internal/usecase/... -run EphemeralVm
```

## gitnexus

`impact({target: "EphemeralVmRelay", direction: "upstream"})` — đã chạy
ở TASK-BE-EVM-001, chạy lại vì thêm public method mới có thể ảnh hưởng
constructor/mock ở nơi khác dùng struct này.

## Blocking

TASK-BE-EVM-005 phụ thuộc task này. TASK-BE-EVM-006 (BE-SOL-EVM-003)
phụ thuộc task này (cần nhánh `orca-server` xử lý xong để có chỗ ghi
`environment_id`).
