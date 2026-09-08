# CR-STORAGE-006 — Tập trung hoá trạng thái dev-server/agent vào backend-go đã có sẵn (`infra-fleet-service`, `orchestration-service`)

| Trường | Giá trị |
|--------|---------|
| **CR ID** | CR-STORAGE-006 |
| **Tên** | Frontend hydrate trạng thái dev-server/agent-session từ `infra-fleet-service`/`orchestration-service` thay vì tự giữ reducer in-memory |
| **Loại** | Architectural Change |
| **Priority** | P0 — dữ liệu vận hành agent, không phải chỉ preference cá nhân |
| **Phiên bản** | v1.0 |
| **Ngày tạo** | 2026-09-07 |
| **Trạng thái** | 🔲 Proposed — chưa triển khai |
| **Tác giả** | Yêu cầu user: "mọi thông tin tác động đến agent phải được lưu tập trung ở backend-go" |
| **Tác động HLD** | `infra-fleet-service`, `orchestration-service`, frontend store (`dev-servers.ts`, `remote-agent-sessions.ts`, `bootstrap.ts`, `ssh.ts`, `provisioning.ts`, `runtime-environment-ssh.ts`) |
| **Tác động Features** | Dev server picker, Accounts (Claude/Codex) dev-server routing, terminal/agent session list, SSH fleet health |

---

## Bối cảnh & Vấn đề gốc

Theo đánh giá tác động
[`specs/frontend/storage/dev-server-agent-impact.md`](../../../../specs/frontend/storage/dev-server-agent-impact.md),
6 slice sau trong `frontend/src/renderer/src/store/slices/` **không có bất kỳ
lời gọi persistence nào** (`feature-persistence-matrix.md`), và đều là dữ
liệu trực tiếp quyết định agent chạy được hay không:

| Slice | Nội dung | Ghi chú tác động agent |
|---|---|---|
| `dev-servers.ts` | Danh sách/trạng thái dev server | "Pure reducer, populated externally" — không có nguồn phục hồi khi rebuild |
| `remote-agent-sessions.ts` | Session agent từ xa (`agentOrchestration` IPC) | Đây **chính là** registry sống của agent đang chạy — mất khi refresh |
| `bootstrap.ts` | Tiến trình bootstrap từng dev server (CR-004 automation) | Refresh giữa chừng làm mất tiến trình, phải chạy lại từ đầu |
| `ssh.ts` | SSH fleet import/health/credential-request | Không persist |
| `provisioning.ts` | Tiến trình provisioning SSH fleet hàng loạt | Không persist |
| `runtime-environment-ssh.ts` | Trạng thái kết nối SSH runtime-environment | Không persist |

**Điểm khác biệt quan trọng với CR-STORAGE-001/003/004**: những CR đó thêm
**cột JSON mới** vào `tenant-service` cho dữ liệu **chưa từng có nơi lưu ở
backend-go** (preference cá nhân, tab/layout browser-local). Nhóm dữ liệu ở
CR này thì **NGƯỢC LẠI — đã có chủ sở hữu backend-go thật, đã chạy**:

- `infra-fleet-service` (xác nhận qua
  `specs/backend-go/tdd/services/infra-fleet-service.md` §3-5 VÀ qua code
  gRPC **đã generate thật**,
  `backend-go/proto/gen/go/orca/infrafleet/v1/infrafleet_grpc.pb.go`) sở hữu
  bảng `dev_servers`, `connections`, `terminal_sessions`, `ssh_targets`,
  `fleet_health_samples`, với RPC đã tồn tại: `ListDevServers`,
  `IsDevServerConnected`, `EstablishConnection`, `ListTerminalSessions`,
  `GetTerminalAgentStatus`, `ListSshTargets`, `GetSshState`,
  `WaitTerminalSession`, `FocusTerminalSession`, `InspectTerminalProcess`.
- `orchestration-service` (`specs/backend-go/tdd/services/orchestration-service.md`
  §3-5) sở hữu `coordinator_runs`, `orchestration_tasks`,
  `dispatch_contexts` (agent nào đang chạy task nào, `last_heartbeat_at`,
  `failure_count`), `messages` — đây **chính là** dữ liệu tương đương
  `remote-agent-sessions.ts` phía frontend, nhưng đã là **system of record**
  ở backend-go.

Vấn đề không phải "chưa có chỗ lưu" — mà là **frontend không đọc lại từ nơi
đã lưu này khi khởi động/refresh**, nên hành xử như thể dữ liệu chỉ tồn tại
tạm thời trong tiến trình renderer. Cũng ghi nhận: `BUG-013`
(`specs/backend-go/bugs/missing-v3/BUG-013-devserver-listforuser-team-grants-ignored.md`)
— `devServer.listForUser` hiện **âm thầm bỏ qua** quyền truy cập theo team —
là một lỗ hổng cần vá song song, nếu không danh sách dev server hydrate về
từ CR này vẫn thiếu cho user được cấp quyền qua team.

