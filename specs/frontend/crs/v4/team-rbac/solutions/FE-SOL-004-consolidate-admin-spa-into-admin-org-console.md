# FE-SOL-004: Gộp Admin SPA (Hệ B) vào `AdminOrgConsole` (Hệ A) — thêm tab Policies/Teams/Sessions/Audit, xoá Hệ B

> 🔲 Proposed — chưa cài đặt.

## CR Reference

- **CR:** [CR-RBAC-001](../../../../../../docs/crs/v4/team-rbac/CR-RBAC-001-consolidate-admin-surface-to-backend-go.md)
- **Mức độ:** 🔴 P0, Effort Large — chạy **sau cùng**, sau
  [FE-SOL-001](./FE-SOL-001-drop-lead-from-global-role-model.md) (CR-002),
  [FE-SOL-003](./FE-SOL-003-audit-log-filter-actor-and-outcome.md) (CR-005), và backend-go's
  BE-SOL của CR-RBAC-006 (policy publish thật).
- **Phát hiện mới quan trọng (không có trong audit gốc — thay đổi phạm vi effort của CR này):** xem
  "Bối cảnh" mục 2 và 3 dưới đây.

## Impact analysis (gitnexus, đã chạy lại)

| Symbol | Direction | Risk | Impacted | Ghi chú |
|---|---|---|---|---|
| `AdminApp` (`components/admin/AdminApp.tsx`) | upstream | LOW | 1 (`admin-main.tsx`) | Khớp đúng số liệu README — xoá an toàn sau cutover |
| `UsersTab` (`admin-org-console-users-tab.tsx`) | upstream | LOW | 2 (`AdminOrgConsole`→`Settings`) | Tab đích Users — xác nhận **đã đầy đủ**, xem Bối cảnh mục 1 |
| `AuditPage` (Hệ B) | upstream | LOW | 0 (giới hạn công cụ với React Router — xem FE-SOL-003) | |

Các symbol khác cần xoá ở bước 6 (`AdminLayout`, `AdminDashboard`, `PoliciesPage`, `PolicyForm`,
`TeamAdmin`, `SessionsPage`) **chưa chạy `impact()` trong solution này** — README đã ghi rõ, và quy
tắc bắt buộc của repo yêu cầu chạy lại `impact({target, direction:"upstream"})` cho từng symbol
**ngay trước khi xoá thật** ở bước implement, không dùng số liệu suy đoán ở đây.

## Bối cảnh (đã xác nhận lại — 3 phát hiện mới so với CR gốc)

### 1. `AdminOrgConsole`'s `UsersTab` đã hoàn chỉnh — KHÔNG cần bổ sung gì

CR-001 gốc viết: "tab này đã gọi `updateUserRole` — chỉ cần bổ sung create/deactivate/reactivate
nếu còn thiếu, kiểm tra lại khi cài đặt". Đã đọc verbatim `admin-org-console-users-tab.tsx` qua
`codegraph_explore`: `CreateUserForm` (gọi `window.api.admin.createUser`) và `UsersTab`'s
`handleRoleChange`/`handleActiveToggle` (gọi `updateUserRole`/`deactivateUser`/`reactivateUser`)
**đã có đủ cả 5 thao tác**, dùng đúng `AdminUserRole = 'user'|'admin'` (không có "lead", khớp
CR-002). Kết luận: **không có việc gì để làm ở Users tab** — chỉ giữ nguyên khi gộp các tab khác
vào cùng `AdminOrgConsole`.

### 2. `/admin/api/*` REST đã tồn tại đầy đủ ở backend-go — nhưng KHÔNG phải transport `AdminOrgConsole` dùng

Đọc verbatim `backend-go/services/api-gateway/internal/adapter/httpgateway/admin_routes.go` xác
nhận **toàn bộ REST surface Policies/Sessions/Audit đã được mount** tại `/admin/api/*`
(`GET/POST /policies`, `PUT/DELETE /policies/{id}`, `GET /sessions`, `DELETE /sessions/{sessionId}`,
`DELETE /users/{userId}/sessions`, `GET /audit`) — comment tại chỗ xác nhận đây là "REST->gRPC
reverse-proxy... distinct from auth_admin_routes.go's /v1/auth/* mount of the same underlying RPCs
(kept for backward compat)", có cả test `TestAdminRoutes_AuditMatchesV1AuthAuditLog` đảm bảo tương
thích. **Điều này khác với giả định ban đầu rằng backend-go "chưa có REST cho Policies"** — REST đã
có, nhưng đây không phải lớp mà `AdminOrgConsole` gọi.

