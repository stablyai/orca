# TASK-BE-EVM-003: `DevServerAgentClient.StreamVmProvision` (adapter tới agent)

**Solution:** [BE-SOL-EVM-002](../solutions/BE-SOL-EVM-002-provision-streaming-channel.md) §2-3 | **CR:** CR-EVM-003
**Service:** `infra-fleet-service` (`internal/adapter/devserveragent/`)
**Depends on:** [TASK-BE-EVM-002](./TASK-BE-EVM-002-provision-proto.md)
**Status:** ✅ DONE — 2026-09-08

---

**Kết quả thực tế:** Implement khác đáng kể so với sketch gốc của task doc,
vì sketch giả định sai wire shape (đã được coordinator xác nhận qua đọc
source thật `agent-ephemeral-vm-handler.ts`/`agent-git-handler.ts` trước khi
code — KHÔNG copy mù sketch).

- **Phát hiện quan trọng nhất**: `vm.provision`'s frame thật KHÔNG chỉ có
  `stream.chunk`/`stream.end` như task doc mô tả — dispatcher (agent-side)
  gửi NGAY 1 frame `{result:{type:'stream.started'}}` làm RESPONSE cho
  chính request gốc (cùng `id`) TRƯỚC KHI `handleVmProvision` chạy, mirror
  y hệt `handleGitExecStream`'s precedent thật ("The initial 'stream.started'
  response is sent by the dispatcher before calling here"). Sau đó
  `stream.chunk`(N lần)/`stream.end`(1 lần) cũng gửi qua CÙNG `id` đó — tức
  là 1 request nhận NHIỀU response frame chia sẻ chung id, khác hẳn
  notification demux (`pty.data`/`browser.screencastReady`) mà
  `StreamPty`/`StreamScreencast` dùng (method+params, không có id).
- **Hệ quả kiến trúc**: `session.go`'s `call()`/`readLoop` gốc chỉ hỗ trợ
  ĐÚNG 1 response/id (xoá `pending[id]` ngay sau frame đầu) — không đủ cho
  shape này. Phải thêm cơ chế thứ 3 (`pendingCall.streaming` +
  `session.streamCall`): `streamCall` block đợi CHÍNH XÁC frame đầu tiên
  (giống `call()`, để dispatch-time error như "method not found" trả về
  đồng bộ), rồi trả channel sống cho các frame tiếp theo — `readLoop` chỉ
  auto-xoá `pending[id]` khi KHÔNG streaming HOẶC gặp `resp.Error != nil`
  (luôn terminal, kể cả streaming). `complete()` do caller gọi đúng 1 lần
  (mirror unsubscribe contract của StreamPty/StreamScreencast).
- `ports.go`: thêm `StreamVmProvision` vào interface +
  `VmProvisionParams`/`VmProvisionEvent`/`VmProvisionResult`/
  `EphemeralVmRecipeSshTarget` — kiểu Go thuần (không dùng proto type trực
  tiếp), đúng convention `ScreencastParams`/`ScreencastEvent` đã có.
- `client.go`: `StreamVmProvision` gọi `sess.streamCall("vm.provision", ...)`
  rồi demux `stream.end`'s `provisionResult` field — field này mang NGUYÊN
  object trả về từ agent's `parseEphemeralVmRecipeResult`
  (`{ok:true,result:...}|{ok:false,error}`), KHÔNG phải flattened
  `VmProvisionResult` proto shape trực tiếp. Phải viết
  `normalizeVmProvisionResult` để tự collapse cả 2 dạng recipe result
  (legacy `pairingCode`/`projectRoot` top-level vs. dạng mới có
  `connection.type`) — mirror đúng `getEphemeralVmRecipeResultConnection`'s
  logic thật bên TS. `stream.end` còn có nhánh lỗi thứ 3 chưa có trong
  sketch: top-level `error` field (catch-block exception, khác
  `provisionResult.error`) — đã cover cả 3 nhánh lỗi (exitCode≠0,
  top-level `error`, `provisionResult.ok===false`) bằng test riêng.
- Method-not-found detection: đặt lỗi -32601 check TRONG `streamCall`'s
  đường đồng bộ (chờ frame đầu) — không phải sau khi channel đã trả về —
  để caller (test `TestStreamVmProvision_AgentMethodNotFoundReturnsTypedError`)
  nhận lỗi `errors.Is(err, domain.ErrAgentMethodNotFound)` NGAY từ return
  value, đúng "starting IS subscribing" discipline `StreamScreencast` đã
  dùng (không phải như 1 event lỗi trong channel).
- `scan_workspace_ports_test.go`'s `fakeDevServerAgentClient` (dùng chung
  toàn bộ package `usecase`) phải thêm stub `StreamVmProvision` — ngoài
  phạm vi "Files cần sửa" gốc nhưng bắt buộc để package compile (Go
  interface, `impact()` xác nhận đây là interface trung tâm, risk MEDIUM,
  21 caller downstream).
- `client_test.go`'s `fakeAgent` thêm field `vmProvisionFrames` (chuỗi
  frame `result` gửi liên tiếp cùng 1 request id) — cơ chế test mới, vì
  `results map[string]any` cũ chỉ hỗ trợ 1 response/method.
