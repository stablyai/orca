# TASK-BE-EVM-005: wscompat — channel `ephemeralVm.provision`/`cancelProvision`

**Solution:** [BE-SOL-EVM-002](../solutions/BE-SOL-EVM-002-provision-streaming-channel.md) §4 | **CR:** CR-EVM-003
**Service:** `api-gateway`
**Depends on:** [TASK-BE-EVM-004](./TASK-BE-EVM-004-ephemeral-vm-relay-provision-usecase.md)
**Status:** ✅ DONE — 2026-09-08

---

**Kết quả thực tế:** Implement lệch đáng kể so với sketch ở 3 điểm chính —
tất cả xác nhận bằng cách đọc source thật (frontend's
`runtime-ephemeral-vm-client.ts`) trước khi code, không copy mù sketch.

- **`provisionID` PHẢI là id mint mới server-side, không phải `runtimeID`
  tái dùng** — ban đầu định dùng `runtimeID` làm registry key (đơn giản
  hơn, không cần thêm ID scheme), nhưng đọc thật
  `frontend/src/renderer/src/runtime/runtime-ephemeral-vm-client.ts:294-303`'s
  `cancelRuntimeEphemeralVmProvision` xác nhận frontend gửi CHỈ
  `{provisionId}` tới `ephemeralVm.cancelProvision` (không có `runtimeId`
  nào), và dòng 208-230's `provisionRuntimeEphemeralVmWorkspace` (nhánh
  environment/paired) không hề tự sinh hay gửi `provisionId` trong request
  — nó CHỈ nhận lại `provisionId` mới từ response.result của ack. Vậy
  sketch's `newProvisionID()` đúng, giả định ban đầu của tôi sai. Implement
  `newProvisionID()` bằng `crypto/rand` + hex (16 byte) — không thêm
  `google/uuid` làm dependency trực tiếp (hiện chỉ là indirect dependency
  của `api-gateway`, không có import trực tiếp nào trong service này).
- **Gap hạ tầng lớn phát hiện giữa chừng, đã fix ở TASK-BE-EVM-004's mục
  "Cập nhật"**: gRPC handler `StreamVmProvision` hoàn toàn chưa tồn tại ở
  `internal/adapter/grpc/server_ephemeral_vm.go`, và
  `StreamVmProvisionRequest` proto thiếu field `command` (3 message anh em
  Suspend/Resume/CleanupEphemeralVmWorkspaceRequest đều có). Task này
  không thể chạy được nếu không có 2 thứ đó — đã bổ sung, xem
  TASK-BE-EVM-004's "Cập nhật" section để biết chi tiết đầy đủ (proto
  diff, buf generate, handler mới, `toProtoVmProvisionEvent`).
- **`resolveEphemeralVmRecipeCommand` thiếu case `"create"`** — helper có
  sẵn (dùng cho suspend/resume/destroy) chưa từng có nhánh `"create"`
  trong switch — phát hiện qua 1 test fail thật (`TestEphemeralVmProvision_AcksWithProvisionId`
  ban đầu fail vì command rỗng), sửa bằng cách thêm `case "create": return
  rec.GetCreate(), nil`.
