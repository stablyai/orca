# CR-STORAGE-001 — Chuyển "Local app" storage của frontend sang backend-go

| Trường | Giá trị |
|--------|---------|
| **CR ID** | CR-STORAGE-001 |
| **Tên** | Đưa keybindings / UI-local-prefs / saved-server-list ra khỏi file JSON cục bộ, lưu ở `backend-go` |
| **Loại** | Architectural Change |
| **Priority** | P1 |
| **Phiên bản** | v1.0 |
| **Ngày tạo** | 2026-09-07 |
| **Trạng thái** | 🔲 Proposed — chưa triển khai |
| **Tác giả** | Yêu cầu user: "mọi thông tin lưu trữ ở 'Local app' của frontend phải lưu ở backend-go" |
| **Tác động HLD** | Tenant/Profile domain, RPC surface (`ui.*`) |
| **Tác động Features** | Keybindings, Settings (phần UI-local), Runtime Environments picker |

---

## Bối cảnh & Vấn đề gốc

Theo [`specs/frontend/storage/feature-persistence-matrix.md`](../../../../specs/frontend/storage/feature-persistence-matrix.md#local-desktop-only-electron-ipc-not-backendcross-device),
các slice sau lưu dữ liệu **chỉ trên thiết bị hiện tại**, qua `window.api.*`
(Electron IPC same-process, không phải RPC tới backend):

| Slice | Cơ chế hiện tại | file:line |
|---|---|---|
| `keybindings.ts` | `window.api.keybindings.ensureFile/get/setAction/reload/openFile/revealFile` — ghi vào `keybindings.json` cục bộ, mỗi rebind ghi ngay | `frontend/src/renderer/src/store/slices/keybindings.ts:45-125` |
| `ui.ts` (phần chưa đi qua `ui.set` RPC) | `uiSet({...})` + `window.api.settings.set(updates.settings)` | `frontend/src/renderer/src/store/slices/ui.ts:2101,2115` |
| `runtime-status.ts` | `window.api.runtimeEnvironments.list()` — danh sách server đã lưu, cục bộ | `frontend/src/renderer/src/store/slices/runtime-status.ts:113` |

Cả 3 đều bị backing store thật là `backend/src/main/persistence.ts`'s
`Store` — 1 file JSON duy nhất (`orca-data.json`, path resolved ở
`backend/src/main/persistence-paths.ts:20-42`) sống trên **máy chạy Electron
main process**. Hệ quả: đổi máy, cài lại app, hoặc dùng bản web (không có
Electron main process) đều mất toàn bộ 3 loại dữ liệu này — không có bản
sao nào ở backend-go.

**Quan trọng — không nhầm với `ui`/`settings` RPC namespace đã tồn tại**:
`ui.get`/`ui.set` (`backend/src/main/runtime/rpc/methods/client-ui.ts:28-39`)
đã là RPC, nhưng đích của nó vẫn là `Store.getUI()/updateUI()` — tức **vẫn
là file JSON cục bộ**, không phải backend-go. CR này không đổi giao thức
RPC (`ui.*`) — mà đổi **backing store phía sau** các RPC handler đó, và bổ
sung backing store tương tự cho `keybindings`/`runtime-status` (hiện còn
chưa có RPC namespace nào, thuần `window.api`).

## Giải pháp đề xuất

### Tái dùng nguyên xi pattern `onboarding_state_json` đã có trong `tenant-service`

`tenant.user_profiles` đã có tiền lệ cho đúng bài toán "lưu 1 JSON blob
opaque, per-user, không cần schema cố định, tách biệt khỏi `settings_json`
layered dùng cho policy resolution":

```go
// backend-go/services/tenant-service/internal/adapter/postgres/user_profile_repository.go:119-160
func (r *UserProfileRepository) GetOnboardingState(ctx, companyID, userID) (string, bool, error)
func (r *UserProfileRepository) SetOnboardingState(ctx, companyID, userID, stateJSON string) error
```

Doc comment tại `backend-go/proto/gen/go/orca/tenant/v1/tenant_grpc.pb.go:85-90`
giải thích chính xác lý do dùng cột riêng thay vì `settings_json`:
> "per-user onboarding wizard progress, opaque JSON as far as this service
> is concerned ... See UserProfileRepository.GetOnboardingState's doc
> comment for why this is a dedicated store, not settings_json."

**Đề xuất**: thêm 3 cột JSON mới cùng bảng `tenant.user_profiles`, theo
đúng khuôn mẫu này:

| Cột mới | Chứa | Nguồn dữ liệu TS |
|---|---|---|
| `keybindings_json` | Toàn bộ file `keybindings.json` hiện tại | `KeybindingsConfig` (kiểu dùng ở `keybindings.ts`) |
| `ui_local_state_json` | Phần `PersistedUIState` KHÔNG cần đồng bộ realtime nhiều-thiết-bị nhưng cần bền qua các lần cài đặt lại | `PersistedUIState` (`frontend/src/shared/types.ts:3315`) |
| `saved_runtime_environments_json` | Danh sách server đã lưu (thay `window.api.runtimeEnvironments.list()`'s nguồn cục bộ) | Kiểu trả về của `runtimeEnvironments.list()` |

Mỗi cột đi kèm 1 cặp gRPC method mới trên `TenantServiceClient`
(`GetKeybindings`/`SetKeybindings`, v.v.), theo đúng chữ ký
`GetOnboardingState(ctx, companyID, userID)`/`SetOnboardingState(ctx,
companyID, userID, json string)` — **KHÔNG** thêm field vào message
`UpdateUserProfileRequest`/`GetUserProfileResponse` hiện có (tránh đụng
`profile.updateUser`/`profile.getUserProfile` đang chạy ổn định cho
company/department/team resolution).

### Expose qua `api-gateway`'s wscompat — namespace mới, không đụng `profile.*` cũ

Theo mẫu `channels_tenant_project.go:118-147` (`profile.getResolved`,
`profile.getUserProfile`), thêm 3 cặp channel mới, ví dụ:

```go
r.Register("keybindings.getRemote", ...)   // → TenantServiceClient.GetKeybindings
r.Register("keybindings.setRemote", ...)   // → TenantServiceClient.SetKeybindings
```

(tên `*Remote` để phân biệt rõ với `window.api.keybindings.*` phía Electron
IPC hiện có, tránh nhầm lẫn 2 tầng trong lúc migrate).

### Phía frontend: giữ nguyên `window.api.keybindings.*` cho desktop, thêm nhánh RPC cho web

Theo đúng pattern hybrid đã ghi nhận ở `ipc-surface.md` (ví dụ
`runtime-git-client.ts`):

```ts
const target = getActiveRuntimeTarget(settings)
if (target.kind !== 'environment') {
  return window.api.keybindings.get()          // desktop-local, không đổi
}
return callRuntimeRpc(target, 'keybindings.getRemote', {})   // web/paired — MỚI
```

Desktop **tiếp tục** ghi cả 2 nơi (local file để hoạt động offline + gọi
`keybindings.setRemote` khi có kết nối) — không xoá `keybindings.json` cục
bộ trong CR này (xem "Không thuộc phạm vi").

## Rủi ro / Phụ thuộc

| Hạng mục | Rủi ro | Ghi chú |
|---|---|---|
| Migration `tenant.user_profiles` thêm 3 cột JSON | Thấp | Additive, nullable, có down migration — không đổi cột hiện có |
| gRPC method mới trên `TenantServiceClient` | Trung bình | Phải chạy `buf generate` sạch, tránh phá `proto/gen/go` dùng chung với các service khác (đã ghi nhận rủi ro tương tự ở `CR-PW-006`) |
| Xung đột dữ liệu khi user dùng cả desktop lẫn web song song | Trung bình | Không có transport push (xem README) — last-write-wins theo thời điểm gọi `set`, giống hệt `ui.set` hôm nay, không phải regression mới |
| `runtime-status.ts`'s saved list có thể chứa thông tin nhạy cảm (địa chỉ IP/hostname nội bộ) | Cần review bảo mật | Trước khi đồng bộ lên backend-go dùng chung hạ tầng multi-tenant, cần xác nhận cột mới có RLS/tenant isolation đúng như các bảng khác trong `tenant.*` |

## Không thuộc phạm vi CR này

- Xoá `keybindings.json`/local `PersistedUIState` cục bộ trên desktop —
  desktop tiếp tục có bản sao cục bộ để hoạt động offline; CR này chỉ thêm
  1 bản sao backend-go làm nguồn phục hồi khi đổi máy, không thay thế cơ
  chế local-first.
- `stats.ts`, `dictation.ts`, `preflight.ts`, `workspace-cleanup.ts`,
  `terminals.ts`, `browser.ts` (session/cookie/profile qua Electron
  session API) — đây là **live query kết quả OS/tiến trình cục bộ** (số
  liệu sử dụng, model giọng nói cài trên máy, tiến trình đang chạy...),
  không phải dữ liệu người dùng cần bền — di chuyển sang backend-go không
  có ý nghĩa (dữ liệu vốn dĩ chỉ đúng cho đúng máy đó tại đúng thời điểm
  đó).
- Đầy đủ field `GlobalSettings` (`settings.ts`) — xem
  [CR-STORAGE-003](./CR-STORAGE-003-full-settings-sync-per-user.md) (vấn đề
  khác: allowlist quá hẹp, không phải "chưa có RPC nào").
- `orca.web.workspaceSession.v1`/`orca.saved-instances`/
  `orca.accountsDevServer.<id>` — xem
  [CR-STORAGE-004](./CR-STORAGE-004-session-and-connection-keys-to-backend.md).

## Liên quan

- `specs/frontend/storage/feature-persistence-matrix.md` (nguồn phân loại)
- `backend-go/services/tenant-service/internal/adapter/postgres/user_profile_repository.go`
- `backend-go/proto/orca/tenant/v1/tenant.proto`
- `backend-go/services/api-gateway/internal/adapter/wscompat/channels_tenant_project.go`
- `backend/src/main/runtime/rpc/methods/client-ui.ts`
- [CR-STORAGE-002](./CR-STORAGE-002-zustand-persist-middleware-backend-go.md) (dùng RPC mới ở CR này làm backing store)
