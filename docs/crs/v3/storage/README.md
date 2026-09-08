# Frontend Storage Consolidation — Change Requests (v3)

> **Bối cảnh:** phát sinh từ audit toàn bộ storage surface của `frontend/`
> (localStorage/sessionStorage, hybrid `ui`/`settings`/`session` cache, và
> phân loại persistence của 79 Zustand store slice) — xem
> [`specs/frontend/storage/`](../../../../specs/frontend/storage/README.md)
> cho chi tiết đầy đủ, code-grounded (file:line) của từng phát hiện, mở rộng
> bởi [`dev-server-agent-impact.md`](../../../../specs/frontend/storage/dev-server-agent-impact.md)
> cho câu hỏi riêng "cái gì tác động tới agent chạy trên dev server". 8 CR
> dưới đây là **đề xuất kiến trúc (Proposed), chưa triển khai**, chia làm 2
> track (xem "Hai track riêng biệt" bên dưới) — mục tiêu chung: loại bỏ tình
> trạng "dữ liệu người dùng/agent chỉ tồn tại trên 1 thiết bị/1 trình duyệt,
> hoặc chỉ sống trong bộ nhớ tiến trình renderer" bằng cách (a) chuyển các
> tầng lưu trữ cục bộ (`localStorage` trên web, file JSON cục bộ
> `orca-data.json`/`settings.json`/`keybindings.json` trên desktop) sang
> `backend-go`'s `tenant-service`, và (b) đảm bảo dữ liệu dev-server/agent
> vốn đã có chủ ở `infra-fleet-service`/`orchestration-service` được
> frontend đọc/ghi/báo lỗi/reconnect đúng cách thay vì giữ tạm trong bộ nhớ.

| CR | Vấn đề | Đề xuất | Status |
|----|--------|---------|--------|
| [CR-STORAGE-001](./CR-STORAGE-001-local-app-storage-to-backend-go.md) | `keybindings.ts`, `ui.ts` (phần local), `runtime-status.ts` (saved server list) chỉ lưu trong file JSON cục bộ (Electron main process) qua `window.api.*` — không đồng bộ nhiều thiết bị, mất khi cài lại app | Thêm cột JSON theo mẫu `tenant.user_profiles.onboarding_state_json` đã có sẵn, expose qua `profile.*` wscompat namespace đã có sẵn (`api-gateway` → `tenant-service`) | 🔲 Proposed |
| [CR-STORAGE-002](./CR-STORAGE-002-zustand-persist-middleware-backend-go.md) | Store Zustand gốc (~79 slice) không dùng `persist` middleware nào — mọi slice tự gọi (hoặc quên gọi) IPC/RPC riêng lẻ, không có xử lý lỗi/retry thống nhất | Viết 1 Zustand `persist` `StateStorage` adapter dùng chung, backend là `callRuntimeRpc`/`profile.*` (không phải `localStorage`), có retry + offline queue + trạng thái lỗi hiển thị UI | 🔲 Proposed |
| [CR-STORAGE-003](./CR-STORAGE-003-full-settings-sync-per-user.md) | `settings.get`/`settings.update` trên web chỉ đồng bộ ~5/~200 field của `GlobalSettings` (allowlist cứng trong `orca-runtime.ts`) — phần còn lại chỉ tồn tại trong `localStorage` | Bỏ allowlist, lưu **toàn bộ** `GlobalSettings` dưới dạng JSON theo user (`tenant.user_profiles`, cột mới `client_settings_json`, không đụng `settings_json` layered hiện có) | 🔲 Proposed |
| [CR-STORAGE-004](./CR-STORAGE-004-session-and-connection-keys-to-backend.md) | `orca.web.workspaceSession.v1`, `orca.saved-instances`, `orca.accountsDevServer.<id>` không có đường đồng bộ backend nào — mất khi xoá localStorage | (a) `workspaceSession` + `accountsDevServer`: cột JSON per-user mới, cùng mẫu CR-001/003; (b) `saved-instances`: **giữ nguyên client-side** — giải thích ràng buộc "chưa biết backend nào để hỏi" (bootstrap trước khi có kết nối/đăng nhập) | 🔲 Proposed |
| [CR-STORAGE-005](./CR-STORAGE-005-cleanup-diagnostic-modules.md) | 2 module diagnostic tạm (`bug-fe-pty-001-diagnostic-log.ts`, `remove-project-diagnostic-log.ts`) vẫn còn trong codebase dù điều tra đã đóng | Xoá 2 module + toàn bộ call site | 🔲 Proposed |
| [CR-STORAGE-006](./CR-STORAGE-006-centralize-dev-server-agent-state-backend-go.md) | `dev-servers.ts`, `remote-agent-sessions.ts`, `bootstrap.ts`, `ssh.ts`, `provisioning.ts`, `runtime-environment-ssh.ts` không persist gì — nhưng dữ liệu này **đã có** chủ sở hữu backend-go thật (`infra-fleet-service`, `orchestration-service`), chỉ thiếu bước hydrate | Frontend đọc lại từ RPC/bảng đã tồn tại (`ListDevServers`, `dispatch_contexts`, `bootstrap_status`, `ssh_targets`...) khi load/refresh — không thêm bảng mới | 🔲 Proposed |
| [CR-STORAGE-007](./CR-STORAGE-007-bidirectional-error-health-reporting.md) | Lỗi ghi bị nuốt âm thầm (frontend↔backend-go); tín hiệu health/circuit-breaker đã có ở backend-go↔agent nhưng không lên tới UI | 1 slice trạng thái đồng bộ dùng chung (mở rộng CR-002) + 1 RPC đọc health tổng hợp (`GetFleetConnectivitySummary`), poll theo nhịp đã có — không transport push mới | 🔲 Proposed |
| [CR-STORAGE-008](./CR-STORAGE-008-reconnect-resume-semantics.md) | Auth-failure hiện `.clear()` giống hệt logout (mất hết trạng thái khi đăng nhập lại); backend-go chưa có hợp đồng "dev server reconnect thì resume đúng session cũ" | (a) Tách auth-failure khỏi logout, chỉ xoá khi logout có xác nhận; (b) `connections`/`terminal_sessions`/`dispatch_contexts` giữ `connectionId`/`ptyId` qua 1 grace-period, không trip circuit-breaker do lỗi transport | 🔲 Proposed |

