# BE-SOL-STORAGE-002: Read-path hydrate + health tổng hợp cho dev-server/agent (`infra-fleet-service`, `orchestration-service`)

> **🔲 Designed — chưa implement.** Không thêm bảng mới nào ở solution
> này — `infra-fleet-service`/`orchestration-service` đã sở hữu đúng dữ
> liệu cần thiết (xem CR-STORAGE-006). Phạm vi ở đây là: (1) xác nhận/khai
> báo các read RPC cần dùng để hydrate, và (2) 1 RPC mới,
> `GetFleetConnectivitySummary`, cho phần báo health/lỗi (CR-STORAGE-007).

**CRs:** [CR-STORAGE-006](../../../../../../docs/crs/v3/storage/CR-STORAGE-006-centralize-dev-server-agent-state-backend-go.md) · [CR-STORAGE-007](../../../../../../docs/crs/v3/storage/CR-STORAGE-007-bidirectional-error-health-reporting.md)
**Service:** `infra-fleet-service` (dev server/connection/terminal read-paths, RPC health mới) + `orchestration-service` (agent-session/dispatch read-path) + `api-gateway` (wscompat wiring)
**Frontend counterpart:** [FE-SOL-STORAGE-006](../../../../frontend/crs/v3/storage/solutions/FE-SOL-STORAGE-006-dev-server-agent-state-hydration.md)
**TDD tham chiếu:** [`infra-fleet-service.md`](../../../../tdd/services/infra-fleet-service.md) §3-5, §8; [`orchestration-service.md`](../../../../tdd/services/orchestration-service.md) §3-5

---

## 1. Vì sao đây KHÔNG phải "thêm cột JSON" như BE-SOL-STORAGE-001

BE-SOL-STORAGE-001 giải quyết dữ liệu **chưa có** chủ sở hữu backend-go
(preference cá nhân, tab/layout browser-local) — giải pháp là thêm cột mới
vào `tenant.user_profiles`. Ở đây, dữ liệu (`dev_servers`, `connections`,
`terminal_sessions`, `dispatch_contexts`, `coordinator_runs`) **đã tồn
tại** làm bảng Postgres thật, sở hữu bởi `infra-fleet-service`/
`orchestration-service`, với phần lớn RPC đọc **đã generate** trong
`backend-go/proto/gen/go/orca/infrafleet/v1/infrafleet_grpc.pb.go`
(xác nhận đọc code thật): `ListDevServers`, `IsDevServerConnected`,
`ListTerminalSessions`, `GetTerminalAgentStatus`, `WaitTerminalSession`,
`FocusTerminalSession`, `InspectTerminalProcess`, `ListSshTargets`,
`GetSshState`. Việc cần làm ở backend-go là **xác nhận các RPC đọc này đã
implement đầy đủ** (không chỉ có ở `infrafleet_grpc.pb.go`'s interface mà
còn có handler thật, không phải `Unimplemented*`) và **expose qua
wscompat** cho web client gọi tới — không phải thiết kế schema mới.

## 2. Read-path cần xác nhận/hoàn thiện cho CR-STORAGE-006

| Frontend slice | RPC cần | Trạng thái cần xác nhận |
|---|---|---|
| `dev-servers.ts` | `ListDevServers`, `IsDevServerConnected` | RPC đã generate; cần xác nhận handler không phải stub, và vá [BUG-013](../../../../backend-go/bugs/missing-v3/BUG-013-devserver-listforuser-team-grants-ignored.md) (team grants bị bỏ qua) trước khi coi kết quả là đầy đủ |
| `ssh.ts`/`provisioning.ts`/`runtime-environment-ssh.ts` | `ListSshTargets`, `GetSshState` | RPC đã generate; xác nhận handler thật, không phải `Unimplemented*` |
| `bootstrap.ts` | Đọc `dev_servers.bootstrap_status` (cột đã có trong schema, §5 TDD) | Cần 1 read nhỏ — có thể phủ bởi `GetDevServer`/`ListDevServers` đã có, không cần RPC riêng nếu response đã trả field này; xác nhận field có mặt trong `DevServer` message |
| `remote-agent-sessions.ts` | Đọc `dispatch_contexts`/`coordinator_runs` đang active của user | **Chưa rõ đã có RPC tổng hợp phù hợp hay chưa** — `orchestration-service`'s API sketch (§3 TDD) có `ListMessages`/`ListPendingDecisionGates` nhưng không có "list mọi dispatch context đang active của 1 user" theo đúng nghĩa registry. Nếu chưa có, thêm 1 RPC mới `ListActiveDispatchContextsForUser(user_id)` — GIỮ NGUYÊN domain model đã có (`DispatchContext`), chỉ thêm 1 read qua `assignee_handle`/`tenant_id` filter theo user |

