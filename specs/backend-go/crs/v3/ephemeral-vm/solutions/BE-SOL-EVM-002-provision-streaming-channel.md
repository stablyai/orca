# BE-SOL-EVM-002: `ephemeralVm.provision`/`cancelProvision` qua `StreamChannelHandler`

> **🔲 Designed — chưa implement.** Đây là solution trung tâm của cả
> nhóm CR ephemeral-vm — hiện thực hoá
> [CR-EVM-003](../../../../../../docs/crs/v3/ephemeral-vm/CR-EVM-003-provision-streaming-rpc.md).
> Kết luận cũ ("cần `defineStreamingMethod`, backend-go chưa có") của
> `specs/backend/api/ephemeral-vm-server-mode-design.md` bị supersede bởi
> solution này — hạ tầng cần thiết **đã tồn tại**, chỉ chưa được dùng cho
> namespace này.

**CR:** [CR-EVM-003](../../../../../../docs/crs/v3/ephemeral-vm/CR-EVM-003-provision-streaming-rpc.md)
**Service:** `infra-fleet-service` (usecase + agent client mới) + `api-gateway` (wscompat channel mới)
**Frontend counterpart:** [FE-SOL-EVM-002](../../../../frontend/crs/v3/ephemeral-vm/solutions/FE-SOL-EVM-002-provision-streaming-client.md)
**Agent counterpart:** [SOL-AG-EVM-002](../../../../agent/crs/v3/ephemeral-vm/solutions/SOL-AG-EVM-002-vm-provision-streaming-handler.md)
**TDD tham chiếu:** [`api-gateway.md`](../../../../tdd/services/api-gateway.md) §8 (WS↔gRPC streaming bridge — mô tả khái niệm, xem mục 1 dưới đây cho implementation thật); [`infra-fleet-service.md`](../../../../tdd/services/infra-fleet-service.md) §3, §7

---

## 1. Primitive dùng: `Registry.StreamChannelHandler` — đã tồn tại, đã chạy production

`api-gateway.md` §8 mô tả đúng Ý ĐỊNH kiến trúc ("mỗi WS endpoint mở 1
gRPC streaming call tương ứng") nhưng ở mức trừu tượng — audit trực tiếp
`backend-go/services/api-gateway/internal/adapter/wscompat/registry.go:63-95`
xác nhận cơ chế **thật, cụ thể** đã tồn tại:

```go
type StreamChannelHandler func(ctx context.Context, id Identity, args []json.RawMessage) (ack any, events <-chan PushEvent, err error)
func (r *Registry) RegisterStreamChannel(channel string, h StreamChannelHandler)
```

— 1 channel vừa ack (trả kết quả ngay) vừa mở 1 subscription push cho
phần còn lại. Có tiền lệ **chạy thật, có test**, làm khuôn mẫu trực tiếp:
`onboarding.openGhAuthTerminal`
(`backend-go/services/api-gateway/internal/adapter/wscompat/channels_onboarding.go:639-701`)
— ack `{ptyId, devServerId}` ngay, rồi đẩy tiếp `terminal.output`/
`terminal.exited` qua cùng subscription.

## 2. Precedent tốt hơn cho tầng `infra-fleet-service` ↔ agent: `StreamScreencast`, không phải `StreamPty`

`DevServerAgentClient`'s PTY methods (`ports.go:260-302`) tách "khởi
động" (`SpawnPty`) khỏi "theo dõi" (`StreamPty`) vì 1 pty **đã tồn tại**
trước khi ai đó attach vào nó. `provision` không có tình huống đó — không
có "phiên provision" nào tồn tại trước khi provision bắt đầu. Đúng dạng
này đã có tiền lệ thật:

```go
// ports.go:312-322 — comment gốc, đọc verbatim
// StreamScreencast starts a browser.screencast capture on the agent
// (fire-and-forget browser.screencastStart dispatch, mirroring how
// git.execStream/agent.spawn ack immediately then push further data via
// notify) and subscribes to its ready/frame/ended/error notifications
// over devServer's persistent session ... unlike StreamPty, there's no
// separate "spawn" step to call first: starting IS subscribing ...
StreamScreencast(ctx context.Context, devServer domain.DevServer, params ScreencastParams) (<-chan ScreencastEvent, func(), error)
```

**`provision` dùng đúng shape này** — "starting IS subscribing":

```go
// ports.go (bổ sung)
type VmProvisionParams struct {
  RecipeID, RuntimeID, RepoPath, Command string
  Env map[string]string
}
type VmProvisionEvent struct {
  Type    string // "stdout" | "stderr" | "result" | "error"
  Chunk   string // stdout/stderr
  Result  *VmProvisionResult // set khi Type == "result" — EphemeralVmRecipeResultSchema đã decode
}
StreamVmProvision(ctx context.Context, devServer domain.DevServer, params VmProvisionParams) (<-chan VmProvisionEvent, func(), error)
```

Comment trên chính là bằng chứng: `git.execStream`/`agent.spawn` đã dùng
đúng mô hình "ack ngay rồi push qua notify" này trong sản xuất — không
phải thiết kế suy đoán, là mẫu đã kiểm chứng 2 lần trong cùng codebase.

## 3. Agent-side wire: tái dùng đúng khuôn `git.execStream`, không phải PTY notification

Đọc trực tiếp `agent/src/relay/agent-git-handler.ts:238-289` (real code,
không phải TDD) xác nhận `git.execStream` gửi nhiều frame cùng 1 `id`
RPC gốc:

```
{ jsonrpc: '2.0', id, result: { type: 'stream.chunk', line, source?: 'stderr' } }
...
{ jsonrpc: '2.0', id, result: { type: 'stream.end', exitCode } }
```

Đây là mẫu **đơn giản hơn và khớp bản chất hơn** cho `vm.provision` so
với PTY's notification-demux layer (`pty.data`/`pty.exit` qua
`devserveragent/session.go`) — vì provision về bản chất là "chạy 1 shell
command dài, muốn xem output realtime", đúng loại việc `git.execStream`
đã giải quyết cho `git push`/`git pull`, không phải 1 phiên tương tác 2
chiều như pty. Agent's `vm.provision` handler (xem
[SOL-AG-EVM-002](../../../../agent/crs/v3/ephemeral-vm/solutions/SOL-AG-EVM-002-vm-provision-streaming-handler.md))
nên emit `stream.chunk`/`stream.end` theo đúng khuôn này; `StreamVmProvision`
(mục 2) ở tầng `devserveragent` demux các frame đó thành `VmProvisionEvent`.