- Không dùng `goleak` (task doc gợi ý "nếu package đã dùng ở test khác") —
  xác nhận package này chưa dùng goleak ở bất kỳ test nào khác, nên không
  thêm dependency mới; `TestStreamVmProvision_UnsubscribeStopsDemux` xác
  nhận qua channel-close-with-timeout pattern đã có sẵn
  (`TestSession_UnsubscribeScreencast_ClosesChannelAndStopsRouting`'s
  convention) thay vì goleak.
- gitnexus: `impact({target:"DevServerAgentClient", direction:"downstream"})`
  chạy trước khi sửa — risk MEDIUM, 21 caller trực tiếp (usecase layer:
  `EmulatorRelay`, `EphemeralVmRelay`, `ScanWorkspacePorts`, ... — không có
  process/module bị ảnh hưởng theo gitnexus's риск summary). `codegraph
  explore` dùng để đọc `StreamScreencast`'s source thật làm mẫu mirror
  trước khi viết `StreamVmProvision`.

**Verify thật đã chạy:**
```
cd backend-go/services/infra-fleet-service && go build ./...                       # sạch
go test ./internal/adapter/devserveragent/... -run StreamVmProvision -v            # 5/5 PASS (2 test có subtest)
go test ./internal/adapter/devserveragent/...                                       # PASS toàn package
go test -race ./...                                                                  # PASS, không race
gofmt -l .                                                                            # sạch
```
Ngoài ra `go build ./...` cho toàn bộ 19 module `go.work` — không module
nào vỡ build. `go vet ./...` xác nhận `fakeDevServerAgentClient` (usecase
package) implement đủ interface mới sau khi thêm stub.

## Mục tiêu

Thêm `StreamVmProvision` vào `DevServerAgentClient` interface + adapter
thật — mirror đúng shape `StreamScreencast` ("starting IS subscribing",
`ports.go:312-322`), demux frame `stream.chunk`/`stream.end` mà agent
gửi qua `vm.provision` (theo
[SOL-AG-EVM-002](../../../../agent/crs/v3/ephemeral-vm/solutions/SOL-AG-EVM-002-vm-provision-streaming-handler.md))
thành `VmProvisionEvent`.

## Files cần sửa

1. `backend-go/services/infra-fleet-service/internal/usecase/ports.go` (MODIFY — thêm `StreamVmProvision` vào `DevServerAgentClient` interface, `VmProvisionParams`/`VmProvisionEvent` type nếu không dùng thẳng proto type)
2. `backend-go/services/infra-fleet-service/internal/adapter/devserveragent/client.go` (MODIFY — implement `StreamVmProvision`, mirror `StreamScreencast`'s cách mở subscription)
3. `backend-go/services/infra-fleet-service/internal/adapter/devserveragent/session.go` (MODIFY nếu cần — xác nhận notification demux đọc được `stream.chunk`/`stream.end` frame shape agent gửi, khác `pty.data`/`pty.exit`'s shape hiện có)

## Nội dung (xem BE-SOL-EVM-002 §2-3)

```go
// ports.go — thêm vào DevServerAgentClient interface
StreamVmProvision(ctx context.Context, devServer domain.DevServer, params VmProvisionParams) (<-chan VmProvisionEvent, func(), error)
```

`client.go`'s implementation gọi `vm.provision` qua session's
persistent-connection RPC dispatch (cùng cơ chế `StreamScreencast` dùng
để gọi `browser.screencastStart`), rồi demux 2 loại frame agent trả:
`{type:'stream.chunk', line, source?}` → `VmProvisionEvent{Type:
"stdout"|"stderr", Chunk: line}`; `{type:'stream.end', exitCode,
provisionResult?, error?}` → `VmProvisionEvent{Type: "result"|"error",
...}`, rồi đóng channel.

## Test cases cần cover

- `TestStreamVmProvision_DemuxesStdoutStderrChunks`
- `TestStreamVmProvision_EmitsResultEventOnStreamEnd`
- `TestStreamVmProvision_EmitsErrorEventOnNonZeroExit`
- `TestStreamVmProvision_UnsubscribeStopsDemux` — gọi `unsubscribe`, xác nhận không panic/leak goroutine (dùng `goleak` nếu package đã dùng ở test khác cùng adapter)
- `TestStreamVmProvision_AgentMethodNotFoundReturnsTypedError` — agent build cũ, method không tồn tại → lỗi phân loại đúng (mirror `ErrAgentMethodNotFound` đã dùng ở `vm.exec`)

## Verify

```bash
cd backend-go/services/infra-fleet-service && go build ./... && go test ./internal/adapter/devserveragent/...
```

## gitnexus

`impact({target: "DevServerAgentClient", direction: "downstream"})` —
đây là 1 interface trung tâm, nhiều usecase implement/mock nó
(`EphemeralVmRelay`, `EmulatorRelay`, ...) — xác nhận thêm 1 method mới
vào interface không phá bất kỳ mock/fake nào khác đang implement nó
(Go interface — mọi struct implement interface này cần có method mới,
kể cả struct test-double).

## Blocking

TASK-BE-EVM-004 phụ thuộc task này.