## 3. RPC mới cho CR-STORAGE-007 — `GetFleetConnectivitySummary`

```protobuf
// infra-fleet-service — proto/orca/infrafleet/v1/infrafleet.proto, THÊM
message GetFleetConnectivitySummaryRequest {}   // tenant/user từ metadata, giống các RPC khác

message ConnectionHealthEntry {
  string connection_id = 1;
  string dev_server_id = 2;
  string status = 3;          // establishing|established|degraded|closed — mirror connections.status
  google.protobuf.Timestamp last_activity_at = 4;
  google.protobuf.Timestamp degraded_since = 5;   // rỗng nếu không ở trạng thái degraded
}

message GetFleetConnectivitySummaryResponse {
  repeated ConnectionHealthEntry connections = 1;
}
```

Cho phần dispatch/agent-session health, mở rộng response của
`ListActiveDispatchContextsForUser` (mục 2) để bao gồm luôn `status`,
`failure_count`, `last_heartbeat_at` — không cần 1 RPC health riêng cho
orchestration-service, vì `DispatchContext` (đã có field này trong domain
model, §4 orchestration-service.md) chính là dữ liệu cần trả.

**Usecase mới**: `GetFleetConnectivitySummary` (infra-fleet-service) —
join `connections` với `dev_servers` theo `tenant_id`/user đang gọi (qua
identity, không qua tham số request — cùng quy tắc bảo mật đã áp dụng
xuyên suốt, xem mục 5). Không cần bảng mới — đọc thẳng `connections` hiện
có.

## 4. wscompat — expose read-path

```go
// backend-go/services/api-gateway/internal/adapter/wscompat/channels_infra_fleet.go (MỞ RỘNG nếu đã tồn tại, hoặc MỚI)
r.Register("connectivity.getSummary", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
	resp, err := infraFleetClient.GetFleetConnectivitySummary(rpcCtx, &infrafleetv1.GetFleetConnectivitySummaryRequest{})
	// tenant/user scoping đến từ Identity, truyền qua gRPC metadata — KHÔNG qua args
	...
})

r.Register("agentSession.listActive", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
	resp, err := orchestrationClient.ListActiveDispatchContextsForUser(rpcCtx, &orchestrationv1.ListActiveDispatchContextsForUserRequest{})
	...
})
```

`devServer.*`/`ssh.*` wscompat namespace — xác nhận namespace hiện có
(nếu `frontend/src/renderer/src/runtime/runtime-rpc-client.ts` đã gọi
`devServer.listForUser` theo BUG-013, namespace này **đã tồn tại**; chỉ
cần vá bug đó, không cần namespace mới).

## 5. Bảo mật — nhất quán quy tắc đã áp dụng ở BE-SOL-STORAGE-001

`user_id`/`tenant_id` cho mọi RPC ở solution này **luôn lấy từ `Identity`
đã xác thực** (gRPC metadata phía backend-go, `Identity` phía wscompat),
**không bao giờ từ `args`/request field** — đúng quy tắc đã kiểm chứng ở
BE-SOL-STORAGE-001 và `tenant-service.md` §9. Áp dụng cho cả
`GetFleetConnectivitySummary` lẫn `ListActiveDispatchContextsForUser`.

## 6. Rủi ro / Kiểm thử cần có

| Hạng mục | Ghi chú |
|---|---|
| Xác nhận danh sách handler nào trong `infrafleet_grpc.pb.go` còn là `Unimplemented*` | Bắt buộc trước khi coi CR-STORAGE-006 "sẵn sàng" — 1 số RPC liệt kê ở mục 2 có thể vẫn là stub; audit riêng cần thiết trước khi implement (không giả định) |
| `ListActiveDispatchContextsForUser` là RPC mới | Cần xác nhận `assignee_handle` có map 1:1 về `user_id` hay không — theo domain model hiện tại `DispatchContext.assignee_handle` mô tả "which agent worker", có thể không phải user_id trực tiếp; cần review mapping trước khi viết filter theo user |
| `TestGetFleetConnectivitySummary_UserIDComesFromIdentityNotArgs` | Regression-guard bắt buộc, cùng pattern `TestClientStateChannel_...` ở BE-SOL-STORAGE-001 |
| Vá BUG-013 trước/song song | Không chặn cứng solution này nhưng **chặn** việc coi `ListDevServers` hydrate là đáng tin cậy cho user được cấp quyền qua team |
| Tải RPC tăng do frontend poll `connectivity.getSummary` (CR-007) | Thấp nếu tuân theo nhịp 30s đã có ở fleet health poll — cần benchmark nếu client base lớn |

