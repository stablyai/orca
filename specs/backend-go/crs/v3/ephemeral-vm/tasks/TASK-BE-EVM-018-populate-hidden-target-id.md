# TASK-BE-EVM-018: Gap 3 — populate `hiddenTargetID` (2 proto + wiring)

**Solution:** [BE-SOL-EVM-004](../solutions/BE-SOL-EVM-004-ssh-connection-type-backend.md) §6c | **CR:** CR-EVM-005
**Service:** `infra-fleet-service`, `git-gateway-service`, `project-service`
**Depends on:** [TASK-BE-EVM-015](./TASK-BE-EVM-015-git-gateway-hidden-target-routing.md) (routing mechanism đã có, chỉ thiếu chỗ set field)
**Status:** ✅ DONE (2026-09-08) — chỉ cần thiết cho Hướng A (Hướng B không có khái niệm hidden target)

---

## Mục tiêu

`RelayExecutor.relay()` (TASK-BE-EVM-015) đã đọc `HiddenTargetID` từ ctx
để đổi routing — nhưng chưa ai set giá trị đó. Thêm field vào 2 proto +
wire population đúng chỗ.

## ⚠️ Audit bắt buộc trước khi sửa — 2 file proto đang dirty từ WIP khác

`infrafleet.proto` và project-service's proto (repo-info message) đều
nằm trong khối WIP không liên quan đang có thay đổi song song. **Đọc lại
nguyên trạng file NGAY TRƯỚC KHI GHI**, chỉ thêm đúng 1 field mới, không
đụng field/message khác — đúng cách 2 agent song song đã merge sạch
`ephemeral_vm_ssh_target.go` trong phiên trước (không double-declare,
không mất nội dung bên nào).

## Files cần sửa

1. `backend-go/proto/orca/infrafleet/v1/infrafleet.proto` (MODIFY — thêm `string hidden_target_id = N;` vào `ResolvedConnection`/`ResolveConnectionResponse` message, số field N kế tiếp field cuối hiện có)
2. Proto tương ứng của `project-service` mang `domain.RepoInfo` (tìm file thật trước — audit, không đoán tên) (MODIFY — thêm field tương tự)
3. `internal/usecase/ephemeral_vm_relay.go` hoặc nơi `AttachWorkspace` xử lý runtime `ssh`-type đã attach (MODIFY — set `hidden_target_id = runtimeID` khi trả `ResolveConnection` cho connection này)
4. `git-gateway-service`'s tương ứng (MODIFY nếu cần — đọc field mới, populate `domain.RepoInfo.HiddenTargetID`)

## Test cases cần cover

- `TestResolveConnection_SshTypeRuntimeReturnsHiddenTargetID`
- `TestResolveConnection_NonSshRuntimeHiddenTargetIDEmpty` (regression-guard — mọi connection thường không đổi)
- `TestGitGatewayRelay_PopulatesHiddenTargetIDFromRepoInfo`

## Verify

```bash
cd backend-go && buf generate
# Xác nhận chỉ infrafleet + project-service's proto liên quan đổi — nếu buf generate động
# tới proto khác đang dirty từ WIP song song, xử lý đúng theo tiền lệ TASK-BE-EVM-002
# (giữ lại nếu service khác phụ thuộc generated code mới, không revert mù quáng)
cd backend-go/services/infra-fleet-service && go build ./... && go test ./...
cd backend-go/services/git-gateway-service && go build ./... && go test ./...
cd backend-go/services/project-service && go build ./... && go test ./...
```

## gitnexus

`impact({target: "ResolveConnection", direction: "downstream"})` — nhiều caller, xác nhận thêm field không phá response shape hiện có (proto field mới, optional, không breaking).

## Blocking

Không task nào khác phụ thuộc — hoàn thành Gap 3.

## Kết quả thực tế (2026-09-08)

**Audit trước khi sửa (theo cảnh báo trong task doc):** đọc lại
`infrafleet.proto`/`project.proto` NGAY TRƯỚC khi ghi — cả 2 file đều SẠCH
(đúng như bối cảnh phiên này đã nêu, không còn dirty WIP như mô tả gốc).
Tìm ra file proto thật của project-service mang tương đương
`domain.RepoInfo`: `project.proto`'s `GetRepoResponse` (không phải 1
message tên `RepoInfo`) — `dev_server_id` đã là tiền lệ field top-level
tương tự, `hidden_target_id` thêm cùng kiểu.

