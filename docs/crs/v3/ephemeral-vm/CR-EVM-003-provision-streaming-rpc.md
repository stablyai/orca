# CR-EVM-003 — `ephemeralVm.provision`/`cancelProvision`/`onProvisionEvent` qua `StreamChannelHandler`

| Trường | Giá trị |
|--------|---------|
| **CR ID** | CR-EVM-003 |
| **Tên** | Port `provision`/`cancelProvision` sang `backend-go` bằng primitive streaming đã có sẵn (`StreamChannelHandler`) |
| **Loại** | Architectural Change / New Capability |
| **Priority** | **P0** |
| **Phiên bản** | v1.0 |
| **Ngày tạo** | 2026-09-08 |
| **Trạng thái** | 🔲 Proposed — chưa triển khai |
| **Tác giả** | Audit trực tiếp mã nguồn — supersede kết luận "out of scope, cần defineStreamingMethod" của `specs/backend/api/ephemeral-vm-server-mode-design.md` (2026-08-16) |
| **Tác động HLD** | Infra-Fleet domain, `api-gateway`'s wscompat streaming surface, Dev Server Agent RPC catalog |
| **Tác động Features** | Ephemeral VM workspace creation (`create`) — hiện là **method duy nhất thật sự dựng VM**, hoàn toàn thiếu ở mọi target không phải desktop-local |

---

## Bối cảnh & Vấn đề gốc

