# CR-STORAGE-007 — Cơ chế báo lỗi/health hai chiều: frontend↔backend-go và backend-go↔agent

| Trường | Giá trị |
|--------|---------|
| **CR ID** | CR-STORAGE-007 |
| **Tên** | 1 kênh trạng thái đồng bộ/lỗi dùng chung, áp dụng cho cả preference sync (CR-001/003/004) lẫn dev-server/agent connectivity (CR-006) |
| **Loại** | Architectural Change / Reliability |
| **Priority** | P0 |
| **Phiên bản** | v1.0 |
| **Ngày tạo** | 2026-09-07 |
| **Trạng thái** | 🔲 Proposed — chưa triển khai |
| **Tác giả** | Yêu cầu user: "có các cơ chế báo lỗi qua lại giữa frontend với backend và backend với agent để đảm bảo dữ liệu được cập nhật đầy đủ và thông suốt" |
| **Tác động HLD** | `infra-fleet-service`, `orchestration-service`, `api-gateway` (wscompat), frontend store (`persistence-status.ts` từ CR-002) |
| **Tác động Features** | Mọi tính năng ghi dữ liệu qua RPC (settings/ui/session/keybindings) + dev-server/agent connectivity |

---

## Bối cảnh & Vấn đề gốc

Hai lớp lỗi/health khác nhau, hiện **đều thiếu đường báo lại rõ ràng cho
người dùng**:

### (a) Frontend↔backend-go: lỗi ghi bị nuốt âm thầm

Đã ghi nhận ở [CR-STORAGE-002](./CR-STORAGE-002-zustand-persist-middleware-backend-go.md):
`ui.set` trên web **nuốt lỗi RPC âm thầm**
(`web-preload-api.ts:2672-2674` — "a failure is silently swallowed").
CR-002 đã đề xuất 1 `persistence-status.ts` slice cho riêng preference sync —
CR này **mở rộng cùng cơ chế đó** để dùng chung cho cả dữ liệu
dev-server/agent (CR-006), thay vì làm 2 hệ thống báo lỗi riêng biệt.

### (b) Backend-go↔agent: tín hiệu health/lỗi đã tồn tại nhưng không lên tới frontend

Theo `specs/backend-go/tdd/services/orchestration-service.md` §4/§8 và
`infra-fleet-service.md` §4/§8, backend-go **đã có** đủ tín hiệu:

- `dispatch_contexts.failure_count`/`last_heartbeat_at`, circuit-breaker
  tại `failure_count >= 3` → `circuit_broken` (orchestration-service.md §4).
- `connections.status` (`establishing|established|degraded|closed`) +
  `fleet_health_samples` (poll 30s, infra-fleet-service.md §8).
- Event outbox dự kiến: `connection.established`/`connection.lost`/
  `dev_server.health_degraded` qua NATS JetStream
  (infra-fleet-service.md §7).

