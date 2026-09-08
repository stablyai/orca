# SOL-AG-STORAGE-002: Agent-side cho hydrate + báo health (CR-STORAGE-006, CR-STORAGE-007)

> **🔲 Designed — chưa implement.** Phần lớn tín hiệu backend-go cần để
> hydrate/báo health **đã được agent gửi hôm nay** qua handshake/keepalive
> — verified bằng đọc source thật `agent/src/relay/agent-session.ts`,
> `agent-connection-direct.ts`, `agent-token-manager.ts`. Việc còn thiếu
> là xác nhận `infra-fleet-service`/`orchestration-service` (backend-go)
> có ghi nhận đúng các tín hiệu này hay không — đó là phạm vi
> [BE-SOL-STORAGE-002](../../../../../backend-go/crs/v3/storage/solutions/BE-SOL-STORAGE-002-dev-server-agent-hydration-and-health.md),
> không phải agent.

**CRs:** [CR-STORAGE-006](../../../../../../docs/crs/v3/storage/CR-STORAGE-006-centralize-dev-server-agent-state-backend-go.md) · [CR-STORAGE-007](../../../../../../docs/crs/v3/storage/CR-STORAGE-007-bidirectional-error-health-reporting.md)
**backend-go counterpart:** [BE-SOL-STORAGE-002](../../../../../backend-go/crs/v3/storage/solutions/BE-SOL-STORAGE-002-dev-server-agent-hydration-and-health.md)
**Frontend counterpart:** [FE-SOL-STORAGE-006](../../../../../frontend/crs/v3/storage/solutions/FE-SOL-STORAGE-006-dev-server-agent-state-hydration.md)
**TDD tham chiếu:** [TDD-AG-03](../../../../tdd/v5/03-connection-modes.md), [TDD-AG-04](../../../../tdd/v5/04-handshake-session.md)

---

## 1. Tín hiệu agent đã gửi hôm nay — verified qua source thật, không chỉ TDD

