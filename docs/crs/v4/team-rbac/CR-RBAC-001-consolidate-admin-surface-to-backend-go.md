# CR-RBAC-001 — Gộp 2 Admin UI song song, chuyển toàn bộ về backend-go

| Trường | Giá trị |
|--------|---------|
| **CR ID** | CR-RBAC-001 |
| **Tên** | Retire Admin SPA khỏi legacy `backend/` — chuyển Users/Policies/Teams/Audit/Sessions sang backend-go |
| **Loại** | Architectural Change |
| **Priority** | 🔴 P0 (mọi CR khác trong bộ này phụ thuộc gián tiếp vào việc có 1 nguồn sự thật duy nhất) |
| **Effort** | Large (đây là CR "cutover" — chạy **sau cùng**, sau CR-RBAC-002/005/006) |
| **Phiên bản** | v1.1 |
| **Ngày tạo** | 2026-09-09 |
| **Trạng thái** | 🔲 Chưa triển khai — nay đã có giải pháp thực thi đầy đủ cả 2 tầng (xem "Cập nhật 2026-09-09") |
| **Tác giả** | Rà soát backend-go + frontend theo yêu cầu "đã triển khai SSO và RBAC → tạo CR để thực hiện đầy đủ F32" |
| **Tác động HLD** | C3.1 |
| **Tác động Features** | F32 (Team RBAC), F23 (Multi-User Auth), F25 (Admin Panel) |
| **Phụ thuộc** | CR-RBAC-002 (role model), CR-RBAC-005 (audit schema), CR-RBAC-006 (policy publish) nên xong trước khi cutover; **backend-go cần thêm wscompat channel mới trước khi frontend cutover được** — xem cập nhật bên dưới |

---

## Cập nhật 2026-09-09 — Backend-go cần thêm channel mới, không chỉ "trỏ lại RPC có sẵn"

Khi soạn giải pháp thực thi (FE-SOL-004 phía frontend, BE-SOL-001/008 phía backend-go), phát hiện 1 chi
tiết quan trọng làm rõ hơn (không thay đổi kết luận, nhưng thay đổi khối lượng việc backend-go thật sự
cần làm) so với mục "Changes Required" gốc bên dưới (lúc đó ghi "Không đổi code"):

- **`AdminOrgConsole.tsx` (Hệ A) gọi backend-go qua `window.api.admin.*` → tầng `wscompat`
  (`api-gateway/internal/adapter/wscompat/channels_admin_users.go`), KHÔNG phải qua `/admin/api/*` REST**
  (REST đó là của Hệ B — legacy `backend/src/main/admin/*`, hoàn toàn khác transport, khác cả kiến trúc).