## Hai track riêng biệt trong nhóm CR này

CR-STORAGE-001/002/003/004/005 nhắm vào **`tenant-service`** — thêm cột JSON
per-user mới cho dữ liệu preference/UI **chưa từng có** nơi lưu ở
backend-go. CR-STORAGE-006/007/008 nhắm vào **`infra-fleet-service`** +
`orchestration-service` — dữ liệu **đã có** chủ sở hữu backend-go thật
(`dev_servers`, `connections`, `terminal_sessions`, `dispatch_contexts`),
vấn đề là frontend chưa đọc/ghi/báo lỗi đúng cách qua các RPC đã tồn tại.
2 track này **độc lập kỹ thuật với nhau** (khác service, khác bảng) và có
thể triển khai song song — chỉ chia sẻ 1 vài nguyên tắc chung (không
transport push mới, `persistence-status.ts` từ CR-002 được CR-007 dùng lại)
và cùng xuất phát từ 1 đợt audit
([`specs/frontend/storage/`](../../../../specs/frontend/storage/README.md),
mở rộng bởi
[`dev-server-agent-impact.md`](../../../../specs/frontend/storage/dev-server-agent-impact.md)
cho riêng câu hỏi "cái gì ảnh hưởng tới agent trên dev server").

## Nguyên tắc thiết kế xuyên suốt

1. **Không phát minh transport mới.** `api-gateway`'s wscompat đã expose sẵn
   `profile.getUserProfile`/`profile.updateUser`/`profile.getResolved` →
   `tenant-service`'s `GetUserProfile`/`UpdateUserProfile`/
   `GetResolvedProfile` gRPC → Postgres `tenant.user_profiles`
   (`backend-go/services/api-gateway/internal/adapter/wscompat/channels_tenant_project.go:118-147,320-336`).
   Cả 4 CR đầu đều **tái sử dụng** namespace RPC này thay vì tạo service mới.
2. **Tái dùng đúng pattern đã có tiền lệ trong chính codebase.**
   `tenant.user_profiles.onboarding_state_json` (migration + repository ở
   `backend-go/services/tenant-service/internal/adapter/postgres/user_profile_repository.go:119-160`)
   đã giải quyết đúng bài toán này cho 1 trường hợp khác (onboarding wizard
   progress) — doc comment tại `tenant_grpc.pb.go:85-90` giải thích rõ vì
   sao nó là **cột riêng, không đi qua `settings_json`** layered
   (company/department/team/user merge) đã tồn tại cho mục đích khác
   (feature-flag/policy resolution, không phải nơi chứa preference cá
   nhân opaque). CR-001/003/004 nhân bản chính xác pattern này cho
   `ui_state_json`, `client_settings_json`, `workspace_session_json`,
   `accounts_dev_server_json` — không tái dùng `settings_json` layered.
3. **Không CR nào đụng vào cơ chế transport push/streaming.** Theo
   [`CR-PW-006`](../project-workspace/CR-PW-006-execution-monitoring-architecture.md),
   codebase chưa có pattern "JSON push generic" nào ngoài PTY streaming
   chuyên biệt — xây transport mới là việc rủi ro cao, ngoài phạm vi các CR
   này. Toàn bộ đồng bộ ở đây là **request/response qua RPC đã có**
   (`callRuntimeRpc`), giống hệt cách `ui.get`/`settings.get` hoạt động hôm
   nay — không polling, không WebSocket mới.
4. **Per-user, không phải per-thiết-bị.** Khoá của mọi bản ghi mới là
   `user_id` (từ `tenant.user_profiles`, hiện đã 1:1 với user qua FK logic
   tới `auth-service`) — đúng yêu cầu "mỗi user 1 thuộc tính riêng" của
   CR-STORAGE-003. Không thêm khái niệm "thiết bị" nào vào schema.