## 4. `wscompat`: channel `ephemeralVm.provision`

```go
// channels_ephemeral_vm.go (bổ sung)
func registerEphemeralVmProvisionChannel(r *Registry, infra infrafleetv1.InfraFleetServiceClient) {
  r.RegisterStreamChannel("ephemeralVm.provision", func(ctx context.Context, id Identity, args []json.RawMessage) (any, <-chan PushEvent, error) {
    in, err := decodeArg[ephemeralVmProvisionArgs](args, 0)   // {connectionId, recipeId, runtimeId}
    if err != nil { return nil, nil, err }

    invokeCtx := gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID, Role: id.Role})
    resolved, err := infra.ResolveConnection(invokeCtx, &infrafleetv1.ResolveConnectionRequest{ConnectionId: in.ConnectionID})
    if err != nil || !resolved.GetConnected() {
      return nil, nil, fmt.Errorf("INFRA_EPHEMERAL_VM_NO_CONNECTION: no dev server bound")
    }

    provisionID := newProvisionID()
    streamCtx, cancel := attachContext(id)   // mirror channels_terminal.go — KHÔNG timeout ngắn
    provisionStream, err := infra.StreamVmProvision(streamCtx, &infrafleetv1.StreamVmProvisionRequest{
      ConnectionId: in.ConnectionID, RecipeId: in.RecipeID, RuntimeId: in.RuntimeID,
    })
    if err != nil { cancel(); return nil, nil, err }

    entry := &provisionStreamEntry{stream: provisionStream, cancel: cancel}  // mirror terminalStreamEntry
    provisions.put(provisionID, entry)   // registry mới, cùng khuôn streams.put (channels_terminal.go)

    events := make(chan PushEvent)
    go drainVmProvisionOutput(streamCtx, provisionID, entry, provisions, events)  // mirror drainAttachPtyOutput

    return ephemeralVmProvisionAckView{ProvisionID: provisionID}, events, nil
  })
}
```

`ephemeralVm.cancelProvision` là 1 `Register` bình thường (request/
response): lookup `provisionID` trong `provisions` registry, gọi
`entry.cancel()` — không cần `StreamChannelHandler`, mirror đúng cách
`channels_terminal.go` xử lý `terminal.close`.

`ephemeralVm.onProvisionEvent` **không phải 1 channel riêng** — các
`PushEvent` (`{type: 'stdout'|'stderr'|'result'|'error', ...}`) đẩy qua
subscription mà `provision`'s ack đã mở chính là "event" đó, đúng cách
`terminal.output` không phải 1 RPC riêng mà là push frame trên
subscription `terminal.create` đã mở.

## 5. Xử lý kết quả — chỉ nhánh `orca-server`, nhánh `ssh` pass-through nguyên vẹn

