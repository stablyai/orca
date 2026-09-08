# CR-STORAGE-003 — Đồng bộ toàn bộ field `GlobalSettings` theo user qua backend-go

| Trường | Giá trị |
|--------|---------|
| **CR ID** | CR-STORAGE-003 |
| **Tên** | Bỏ allowlist 5-field, lưu toàn bộ `GlobalSettings` (~200 field) per-user trong `backend-go` |
| **Loại** | Bug Fix / Architectural Change |
| **Priority** | P0 — mất dữ liệu người dùng thật khi xoá `localStorage` |
| **Phiên bản** | v1.0 |
| **Ngày tạo** | 2026-09-07 |
| **Trạng thái** | 🔲 Proposed — chưa triển khai |
| **Tác giả** | Yêu cầu user: "toàn bộ field của settings trên bản web phải đồng bộ từ backend, mọi thay đổi phải cập nhật vào backend (mỗi user 1 thuộc tính riêng)" |
| **Tác động HLD** | Settings/Preferences (toàn bộ `GlobalSettings`) |
| **Tác động Features** | Settings screen (mọi pane: Terminal, Appearance, Notifications, Agents, Proxy, ...) |

---

## Bối cảnh & Vấn đề gốc

Đây là **phát hiện đáng chú ý nhất** của audit storage
([`specs/frontend/storage/ui-settings-session-hybrid.md`](../../../../specs/frontend/storage/ui-settings-session-hybrid.md#settings-namespace)):

- `GlobalSettings` (`frontend/src/shared/types.ts:2524`) có **~200+ field**:
  toàn bộ theme, terminal font/cursor/scrollback, proxy, notification,
  default agent, `githubProjects`, `voice`, v.v.
- Backend RPC `settings.get`/`settings.update` chỉ round-trip **17 field cố
  định** — `getClientSettings()` trả về đúng 1
  `Pick<GlobalSettings, 'defaultTuiAgent' | 'disabledTuiAgents' | ...>`
  (`backend/src/main/runtime/orca-runtime.ts:493-512`).
- Phía web, `getRuntimeBackedStoredSettings()`/`syncRuntimeBackedSettings()`
  (`frontend/src/renderer/src/web/web-preload-api.ts:3598-3678`) thu hẹp
  tiếp xuống còn **~5 field** thực sự gửi lên (`experimentalNewWorktreeCardStyle`,
  `compactWorktreeCards`, `minimaxGroupId`, `minimaxUsageModels`,
  `prBotAuthorOverrides`).
- **~195 field còn lại** (toàn bộ giao diện Settings mà người dùng thực sự
  tương tác hàng ngày) **chỉ tồn tại trong `localStorage`**
  (`orca.web.settings.v1`) trên trình duyệt web — xoá cache/đổi trình
  duyệt/đổi máy là **mất vĩnh viễn**, không có cách khôi phục.

## Giải pháp đề xuất

### Cột JSON mới, riêng biệt — theo đúng pattern `onboarding_state_json`

Thêm cột `client_settings_json` vào `tenant.user_profiles`
(`backend-go/services/tenant-service`), **KHÔNG** tái dùng cột
`settings_json` layered đã có (đó là 1 khái niệm khác — policy/feature-flag
theo tầng company→department→team→user, dùng cho `ResolveProfile`; xem
`backend-go/services/tenant-service/internal/domain/settings.go:1-16`).
`client_settings_json` lưu **nguyên vẹn** object `GlobalSettings` JSON,
opaque với backend-go — cùng triết lý với `onboarding_state_json`:

```go
// Mẫu: backend-go/services/tenant-service/internal/adapter/postgres/user_profile_repository.go:119-160
func (r *UserProfileRepository) GetClientSettings(ctx, companyID, userID) (string, bool, error)
func (r *UserProfileRepository) SetClientSettings(ctx, companyID, userID, settingsJSON string) error
```

gRPC method mới `GetClientSettings`/`SetClientSettings` trên
`TenantServiceClient`, expose qua wscompat namespace mới
`settings.getFull`/`settings.updateFull` (đặt tên khác `settings.get`/
`settings.update` hiện có để **không phá** 5-field contract đang chạy —
xem "Kế hoạch chuyển đổi không breaking").

### Kế hoạch chuyển đổi không breaking

1. **Giai đoạn 1 (additive)**: thêm `settings.getFull`/`settings.updateFull`
   song song với `settings.get`/`settings.update` cũ. Frontend web đổi
   `getRuntimeBackedStoredSettings()`/`syncRuntimeBackedSettings()`
   (`web-preload-api.ts:3598-3678`) để gọi **toàn bộ** `GlobalSettings` qua
   API mới, bỏ hoàn toàn danh sách hand-pick 5 field.
2. **Giai đoạn 2**: `settings.get`/`settings.update` cũ (17-field Pick,
   dùng bởi cả desktop lẫn web cho phần "cross-host defaults" — ví dụ
   `defaultTuiAgent`) **giữ nguyên**, tiếp tục phục vụ đúng mục đích hẹp của
   nó (các field cần theo dõi từ phía server logic, ví dụ chọn agent mặc
   định khi dispatch task) — không gộp 2 khái niệm "cross-host operational
   default" và "cá nhân hoá giao diện người dùng" vào 1 API.
3. **Migrate dữ liệu cũ**: khi 1 user lần đầu gọi `settings.updateFull` mà
   `client_settings_json` chưa tồn tại, seed từ `localStorage` hiện có của
   trình duyệt đó (gửi kèm trong request đầu tiên) — tránh reset toàn bộ
   preference của user hiện tại về default ngay khi rollout.

### Mỗi user 1 bản ghi riêng — đã đúng theo yêu cầu

`tenant.user_profiles` đã khoá theo `user_id` (1:1 với user, không phải
theo thiết bị/trình duyệt) — `Upsert`/`Get`
(`user_profile_repository.go:25-76`) đã đúng model "mỗi user 1 thuộc tính
riêng" mà không cần thiết kế thêm.

## Rủi ro / Phụ thuộc

| Hạng mục | Rủi ro | Ghi chú |
|---|---|---|
| Kích thước JSON blob | Thấp | `GlobalSettings` gồm `terminalCustomThemes`, `codexManagedAccounts`, `webPushSubscriptions` — cần ước lượng kích thước tối đa thực tế trước khi chọn kiểu cột (`jsonb` không giới hạn cứng, nhưng cần index/kiểm tra `vapidKeys` không lẫn giá trị nhạy cảm nếu đồng bộ) |
| `vapidKeys`/`webPushSubscriptions`/`codexManagedAccounts`/`claudeManagedAccounts` có thể chứa secret | **Cao — cần security review riêng** | Trước khi đồng bộ toàn bộ `GlobalSettings` lên backend-go dùng chung hạ tầng multi-tenant, PHẢI xác nhận không có field nào trong danh sách này là secret/token cần mã hoá riêng (khác cơ chế OS keychain hiện tại cho `credentials`) — nếu có, tách field đó ra khỏi `client_settings_json`, xử lý như `credential-broker-service` đang làm cho credential khác |
| Desktop vẫn dùng `Store.getSettings()`/local file làm nguồn thật | Trung bình | CR này chỉ áp dụng cho **web build**; desktop's local-first behavior không đổi trong CR này — tránh 2 nguồn thật xung đột nếu sau này desktop cũng đồng bộ (cần CR nối tiếp, không nằm trong phạm vi này) |
| Field 1-shot migration guard (`_xyzMigrated`/`_xyzDefaulted`) | Thấp | Các field này vẫn hoạt động bình thường khi lưu nguyên object — không cần xử lý đặc biệt vì backend-go không decode field-by-field |

## Không thuộc phạm vi CR này

- Đồng bộ `GlobalSettings` cho **desktop** build — desktop đã có local-first
  file `orca-data.json`/`Store.getSettings()` hoạt động ổn định; việc có
  nên đồng bộ thêm lên backend-go cho desktop hay không là quyết định
  riêng, không ép buộc trong CR này.
- Xử lý secret/token phát hiện được trong `GlobalSettings` (xem bảng rủi ro)
  — cần 1 CR bảo mật riêng nếu security review xác nhận có field nhạy cảm.
- Zustand `persist` middleware cho `settings.ts` — xem
  [CR-STORAGE-002](./CR-STORAGE-002-zustand-persist-middleware-backend-go.md),
  làm sau khi CR này có RPC thật để adapter gọi vào.

## Liên quan

- `specs/frontend/storage/ui-settings-session-hybrid.md` (phân tích chi tiết gap)
- `frontend/src/shared/types.ts:2524` (`GlobalSettings`)
- `frontend/src/renderer/src/web/web-preload-api.ts:3598-3678`
- `backend/src/main/runtime/orca-runtime.ts:493-602`
- `backend-go/services/tenant-service/internal/domain/settings.go`
- `backend-go/services/tenant-service/internal/adapter/postgres/user_profile_repository.go`
- [CR-STORAGE-001](./CR-STORAGE-001-local-app-storage-to-backend-go.md) (pattern chung), [CR-STORAGE-002](./CR-STORAGE-002-zustand-persist-middleware-backend-go.md)