## 7. Không thuộc phạm vi solution này

- Ngữ nghĩa reconnect-resume (`connections.status` chuyển `degraded`, giữ
  nguyên `connectionId`/`ptyId`, không trip circuit-breaker do lỗi
  transport) — xem
  [BE-SOL-STORAGE-003](./BE-SOL-STORAGE-003-connection-reconnect-resume-contract.md).
- Push/streaming health real-time — CR-STORAGE-007 chọn poll; nếu quyết
  định sau này tái dùng WS terminal control-plane, đó là 1 thiết kế bổ
  sung riêng, không nằm trong solution này.
- Thêm cột JSON per-user ở `tenant-service` — không liên quan, xem
  BE-SOL-STORAGE-001.

## Liên quan

- `backend-go/proto/gen/go/orca/infrafleet/v1/infrafleet_grpc.pb.go`
- `backend-go/services/project-service/internal/adapter/grpcclient/infra_fleet_dev_server_lister.go` (mẫu client gRPC hiện có tới infra-fleet-service)
- `specs/backend-go/tdd/services/infra-fleet-service.md`, `orchestration-service.md`
- `specs/backend-go/bugs/missing-v3/BUG-013-devserver-listforuser-team-grants-ignored.md`
- [BE-SOL-STORAGE-001](./BE-SOL-STORAGE-001-user-profile-json-columns.md) (mẫu quy tắc bảo mật identity-from-context tham chiếu)
- [BE-SOL-STORAGE-003](./BE-SOL-STORAGE-003-connection-reconnect-resume-contract.md)

## Investigation result: DispatchContext-to-user mapping (TASK-BE-STORAGE-007)

**Kết luận: KHÔNG tìm được đường liên kết rõ ràng, code-grounded, từ
`DispatchContext` (hay `OrchestrationTask`/`CoordinatorRun`) tới "user đang
gọi RPC". TASK-BE-STORAGE-007 dừng ở mức điều tra, không implement.**

### Domain thật đã đọc (không phải suy đoán từ TDD)

Đọc trực tiếp `backend-go/services/orchestration-service/internal/domain/orchestration.go`
và migration thật `backend-go/services/orchestration-service/migrations/0001_init.up.sql`
(khớp 1:1, không có schema drift so với TDD §5):

- `DispatchContext` struct (dòng 149-166): `ID`, `TenantID`,
  `OrchestrationTaskID`, `Handle`, `CoordinatorRunID`, `Status`,
  `FailureCount`, `LastFailure`, `DispatchedAt`, `CompletedAt`,
  `LastHeartbeatAt`, `CreatedAt`. **Không có `assignee_handle` tên field —
  tên thật trong Go domain là `Handle`.** Trong generated proto
  (`orchestration.pb.go`), field này mang comment nguồn:
  `Handle string ... // KeyedAsyncQueue serialization key`. TDD §6 xác nhận
  cùng ngữ nghĩa: `Handle` là key dùng để serialize các thao tác qua
  `HandleSerializer`/keyed-worker (tương đương `KeyedAsyncQueue` của TS) —
  **đây là định danh terminal-pane/agent-worker, không mã hoá user identity
  ở bất kỳ dạng nào.** Nhiều dispatch context của nhiều user khác nhau có
  thể dùng chung một handle (terminal đó có thể được tái sử dụng qua nhiều
  lượt dispatch của nhiều task/coordinator run khác nhau).
