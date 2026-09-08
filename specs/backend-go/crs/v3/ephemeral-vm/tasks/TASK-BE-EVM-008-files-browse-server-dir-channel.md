# TASK-BE-EVM-008: `files.browseServerDir` channel mới

**Solution:** [BE-SOL-EVM-003](../solutions/BE-SOL-EVM-003-environment-devserver-resolution.md) §3 | **CR:** CR-EVM-004
**Service:** `api-gateway`
**Depends on:** [TASK-BE-EVM-007](./TASK-BE-EVM-007-terminal-create-environment-resolution.md)
**Status:** ✅ DONE — 2026-09-08

---

**Kết quả thực tế:** Implement lệch đáng kể so với sketch ở 2 điểm — cả 2
xác nhận bằng audit thật trước khi code, đúng yêu cầu "bước bắt buộc" của
task doc.

- **Audit tên RPC method thật (bước bắt buộc)**: agent thật có 2 method
  browse-dir riêng biệt, không phải 1:
  - `fs.readDir` (`agent-rpc-dispatch-fs.ts:20`, handler thật
    `fs-agent-extensions.ts`'s `handleFsReadDir`) — **method đã được dùng
    thật** bởi `devServer.browseDir` (channel có sẵn, `channels.go:612-724`,
    relay qua `RelayByDevServer`), trả `{entries:[{path,name,type,size?}],path}`
    (tree shape, depth-limited).
  - `fs.listDirectory` (`agent-rpc-dispatch-fs.ts:127`, handler
    `fs-agent-directory-browse.ts`'s `handleFsListDirectory`) — method
    THẬT khác, cũng tồn tại/dispatch được, nhưng **chưa từng được gọi từ
    backend-go** (chỉ dùng bởi Electron's `repo-remote-ipc.ts`, ngoài
    phạm vi backend-go) — trả `{entries:[{name,path,isDirectory,isGitRepo}],platform}`
    (chỉ liệt kê thư mục, có phát hiện git repo).
  - Quyết định: dùng `fs.readDir` — khớp đúng tiền lệ `devServer.browseDir`
    đã hoạt động thật (không phải đoán), cùng response shape đã có sẵn
    logic map sang `{resolvedPath,entries:[{name,isDirectory,isSymlink}]}`
    mà `web-preload-api.ts`/`RemoteFileBrowser` đã kỳ vọng.
- **Sketch's `ephemeralVmRuntimes.FindDevServerByEnvironmentID(...)` gọi
  trực tiếp từ wscompat KHÔNG THỂ hoạt động** — đây là method trên Go
  interface nội bộ của `infra-fleet-service` (task 007 thêm), không thể
  gọi xuyên process boundary từ `api-gateway` (service khác, chỉ giao
  tiếp qua gRPC). Điều chỉnh: tận dụng đúng thiết kế "environment_id BẰNG
  LUÔN dev_server_id" (BE-SOL-EVM-003 §1) — channel gửi thẳng
  `in.EnvironmentID` làm `ResolveConnectionRequest.DevServerId` (RPC gRPC
  ĐÃ CÓ SẴN, không cần RPC mới) để xác nhận tồn tại + connected trước,
  rồi dùng CHÍNH giá trị đó làm `RelayByDevServerRequest.DevServerId` —
  không cần bảng dịch/RPC riêng nào cho "resolve environmentId".
- Channel mirror gần như y hệt `devServer.browseDir`'s logic (đã hoạt
  động thật) — tái dùng thẳng `devServerBrowseDirEntryView`/
  `devServerBrowseDirResultView` (cùng package `wscompat`, không định
  nghĩa lại), cùng convention lỗi `depth:1`, `~`/`""` → `/`, và
  `isSymlink: false` honest-fallback (fs.readDir không báo symlink).
- File mới `channels_files.go` (xác nhận trước: chưa tồn tại, đúng dự
  đoán task doc's "MỚI hoặc MODIFY... audit trước") + đăng ký trong
  `channels.go`'s `RegisterRealChannels` (1 dòng thêm, sau
  `registerEphemeralVmChannels`).
- gitnexus: `mcp__gitnexus__impact` báo lỗi "Connection closed" khi gọi
  (2 lần thử, cả 2 task 007 và 008) — dùng lại kết quả `codegraph_explore`/
  investigation qua subagent đã audit trực tiếp source thật của
  `Registry.Register`/`RegisterRealChannels`/`devServer.browseDir` thay
  thế — xác nhận thêm 1 channel mới hoàn toàn additive, không rủi ro với
  channel khác.

**Test coverage** (5 test mới trong `channels_files_test.go`, tất cả
pass, kể cả dưới `-race`):
`TestFilesBrowseServerDir_ResolvesEnvironmentIdToDevServer`,
`TestFilesBrowseServerDir_UnresolvableEnvironmentIdReturnsError`,
`TestFilesBrowseServerDir_RequiresEnvironmentId`,
`TestFilesBrowseServerDir_RelaysToAgentCorrectMethod` (regression test
trực tiếp cho bước audit — xác nhận method relay đúng là `fs.readDir`,
không phải tên đoán),
`TestFilesBrowseServerDir_DefaultsTildeToRoot`.

**Verify thật đã chạy:**
```
cd backend-go/services/api-gateway && go build ./...                                   # sạch
go test ./internal/adapter/wscompat/... -run FilesBrowseServerDir -v                    # 5/5 PASS (đúng lệnh task doc)
go test ./internal/adapter/wscompat/...                                                  # PASS toàn package
go test -race ./internal/adapter/wscompat/... -run FilesBrowseServerDir                  # PASS, không race
gofmt -l internal/adapter/wscompat/channels_files*.go internal/adapter/wscompat/channels.go  # sạch
```
`go build ./...` cho toàn bộ 19 module `go.work` — không module nào vỡ
build.

## Mục tiêu

## Mục tiêu

Đăng ký channel `files.browseServerDir` (hiện rơi vào
`notImplementedHandler`) — resolve `environmentId → devServerId` (tái
dùng helper TASK-BE-EVM-007 tạo), relay tới agent's browse-dir method
thật.

**Bước bắt buộc trước khi viết code**: audit tên RPC/agent-method thật
dùng cho browse-dir ở các path SSH/dev-server-bound khác đã hoạt động —
BE-SOL-EVM-003 §3 gọi nó "`devServer.browseDir`-style" nhưng đây là mô
tả, không phải tên xác nhận từ code.

## Files cần sửa

1. `backend-go/services/api-gateway/internal/adapter/wscompat/channels_files.go` (MỚI hoặc MODIFY nếu file này đã tồn tại cho mục đích khác — audit trước)

## Nội dung (xem BE-SOL-EVM-003 §3)

```go
r.Register("files.browseServerDir", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
  in, err := decodeArg[filesBrowseServerDirArgs](args, 0)  // {environmentId, path}
  devServerID, found, err := ephemeralVmRuntimes.FindDevServerByEnvironmentID(rpcCtx, id.TenantID, in.EnvironmentID)
  if !found { return nil, fmt.Errorf("INFRA_TERMINAL_NO_COMPUTE_BOUND: ...") }
  resolved, err := infra.ResolveConnection(rpcCtx, &infrafleetv1.ResolveConnectionRequest{DevServerId: devServerID})
  // relay tới agent method thật đã audit — TÊN CHÍNH XÁC xác nhận trước khi viết dòng này
})
```

## Test cases cần cover

- `TestFilesBrowseServerDir_ResolvesEnvironmentIdToDevServer`
- `TestFilesBrowseServerDir_UnresolvableEnvironmentIdReturnsError`
- `TestFilesBrowseServerDir_RelaysToAgentCorrectMethod` — dùng tên method thật đã audit, không phải placeholder

## Verify

```bash
cd backend-go/services/api-gateway && go build ./... && go test ./internal/adapter/wscompat/... -run FilesBrowseServerDir
```

## gitnexus

`codegraph explore "browseDir devServer.browseDir agent method"` hoặc
`impact({target: "<tên RPC thật tìm được>"})` — bước audit bắt buộc,
không bỏ qua (xem "Mục tiêu").

## Blocking

Không task nào khác phụ thuộc task này.