## Giải pháp đề xuất

### 1. `dev-servers.ts` — hydrate từ `ListDevServers`/`IsDevServerConnected` khi load, không chỉ "populated externally"

Thêm 1 action `hydrateDevServers()` gọi RPC đã có (không cần RPC mới), chạy
ở App startup và sau khi reconnect (xem CR-STORAGE-008). Backend-go trở
thành **nguồn thật duy nhất** — reducer chỉ còn là cache hiển thị.

### 2. `remote-agent-sessions.ts` — đọc từ `orchestration-service` thay vì chỉ nghe IPC event

`orchestration_tasks`/`dispatch_contexts`/`coordinator_runs` đã là đúng
"registry" cần thiết. Thêm 1 read-path (`ListMessages`/1 RPC tổng hợp mới
nếu chưa có sẵn — cần xác nhận khi implement, xem BE-SOL tương ứng) để
slice này **hydrate lại danh sách agent-session đang chạy** khi mở lại
app/tab, thay vì coi mất kết nối IPC = mất luôn session.

### 3. `bootstrap.ts` — dùng `dev_servers.bootstrap_status` (đã có cột) làm nguồn thật

Cột `bootstrap_status` đã tồn tại trong schema `dev_servers`
(`infra-fleet-service.md` §5) và `BootstrapFleetTarget` đã là 1 RPC
streaming. Thay vì tự giữ tiến trình bootstrap chỉ trong store, đọc lại
`bootstrap_status` khi mount lại UI — 1 refresh giữa chừng bootstrap vẫn
hiển thị đúng bước đang dừng, không phải chạy lại từ đầu.

### 4. `ssh.ts`/`provisioning.ts`/`runtime-environment-ssh.ts` — hydrate từ `ListSshTargets`/`GetSshState`/`fleet_health_samples`

Cùng pattern: các RPC/bảng đã tồn tại, chỉ thiếu bước đọc lại khi
mount/refresh phía frontend.

### 5. Vá `BUG-013` như điều kiện tiên quyết cho phần dev-server list

Không bắt buộc phải xong trước khi bắt đầu CR này, nhưng **phải xong trước
khi coi hydrate là đáng tin cậy cho user được cấp quyền qua team** — ghi rõ
là dependency mềm.

## Rủi ro / Phụ thuộc

| Hạng mục | Rủi ro | Ghi chú |
|---|---|---|
| Một số read-path cần ở `orchestration-service` có thể chưa có RPC tổng hợp phù hợp (chỉ có `ListMessages`/theo `coordinator_run_id`, chưa chắc có "list mọi dispatch context đang active của user") | Trung bình | Cần xác nhận khi implement (xem BE-SOL) — có thể cần 1 RPC đọc mới, nhưng đây là bổ sung read-path, không phải kiến trúc lưu trữ mới |
| `BUG-013` chưa vá | Trung bình | Danh sách dev server hydrate về có thể thiếu server được cấp qua team cho tới khi bug này được xử lý |
| Tải hydrate đồng loạt khi nhiều client cùng mở lại (spike RPC) | Thấp | `infra-fleet-service`'s connection pool đã thiết kế cho tải này (§8 TDD); không kỳ vọng vấn đề mới |

## Không thuộc phạm vi CR này

- Cơ chế báo lỗi/health hai chiều khi hydrate thất bại hoặc kết nối rớt —
  xem [CR-STORAGE-007](./CR-STORAGE-007-bidirectional-error-health-reporting.md).
- Ngữ nghĩa "reconnect thì tiếp tục công việc cũ" (giữ nguyên `connectionId`/
  `ptyId`/không trip circuit-breaker do mất kết nối tạm thời) — xem
  [CR-STORAGE-008](./CR-STORAGE-008-reconnect-resume-semantics.md).
- Thêm cột JSON mới ở `tenant-service` — không liên quan, xem
  CR-STORAGE-001/003/004 (đó là dữ liệu preference cá nhân, không phải
  agent/dev-server operational state).

## Liên quan

- `specs/frontend/storage/dev-server-agent-impact.md` (nguồn đánh giá tác động)
- `specs/backend-go/tdd/services/infra-fleet-service.md`
- `specs/backend-go/tdd/services/orchestration-service.md`
- `specs/backend-go/bugs/missing-v3/BUG-013-devserver-listforuser-team-grants-ignored.md`
- `backend-go/proto/gen/go/orca/infrafleet/v1/infrafleet_grpc.pb.go`
- `frontend/src/renderer/src/store/slices/dev-servers.ts`,
  `remote-agent-sessions.ts`, `bootstrap.ts`, `ssh.ts`, `provisioning.ts`,
  `runtime-environment-ssh.ts`
- [CR-STORAGE-007](./CR-STORAGE-007-bidirectional-error-health-reporting.md), [CR-STORAGE-008](./CR-STORAGE-008-reconnect-resume-semantics.md)