Đọc trực tiếp `agent/src/relay/agent-connection-direct.ts`,
`agent-session.ts`, `agent-token-manager.ts` (không chỉ tin vào
`specs/agent/tdd/v5` — các TDD này tự thừa nhận có thể lệch so với code
thật, xem `00-index.md`'s addendum) xác nhận agent **đã có sẵn** đúng
những gì CR-STORAGE-006/007 cần ở phía nguồn phát:

| Tín hiệu | Cơ chế thật đã có | file (agent/src/relay/) |
|---|---|---|
| Định danh dev server ổn định qua mỗi lần kết nối lại | `devServerId` gửi trong mọi `agent.handshake`, không đổi giữa các lần reconnect | `agent-session.ts` (`sendHandshake`) |
| Capabilities/tools hiện có (agent version này hỗ trợ gì) | `capabilities: buildCapabilities()` (`fs`, `git`, `pty`, `pty.stream`, `agent.spawn`, ...) + `tools` list, gửi mỗi lần handshake | `agent-session.ts` |
| Transport liveness (kết nối còn sống hay đã treo) | Keepalive frame mỗi `AGENT_KEEPALIVE_INTERVAL_MS` (5s, hằng số thật trong `shared/agent-wire-protocol.ts`), timeout phía server `AGENT_TIMEOUT_MS` (20s) | `agent-wire-protocol.ts`, `agent-session.ts` |
| Phân biệt "network drop, đang reconnect" vs. "đóng sạch" | `connectDirect()` (bản thật, KHÔNG như mô tả cũ trong TDD-AG-03/04 — xem mục 2) phân biệt rõ `code===1000` (sạch, thoát) vs. mọi code khác (reconnect ngay, không thoát process) | `agent-connection-direct.ts` |
| Token vẫn hợp lệ để reconnect nhanh | `AgentTokenManager`: fetch token khi start, **chủ động renew ở 80% TTL**, giữ sẵn `.next` token trong RAM để dùng ngay khi WS rớt — không phải đợi round-trip HTTP mới có token mới | `agent-token-manager.ts` |

**Kết luận quan trọng**: hạ tầng "agent còn sống, đây có phải cùng 1 dev
server không, transport có đang chập chờn không" **đã tồn tại và đã đúng
hướng** — không cần thêm cơ chế phát tín hiệu mới ở agent cho phần này.
Việc CR-STORAGE-007 cần làm là ở phía backend-go: **ghi nhận** đúng các
tín hiệu này vào `connections.status`/`fleet_health_samples` (xem
BE-SOL-STORAGE-002) — agent không thiếu gì để báo.

## 2. Phát hiện quan trọng: TDD-AG-03/04 mô tả sai hành vi reconnect của code thật hiện tại

`specs/agent/tdd/v5/03-connection-modes.md`/`04-handshake-session.md` mô
tả: mất kết nối sau handshake → log rồi **`process.exit(2)`**, không tự
retry, dựa vào "token dùng 1 lần, systemd Restart=always sẽ khởi động lại
với token mới". **Đây không còn đúng với code thật** — `connectDirect()`
hiện tại (đọc trực tiếp bundle + `agent-connection-direct.ts`) chạy 1
vòng lặp `while (true)` **tự reconnect trong cùng 1 process**, không bao
giờ `exit()` trừ khi: (a) đóng sạch `code===1000`, hoặc (b) nhận
`SIGINT`/`SIGTERM`. Mọi trường hợp khác (`code!==1000`, WS error) →
`reconnect-renew`/`reconnect-auth-failed` → `forceRenew()` token nếu cần →
đợi theo `RECONNECT_DELAYS_MS = [1000, 2000, 5000, 15000, 30000]` → thử
lại — **vô hạn**, không phụ thuộc systemd restart cho trường hợp này.

**Ghi lại phát hiện này vì 2 lý do**:
1. Đây là tin tốt cho CR-STORAGE-008 — tầng kết nối (transport) đã tự
   phục hồi mà không cần thiết kế mới; phần còn thiếu là ở tầng **công
   việc đang chạy** (PTY/agent process), xem
   [SOL-AG-STORAGE-003](./SOL-AG-STORAGE-003-agent-spawn-pty-daemon-grace-period.md).
2. Cảnh báo cho bất kỳ ai đọc `specs/agent/tdd/v5/03-04` để thiết kế tiếp
   — 2 tài liệu đó đã lỗi thời ở đúng phần "điều gì xảy ra khi mất kết
   nối", cần cập nhật riêng (không thuộc phạm vi CR-STORAGE-00x, ghi nhận
   như 1 tech-debt tài liệu).

## 3. Việc cần xác nhận/bổ sung — ĐÃ XÁC NHẬN qua TASK-AG-STORAGE-002/003 (2026-09-07)