`AdminOrgConsole`'s `UsersTab`/`DepartmentsTab` **không** gọi REST trực tiếp — chúng gọi qua
`window.api.admin.*`/`window.api.tenantProfile.*`, tức 1 lớp preload-IPC/wscompat riêng
(`frontend/src/renderer/src/web/web-preload-api.ts`'s `createAdminApi()` →
`callRuntimeResult('admin.createUser', ...)` → backend-go's
`services/api-gateway/internal/adapter/wscompat/channels_admin_users.go`). Đây là **transport thứ
4** phát hiện thêm ngoài 3 transport đã liệt kê trong audit gốc (REST `/admin/api`, REST `/v1/auth`,
Unix-socket RPC legacy) — và là transport **đúng** mà mọi tab mới trong `AdminOrgConsole` phải theo,
để nhất quán với `UsersTab`/`DepartmentsTab` hiện có.

### 3. wscompat channel cho Policies/Sessions/Audit/Teams CHƯA tồn tại — đây là phần backend-go thật sự còn thiếu của CR-001

`grep` xác nhận **chỉ có** `backend-go/services/api-gateway/internal/adapter/wscompat/
channels_admin_users.go` — không có `channels_admin_policies.go`/`channels_admin_sessions.go`/
`channels_admin_audit.go`/tương đương cho Teams. Nghĩa là: dù gRPC RPC (`ListAccessPolicies`,
`ListSessionsForUser`, `QueryAuditLog`...) và cả REST `/admin/api/*` đã có, **cầu nối wscompat mà
web app thật sự dùng thì chưa** — đây là backend-go work thật sự cần làm cho CR-001, không phải
"chỉ cutover FE". Solution này giả định các channel `admin.listPolicies`/`admin.createPolicy`/
`admin.updatePolicy`/`admin.deletePolicy`/`admin.listSessionsForUser`/`admin.revokeSession`/
`admin.forceRevokeAllSessionsForUser`/`admin.queryAuditLog`/`admin.listTeams`/`admin.createTeam`/
`admin.addTeamMember`/`admin.removeTeamMember` được backend-go thêm (mirror
`channels_admin_users.go`'s pattern, mỗi channel wrap đúng 1 gRPC call), và code FE dưới đây viết
theo giả định các channel này tồn tại với tên đó — xác nhận lại tên channel thật khi cài đặt.

### 4. Điểm khác biệt còn lại — xác nhận không đổi so với audit gốc

- Hệ B (`admin-main.tsx` → `AdminApp.tsx`, route `/users /policies /sessions /audit /teams
  /fleet /ai-providers /profile`) vẫn sống, tách biệt hoàn toàn — xác nhận qua `impact()`.
- `TeamAdmin.tsx` (Hệ B) vẫn dùng `callRuntimeRpc('team.*', ...)` → Unix-socket RPC →
  `backend/src/main/team/TeamService.ts` → SQLite `orca_teams`/`orca_team_members` — transport thứ
  5, tách biệt cả REST lẫn wscompat lẫn gRPC.

## Giải pháp

Theo đúng thứ tự 7 bước của CR gốc, nhưng cập nhật lại theo phát hiện #1-#3 ở trên.

### Bước 1 — Tab "Policies"

**File mới:** `frontend/src/renderer/src/components/settings/admin-org-console-policies-tab.tsx`

Mirror cấu trúc `admin-org-console-users-tab.tsx` (list + create form + per-row actions). Vì
`AccessPolicy` là JSON document versioned (không phải form nhiều field như `AdminPolicy` cũ), UI
tối thiểu là 1 textarea JSON (không phải form fields riêng cho `teams`/`roles`/`allowedServers` như
`PolicyForm.tsx` cũ — CR-RBAC-006's "Không thuộc phạm vi" xác nhận `document_json` đủ generic, đổi
UX form là CR khác):

```tsx
export function PoliciesTab(): React.JSX.Element {
  const [policies, setPolicies] = useState<AdminAccessPolicy[]>([])
  const [newDocumentJson, setNewDocumentJson] = useState('{}')
  // list: window.api.admin.listPolicies()
  // create: window.api.admin.createPolicy({ name, kind, documentJson })
  // update: window.api.admin.updatePolicy({ id, documentJson, expectedVersion })
  // delete: window.api.admin.deletePolicy({ id })
}
```

**Cảnh báo phụ thuộc:** chỉ merge tab này SAU khi backend-go's CR-RBAC-006 xong (`NoopPublisher`
thay bằng implementation thật) — nếu không, tab hiển thị "thành công" nhưng policy không có hiệu
lực, đúng gap nguy hiểm CR-006 mô tả. Nếu CR-001 buộc phải chạy trước CR-006 xong (không khớp thứ
tự khuyến nghị của README), thêm banner cảnh báo rõ trong tab: "Thay đổi có thể chưa có hiệu lực
ngay — xem CR-RBAC-006".

