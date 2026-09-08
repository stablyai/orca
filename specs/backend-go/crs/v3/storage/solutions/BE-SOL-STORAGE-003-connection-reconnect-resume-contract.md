# BE-SOL-STORAGE-003: Hợp đồng reconnect-resume cho `connections`/`terminal_sessions`/`dispatch_contexts`

> **🔲 Designed — chưa implement.** Đây là thiết kế **ngữ nghĩa**
> (state machine + quy tắc phân loại lỗi), không phải migration mới — cả 3
> bảng liên quan (`connections`, `terminal_sessions`, `dispatch_contexts`)
> đã tồn tại đúng shape cần thiết (`infra-fleet-service.md` §5,
> `orchestration-service.md` §5). Phần khó của solution này là **quy tắc
> chuyển trạng thái**, không phải schema.

**CR:** [CR-STORAGE-008](../../../../../../docs/crs/v3/storage/CR-STORAGE-008-reconnect-resume-semantics.md) (phần b)
**Service:** `infra-fleet-service` (connection/terminal-session state machine) + `orchestration-service` (dispatch failure classification)
**Frontend counterpart:** [FE-SOL-STORAGE-007](../../../../frontend/crs/v3/storage/solutions/FE-SOL-STORAGE-007-reconnect-preserves-session-state.md)
**TDD tham chiếu:** [`infra-fleet-service.md`](../../../../tdd/services/infra-fleet-service.md) §4, §8

---

## 1. Vấn đề cốt lõi: `infra-fleet-service.md` §8 tự nhận đây là câu hỏi mở

> "`relay-websocket` mode (agent dials in) requires session affinity or
> connection handoff — flag this as an open design question for the Go
> rewrite's implementation phase, not resolved by this doc."

Solution này **không** giải quyết bài toán hạ tầng đó (pod nào giữ
transport sống khi service scale ngang) — đó vẫn là 1 quyết định triển
khai riêng, cần review kiến trúc (sticky session / connection handoff qua
load balancer, hoặc 1 registry trung tâm ánh xạ `connectionId → pod`).
Solution này chỉ định nghĩa: **giả sử** hạ tầng transport-level được giải
quyết (agent thực sự kết nối lại được tới đúng backend-go instance hoặc
được route lại đúng), thì **state machine ứng dụng** phải xử lý ra sao để
không orphan công việc đang chạy.

## 2. State machine `connections.status` — thêm quy tắc chuyển trạng thái tường minh

Domain hiện tại (`infra-fleet-service.md` §4/§5) đã có đủ 4 trạng thái —
solution này định nghĩa **cạnh chuyển (transition)** nào được phép, điều
chưa có trong tài liệu gốc:

```
establishing -> established   : handshake/agent.handshake thành công
established  -> degraded      : mất heartbeat/keep-alive quá 1 ngưỡng ngắn (giây),
                                 KHÔNG phải do lệnh đóng chủ động
degraded     -> established   : agent kết nối lại trong grace-period,
                                 TÁI SỬ DỤNG connectionId hiện có (không tạo mới)
degraded     -> closed        : hết grace-period mà không reconnect được
established  -> closed        : đóng chủ động (logout đã xác nhận — CR-008a,
                                 hoặc người dùng tắt dev server thủ công)
```

**Trường mới trên `connections`** (bảng đã có, thêm cột, additive):

```sql
ALTER TABLE connections
  ADD COLUMN degraded_since   TIMESTAMPTZ NULL,
  ADD COLUMN grace_period_seconds INTEGER NOT NULL DEFAULT 300;
  -- 300s mặc định — KHÔNG copy nguyên relayGracePeriodSeconds=86400s của
  -- TS's SshTarget (đó là "cửa sổ giữ token/relay auth", ngữ nghĩa khác
  -- với "cửa sổ chờ reconnect trước khi coi hẳn là mất kết nối"); giá trị
  -- cụ thể cần review sản phẩm riêng, 300s chỉ là điểm khởi đầu hợp lý
  -- cho 1 network blip, không phải quyết định cuối cùng.
```