## Thứ tự thực thi & phụ thuộc

```
CR-STORAGE-005 → độc lập hoàn toàn, có thể làm ngay, không phụ thuộc gì
CR-STORAGE-001 → nền tảng (migration + gRPC method + wscompat channel mới)
                 cho keybindings/ui-local/runtime-status
CR-STORAGE-003 → dùng lại đúng migration pattern của CR-STORAGE-001,
                 nhưng là 1 cột riêng (client_settings_json) — có thể làm
                 song song với CR-STORAGE-001, không phụ thuộc cứng
CR-STORAGE-004 → (a) dùng lại pattern CR-STORAGE-001 cho workspaceSession/
                 accountsDevServer; (b) saved-instances KHÔNG đổi (xem CR)
CR-STORAGE-002 → phụ thuộc CR-STORAGE-001 VÀ CR-STORAGE-003 đã có RPC thật
                 để adapter gọi vào — làm SAU CÙNG, vì nếu làm trước sẽ
                 không có gì để "sync" thật (chỉ còn localStorage cũ)
```

### Track 2 — dev-server/agent (`infra-fleet-service`/`orchestration-service`)

```
CR-STORAGE-006 → không phụ thuộc CR-001..005; chỉ cần RPC ĐÃ TỒN TẠI ở
                 infra-fleet-service/orchestration-service — có thể làm
                 song song, ngay cả trước khi track 1 xong
CR-STORAGE-007 → phụ thuộc (a) CR-STORAGE-002's persistence-status.ts (mở
                 rộng, không viết lại) và (b) CR-STORAGE-006 đã hydrate
                 xong để có dữ liệu thật mà báo trạng thái/lỗi
CR-STORAGE-008 → phần (a) (auth-failure vs. logout) độc lập, làm được ngay;
                 phần (b) (reconnect-resume ở backend-go) nên làm SAU
                 CR-STORAGE-006/007 — cần dữ liệu connection/dispatch đã
                 hydrate + kênh báo lỗi đã có để kiểm chứng hành vi resume
```

2 track chạy song song; không có phụ thuộc chéo bắt buộc giữa track 1 và
track 2 (CR-007 có mượn lại `persistence-status.ts` của CR-002, nhưng chỉ
là *mở rộng field*, không cần CR-001/003/004 xong trước).

## Rủi ro chung cần lưu ý trước khi triển khai bất kỳ CR nào

- **`GlobalSettings`/`PersistedUIState`/`WorkspaceSessionState` là type TS
  dùng chung `backend/`, `desktop/`, `agent/`** (xem
  `specs/frontend/storage/ui-settings-session-hybrid.md`) — đổi nơi lưu
  không được đổi các type này; backend-go chỉ lưu **JSON blob nguyên vẹn**,
  không decode field-by-field (giống hệt cách `tenant-service` xử lý
  `settings_json`/`onboarding_state_json` hôm nay — "domain code only
  reads/merges already-decoded values" áp dụng y hệt: backend-go **không
  cần biết** schema `GlobalSettings`).
- **Không có transport push** — mọi client khác (một tab web thứ 2, một
  phiên desktop khác của cùng user) sẽ **không** thấy thay đổi realtime,
  chỉ thấy khi tự gọi lại `get`. Đây là hạn chế đã biết, chấp nhận được vì
  đây cũng chính là hành vi hiện tại của `ui.get`/`settings.get` (không có
  gì thoái lui, chỉ mở rộng phạm vi field/namespace được đồng bộ).
- **Thứ tự viết `Store` (Postgres) đè `backend/src/main/persistence.ts`
  (JSON blob cục bộ)?** Không — 4 CR đầu **thêm** 1 con đường lưu trữ mới
  (backend-go) làm nguồn thật (source of truth) cho các namespace đang chỉ
  có ở web/localStorage; hành vi desktop's `orca-data.json` (đã hoạt động
  ổn định, per `specs/frontend/storage/ui-settings-session-hybrid.md`'s
  `session` section) **không nằm trong phạm vi các CR này** trừ khi ghi rõ
  trong từng CR — tránh regression trên desktop khi mới chỉ có mục tiêu là
  vá lỗ hổng bên web.
- **Riêng track 2 (CR-006/007/008)**: `infra-fleet-service.md` §8 tự nêu
  "relay-websocket mode requires session affinity or connection handoff" là
  1 câu hỏi thiết kế **còn mở**, chưa được giải quyết bởi bất kỳ tài liệu
  nào hiện có. CR-STORAGE-008 định nghĩa **ngữ nghĩa mong muốn** (reconnect
  giữ nguyên `connectionId`/không trip circuit-breaker do lỗi transport)
  nhưng **không tự giải quyết** bài toán hạ tầng đó — cần 1 vòng review
  kiến trúc riêng (sticky session / connection handoff giữa các pod) trước
  khi implement phần (b) của CR-STORAGE-008.