- Tầng wscompat hiện **chỉ có channel cho Users** (`admin.createUser/.listUsers/.updateUserRole/
  .deactivateUser/.reactivateUser`). Chưa có channel nào cho Policies/Sessions/Audit/Teams dù các RPC gRPC
  tương ứng ở `auth-service`/`tenant-service` đã tồn tại đầy đủ (xác nhận bởi BE-SOL-001's RPC audit).
- Vậy bước 1–4 trong "Giải pháp đề xuất" bên dưới không chỉ là "trỏ FE sang RPC có sẵn" mà cần backend-go
  **thêm 4 file wscompat channel mới** (`channels_admin_{policies,sessions,audit,teams}.go`, 14 channel) —
  đã thiết kế đầy đủ ở [BE-SOL-008](../../../../specs/backend-go/crs/v4/team-rbac/solutions/BE-SOL-008-admin-wscompat-channels-policies-sessions-audit-teams.md).
- BE-SOL-001 cũng phát hiện 1 gap RPC nhỏ: `ForceRevokeSession` (kill 1 session cụ thể, khác
  `ForceRevokeAllSessionsForUser`) có thể chưa tồn tại ở `auth-service` — cần xác nhận và bổ sung nếu đúng
  (xem BE-SOL-001 §3).

**Chi tiết đầy đủ đã có giải pháp thực thi**, xem:
[BE-SOL-001](../../../../specs/backend-go/crs/v4/team-rbac/solutions/BE-SOL-001-admin-rpc-surface-audit.md),
[BE-SOL-008](../../../../specs/backend-go/crs/v4/team-rbac/solutions/BE-SOL-008-admin-wscompat-channels-policies-sessions-audit-teams.md),
[FE-SOL-004](../../../../specs/frontend/crs/v4/team-rbac/solutions/FE-SOL-004-consolidate-admin-spa-into-admin-org-console.md),
task thực thi ở `specs/{backend-go,frontend}/crs/v4/team-rbac/tasks/`.

---

## Bối cảnh & Vấn đề (nguyên trạng lúc audit ban đầu — giữ nguyên để tham chiếu lịch sử, xem mục cập nhật ở trên cho chi tiết mới nhất)

Rà soát `backend-go/` + `frontend/` cho thấy Orca hiện có **2 hệ RBAC/Admin hoàn toàn song song, không liên thông**:

### Hệ A — backend-go (đúng kiến trúc hiện tại, dùng cho SSO + 1 phần Settings)

- `auth-service`: OIDC/GitHub SSO thật (`start_sso_login.go`, `oidc.go`, `github.go`), user/role (`domain.Role = user|admin`), `AccessPolicy` (versioned JSON, `access_policy.go`), audit (`domain.AuditEntry`), session, tất cả qua gRPC + api-gateway HTTP (`/auth/*`).
- `tenant-service`: `Team`/`TeamMember`/`Department`/`Company` (gRPC).
- `project-service`: `ProjectRole owner|member`, `RepoRole developer|lead|admin`, enforce qua OPA/Rego (`backend-go/policy/orca-authz/*.rego`).
- `infra-fleet-service`: `DevServerGroup`/`DevServerGroupGrant` — RBAC thật cho việc thấy/không thấy dev server.
- Frontend: `frontend/src/renderer/src/components/settings/AdminOrgConsole.tsx` (Company/Departments/Users tab, đã gọi `updateUserRole`) và `AdminDevServerConsole.tsx` (Approvals/Groups & access/Access requests) — **nhúng trong Settings của app chính**, gọi thẳng backend-go.

### Hệ B — legacy Electron `backend/` (kiến trúc cũ, TASK-FE-013/014, tiền thân của CR-006)

- Route riêng: `frontend/src/renderer/src/admin/admin-main.tsx` mount `AdminApp` (`frontend/src/renderer/src/components/admin/AdminApp.tsx:78`) — **1 SPA độc lập**, khác hẳn `Settings.tsx`.
- Toàn bộ data layer đi qua `admin-api-client.ts`'s `adminFetch()` → `/admin/api/*` — do `backend/src/main/admin/admin-policy-handlers.ts` (và các handler `admin-user-handlers.ts`, `admin-session-handlers.ts`, `admin-audit-handlers.ts` tương tự) phục vụ, ghi vào **SQLite** (`orca_access_policies`, `orca_audit_log`) của app Electron cũ — không phải Postgres của backend-go.
- Tab "Teams" (`TeamAdmin.tsx`) lại dùng transport thứ 3: `callRuntimeRpc('team.*', …)` → `backend/src/main/runtime/runtime-rpc.ts` (Unix-socket RPC) → `backend/src/main/team/TeamService.ts` → bảng SQLite `orca_teams`/`orca_team_members` — **khác cả REST lẫn khác gRPC tenant-service**.
- `PoliciesPage`/`PolicyForm` implement policy model `{teams, roles, allowedServers, canCreateWorktrees, canDeleteWorktrees, canAccessProduction}` — không phải OPA/Rego, không phải `AccessPolicy` của auth-service.

**Hệ quả cụ thể:**

1. Admin sửa role/policy/team trong `AdminApp` (Hệ B) **không có tác dụng gì** với OPA/Rego enforcement thật đang chạy ở backend-go (Hệ A) — 2 nguồn dữ liệu độc lập, dễ gây ảo giác "đã cấu hình" trong khi hệ thống thật không đọc dữ liệu đó.
2. `UsersPage`(Hệ B) cho chọn role `developer/lead/admin`, nhưng `auth-service` (Hệ A) chỉ có 2 role thật `user/admin` — một `AdminUser` role="lead" tạo ra ở Hệ B không tương ứng với bất kỳ user thật nào ở Hệ A (2 bảng user khác nhau, chưa xác nhận có đồng bộ hay không).
3. `orca_audit_log` (Hệ B, SQLite) và `auth.audit_log` (Hệ A, Postgres) là 2 audit trail tách biệt — không có nơi nào cho admin xem "toàn bộ" audit trail của hệ thống.
4. F32's acceptance criteria ("Admin panel hiển thị roles, promote/demote UI", "Audit log table filter") về hình thức đã ✅ ở Hệ B, nhưng vì Hệ B không nói chuyện với backend-go, tiêu chí đó **không phản ánh RBAC thật đang bảo vệ hệ thống**.

## Giải pháp đề xuất

**Retire Hệ B, không xây thêm 1 UI mới — mở rộng Hệ A cho đủ những gì Hệ B có mà Hệ A còn thiếu**, cụ thể theo thứ tự (mỗi gạch đầu dòng ứng với 1 CR khác trong bộ, xem "Thứ tự thực thi" ở README):

1. `AccessPolicy` (auth-service) đã có CRUD RPC — chỉ thiếu publish-to-OPA thật (CR-RBAC-006). Sau khi xong, **xoá `PoliciesPage`/`PolicyForm`/`admin-policy-handlers.ts`**, thêm 1 tab "Policies" vào `AdminOrgConsole.tsx` gọi thẳng `CreateAccessPolicy`/`ListAccessPolicies`/`UpdateAccessPolicy`/`DeleteAccessPolicy`.
2. `QueryAuditLog` (auth-service) sau khi có `outcome`/`ip_address`/filter đầy đủ (CR-RBAC-005) → thêm tab "Audit Log" vào `AdminOrgConsole.tsx`, **xoá `AuditPage.tsx` + `admin-audit-handlers.ts` + bảng `orca_audit_log` SQLite** (di trú dữ liệu cũ nếu cần giữ lịch sử — xem "Không thuộc phạm vi").
3. `TeamAdmin.tsx` chuyển từ `callRuntimeRpc('team.*')` sang gọi `tenant-service`'s `CreateTeam`/`AddTeamMember`/`RemoveTeamMember`/`ListTeamMembers`/`ListTeams` (qua api-gateway, cùng cách `AdminOrgConsole` đang gọi departments) — merge UI này vào `AdminOrgConsole` như 1 tab "Teams". Field `role` tự do trên `TeamMember` cần khớp với quyết định của CR-RBAC-002 (Team có role hay không).
4. `SessionsPage.tsx` (list/kill session) map sang `ListSessionsForUser`/`RevokeSession`/`ForceRevokeAllSessionsForUser` (auth-service RPC đã có sẵn) — thêm tab "Sessions".
5. `UsersPage.tsx`/`UserForm.tsx` map sang `ListUsers`/`UpdateUserRole`/`DeactivateUser`/`ReactivateUser` (auth-service) — hợp nhất với `AdminOrgConsole`'s Users tab đã có sẵn (tab này **đã** gọi `updateUserRole` — chỉ cần bổ sung create/deactivate/reactivate nếu còn thiếu, kiểm tra lại khi cài đặt).
6. Sau khi 5 tab trên đã sống trong `AdminOrgConsole` (nhúng trong Settings, không cần route/bundle riêng), **xoá hẳn**: `frontend/src/renderer/src/admin/admin-main.tsx`, `AdminApp.tsx`, `AdminLayout.tsx`, `AdminDashboard.tsx`, `admin-api-client.ts`, `UsersPage.tsx`, `UserForm.tsx`, `PoliciesPage.tsx`, `PolicyForm.tsx`, `TeamAdmin.tsx`, `SessionsPage.tsx`, `AuditPage.tsx`; và backend `backend/src/main/admin/*` (`admin-policy-handlers.ts`, `admin-user-handlers.ts`, `admin-session-handlers.ts`, `admin-audit-handlers.ts`, `audit-logger.ts`), `backend/src/main/team/TeamService.ts` + `team-rpc-handler.ts`, cùng các migration liên quan (giữ migration là history, không xoá ngược — chỉ ngừng ghi/đọc).
7. `FleetDashboard`, `/ai-providers`, `/profile` (company/dept) trong `AdminApp` **đã có tương đương** ở Settings hiện tại (`AdminDevServerConsole` cho fleet, `ProviderList`, `CompanyProfileAdmin`/`DeptProfileAdmin`) — xác nhận song song, gộp nốt nếu còn thiếu tính năng.

## Changes Required

| Layer | File | Thay đổi |
|-------|------|---------|
| Frontend | `components/settings/AdminOrgConsole.tsx` | Thêm tab Policies/Teams/Sessions/Audit |
| Frontend | `components/admin/*` (11 file liệt kê ở bước 6) | Xoá sau khi cutover xong |
| Frontend | `admin/admin-main.tsx` | Xoá entry point riêng |
| Frontend | `preload/api-types.ts`, `web/web-preload-api.ts` | Thêm 14 method signature `window.api.admin.*` mới |
| Backend (legacy) | `backend/src/main/admin/*`, `backend/src/main/team/*` | Xoá sau khi cutover xong |
| Backend-go | `services/auth-service` | Không đổi domain/usecase — chỉ cần CR-RBAC-005/006 xong trước; **có thể cần thêm `ForceRevokeSession` RPC** nếu BE-SOL-001 §3 xác nhận gap thật |
| Backend-go | `services/tenant-service` | Không đổi code cho CR này — CR-RBAC-002 xử lý role trên Team |
| Backend-go | `services/api-gateway/internal/adapter/wscompat/channels_admin_{policies,sessions,audit,teams}.go` (mới) | **Cập nhật 2026-09-09**: 4 file mới, 14 channel — xem BE-SOL-008 |

## Không thuộc phạm vi CR này

- **Di trú dữ liệu lịch sử** (`orca_access_policies`, `orca_teams`, `orca_audit_log` SQLite → Postgres backend-go) — quyết định business (có cần giữ audit trail cũ không) nằm ngoài phạm vi kỹ thuật CR này; nếu cần, tách thành CR riêng "one-off migration script" trước khi xoá bảng.
- Đổi UI/UX của các tab (giữ nguyên hành vi, chỉ đổi transport) — tránh gộp thay đổi UX vào 1 CR đã đủ rủi ro do đổi kiến trúc.

## Impact analysis (gitnexus)

| Symbol | Risk | Ghi chú |
|---|---|---|
| `AdminApp` (`frontend/.../admin/AdminApp.tsx`) | LOW (1 direct: `admin-main.tsx`) | Xoá an toàn sau khi cutover — không ai khác import |
| `AuditLogger` (`backend/src/main/admin/audit-logger.ts`) | 11 callers — cần rà kỹ trước khi xoá (không chỉ admin handlers) |
| `OrcaRuntimeRpcServer`/`team.*` handlers | 5 callers qua `server-bootstrap.ts` — xoá `team.*` cần đảm bảo không route nào khác (CLI `orca team …`?) còn phụ thuộc |

Chạy lại `impact({target, direction:"upstream"})` cho từng symbol **ngay trước khi xoá**, theo đúng quy tắc bắt buộc của repo.

## Liên quan

- [F32-team-rbac.md](../../../features/F32-team-rbac.md)
- [CR-006-team-rbac.md](../../v1/remote-server/CR-006-team-rbac.md) — Phase 1 gốc, chính là Hệ B đang bị retire ở CR này
- [CR-RBAC-002](./CR-RBAC-002-unify-role-model-and-propagate-claims.md), [CR-RBAC-005](./CR-RBAC-005-audit-log-outcome-and-coverage.md), [CR-RBAC-006](./CR-RBAC-006-live-policy-publish.md)
- [BE-SOL-001](../../../../specs/backend-go/crs/v4/team-rbac/solutions/BE-SOL-001-admin-rpc-surface-audit.md) — audit RPC surface, phát hiện gap `ForceRevokeSession`
- [BE-SOL-008](../../../../specs/backend-go/crs/v4/team-rbac/solutions/BE-SOL-008-admin-wscompat-channels-policies-sessions-audit-teams.md) — thiết kế 14 wscompat channel còn thiếu
- [FE-SOL-004](../../../../specs/frontend/crs/v4/team-rbac/solutions/FE-SOL-004-consolidate-admin-spa-into-admin-org-console.md) — giải pháp cutover phía frontend
- Task thực thi: `specs/backend-go/crs/v4/team-rbac/tasks/` (TASK-BE-001/002/029-032), `specs/frontend/crs/v4/team-rbac/tasks/` (FE-TASK-017-024)