`ResolveConnection`/health-poll logic (usecase đã có, `infra-fleet-service.md`
§7) thêm 1 nhánh: khi phát hiện mất heartbeat, set `status='degraded'`,
`degraded_since=now()` — **không** xoá `connectionId` khỏi
`provider_registry_entries`/`terminal_sessions`. Một job định kỳ (hoặc
kiểm tra lazy khi có request tới `connectionId` đó) chuyển `degraded ->
closed` khi `now() - degraded_since > grace_period_seconds`.

## 3. `terminal_sessions` — không đóng khi `degraded`

```sql
-- KHÔNG thêm cột — chỉ thêm quy tắc ứng dụng:
-- terminal_sessions.closed_at chỉ được set khi:
--   (a) KillTerminalSession được gọi tường minh, HOẶC
--   (b) connections.status chuyển sang 'closed' (kể cả do hết grace-period
--       hoặc do đóng chủ động)
-- KHÔNG set closed_at chỉ vì connections.status = 'degraded'.
```

`WaitTerminalSession`/`FocusTerminalSession` (đã generate trong
`infrafleet_grpc.pb.go`) là đúng 2 RPC client cần gọi lại sau khi
`connections.status` quay về `established` — client dùng `ptyId` đã lưu
lại từ trước (phía frontend, theo FE-SOL-STORAGE-007) để reattach, không
cần backend-go trả `ptyId` mới.

## 4. `dispatch_contexts` — phân loại lỗi transport vs. lỗi dispatch thật

`FailDispatch` usecase (đã có, `orchestration-service.md` §3/§8) hiện được
gọi khi 1 dispatch thất bại — solution này yêu cầu **caller** của
`FailDispatch` phân biệt nguồn gốc lỗi trước khi gọi:

| Nguồn lỗi | Hành động |
|---|---|
| `connections.status` chuyển `degraded` (transport) trong lúc có 1 `DispatchContext.status = 'dispatched'` gắn với `connectionId` đó | **KHÔNG** gọi `FailDispatch` — để nguyên `dispatched`, chờ `degraded -> established` (mục 2). Nếu `degraded -> closed` (hết grace-period), LÚC ĐÓ mới gọi `FailDispatch` — đây là lỗi thật (không reconnect được), không phải lỗi tạm thời |
| Agent trả lỗi thực thi (exit code khác 0, exception trong quá trình chạy task) trong khi `connections.status = established` | Gọi `FailDispatch` ngay — đây là lỗi dispatch thật, đúng hành vi hiện tại |
| Agent timeout dù `connections.status = established` (agent còn kết nối nhưng không phản hồi RPC cụ thể) | Gọi `FailDispatch` — đây KHÔNG phải lỗi transport (transport vẫn `established`), nên tính là lỗi dispatch |

**Không đổi** ngưỡng `failure_count >= 3 -> circuit_broken` đã có — chỉ
đổi **cái gì được tính là 1 failure**.

## 5. Đóng chủ động (logout đã xác nhận) — bỏ qua toàn bộ grace-period

Khi frontend gọi `closeAllActiveSessions()` (FE-SOL-STORAGE-007, sau khi
người dùng xác nhận logout), backend-go nhận 1 lệnh đóng tường minh
(RPC `TeardownConnection` đã có trong API surface, §3 TDD) — chuyển thẳng
`established|degraded -> closed`, đóng toàn bộ `terminal_sessions` liên
quan ngay lập tức, **bỏ qua** `grace_period_seconds`. Đây là điểm khác biệt
duy nhất so với mất-kết-nối-ngoài-ý-muốn.

## 6. Rủi ro / Kiểm thử cần có