| Việc | Kết luận |
|---|---|
| Nhịp Health Reporter (CPU/RAM/disk) có khớp 30s mà `infra-fleet-service.md` §8 kỳ vọng không | **Không có "Health Reporter" nào để lệch nhịp — module này không tồn tại trong `agent/src/relay/` hôm nay.** 2 lượt `codegraph_explore` riêng biệt ("health reporter CPU RAM disk emit interval" và "cpu usage os.loadavg os.freemem diskusage") trong toàn bộ `agent/src/` đều **không** tìm thấy module nào định kỳ thu thập/emit CPU/RAM/disk/latency. Đối chiếu backend-go: `backend-go/services/infra-fleet-service/internal/usecase/get_fleet_health.go` (`GetFleetHealth`, `NewPollFleetHealth`) tồn tại thật — xác nhận mô hình thật là **backend-go tự POLL** (nhiều khả năng qua SSH exec), không phải agent chủ động đẩy dữ liệu theo interval. `specs/agent/tdd/v5/00-index.md` §A.1/A.2's "Health Reporter emit every 60s" mô tả 1 cơ chế **chưa từng được implement** theo hướng agent-push — không phải lệch nhịp 60-vs-30. Xem TASK-AG-STORAGE-004 — cần sửa luôn `00-index.md`, không chỉ 03/04 |
| `bootstrap_status` (CR-STORAGE-006 mục 3) — agent có báo tiến trình bootstrap không | **`bootstrap_status`/`BootstrapFleetTarget` không tồn tại trong backend-go thật** — xác nhận bằng grep toàn bộ `infra-fleet-service/`: chỉ 1 lần nhắc `BootstrapFleetTarget` trong toàn backend-go, và đó là 1 **comment tham chiếu** (`channels_repo_ssh_status_workspace.go:704`, làm tiền lệ chọn timeout cho 1 RPC khác — không phải chính nó được implement). `internal/domain/dev_server.go:96-98` tự thừa nhận: `DevServer` struct thật "does not model" bootstrap status/agent version — "see this service's README 'Known gaps'". **Tin tốt**: migration `0007_dev_server_health_status.up.sql` xác nhận đã có thật cột `infra.dev_servers.status` ("health/bootstrap status: pending\|healthy\|degraded\|unhealthy") **cùng** `platform`/`arch`/`node_version`/`agent_version`/`last_provisioned_at`/`tags` — khớp chính xác với những gì `agent.handshake` đã gửi hôm nay (mục 1). **Kết luận: agent không cần đổi gì** — dữ liệu cần thiết đã có sẵn trong handshake; backend-go chỉ cần ghi đúng `infra.dev_servers.status`/`agent_version` khi nhận handshake. CR-STORAGE-006/BE-SOL-STORAGE-002 cần cập nhật để trỏ đúng tên cột thật (`status`, không phải `bootstrap_status`) |
| `agentSession.listActive` (BE-SOL-STORAGE-002 mục 2, cho `remote-agent-sessions.ts` hydrate) — dữ liệu này lấy từ đâu ở agent | Theo mục 1, agent không tự "list các phiên agent đang chạy" qua 1 RPC riêng — `orchestration-service`'s `dispatch_contexts`/`messages` (heartbeat qua mailbox) là nguồn thật; agent chỉ cần tiếp tục gửi đúng `worker_done`/`heartbeat` message như thiết kế hiện có của `orchestration-service` (§4/§8 TDD) — **không cần** thêm RPC "list active" phía agent |

## Rủi ro / Phụ thuộc

| Hạng mục | Ghi chú |
|---|---|
| `specs/agent/api/gaps-and-findings.md` đã ghi nhận TDD-AG bị lệch code thật ở nhiều chỗ khác | Bất kỳ thiết kế nào dựa trên TDD-AG-0x cho track 2 nên đối chiếu lại `specs/agent/api/` (catalog code-verified 2026-08-15) trước khi coi là chính xác — solution này đã làm việc đó cho các phần liên quan trực tiếp, nhưng không audit toàn bộ |
| Nhịp Health Reporter chưa verify | Cần 1 phiên riêng đọc source thật trước khi BE-SOL-STORAGE-002's `GetFleetConnectivitySummary` giả định nhịp cập nhật cụ thể |

## Không thuộc phạm vi solution này

- Thay đổi wire protocol/handshake — không cần, dữ liệu đã đủ (mục 1).
- Ghi nhận tín hiệu vào `connections`/`fleet_health_samples` ở backend-go
  — xem [BE-SOL-STORAGE-002](../../../../../backend-go/crs/v3/storage/solutions/BE-SOL-STORAGE-002-dev-server-agent-hydration-and-health.md).
- Ngữ nghĩa "công việc đang chạy có sống sót qua reconnect không" — xem
  [SOL-AG-STORAGE-003](./SOL-AG-STORAGE-003-agent-spawn-pty-daemon-grace-period.md).

## Liên quan

- `agent/src/relay/agent-session.ts`, `agent-connection-direct.ts`, `agent-token-manager.ts`
- `agent/src/shared/agent-wire-protocol.ts` (`AGENT_KEEPALIVE_INTERVAL_MS`, `AGENT_TIMEOUT_MS`)
- `specs/agent/tdd/v5/03-connection-modes.md`, `04-handshake-session.md` (lưu ý: đã lỗi thời ở phần reconnect, xem mục 2)
- `specs/agent/api/gaps-and-findings.md`
- `specs/backend-go/tdd/services/infra-fleet-service.md` §8, `orchestration-service.md` §4, §8