**Đã implement (real, tested):**
1. `backend-go/proto/orca/infrafleet/v1/infrafleet.proto` — thêm
   `string hidden_target_id = 6;` vào `ResolveConnectionResponse` (field
   tiếp theo sau `connection_id = 5`).
2. `backend-go/proto/orca/project/v1/project.proto` — thêm
   `string hidden_target_id = 3;` vào `GetRepoResponse` (sau
   `dev_server_id = 2`).
3. `cd backend-go/proto && buf generate` — chỉ 2 file `.pb.go` tương ứng
   đổi (`infrafleet.pb.go` +29/-. dòng, `project.pb.go` +31/-. dòng),
   không file proto/generated nào khác bị động tới (xác nhận bằng
   `git status --porcelain proto/` trước/sau — sạch trước, chỉ 4 file sau).
   Không có `_grpc.pb.go` nào đổi (chỉ thêm field, không đổi RPC).
4. **infra-fleet-service — nơi set field (item 3 trong "Files cần sửa")**:
   `internal/usecase/resolve_connection.go` — `ResolveConnection` thêm
   dependency `runtimes EphemeralVmRuntimeRepository` (optional/nil-safe,
   mirror `AgentOutboundSshProvisioner.records`'s convention).
   `resolveHiddenTargetID` helper: nếu `conn.WorktreeID != ""`, gọi
   `runtimes.GetByWorkspaceID(ctx, tenantID, conn.WorktreeID)` — nếu tìm
   thấy VÀ `ConnectionType == "ssh"`, `HiddenTargetID = runtime.ID` (quy
   ước hiddenTargetID == runtimeID, BE-SOL-EVM-004 §4). Mọi lỗi/not-found
   đều fallback về `""`, KHÔNG BAO GIỜ escalate thành error (thuộc tính
   trực giao, best-effort — đúng quyết định 3 đã chốt).
   **Audit xác nhận WorktreeID == ephemeral VM's WorkspaceID cùng 1 ID
   space** (không đoán): đọc trực tiếp
   `api-gateway/internal/adapter/wscompat/channels_ephemeral_vm.go`'s
   `resolveConnectionIDForWorktree` — được gọi với `in.WorkspaceID` (từ
   `ephemeralVm.suspendWorkspace`/`resumeWorkspace` handlers) và tự nó gửi
   giá trị đó làm `ResolveConnectionRequest.WorktreeId` — code thật đã
   land, không phải suy đoán kiến trúc.
   `internal/adapter/grpc/server.go` — `ResolveConnection` map
   `resp.HiddenTargetId = out.HiddenTargetID`.
   `cmd/server/main.go` — di chuyển `resolveConnectionUC`'s construction
   xuống SAU `ephemeralVmRuntimeStore` (trước đó `resolveConnectionUC`
   được tạo trước store này trong file — đổi thứ tự, không đổi logic
   khác), truyền `ephemeralVmRuntimeStore` vào `NewResolveConnection`.
5. **git-gateway-service — populate `domain.RepoInfo.HiddenTargetID`
   (item 4)**: `internal/adapter/grpcclient/project_client.go`'s `GetRepo`
   — map `resp.GetHiddenTargetId()` vào `domain.RepoInfo.HiddenTargetID`.
   project-service's `GetRepo` handler THẬT (`internal/adapter/grpc/server.go`)
   KHÔNG set giá trị thật cho field mới (đúng phạm vi task — item 4 chỉ
   liệt kê git-gateway-service, không phải project-service's usecase; join
   thật (repo_id → ephemeral_vm_runtime nào) vẫn là câu hỏi kiến trúc mở,
   đúng như TASK-BE-EVM-015's gap #2 đã ghi) — field luôn `""` từ nguồn
   thật hôm nay, nhưng mapping phía client đã sẵn sàng thật.
6. **Bonus fix cùng lớp (không nằm trong "Files cần sửa" gốc nhưng đóng
   TASK-BE-EVM-015's gap #1 luôn, cùng 2 proto field vừa thêm)**:
   `internal/adapter/grpcclient/resolver.go`'s `ConnectionResolver.ResolveConnection`
   — map `resp.GetHiddenTargetId()` vào `usecase.ResolvedConnection.HiddenTargetID`
   (trước đây field này tồn tại nhưng KHÔNG BAO GIỜ được set — chính là
   TASK-BE-EVM-015's gap #1). `dispatchExecutor` (`ports.go`) VẪN giữ
   nguyên quyết định KHÔNG thread `HiddenTargetID` vào ctx (33 call site,
   ngoài phạm vi) — chỉ cập nhật doc comment cho đúng thực tế mới (field
   giờ CÓ THỂ non-empty, nhưng vẫn cố tình không dùng ở nhánh này).
7. Cập nhật doc comment `domain.RepoInfo.HiddenTargetID` +
   `usecase.ResolvedConnection.HiddenTargetID` — bỏ khung "GAP" cũ, ghi rõ
   trạng thái mới (wire mapping thật, nguồn dữ liệu project-service vẫn
   chưa populate).
8. Test mới, thật, pass:
   - `TestResolveConnection_SshTypeRuntimeReturnsHiddenTargetID` (infra-fleet-service)
   - `TestResolveConnection_NonSshRuntimeHiddenTargetIDEmpty` (infra-fleet-service,
     4 sub-case: not-found, orca-server-type, runtimes==nil, no-worktree)
   - `TestGitGatewayRelay_PopulatesHiddenTargetIDFromRepoInfo` (git-gateway-service,
     `ProjectClient.GetRepo` qua `fakeProjectServiceClient` mới — embed
     `projectv1.ProjectServiceClient`, mirror `fakeInfraFleetServiceClient`'s
     tiền lệ có sẵn trong cùng file)
   - `TestGitGatewayRelay_NoHiddenTargetID_UnchangedBehavior` (regression-guard bổ sung)
   - `TestConnectionResolver_ResolveConnection_MapsHiddenTargetID` (regression-guard
     cho bonus fix #6 ở trên)

**Verify thật đã chạy (2026-09-08):**
```
cd backend-go/proto && buf generate                              # OK, diff đúng 2 .pb.go
cd backend-go/services/infra-fleet-service && go build ./... && go vet ./...        # OK
go test ./... -v                                                  # PASS toàn bộ (bao gồm 2 test mới)
cd backend-go/services/git-gateway-service && go build ./... && go vet ./...        # OK
go test ./... -v                                                  # PASS toàn bộ (bao gồm 3 test mới)
cd backend-go/services/project-service && go build ./... && go vet ./... && go test ./...  # OK, PASS
gofmt -l <mọi file đã sửa>                                          # rỗng — sạch
```

**Xác nhận không đụng WIP song song khác:** `cd backend-go && for svc in
api-gateway task-service ai-provider-service; do (cd services/$svc && go
build ./...); done` — `api-gateway`/`ai-provider-service` OK (2 message
proto này backward-compatible, field mới optional). `task-service` build
FAIL — xác nhận qua `git status --porcelain services/task-service/` đây là
lỗi CÓ SẴN từ 1 khối WIP khác đang dở trong working tree (nhiều file M
không liên quan tới `ResolveConnectionResponse`/`GetRepoResponse`, lỗi về
`SimpleExecutor.Execute`'s chữ ký — hoàn toàn không liên quan tới 2 proto
field vừa thêm) — KHÔNG phải do task này gây ra, không sửa (ngoài phạm vi
4 task được giao).

**Không có gap nào để lại trong phạm vi task này** — 2 câu hỏi kiến trúc
còn mở KHÔNG phải gap của task này mà là quyết định đã ghi rõ ràng, cố ý
để lại cho follow-up (đã note trong doc comment thật, không giấu):
1. project-service's `GetRepo` handler chưa populate `hidden_target_id`
   thật (cần join `repo_id` → `infra-fleet-service`'s
   `ephemeral_vm_runtimes`, cross-service — TASK-BE-EVM-015's gap #2,
   ngoài phạm vi 4 task BE-EVM-016..019).
2. `dispatchExecutor` (worktree-keyed) cố ý không thread `HiddenTargetID`
   vào ctx — quyết định TASK-BE-EVM-015 đã chốt, giữ nguyên.