Khi `VmProvisionEvent{Type: "result"}` mang `Result.Type == "ssh"`, usecase
chỉ lưu `ephemeral_vm_runtimes.connection_type = 'ssh'` và dừng — **không**
thử dial SSH (đó là
[CR-EVM-005](../../../../../../docs/crs/v3/ephemeral-vm/CR-EVM-005-ssh-connection-type-outbound-client.md)/
[BE-SOL-EVM-004](./BE-SOL-EVM-004-ssh-connection-type-backend.md)). Khi
`Result.Type == "orca-server"`, usecase pairing với agent's outbound dial
(qua `pairingCode`) — đây chính là input cho
[BE-SOL-EVM-003](./BE-SOL-EVM-003-environment-devserver-resolution.md)'s
`environment_id` write.

## 6. Proto — RPC + message mới

```protobuf
// infrafleet.proto — THÊM
rpc StreamVmProvision(StreamVmProvisionRequest) returns (stream VmProvisionEvent);

message StreamVmProvisionRequest {
  string connection_id = 1;
  string recipe_id = 2;
  string runtime_id = 3;
}
message VmProvisionEvent {
  string type = 1;   // "stdout" | "stderr" | "result" | "error"
  string chunk = 2;
  VmProvisionResult result = 3;
}
message VmProvisionResult {
  string type = 1;          // "orca-server" | "ssh"
  string pairing_code = 2;  // set khi type == "orca-server"
  string project_root = 3;
  EphemeralVmRecipeSshTarget ssh_target = 4;  // set khi type == "ssh"
}
```

## Rủi ro / Phụ thuộc

| Hạng mục | Rủi ro | Ghi chú |
|---|---|---|
| `buf generate` phải sạch, không phá `proto/gen/go` dùng chung | Trung bình | Rủi ro đã ghi nhận tương tự ở `CR-PW-006`/`CR-STORAGE-001` — chạy `buf generate` + build toàn bộ service tiêu thụ proto này trước khi merge |
| `provision` chạy lâu (VM cloud thật, có thể nhiều phút) | Trung bình | `StreamChannelHandler`'s context "deliberately NO context.WithTimeout" (`registry.go:87-89`) đúng đặc tính cần — nhưng cần giới hạn riêng ở agent (SOL-AG-EVM-002) để không treo vô hạn 1 dev server |
| `provisions` registry (provisionID → cancel) rò rỉ nếu client disconnect không sạch | Trung bình | Mirror đúng cơ chế cleanup của `terminalStreamEntry`/`streams` — `drainVmProvisionOutput` phải tự gỡ entry khi stream kết thúc (thành công, lỗi, hoặc ctx cancel), không dựa vào riêng `cancelProvision` được gọi |
| Client-side (frontend) subscribe vào `StreamChannelHandler`-shaped channel | Xem [FE-SOL-EVM-002](../../../../frontend/crs/v3/ephemeral-vm/solutions/FE-SOL-EVM-002-provision-streaming-client.md) | Chưa có generic client helper cho dạng channel này ở frontend — cần xác nhận/viết mới, không giả định đã có |

## Không thuộc phạm vi solution này

- Handler `vm.provision` thật ở agent (spawn process, emit
  `stream.chunk`/`stream.end`) — xem
  [SOL-AG-EVM-002](../../../../agent/crs/v3/ephemeral-vm/solutions/SOL-AG-EVM-002-vm-provision-streaming-handler.md).
- Client-side streaming consumption — xem
  [FE-SOL-EVM-002](../../../../frontend/crs/v3/ephemeral-vm/solutions/FE-SOL-EVM-002-provision-streaming-client.md).
- Ghi `environment_id`, resolve `terminal.create`/`files.browseServerDir`
  — xem [BE-SOL-EVM-003](./BE-SOL-EVM-003-environment-devserver-resolution.md).
- Dial SSH thật khi `Result.Type == "ssh"` — xem
  [BE-SOL-EVM-004](./BE-SOL-EVM-004-ssh-connection-type-backend.md).

## Liên quan

- `backend-go/services/api-gateway/internal/adapter/wscompat/registry.go:63-95`
- `backend-go/services/api-gateway/internal/adapter/wscompat/channels_onboarding.go:639-701`
- `backend-go/services/infra-fleet-service/internal/usecase/ports.go:260-322` (`StreamPty`, `StreamScreencast` — 2 precedent so sánh)
- `agent/src/relay/agent-git-handler.ts:238-289` (`git.execStream`'s wire frame — mẫu tái dùng cho agent-side)
- `backend-go/services/infra-fleet-service/internal/domain/ephemeral_vm_runtime.go:14-25` (`Status` enum đã có sẵn `"provisioning"`)
- [BE-SOL-EVM-003](./BE-SOL-EVM-003-environment-devserver-resolution.md) (tiêu thụ kết quả `provision` thành công)