- **Files thực tế sửa/tạo** (khác "Files cần sửa" gốc — gốc chỉ liệt kê 2
  file):
  1. `channels_ephemeral_vm.go` (MODIFY — như dự kiến, cộng thêm fix
     `resolveEphemeralVmRecipeCommand`'s case "create")
  2. `provision_stream_registry.go` (MỚI — như dự kiến)
  3. `handler.go` (MODIFY, NGOÀI kế hoạch — bắt buộc phải wire
     `provisionStreamsContext(ctx, newProvisionStreamRegistry())` vào
     `ServeHTTP` giống hệt `terminalStreamsContext`, nếu không
     `provisionStreamsFromContext(ctx)` luôn trả `nil` ở mọi request thật)
  4. `internal/adapter/grpc/server_ephemeral_vm.go` (infra-fleet-service,
     MODIFY, NGOÀI kế hoạch — xem mục Gap ở trên)
  5. `backend-go/proto/orca/infrafleet/v1/infrafleet.proto` (MODIFY, NGOÀI
     kế hoạch — thêm field `command`)
- **`ephemeralVm.cancelProvision` KHÔNG relay `vm.cancelProvision` tới
  agent** — chỉ dừng subscription phía Go (gọi `entry.cancel()`, đóng gRPC
  stream). Việc báo agent dừng recipe process (relay `vm.cancelProvision`,
  TASK-BE-EVM-004's `EphemeralVmRelay.CancelProvision`) KHÔNG được gọi ở
  đây — ghi rõ trong doc comment, out of scope pass này (task sketch cũng
  không đề cập rõ, quyết định giữ nguyên tối giản: cancel chỉ dừng nghe,
  không dừng agent).
- gitnexus: `impact({target:"Registry", direction:"downstream"})` ambiguous
  (2 candidate — `Handler.Registry` field và struct `Registry`), cả 2
  impactedCount=0/risk=LOW. `codegraph_explore` xác nhận `RegisterStreamChannel`
  có 4 caller hiện có (terminal.create, terminal.subscribe, onboarding
  openGhAuthTerminal) — không caller nào bị ảnh hưởng bởi thêm 1 handler
  mới; `decodeArg` có 77 caller (generic helper, không đổi signature).

**Test coverage** (6 test mới trong `channels_ephemeral_vm_test.go`, tất cả
pass, kể cả dưới `-race` × 5 lần):
`TestEphemeralVmProvision_AcksWithProvisionId`,
`TestEphemeralVmProvision_PushesStdoutStderrResultEvents`,
`TestEphemeralVmProvision_NoConnectionReturnsError`,
`TestEphemeralVmCancelProvision_CancelsRunningStream`,
`TestEphemeralVmCancelProvision_UnknownProvisionIdReturnsCancelledFalse`,
`TestProvisionStreamRegistry_EntryRemovedWhenStreamEndsWithoutCancel`.
Thêm fake `fakeVmProvisionStream` (implement
`grpc.ServerStreamingClient[VmProvisionEvent]`, mirror `fakePtyStream`) —
gặp 1 race trong chính test logic (Go `select` chọn ngẫu nhiên giữa
`s.recv`/`s.err` khi cả 2 đều ready cùng lúc, nếu push cả terminator error
VÀ toàn bộ event cùng lúc trước khi consumer kịp đọc) — sửa bằng cách push
từng event 1 rồi đọc lại từ `events` channel trước khi push event tiếp
theo, giữ `s.err` rỗng cho tới khi mọi event thật sự được tiêu thụ.

**Verify thật đã chạy:**
```
cd backend-go/services/api-gateway && go build ./...                                  # sạch
go test ./internal/adapter/wscompat/... -run EphemeralVm                              # PASS (đúng lệnh task doc)
go test ./internal/adapter/wscompat/... -run EphemeralVm -v -count=5                  # 21 test × 5 lần, PASS toàn bộ
go test -race ./internal/adapter/wscompat/... -run 'EphemeralVm|TestProvisionStreamRegistry'  # PASS, không race
gofmt -l internal/adapter/wscompat/*.go internal/adapter/grpc/server_ephemeral_vm.go   # sạch (file tôi sửa)
```
`go test -race ./internal/adapter/wscompat/...` (KHÔNG filter) phát hiện 1
race PRE-EXISTING không liên quan (`TestBrowserScreencastChannel_ErrorFirstFrame_FailsSynchronously`,
`channels_browser_screencast_test.go` — xác nhận `git status --porcelain`
sạch cho file này, tức KHÔNG do tôi sửa, bug có sẵn trong code đã commit,
ngoài phạm vi task này). `go build ./...` cho toàn bộ 19 module `go.work`
— không module nào vỡ build.

## Mục tiêu

Đăng ký `ephemeralVm.provision` như 1 `StreamChannelHandler` (mirror
`onboarding.openGhAuthTerminal`) + `ephemeralVm.cancelProvision` như 1
channel thường — bao gồm registry `provisionID → cancel` sống ở tầng
này.

## Files cần sửa

1. `backend-go/services/api-gateway/internal/adapter/wscompat/channels_ephemeral_vm.go` (MODIFY — 2 hàm register mới)
2. `backend-go/services/api-gateway/internal/adapter/wscompat/provision_stream_registry.go` (MỚI — mirror `terminalStreamEntry`/`streams` pattern ở `channels_terminal.go`)

## Nội dung (xem BE-SOL-EVM-002 §4)

```go
func registerEphemeralVmProvisionChannel(r *Registry, infra infrafleetv1.InfraFleetServiceClient) {
  r.RegisterStreamChannel("ephemeralVm.provision", func(ctx context.Context, id Identity, args []json.RawMessage) (any, <-chan PushEvent, error) {
    in, err := decodeArg[ephemeralVmProvisionArgs](args, 0)
    invokeCtx := gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID, Role: id.Role})
    resolved, err := infra.ResolveConnection(invokeCtx, &infrafleetv1.ResolveConnectionRequest{ConnectionId: in.ConnectionID})
    // ... not connected -> lỗi
    provisionID := newProvisionID()
    streamCtx, cancel := attachContext(id)
    provisionStream, err := infra.StreamVmProvision(streamCtx, &infrafleetv1.StreamVmProvisionRequest{...})
    entry := &provisionStreamEntry{stream: provisionStream, cancel: cancel}
    provisions.put(provisionID, entry)
    events := make(chan PushEvent)
    go drainVmProvisionOutput(streamCtx, provisionID, entry, provisions, events)
    return ephemeralVmProvisionAckView{ProvisionID: provisionID}, events, nil
  })
}

func registerEphemeralVmCancelProvisionChannel(r *Registry) {
  r.Register("ephemeralVm.cancelProvision", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
    in, err := decodeArg[ephemeralVmCancelProvisionArgs](args, 0)  // {provisionId}
    entry, ok := provisions.get(in.ProvisionID)
    if !ok { return ephemeralVmCancelProvisionResultView{Cancelled: false}, nil }
    entry.cancel()
    return ephemeralVmCancelProvisionResultView{Cancelled: true}, nil
  })
}
```

`drainVmProvisionOutput` mirror `drainAttachPtyOutput`
(`channels_terminal.go`) — đọc `VmProvisionEvent` từ gRPC stream, map
sang `PushEvent{Channel: "ephemeralVm.onProvisionEvent", Args: [...]}`,
tự gỡ entry khỏi `provisions` registry khi stream kết thúc (thành công,
lỗi, hoặc ctx cancel) — **không** dựa vào `cancelProvision` được gọi để
dọn registry (rủi ro leak đã ghi ở BE-SOL-EVM-002 §Rủi ro).

## Test cases cần cover

- `TestEphemeralVmProvision_AcksWithProvisionId`
- `TestEphemeralVmProvision_PushesStdoutStderrResultEvents`
- `TestEphemeralVmProvision_NoConnectionReturnsError`
- `TestEphemeralVmCancelProvision_CancelsRunningStream`
- `TestEphemeralVmCancelProvision_UnknownProvisionIdReturnsCancelledFalse`
- `TestProvisionStreamRegistry_EntryRemovedWhenStreamEndsWithoutCancel` — regression-guard cho rủi ro leak

## Verify

```bash
cd backend-go/services/api-gateway && go build ./... && go test ./internal/adapter/wscompat/... -run EphemeralVm
```

## gitnexus

`impact({target: "Registry", direction: "downstream"})` trước khi thêm
`StreamChannelHandler` mới — xác nhận không ảnh hưởng dispatch loop
chung (`handleInvoke`/`handleSubscribe`, `handler.go`) dùng bởi mọi
channel khác.

## Blocking

Không task backend-go nào khác phụ thuộc trực tiếp task này, nhưng
[FE-TASK-EVM-002](../../../../frontend/crs/v3/ephemeral-vm/tasks/FE-TASK-EVM-002-subscribe-runtime-stream-channel-client.md)
cần channel này tồn tại để test thật (không chỉ mock).