Nhưng **không có đường nào** đưa các tín hiệu này lên UI hôm nay — người
dùng chỉ biết agent/dev server có vấn đề khi 1 thao tác cụ thể lỗi, không
có cảnh báo chủ động ("dev server của bạn vừa mất kết nối", "agent bị dừng
sau 3 lần lỗi liên tiếp").

## Giải pháp đề xuất

### 1. Một slice trạng thái đồng bộ dùng chung — mở rộng `persistence-status.ts` (CR-002)

```ts
// frontend/src/renderer/src/store/slices/persistence-status.ts (từ CR-002, MỞ RỘNG)
type SyncNamespace =
  | 'keybindings' | 'uiLocal' | 'settings' | 'workspaceSession' | 'accountsDevServerMap'  // CR-001/003/004
  | 'devServers' | 'agentSessions' | 'sshFleet'                                            // MỚI, CR-006

type SyncState = 'synced' | 'pending' | 'error' | 'degraded'   // 'degraded' MỚI — kết nối còn sống nhưng chất lượng kém
interface PersistenceStatus {
  [namespace: string]: { state: SyncState; lastError?: string; lastSyncedAt?: number }
}
```

Không tạo slice thứ hai riêng cho dev-server/agent — theo đúng nguyên tắc
"không lặp lại 1 pattern 2 lần" đã áp dụng xuyên suốt README của nhóm CR
này.

### 2. Frontend → backend-go: mọi write (CR-001/003/004/006) đều đi qua wrapper báo lỗi của CR-002

Không có gì mới về giao thức — đây là yêu cầu **áp dụng nhất quán** cơ chế
retry + hàng đợi 1-phần-tử-mới-nhất đã thiết kế ở CR-002 cho **toàn bộ**
namespace mới ở CR-006, không riêng CR-001/003/004.

### 3. Backend-go → frontend: 1 read RPC health tổng hợp, poll theo nhịp hợp lý — không transport push mới

Theo đúng nguyên tắc chung của nhóm CR (`docs/crs/v3/storage/README.md`:
"Không CR nào đụng vào cơ chế transport push/streaming"):

```protobuf
// infra-fleet-service — bổ sung, dùng lại domain đã có (ConnectionHealth đã sketch ở §3 TDD)
rpc GetFleetConnectivitySummary(GetFleetConnectivitySummaryRequest)
    returns (GetFleetConnectivitySummaryResponse);
// Trả về: mỗi connectionId của user -> status, last_activity_at, degraded_since;
// mỗi dispatch_context đang active -> status, failure_count, last_heartbeat_at.
```

Expose qua wscompat `connectivity.getSummary`, frontend poll khi:
(i) app foreground trở lại sau khi ẩn/ngủ, (ii) theo 1 interval vừa phải
(ví dụ 30s, khớp nhịp health-poll 30s đã có ở `infra-fleet-service` §8 —
không cần poll nhanh hơn tần suất backend tự cập nhật), (iii) ngay sau một
RPC ghi thất bại (kiểm tra xem có phải do mất kết nối dev server, không
phải lỗi logic).

**Cân nhắc riêng — có nên tái dùng WS terminal đang mở thay vì poll**: dev
server mất kết nối là tình huống nhạy cảm thời gian hơn "lệch 1 tab
preference". Đề xuất **khi implement, đánh giá** việc gắn thêm 1
control-plane message vào WS stream terminal *đã mở sẵn*
(`infra-fleet-service.md` §7 — "the data stream is a dedicated
server-streaming RPC once the route is resolved") thay vì mở kết nối mới —
đây **không phải** "transport push mới" theo đúng nghĩa của quy tắc chung
(tái dùng kênh đã có, không thêm WebSocket/kênh nào), nhưng cần review kỹ
trước khi chọn, ghi rõ là quyết định thiết kế mở, không mặc định trong CR
này.

### 4. Backend-go → agent: không đổi giao thức, chỉ đảm bảo tín hiệu đã có được ghi nhận đúng & truy vấn được

Giữ nguyên handshake/heartbeat hiện có của agent (`infra-fleet-service.md`
§9, §10's Option A) — CR này **không** đổi wire protocol giữa backend-go và
Dev Server Agent. Chỉ yêu cầu: mọi lần backend-go phát hiện mất
heartbeat/handshake lỗi phải **ghi vào** `connections.status`/
`dispatch_contexts.failure_count` (đã đúng theo domain model hiện có) — để
mục (3) ở trên có dữ liệu thật để trả về, không phải trường mới cần thêm.

## Rủi ro / Phụ thuộc

| Hạng mục | Rủi ro | Ghi chú |
|---|---|---|
| Poll vs. tái dùng WS control-plane cho tín hiệu mất kết nối dev server | Cần quyết định thiết kế | Xem mục 3 — không mặc định trong CR này |
| Tăng tần suất RPC nếu poll quá nhanh | Thấp-Trung bình | Khớp nhịp 30s health-poll đã có, không tự ý poll nhanh hơn |
| `GetFleetConnectivitySummary` là RPC mới trên `InfraFleetService` | Trung bình | Cần `buf generate` sạch, cùng rủi ro proto đã ghi nhận ở các CR khác |
| Phân biệt "degraded" (kết nối chập chờn, còn cơ hội tự phục hồi) và "closed" (cần người dùng can thiệp) trên UI | Trung bình | Cần thiết kế UX riêng khi implement — CR này chỉ đảm bảo dữ liệu có, không thiết kế UI cụ thể |

## Không thuộc phạm vi CR này

- Thay đổi giao thức wire agent↔backend-go (`agent.handshake`,
  `ORCA_AGENT_TOKEN`, SSH trust boundary) — giữ nguyên theo Option A.
- Ngữ nghĩa "reconnect thì có tiếp tục công việc cũ không" — đó là
  [CR-STORAGE-008](./CR-STORAGE-008-reconnect-resume-semantics.md); CR này
  chỉ đảm bảo tín hiệu lỗi/health được nhìn thấy, không định nghĩa hành vi
  phục hồi.
- Transport push/WebSocket **mới** — nếu mục 3's đánh giá "tái dùng WS
  terminal" không khả thi khi implement, fallback về poll thuần, không mở
  kênh mới nào khác.

## Liên quan

- `specs/frontend/storage/dev-server-agent-impact.md`
- `specs/backend-go/tdd/services/orchestration-service.md` §4, §8
- `specs/backend-go/tdd/services/infra-fleet-service.md` §3, §4, §7, §8
- `frontend/src/renderer/src/web/web-preload-api.ts:2672-2674` (hành vi nuốt lỗi cần thay thế)
- [CR-STORAGE-002](./CR-STORAGE-002-zustand-persist-middleware-backend-go.md) (nguồn `persistence-status.ts`)
- [CR-STORAGE-006](./CR-STORAGE-006-centralize-dev-server-agent-state-backend-go.md), [CR-STORAGE-008](./CR-STORAGE-008-reconnect-resume-semantics.md)