`provision` là bước **duy nhất thật sự chạy command `create` của recipe**
— mọi method khác đã port (`attachWorkspace` etc.) chỉ là bookkeeping
hoặc suspend/resume/destroy trên 1 VM **đã tồn tại**
(`ephemeral_vm_relay.go:19-23`'s doc comment tự xác nhận điều này). Không
có `provision`, `ephemeralVm` không thể tạo ra bất kỳ VM/container nào
qua backend-go — đây chính là gốc rễ của
[BACKLOG-002](../../../../docs/backlog/BACKLOG-002-environment-devserver-resolution.md)
("`environment_id` chưa từng được ghi vì không có code path nào pairing
thành công").

`provision`/`cancelProvision` bị loại khỏi mọi đợt port trước đó
(SOL-004/TASK-004/005, `desktop/src/main/runtime/rpc/methods/ephemeral-vm.ts:20-27`)
với lý do: nó stream stdout/stderr theo chunk qua 1 broadcast IPC event
(`ephemeralVm:provisionEvent`) tách rời khỏi request/response phát sinh
ra nó — không khớp `defineMethod`. `specs/backend/api/ephemeral-vm-server-mode-design.md`
(viết 2026-08-16) kết luận: cần `defineStreamingMethod` "if/when that
exists in the backend RPC core" — và **backend-go lúc đó chưa có**.

**Kết luận đó không còn đúng.** Audit trực tiếp
`backend-go/services/api-gateway/internal/adapter/wscompat/registry.go:63-95`
xác nhận `Registry` đã có 1 primitive đúng shape cần:

```go
// registry.go:71
type StreamChannelHandler func(ctx context.Context, id Identity, args []json.RawMessage) (ack any, events <-chan PushEvent, err error)
```

— 1 channel **vừa ack (trả kết quả ngay) vừa mở 1 subscription push** cho
phần còn lại của lifecycle. Đã có tiền lệ **chạy thật, có test**:
`onboarding.openGhAuthTerminal` (`channels_onboarding.go:635-701`) —
ack `{ptyId, devServerId}` ngay khi pty được tạo, rồi tiếp tục đẩy
`terminal.output`/`terminal.exited` qua cùng cơ chế push
(`push_bridge.go`) cho tới khi pty kết thúc. Đây **chính xác** là shape
`provision` cần: ack `{provisionId}` ngay, rồi đẩy stdout/stderr chunk
liên tục cho tới khi recipe's `create` command kết thúc (hoặc bị hủy).

## Giải pháp đề xuất

### 1. `backend-go`: `ephemeralVm.provision` là 1 `StreamChannelHandler` mới

Theo đúng khuôn `registerOnboardingOpenGhAuthTerminalChannel`:

```go
// channels_ephemeral_vm.go (bổ sung)
func registerEphemeralVmProvisionChannel(r *Registry, infra infrafleetv1.InfraFleetServiceClient) {
  r.RegisterStreamChannel("ephemeralVm.provision", func(ctx context.Context, id Identity, args []json.RawMessage) (any, <-chan PushEvent, error) {
    in, err := decodeArg[ephemeralVmProvisionArgs](args, 0)
    // resolve devServer qua connectionId đã có (repo phải đã bind 1 dev
    // server thật — không có local/backend-host fallback, đúng nguyên
    // tắc EphemeralVmRelay đã thiết lập)
    provisionID := newProvisionID()
    events := make(chan PushEvent)
    entry := &provisionStreamEntry{cancel: cancel}
    provisions.put(provisionID, entry)          // registry mới, mirror terminalStreamEntry/streams.put
    go streamVmProvision(streamCtx, devServer, in, entry, events)  // gọi agent, demux stdout/stderr/result
    return ephemeralVmProvisionAckView{ProvisionID: provisionID}, events, nil
  })
}
```

`cancelProvision` là 1 channel `Register` (request/response) bình
thường: lookup `provisionID` trong registry mới, gọi `entry.cancel()` —
mirror đúng cách `terminalStreamEntry`/`streams.put`/`cancel` đã hoạt
động cho pty (`channels_terminal.go`).

`onProvisionEvent` **không cần 1 channel riêng** — nó chính là các
`PushEvent` được đẩy qua cùng subscription `provision`'s ack đã mở, giống
hệt cách `terminal.output` không phải 1 lời gọi riêng mà là push frame
trên subscription `terminal.create` đã mở.

### 2. `backend-go` ↔ `agent`: cần 1 kênh streaming mới, không dùng `Exec` bounded

`DevServerAgentClient.Exec` (`ports.go:250`) là request/response có giới
hạn thời gian — không phù hợp cho 1 lệnh `create` có thể chạy nhiều phút
(`gcloud compute instances create`, `docker build`...). Cần 1 cặp
phương thức mới trên `DevServerAgentClient`, theo đúng mẫu PTY đã có
(`ports.go:260-302`, không phải mở rộng `Exec`):

```go
StartVmProvision(ctx, devServer, in StartVmProvisionInput) (provisionSessionID string, err error)
StreamVmProvision(ctx, devServer, provisionSessionID string) (<-chan VmProvisionEvent, func(), error)
```

— mirror chính xác `SpawnPty`/`StreamPty`'s tách "khởi động" khỏi "theo
dõi output", dùng lại cùng notification-demux layer
(`devserveragent/session.go`) đã phục vụ `pty.data`/`pty.exit` cho
1 loại notification mới (`vm.provision.output`/`vm.provision.exit`).

### 3. `agent`: mở rộng `agent-ephemeral-vm-handler.ts` ([CR-EVM-001](./CR-EVM-001-agent-vm-exec-handler.md)) với mode `create`

Tái dùng `runRecipeCommand` — file này **đã hỗ trợ sẵn** đúng thứ CR này
cần, không cần code exec mới:

```ts
// agent/src/shared/ephemeral-vm-recipe-process.ts:23-34
export async function runRecipeCommand(args: {
  ...
  mode: 'create' | 'suspend' | 'resume' | 'destroy'
  onStdout?: (chunk: string) => void   // ← streaming provision dùng đúng field này
  onStderr?: (chunk: string) => void
  signal?: AbortSignal                 // ← cancelProvision dùng đúng field này
})
```

`agent`'s `vm.provision` case (`agent-rpc-dispatch-misc.ts`) chỉ cần gọi
`runRecipeCommand({ mode: 'create', onStdout, onStderr, signal })`, đẩy
mỗi chunk qua notification `vm.provision.output` (mirror `pty.data`), rồi
parse `EphemeralVmRecipeResultSchema` (`{type: 'orca-server', pairingCode,
projectRoot}` hoặc `{type: 'ssh', target, projectRoot}`) từ dòng JSON
cuối trên stdout khi process kết thúc, gửi qua `vm.provision.exit`.

### 4. `frontend`: `runtime-ephemeral-vm-client.ts` route `provision`/`cancelProvision` qua `callRuntimeRpc`'s stream API

`callRuntimeRpc` cần hỗ trợ subscribe vào push event của 1 lời gọi
stream-channel (nếu chưa có sẵn generic client-side cho
`StreamChannelHandler` — kiểm tra client hiện dùng cho
`terminal.multiplex`/`onboarding.openGhAuthTerminal` trước khi viết mới,
khả năng cao đã có sẵn 1 hàm chung). Gỡ `'ephemeralVm'` khỏi
`DESKTOP_ONLY_NAMESPACES` cho riêng 3 method này (phối hợp với
[CR-EVM-002](./CR-EVM-002-remove-stale-desktop-only-suppressor.md)).

### 5. Chỉ nhánh `{type: 'orca-server', ...}` được xử lý trong CR này

Khi recipe's `create` trả `{type: 'ssh', target, projectRoot}`, `agent`
trả kết quả đó nguyên vẹn lên `backend-go`, `backend-go` lưu vào
`ephemeral_vm_runtimes` với `connection_type = 'ssh'` và **dừng ở đó** —
đúng hành vi hiện tại của toàn bộ lifecycle khác (permanent
`INFRA_EPHEMERAL_VM_SSH_UNSUPPORTED`). Việc thật sự dial SSH outbound tới
target đó là [CR-EVM-005](./CR-EVM-005-ssh-connection-type-outbound-client.md),
không phải CR này.

## Rủi ro / Phụ thuộc

| Hạng mục | Rủi ro | Ghi chú |
|---|---|---|
| `DevServerAgentClient` cần 2 phương thức mới + 1 loại notification mới | Trung bình-Cao | Đây là phần việc lớn nhất của CR — đụng `devserveragent/session.go`'s notification demux, `devserveragent/methods.go`, và proto `infrafleet.proto` (thêm RPC streaming mới hoặc field mới trên `AttachPty`-tương-tự) |
| `provision` có thể chạy rất lâu (VM cloud thật) | Trung bình | `StreamChannelHandler`'s context "deliberately NO context.WithTimeout" (`registry.go:87-89`) — đúng đặc tính cần, nhưng cần timeout/giới hạn riêng ở tầng agent (không để 1 command treo vô hạn chiếm 1 dev server) |
| Client-side streaming API cho `callRuntimeRpc` có thể chưa tồn tại generic | Thấp-Trung bình | Cần audit `frontend/src/renderer/src/runtime/runtime-rpc-client.ts` trước khi implement — nếu `terminal.multiplex` tự có client riêng không tái dùng được, cần viết 1 lớp generic mới (rủi ro phạm vi phình to) |
| Recipe `create` command chạy trên Dev Server, kế thừa toàn bộ credentials máy đó | Đã biết, không tăng thêm | Cùng class rủi ro CR-EVM-001 đã nêu |

## Không thuộc phạm vi CR này

- Dial SSH outbound thật khi `create` trả `{type: 'ssh', ...}` — xem
  [CR-EVM-005](./CR-EVM-005-ssh-connection-type-outbound-client.md).
- Ghi `environment_id`/resolve `terminal.create`/`files.browseServerDir`
  từ `environmentId` bare — xem
  [CR-EVM-004](./CR-EVM-004-environment-devserver-resolution.md) (phụ
  thuộc CR này).
- Đổi shape `OrcaVmRecipe`/`EphemeralVmRecipeResultSchema` — giữ nguyên
  contract JSON hiện có.

## Liên quan

- `backend-go/services/api-gateway/internal/adapter/wscompat/registry.go:63-95` (`StreamChannelHandler`, primitive trung tâm của CR này)
- `backend-go/services/api-gateway/internal/adapter/wscompat/channels_onboarding.go:635-701` (`onboarding.openGhAuthTerminal`, tiền lệ chạy thật để copy khuôn mẫu)
- `backend-go/services/infra-fleet-service/internal/usecase/ports.go:260-302` (`DevServerAgentClient`'s PTY streaming methods, mẫu cho `StartVmProvision`/`StreamVmProvision`)
- `agent/src/shared/ephemeral-vm-recipe-process.ts:23-` (`runRecipeCommand`, tái dùng nguyên xi)
- `desktop/src/main/runtime/rpc/methods/ephemeral-vm.ts:20-27` (lý do gốc bị loại — CR này supersede)
- `specs/backend/api/ephemeral-vm-server-mode-design.md` (kết luận cũ, nay lỗi thời)
- [CR-EVM-001](./CR-EVM-001-agent-vm-exec-handler.md) (dùng chung `agent-ephemeral-vm-handler.ts`)
- [CR-EVM-004](./CR-EVM-004-environment-devserver-resolution.md) (tiêu thụ kết quả `provision` thành công)