- `OrchestrationTask` struct (dòng 63-76): `ID`, `TenantID`,
  `CoordinatorRunID`, `ParentID`, `OriginTaskID` (comment: "logical FK ->
  task-service.Task.id, root row only"), `TaskTitle`, `Spec`, `Status`,
  `Deps`, `Result`, `CreatedAt`, `CompletedAt`. Không có `ProjectID`,
  không có `UserID`/`CreatedByUserID`/`RequestedBy`.
- `CoordinatorRun` struct (dòng 287-297): `ID`, `TenantID`, `OriginTaskID`
  (logical FK -> task-service.Task.id, **luôn set**, không phải "root
  only"), `Spec`, `Status`, `CoordinatorHandle`, `PollIntervalMs`,
  `CreatedAt`, `CompletedAt`. Cũng không có `ProjectID`/`UserID`.
- Migration thật (`0001_init.up.sql`) xác nhận không có cột
  `project_id`/`user_id`/`created_by`/`requested_by` trên bất kỳ bảng nào
  trong schema `orchestration` (`coordinator_runs`, `orchestration_tasks`,
  `dispatch_contexts`, `decision_gates`, `messages`) — chỉ có `tenant_id`
  (RLS-enforced) và logical FK dạng chuỗi opaque `origin_task_id` trỏ sang
  id space của `task-service` (không có SQL FK xuyên database, per
  §2.1 orchestration-service.md).
- `grep -rn "requested_by|created_by|project_id|user_id|ProjectID|RequestedBy|CreatedBy"` trên toàn bộ
  `backend-go/services/orchestration-service` (trừ test) — **0 kết quả**.

### Vì sao "qua tenant_id + project_id" (gợi ý trong task) không khả thi trong scope hiện tại

Đường duy nhất về lý thuyết có thể nối một `DispatchContext` tới "user" là:

```
DispatchContext.OrchestrationTaskID
  -> OrchestrationTask (cần leo ParentID lên tới DAG root vì OriginTaskID
     chỉ set ở root row)
  -> OrchestrationTask.OriginTaskID (task-service task id, string đối lập
     id space, không resolve được tại chỗ)
  -> gọi sang task-service để lấy project_id của task đó
  -> gọi kiểm tra user hiện tại có phải thành viên project đó không
     (project-service/task-service membership check)
```

Điều này đòi hỏi: (1) thêm gRPC client mới tới `task-service` (và có thể
`project-service`) vào `orchestration-service` — hiện `orchestration-service`
chỉ gọi ra `infra-fleet-service` (resolve `connectionId`) và `task-service`
(report kết quả run, theo §7 TDD) chứ chưa có client đọc project
membership; (2) logic leo cây `ParentID` để tìm root `OrchestrationTask`
mỗi dispatch context (không có sẵn 1 query nào làm việc này); (3) một
quyết định kiến trúc mới về nơi thực hiện project-membership check (giống
`ResolveDecisionGate`'s "OPA policy" ở §9 TDD, nhưng đó là cho 1 write RPC
đơn lẻ theo 1 `dispatch_context_id`/`task_id` đã biết, không phải để lọc
toàn bộ danh sách theo user). Đây là một thay đổi kiến trúc rộng hơn nhiều
so với "thêm 1 query mới trong `dispatch_context_repository.go`" — vượt
quá phạm vi file đã liệt kê ở TASK-BE-STORAGE-007, và ngay cả khi làm,
kết quả sẽ là "mọi dispatch context có project mà user là thành viên", một
ngữ nghĩa **membership-scoped**, không phải per-user ownership như tên RPC
(`ListActiveDispatchContextsForUser`) ngụ ý.

### Vì sao không lọc "cho chạy được" bằng field hiện có (đã cân nhắc và loại bỏ)

- **Lọc theo `Handle`/`assignee_handle` == user id**: sai — đã xác nhận
  `Handle` là terminal/worker serialization key, không phải user identity.
  Đoán nó là user_id sẽ vừa sai về ngữ nghĩa vừa có thể rò dữ liệu (2 user
  share terminal cùng handle) hoặc mất dữ liệu (user thật không match được
  handle nào).
- **Lọc chỉ theo `tenant_id` (bỏ qua "user")**: không đáp ứng yêu cầu của
  RPC ("của 1 user") — trả về **toàn bộ** dispatch context của mọi user
  trong tenant, là một lỗ hổng phân quyền thật sự (một user thấy được
  agent-session của user khác cùng tenant), không phải một xấp xỉ chấp
  nhận được.

### Đề xuất hướng đi (không thuộc phạm vi task này — cần quyết định
sản phẩm/kiến trúc trước khi có task mới)

1. Thêm cột thật (`orchestration_tasks.project_id` hoặc
   `coordinator_runs.project_id`/`requested_by_user_id`) — set tại thời
   điểm `StartCoordinatorRun`/`CreateDispatchContext`, nơi caller
   (`task-service`, đã biết `project_id`/`user_id` của task gốc) chuyển
   giao trực tiếp. Đây là thay đổi migration + domain + toàn bộ usecase
   ghi (`CreateDispatchContext`, `UpdateTaskStatusAndPromote`, v.v.) — lớn
   hơn nhiều so với "thêm 1 RPC đọc".
2. Hoặc chấp nhận ngữ nghĩa "membership-scoped" (không phải "created by
   this user") và tường minh hoá nó trong tên RPC/response — vẫn cần
   client mới sang task-service để resolve `project_id` từ `origin_task_id`
   theo mỗi `coordinator_run`, cộng logic leo `ParentID`.

Cả 2 hướng đều cần quyết định kiến trúc + review, không phải việc "viết 1
filter" — đúng như rủi ro BE-SOL-STORAGE-002 §6 đã cảnh báo trước.

## Audit results (TASK-BE-STORAGE-005)

Đọc trực tiếp `backend-go/services/infra-fleet-service/internal/adapter/grpc/server.go`
và các usecase tương ứng (không giả định) — kết quả:

| RPC | Trạng thái | Bằng chứng (file:line) |
|---|---|---|
| `ListDevServers` | ✅ handler thật | `server.go:218-228` gọi `s.listDevServers.Execute(ctx, ...)` → `usecase/list_dev_servers.go:28` đọc `DevServerRepository.List` từ Postgres, scope theo `tenant.RequireTenantID(ctx)` |
| `IsDevServerConnected` | ✅ handler thật | `server.go:438-444` gọi `s.isDevServerConnected.Execute(ctx, req.GetDevServerId())` → `usecase/is_dev_server_connected.go` |
| `ListTerminalSessions` | ✅ handler thật | `server.go:749-759` gọi `s.listTerminalSessions.Execute(...)` → `usecase/list_terminal_sessions.go` |
| `GetTerminalAgentStatus` | ✅ handler thật | `server.go:776-786` gọi `s.getTerminalAgentStatus.Execute(ctx, req.GetPtyId())` → `usecase/get_terminal_agent_status.go` |
| `ListSshTargets` | ✅ handler thật | `server.go:481` gọi usecase `ListSshTargets.Execute(ctx)` → `usecase/list_ssh_targets.go:21-26` đọc `SshTargetRepository.List`, scope theo tenant |
| `GetSshState` | ✅ handler thật | `server.go:495` gọi usecase `GetSshState.Execute(ctx, ...)` → `usecase/get_ssh_state.go:35-49`, đọc `DevServerRepository.FindBySshTarget` + `ConnectionRepository.GetActiveByDevServer`, không dial ra ngoài (doc comment "🏠 always-local") |

**Kết luận chung**: cả 6 RPC trong danh sách audit đều là handler thật, không
RPC nào là `Unimplemented*`/stub. Không cần tạo task con
`TASK-BE-STORAGE-005b-implement-<rpc-name>`.

**`DevServer` proto message có `bootstrap_status` không?** ❌ Không.
`proto/orca/infrafleet/v1/infrafleet.proto:211-233`'s `DevServer` message chỉ có:
`id, tenant_id, host, mode, ssh_target_id, approval_status, group_id, kind`
— không có field bootstrap/health status nào. Đối chiếu với DB: cột
health/bootstrap status (`pending|healthy|degraded|unhealthy`) tồn tại thật
trong `infra.dev_servers.status` (thêm bởi migration 0007, xem
`migrations/0007_dev_server_health_status.up.sql`'s header comment và
`migrations/0008_dev_server_approval_status_and_groups.up.sql`'s comment xác
nhận "infra.dev_servers already has a `status` column ... health/bootstrap
status"), nhưng **không** được map vào `domain.DevServer` struct
(`internal/domain/dev_server.go:92-116`, doc comment tự nhận "bootstrap
status, agent version are not modeled here") và do đó cũng không xuất hiện
trong `toProtoDevServer` (`server.go:631-642`). Vì vậy `bootstrap.ts`'s
hydrate (FE-TASK-STORAGE-013) **không thể** dùng ngay
`ListDevServers`/`GetDevServer` để đọc bootstrap status hôm nay — cần một
task riêng để (a) map cột `status` DB vào `domain.DevServer`, và (b) thêm
field `bootstrap_status` vào proto message + `toProtoDevServer`, trước khi
coi mục 2's dòng "bootstrap.ts" trong bảng trên là xong. Đây KHÔNG nằm
trong scope TASK-BE-STORAGE-006/009, ghi nhận lại làm gap cần task mới.

**BUG-013 (`devServer.listForUser` bỏ qua team grants)**: đối chiếu
`specs/backend-go/bugs/missing-v3/BUG-013-devserver-listforuser-team-grants-ignored.md` —
**Status: PARTIAL, còn mở** (không phải fixed). Root cause vẫn còn:
`channels_dev_server_access_control.go`'s `devServer.listForUser` handler
chỉ build `ListDevServersForUserRequest{DepartmentId: departmentID}`,
`TeamIds` luôn rỗng vì `tenant-service` chưa có RPC "list teams for user".
Đây là **blocker đã xác nhận** cho việc coi `ListDevServers`/
`devServer.listForUser` là nguồn tin cậy hoàn toàn cho user được cấp quyền
qua team (chỉ đáng tin cho user được cấp quyền trực tiếp/qua department) —
đúng như cảnh báo ở mục 6 phía trên.