| Hạng mục | Ghi chú |
|---|---|
| Session affinity/connection handoff hạ tầng (relay-websocket, nhiều pod) | **Chưa giải quyết** — điều kiện tiên quyết thực tế trước khi state machine ở trên có ý nghĩa khi service chạy nhiều replica; cần 1 thiết kế riêng (xem mục 1) |
| `TestDegradedConnectionDoesNotTripCircuitBreaker` | Test bắt buộc — mô phỏng `degraded` rồi `established` lại trong grace-period, xác nhận `dispatch_contexts.failure_count` không tăng |
| `TestGracePeriodExpiryClosesConnectionAndFailsDispatch` | Test bắt buộc — mô phỏng hết grace-period, xác nhận `connections.status=closed`, `terminal_sessions` đóng, VÀ `FailDispatch` được gọi đúng 1 lần (không double-fail) |
| `TestExplicitTeardownBypassesGracePeriod` | Test bắt buộc — `TeardownConnection` (logout) phải đóng ngay, không chờ `grace_period_seconds` |
| Giá trị `grace_period_seconds` mặc định (300s) | Cần review sản phẩm — quá ngắn thì network blip bình thường cũng bị coi là mất hẳn; quá dài thì tài nguyên (PTY, dispatch pending) bị giữ lâu vô ích |
| Race giữa health-poll (chuyển `degraded`) và 1 request đang xử lý dở trên `connectionId` đó | Trung bình — cần xác nhận `ResolveConnection`/in-process cache (Provider Registry, §7 TDD) không trả kết quả stale ngay sau khi status đổi; có thể cần invalidate cache đồng thời với đổi status trong cùng 1 transaction/lock |

## 7. Không thuộc phạm vi solution này

- Thiết kế hạ tầng session affinity/connection handoff cho
  `relay-websocket` khi service chạy nhiều pod — vẫn là câu hỏi mở, chỉ
  ghi nhận lại, không giải quyết ở đây.
- Read-path hydrate và RPC health tổng hợp — xem
  [BE-SOL-STORAGE-002](./BE-SOL-STORAGE-002-dev-server-agent-hydration-and-health.md).
- Đổi giao thức wire agent↔backend-go — không đụng, giữ nguyên Option A
  (`infra-fleet-service.md` §10).

## Liên quan

- `specs/backend-go/tdd/services/infra-fleet-service.md` §4, §5, §7, §8, §10
- `specs/backend-go/tdd/services/orchestration-service.md` §4, §8

## Investigation result: TASK-BE-STORAGE-011 signal for `ClassifyDispatchFailure`

**Bối cảnh:** trước khi viết `ClassifyDispatchFailure`, task yêu cầu xác
nhận `orchestration-service` có cách nào biết `connections.status` của
infra-fleet-service hôm nay không, và tìm ra caller thật của
`FailDispatch` để sửa. Điều tra bằng code thật + `gitnexus impact()`
(không đoán):

1. **Không có gRPC client nào từ `orchestration-service` sang
   `infra-fleet-service`.** `grep -rln "infrafleet" backend-go/services/orchestration-service`
   trả về **0 kết quả**. Không có field/port nào kiểu
   `project-service`'s `infra_fleet_dev_server_lister.go`. Domain type
   `domain.ConnectionStatus` mà task's pseudocode giả định — **không tồn
   tại trong `orchestration-service`**; đó là type nội bộ của
   `infra-fleet-service` (`internal/domain/connection.go`'s
   `ConnectionStatusEstablishing/Established/Degraded/Closed`, xem
   TASK-BE-STORAGE-009), không import được từ service khác (không có
   shared package, không có gRPC surface expose status này).

