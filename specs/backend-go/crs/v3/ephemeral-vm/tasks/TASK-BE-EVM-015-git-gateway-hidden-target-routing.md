# TASK-BE-EVM-015: Hướng A — `hiddenTargetID` routing trong `git-gateway-service`

**Solution:** [BE-SOL-EVM-004](../solutions/BE-SOL-EVM-004-ssh-connection-type-backend.md) §4, "Quyết định đã chốt" mục 3 | **CR:** CR-EVM-005
**Service:** `git-gateway-service`, `infra-fleet-service`
**Depends on:** [TASK-BE-EVM-014](./TASK-BE-EVM-014-agent-outbound-ssh-provisioner-backend.md)
**Status:** 🟡 PARTIAL — cơ chế routing chạy thật, test pass; 2 gap phụ thuộc proto ngoài phạm vi (xem "Kết quả thực tế") — chỉ cần thiết cho Hướng A (Hướng B không cần, xem BE-SOL-EVM-004 §5c)

---

## Mục tiêu

Thêm 1 tham số định tuyến trực giao `hiddenTargetID` (= ephemeral VM
`runtimeID`) đi kèm `RepoPath` — **không** mở rộng khái niệm "host" của
`ResolveConnection` (quyết định đã chốt, xem lý do đầy đủ ở
BE-SOL-EVM-004's "Quyết định đã chốt" mục 3).

## Files cần sửa

1. `backend-go/services/git-gateway-service/internal/usecase/ports.go` (MODIFY — mọi call site nhận `RepoPath` giờ nhận thêm `HiddenTargetID string` optional)
2. `backend-go/services/git-gateway-service/internal/adapter/grpcclient/relay_executor.go` (MODIFY — khi `HiddenTargetID != ""`, gọi agent method mới thay vì method thường)
3. `backend-go/services/infra-fleet-service/internal/usecase/ports.go` (MODIFY — thêm `fs.readViaHiddenTarget`/`git.statusViaHiddenTarget`-style method mới vào `DevServerAgentClient`, mirror `ExecViaHiddenSshTarget` đã phác thảo ở TASK-BE-EVM-014)
4. Nơi `RepoPath` được resolve cho 1 repo/workspace ephemeral-VM-backed (audit trước khi sửa — chưa xác nhận entity nào giữ `RepoPath` cho trường hợp này, có thể là `project-service`/`git-gateway-service`'s domain, cần đọc source thật)

## Nội dung (xem BE-SOL-EVM-004's "Quyết định đã chốt" mục 3 cho lý do đầy đủ)

`provider_registry_entries`'s enum hiện có (`local`/`ssh-backed`/
`dev-server-agent-backed`) **KHÔNG đổi** — chỉ fs/git call cho workspace
của runtime `ssh`-type cần định tuyến lại qua `hiddenTargetID`, PTY
session tới Dev Server không đổi.

## Test cases cần cover

- `TestGitDispatch_HiddenTargetID_RoutesToAgentHiddenTargetMethod`
- `TestGitDispatch_NoHiddenTargetID_UnchangedBehavior` (regression-guard — mọi repo bình thường không bị ảnh hưởng)

## Verify

```bash
cd backend-go/services/git-gateway-service && go build ./... && go test ./...
cd backend-go/services/infra-fleet-service && go build ./... && go test ./...
```

## gitnexus

`impact({target: "RelayExecutor", direction: "upstream"})` trước khi đổi
chữ ký — đây là 1 điểm trung tâm của `git-gateway-service`'s dispatch,
nhiều call site phụ thuộc.

## Blocking

Không task nào khác phụ thuộc task này — đây là điểm hoàn thành Hướng A
phía backend-go (kết hợp với agent's TASK-AG-EVM-005/006/007).

## Kết quả thực tế (2026-09-08)

**Audit trước khi sửa (mục 4 của task):** đọc `git-gateway-service/internal/usecase/ports.go`
xác nhận `RepoPath` đi qua 2 đường: (a) `ResolvedConnection.RepoPath`
(worktree-keyed, qua `ConnectionResolver.ResolveConnection` — gRPC thật tới
`infra-fleet-service`), và (b) `domain.RepoInfo.URL` (repo-scoped, qua
`ProjectClient.GetRepo` — gRPC thật tới `project-service`), tiêu thụ bởi
`dispatchExecutor`/`dispatchExecutorForRepo`/`dispatchFilesystemExecutorForRepo`
trong cùng file. `RelayExecutor.relay()` (1 hàm private, KHÔNG phải method
nào của `GitExecutor`) là chokepoint DUY NHẤT mọi ~52 method
`git.*`/`fs.*` gọi qua — đã có sẵn tiền lệ y hệt cho vấn đề này
(`WithDevServerID`/`DevServerIDFromContext`, thread qua `ctx` thay vì đổi
chữ ký ~33-52 method, đã ghi rõ trong `ports.go`'s doc comment thật). Áp
dụng ĐÚNG tiền lệ đó cho `HiddenTargetID` — theo đúng "không đoán chữ ký
khác" nhưng đây không phải đoán, đây là 1 pattern CÓ SẴN trong code thật
cho đúng lớp vấn đề này.

**Đã implement (real, tested):**
1. `domain.RepoInfo.HiddenTargetID` (mới, optional, mặc định rỗng) —
   `git-gateway-service/internal/domain/domain.go`.
2. `usecase.ResolvedConnection.HiddenTargetID` (mới, optional) —
   `internal/usecase/ports.go`.
3. `usecase.WithHiddenTargetID`/`HiddenTargetIDFromContext` — context helper
   mirror y hệt `WithDevServerID`/`DevServerIDFromContext`.
4. `dispatchExecutorForRepo`/`dispatchFilesystemExecutorForRepo` — thread
   `repo.HiddenTargetID` vào ctx (chỉ trên nhánh relay, cùng lúc với
   `WithDevServerID`) khi non-empty.
5. `dispatchExecutor` (worktree-keyed, qua `ConnectionResolver`) — GIỮ
   NGUYÊN chữ ký 3-giá-trị-trả-về (KHÔNG đổi thành 4 để trả thêm `ctx`) —
   33 call site dùng `executor, repoPath, err := dispatchExecutor(...)`
   sẽ vỡ build nếu đổi, trong khi `conn.HiddenTargetID` LUÔN rỗng từ
   đường này (xem gap #1 dưới) nên đổi chữ ký không mang lại hành vi mới
   nào — đã ghi rõ lý do bằng doc comment tại chỗ, không âm thầm bỏ qua.
6. `grpcclient.RelayExecutor.relay()` — khi `HiddenTargetIDFromContext`
   có giá trị: đổi `method` thành `method + "ViaHiddenTarget"` (đúng quy
   ước `git.statusViaHiddenTarget`/`fs.readViaHiddenTarget` trong
   BE-SOL-EVM-004 §4) và thêm `hiddenTargetId` vào `params` — dùng lại
   NGUYÊN kênh `RelayByDevServer` hiện có, không thêm transport/RPC gRPC
   mới.
7. Test thật, pass: `TestGitDispatch_HiddenTargetID_RoutesToAgentHiddenTargetMethod`,
   `TestGitDispatch_NoHiddenTargetID_UnchangedBehavior` (grpcclient package)
   + 3 test bổ sung ở usecase package xác nhận `dispatchExecutorForRepo`
   thread đúng context (bao gồm case fallback-local không set
   `HiddenTargetID`).

**Quyết định KHÔNG làm — file #3 (`infra-fleet-service/internal/usecase/ports.go`
thêm method mới vào `DevServerAgentClient`):** đọc `usecase.RelayByDevServer.Execute`
thật xác nhận nó gọi thẳng `agent.Exec(ctx, devServer, in.Method, in.Params)`
— HOÀN TOÀN generic theo method name, không có enum/whitelist nào ở tầng
`infra-fleet-service`. Method name mới (`git.statusViaHiddenTarget`,...) đi
xuyên qua nguyên vẹn tới agent mà KHÔNG cần thêm method Go nào vào
`DevServerAgentClient` — khác hẳn TASK-BE-EVM-014's `DialHiddenSshTarget`
(cần typed vì trả về `hiddenTargetID` có cấu trúc, không chỉ passthrough).
Không sửa `infra-fleet-service` cho task này.

**2 gap phụ thuộc proto ngoài phạm vi task (không đoán liều):**

1. **`ResolvedConnection.HiddenTargetID` không bao giờ được populate** —
   `infrafleetv1.ResolveConnectionResponse` (proto) không có field tương
   đương; `grpcclient.ConnectionResolver.ResolveConnection` không có gì để
   map vào. Cần thêm `hidden_target_id` vào `ResolveConnectionResponse` +
   `buf generate` — nhưng `backend-go/proto/orca/infrafleet/v1/infrafleet.proto`
   VÀ `proto/gen/go/orca/infrafleet/v1/*.pb.go` đã nằm trong danh sách
   ~226 file KHÔNG được đụng (đã có `M` sẵn trong git status từ trước khi
   task này bắt đầu, thuộc công việc khác đang dở). Vì vậy nhánh
   `dispatchExecutor` (worktree-keyed) không routing được qua hidden target
   trong pass này — chỉ nhánh `dispatchExecutorForRepo`/
   `dispatchFilesystemExecutorForRepo` (repo-scoped, dùng `domain.RepoInfo`)
   hoạt động đầy đủ.
2. **`domain.RepoInfo.HiddenTargetID` không bao giờ được populate** — cùng
   lý do: `RepoInfo` được xây từ `project-service`'s `GetRepoResponse` proto
   (`grpcclient/project_client.go`'s `GetRepo`), cũng không có field tương
   đương, và sửa proto của `project-service` ngoài phạm vi file list của
   task này (chỉ liệt kê `git-gateway-service`/`infra-fleet-service`).
   Ngay cả khi có field, cần thêm câu hỏi kiến trúc: `project-service` biết
   1 repo có backed bởi ephemeral VM hidden target hay không bằng cách nào
   (join với `infra-fleet-service`'s `ephemeral_vm_runtimes`, service khác
   — race với TASK-BE-EVM-014's gap #1 cùng loại) — chưa có câu trả lời,
   để lại cho follow-up task.

**Kết luận:** cơ chế routing (context threading + `relay()`'s
"ViaHiddenTarget" dispatch) đã implement ĐẦY ĐỦ và test thật xác nhận hoạt
động đúng khi `HiddenTargetID` có giá trị — nhưng KHÔNG CÓ ĐƯỜNG THẬT nào
trong hệ thống populate giá trị đó hôm nay (2 gap proto ở trên). Đây là
tình trạng "cơ chế đã sẵn sàng, chờ nguồn dữ liệu" — giống hệt tinh thần
TASK-BE-EVM-014's gap #1 (devServer resolver) và gap #2 (connectionID thật).