### Bước 2 — Tab "Audit Log"

**File mới:** `frontend/src/renderer/src/components/settings/admin-org-console-audit-tab.tsx`

Khung cơ bản: bảng + filter `from`/`to` (ngang hàng `AuditPage.tsx` cũ), gọi
`window.api.admin.queryAuditLog({ since })`. Filter `actor`/`outcome` là phạm vi của
[FE-SOL-003](./FE-SOL-003-audit-log-filter-actor-and-outcome.md) (CR-RBAC-005) — dựng khung trước,
thêm filter sau (2 CR độc lập theo file, phụ thuộc theo thời gian merge).

Sau khi tab này sống và đã thêm filter actor/outcome (FE-SOL-003), xoá:
`frontend/src/renderer/src/components/admin/AuditPage.tsx`,
`backend/src/main/admin/admin-audit-handlers.ts`, `backend/src/main/auth/audit-logger.ts` (chạy lại
`impact()` cho `AuditLogger` trước khi xoá — README ghi nhận 11 caller, cần rà kỹ, không chỉ admin
handlers).

### Bước 3 — Tab "Teams"

**File mới:** `frontend/src/renderer/src/components/settings/admin-org-console-teams-tab.tsx`

Chuyển từ `callRuntimeRpc('team.*')` sang `window.api.admin.listTeams/createTeam/addTeamMember/
removeTeamMember` (wscompat, mirror pattern trên) → `tenant-service`'s `CreateTeam`/`AddTeamMember`/
`RemoveTeamMember`/`ListTeamMembers`/`ListTeams` (đã có RPC theo audit gốc). Field `role` tự do
trên `TeamMember` (kiểu `Team = {id,name,createdAt,updatedAt}` ở `TeamAdmin.tsx` hiện tại — đã đọc
verbatim, không có role field trên `Team` type chính nó, chỉ `TeamMember` — xác nhận lại field này
khi cài đặt) cần khớp quyết định role model đã chốt ở FE-SOL-001/CR-RBAC-002 (role toàn cục chỉ
`developer|admin`, không có "lead" trên `TeamMember.role` nếu field này tồn tại).

Team đã tạo qua tab này chính là nguồn dữ liệu cho
[FE-SOL-002](./FE-SOL-002-remove-dead-server-visibility-selector-and-wire-team-grant.md)'s Team
grant picker — 2 solution dùng chung `TenantTeam` type và cùng chờ backend-go's team RPC expose.

### Bước 4 — Tab "Sessions"

**File mới:** `frontend/src/renderer/src/components/settings/admin-org-console-sessions-tab.tsx`