2. **`FailDispatch` không tồn tại trong code — ở bất kỳ hình thức nào.**
   - `grep -rn "FailDispatch" backend-go/` (toàn repo, mọi `.go`) chỉ trả
     về 3 dòng, cả 3 đều là **comment** trong
     `infra-fleet-service`'s `connection.go`/`poll_fleet_health*.go` nhắc
     tới `FailDispatch` như 1 khái niệm ở service khác — không có định
     nghĩa hàm/RPC nào.
   - `orchestration-service`'s proto thật
     (`backend-go/proto/orca/orchestration/v1/orchestration.proto`) không
     có `rpc FailDispatch` — chỉ có `CreateDispatchContext`, `CreateGate`,
     `ResolveGate`, `UpdateTaskStatusAndPromote`,
     `GetDispatchContextForTask`. `FailDispatchRequest`/`FailDispatch` RPC
     ở TDD §3's sketch **chưa được generate**.
   - `orchestration-service/README.md`'s "Known gaps" đã tự ghi nhận điều
     này từ trước: *"`FailCoordinatorRun`, `RecordHeartbeat`,
     `FailDispatch`, ... from the design doc §3 sketch are **not** in the
     generated proto, so no RPC/usecase exists for them."*
   - `domain.DispatchContext.RecordFailure` (method thuần, gần nhất với
     ngữ nghĩa "fail 1 dispatch") tồn tại nhưng
     `gitnexus impact({target:"RecordFailure", direction:"upstream"})` trả
     về `impactedCount: 0` — **không ai gọi nó**, kể cả trong test
     ngoài `orchestration_test.go` của chính domain đó.
   - `gitnexus impact({target:"FailDispatch", direction:"upstream"})` trả
     về `"error": "Target 'FailDispatch' not found"` — xác nhận bằng
     công cụ độc lập với `grep`, không chỉ đọc bằng mắt.

   ⇒ **Không có "caller thật của `FailDispatch`" để sửa** — vì bản thân
   `FailDispatch` là 1 khoảng trống đã biết trước (README), không phải
   thứ task này giấu đi. Việc TASK-BE-STORAGE-011 yêu cầu "sửa caller
   thật" giả định 1 tiền đề sai; tự tạo mới `FailDispatch`
   usecase/RPC/wiring 1 dispatcher-loop để có chỗ gọi
   `ClassifyDispatchFailure` là mở rộng phạm vi rất lớn ngoài 3 file được
   liệt kê trong task, không làm ở đây.

3. **`RelayResponse` (RPC hiện có `orchestration-service` sẽ dùng để tới
   agent qua `infra-fleet-service`) không mang tín hiệu phân loại nào** —
   `infrafleet.pb.go`'s `RelayResponse` chỉ có `result_json`, không có
   trường "connection state"/"error kind". Khảo sát mọi caller thật hiện
   có của `Relay`/`RelayByDevServer` trong repo (`project-service`,
   `git-gateway-service`, `task-service`, `workflow-service`,
   `ai-provider-service`, `api-gateway`) — **không nơi nào** phân loại lỗi
   trả về theo mã gRPC status để suy ra "transport down" — tất cả chỉ
   check `err != nil` chung chung. Không có tiền lệ nào trong codebase để
   dựa vào.

**Kết luận:** không có tín hiệu thật, đáng tin cậy nào để phân biệt
transport-degraded/-closed (theo `connections.status`) hôm nay, và không
có call site thật nào để gắn phân loại đó vào. Theo đúng nhánh dự phòng
đã được chỉ định trước khi bắt đầu code: `ClassifyDispatchFailure(err
error) FailureOrigin` được implement dựa trên **mã gRPC chuẩn, luôn sẵn
có** — `codes.Unavailable`/`codes.DeadlineExceeded`
(qua `status.FromError`) và `context.DeadlineExceeded` (qua `errors.Is`)
⇒ `FailureOriginTransport`; mọi lỗi khác ⇒ `FailureOriginDispatchReal`.
Đây là bản rút gọn có chủ đích, không phải đoán — chấp nhận đánh đổi đã
ghi trong code comment (gộp "degraded" và "closed" thành 1 nhóm, và không
tách được §4 dòng 3's "agent timeout dù established" khỏi transport thật
sự mất kết nối) cho tới khi có 1 thiết kế riêng cho cross-service
connection-status lookup (ngoài phạm vi task này).

Xem chi tiết implementation + investigation note đầy đủ trong
`backend-go/services/orchestration-service/internal/usecase/classify_dispatch_failure.go`
và trạng thái cập nhật của
[TASK-BE-STORAGE-011](../tasks/TASK-BE-STORAGE-011-dispatch-failure-classification.md).
- `backend-go/proto/gen/go/orca/infrafleet/v1/infrafleet_grpc.pb.go` (`WaitTerminalSession`, `FocusTerminalSession`, `TeardownConnection` đã generate)
- [BE-SOL-STORAGE-002](./BE-SOL-STORAGE-002-dev-server-agent-hydration-and-health.md)