`window.api.admin.listSessionsForUser({ userId })`/`revokeSession({ sessionId })`/
`forceRevokeAllSessionsForUser({ userId })`. Lưu ý: `admin_routes.go`'s `handleListAllSessions` đã
đọc verbatim xác nhận **không có RPC "list tất cả session mọi user"** — chỉ
`ListSessionsForUser` (scoped theo 1 `user_id`, bắt buộc query param, trả 400 nếu thiếu, comment tại
chỗ: "Follow up with a real cross-user RPC (SOL-001) if the admin console actually needs the
all-users view live"). Tab Sessions ở `AdminOrgConsole` vì vậy nên thiết kế theo user đang chọn
(vd. nút "View sessions" trên mỗi row của `UsersTab`, mở panel Sessions cho đúng user đó) thay vì
bảng "tất cả session" như `SessionsPage.tsx` (Hệ B) cũ — đây là khác biệt UX nhỏ so với hành vi cũ,
cần thiết vì RPC không hỗ trợ; ghi decision này rõ trong code comment.

### Bước 5 — Users tab

**Không cần sửa gì** — xem Bối cảnh mục 1. Chỉ xác nhận lại 1 lần nữa bằng test khi merge.

### Bước 6 — Xoá Hệ B (sau khi 4 tab trên sống ổn định)

Trình tự xoá, **chạy `impact({target, direction:"upstream"})` cho từng symbol ngay trước khi xoá**:

| Symbol/File | Trước khi xoá phải xác nhận |
|---|---|
| `admin-main.tsx`, `AdminApp.tsx`, `AdminLayout.tsx`, `AdminDashboard.tsx` | Không còn route/bundle nào trỏ tới (kiểm tra `admin-index.html`/build config) |
| `admin-api-client.ts`, `UsersPage.tsx`, `UserForm.tsx` | Không còn import ngoài các file Hệ B khác đang xoá cùng đợt |
| `PoliciesPage.tsx`, `PolicyForm.tsx` | — |
| `TeamAdmin.tsx` | Sau khi Bước 3 sống ổn định |
| `SessionsPage.tsx` | Sau khi Bước 4 sống ổn định |
| `AuditPage.tsx` | Sau khi Bước 2 + FE-SOL-003 sống ổn định |
| `backend/src/main/admin/*` (4 handler file), `backend/src/main/team/TeamService.ts` + `team-rpc-handler.ts` | Backend-go, xem `AuditLogger`'s 11 caller — rà kỹ trước khi xoá `audit-logger.ts` |

### Bước 7 — Xác nhận `FleetDashboard`/`/ai-providers`/`/profile` (Hệ B) đã có tương đương

Theo audit gốc: `AdminDevServerConsole` (fleet), `ProviderList`, `CompanyProfileAdmin`/
`DeptProfileAdmin` đã tồn tại song song — xác nhận lại tính năng đủ khi implement, gộp nốt phần
thiếu nếu có (không kỳ vọng có gap lớn, vì các UI này thuộc Hệ A đã hoạt động).

## Files cần sửa

| File | Action |
|------|--------|
| `frontend/src/renderer/src/components/settings/AdminOrgConsole.tsx` | MODIFY — thêm `TabsTrigger`/`TabsContent` cho Policies/Teams/Sessions/Audit |
| `frontend/src/renderer/src/components/settings/admin-org-console-policies-tab.tsx` | CREATE |
| `frontend/src/renderer/src/components/settings/admin-org-console-teams-tab.tsx` | CREATE |
| `frontend/src/renderer/src/components/settings/admin-org-console-sessions-tab.tsx` | CREATE |
| `frontend/src/renderer/src/components/settings/admin-org-console-audit-tab.tsx` | CREATE (khung cơ bản — filter actor/outcome ở FE-SOL-003) |
| `frontend/src/renderer/src/web/web-preload-api.ts` | MODIFY — `createAdminApi()` thêm method cho Policies/Teams/Sessions/Audit |
| `frontend/src/preload/api-types.ts` | MODIFY — mở rộng namespace `admin` |
| `frontend/src/renderer/src/admin/admin-main.tsx` | DELETE (sau Bước 6) |
| `frontend/src/renderer/src/components/admin/*` (11 file, xem Bước 6) | DELETE (sau Bước 6) |
| `backend/src/main/admin/*`, `backend/src/main/team/*` | DELETE (backend-go/legacy, sau Bước 6, ngoài phạm vi review FE trực tiếp nhưng liệt kê vì cùng CR) |

## Verification (khi cài đặt)

```bash
cd frontend && npx tsc --noEmit -p tsconfig.json
cd frontend && npx vitest run src/renderer/src/components/settings/__tests__/AdminOrgConsole.test.tsx
```

Chạy `detect_changes({scope:"compare", base_ref:"main"})` trước khi commit từng bước (bước 1-4 là
additive, bước 6 là xoá — 2 loại thay đổi nên tách commit để `detect_changes` review dễ hơn).

## Không làm ở solution này

- Đổi UI/UX của các tab so với hành vi Hệ B cũ, **trừ** thay đổi bắt buộc do khác biệt RPC (Sessions
  tab theo-user thay vì all-users — xem Bước 4, ghi rõ lý do).
- Viết wscompat channel thật ở backend-go (`channels_admin_policies.go` v.v.) — solution này giả
  định các channel này tồn tại theo tên đã nêu; đây là phần việc backend-go cần làm song song,
  không phải "chỉ cutover FE" như CR gốc ngụ ý (xem Bối cảnh mục 3).
- Di trú dữ liệu lịch sử SQLite (`orca_access_policies`, `orca_teams`, `orca_audit_log`) — quyết
  định business, xem CR gốc's "Không thuộc phạm vi".
- Cập nhật `docs/features/F32-team-rbac.md` — đã thuộc phạm vi FE-SOL-001/FE-SOL-002.
