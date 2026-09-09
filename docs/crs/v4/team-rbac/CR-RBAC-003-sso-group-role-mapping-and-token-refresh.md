# CR-RBAC-003 — SSO: group→role mapping + token refresh

| Trường | Giá trị |
|--------|---------|
| **CR ID** | CR-RBAC-003 |
| **Tên** | Hoàn thiện F32 Phase 2 (SSO) — group-to-role mapping, token refresh |
| **Loại** | Feature Completion |
| **Priority** | 🟡 P1 |
| **Effort** | Medium (3–4 ngày) |
| **Phiên bản** | v1.0 |
| **Ngày tạo** | 2026-09-09 |
| **Trạng thái** | 🔲 Chưa triển khai |
| **Tác giả** | Rà soát backend-go SSO theo yêu cầu hoàn thiện F32 |
| **Tác động HLD** | C3.1 |
| **Tác động Features** | F32, F23 |
| **Phụ thuộc** | CR-RBAC-002 nên xong trước (mapping group→role cần role model đã chốt) |

---

## Bối cảnh & Vấn đề

Khảo sát `backend-go/services/auth-service` xác nhận **OIDC/GitHub login flow đã hoàn chỉnh và có test** (PKCE S256, state codec, account-linking, unverified-email rejection — `start_sso_login.go`, `complete_sso_login.go`, `login_or_provision_sso_user.go` + test). Đây là phần lớn nhất và khó nhất của F32 Phase 2 đã xong — không phải làm lại. Còn thiếu đúng 2 mảnh so với F32 Phase 2:

1. **Group→role mapping**: `VerifiedSsoIdentity` (`backend-go/services/auth-service/internal/usecase/ports.go:200-206`) chỉ có `{Provider, Subject, Email, EmailVerified, Name}` — không có `Groups []string`. Cả `github.go` và `oidc.go` không đọc claim `groups`/tổ chức GitHub nào. `LoginOrProvisionSsoUser` không có nhánh gán role theo group. F32 Phase 2 yêu cầu: SSO group "orca-admins" → role admin, v.v.
2. **Token refresh**: `domain.Session` (`backend-go/services/auth-service/internal/domain/session.go:29`) không có refresh-token field, chỉ `token_hash`/`expires_at`/`revoked_at`. Comment tại `IssueServiceToken` (`adapter/grpc/server.go:137-139`) tự nhận: *"the fuller IssueToken/RefreshToken/RevokeToken surface"* chưa có. Hệ quả: session Orca hết hạn → user phải đăng nhập lại thủ công, không có silent renew.

(SAML — mảnh thứ 3 của Phase 2 — tách riêng thành CR-RBAC-007 vì effort/priority khác hẳn, xem README.)

## Giải pháp đề xuất

### A. Group → role mapping

1. Mở rộng `VerifiedSsoIdentity` thêm `Groups []string`.
2. `oidc.go`: đọc claim `groups` (hoặc claim tên cấu hình được, vì mỗi IdP đặt tên khác nhau — Keycloak mặc định `groups`, Google Workspace cần Directory API riêng nên **chỉ hỗ trợ OIDC/Keycloak ở CR này**, Google ghi rõ "not supported, no group claim in standard OIDC token" trong doc).
3. `github.go`: đọc org membership qua GitHub API (`GET /user/orgs` hoặc `GET /orgs/{org}/teams/{team}/memberships/{username}`) làm "groups" tương đương.
4. Thêm bảng cấu hình `sso_group_role_mapping` (provider, group_name → role) — quản lý qua 1 RPC mới `UpdateSsoGroupMapping`/`ListSsoGroupMapping` trên `AuthService`, hoặc đơn giản hơn: mở rộng `SsoProvidersConfig` bằng env/config file nếu business chấp nhận reload-on-restart (nhất quán với cách OPA bundle đang hoạt động — xem CR-RBAC-006 nếu muốn hot-reload).
5. `LoginOrProvisionSsoUser`: sau khi có `Groups`, map qua bảng trên → set `domain.Role` khi **tạo mới** user; với user đã tồn tại, mặc định **không tự động hạ quyền** một admin thủ công xuống user chỉ vì rời group (tránh lock-out ngoài ý muốn) — chỉ tự động **nâng** quyền theo group, hạ quyền do group vẫn cần thao tác admin thủ công. Ghi rõ quyết định này trong code comment vì đây là quyết định an ninh có chủ đích.

### B. Token refresh

1. Thêm `RefreshToken`/`RefreshTokenHash`/`RefreshExpiresAt` vào `domain.Session`.
2. Thêm RPC `RefreshSession` (auth-service) + route `POST /auth/refresh` (api-gateway) — nhận session sắp hết hạn (còn hợp lệ, chưa revoke) → issue session mới, revoke session cũ (rotation, chống replay).
3. Frontend: `frontend/src/renderer/src/auth/auth-api-client.ts` gọi `/auth/refresh` khi nhận 401 gần hết hạn (hoặc theo lịch định kỳ) trước khi tự động đăng xuất.
4. Không lưu OAuth `refresh_token` gốc của IdP (Google/GitHub/OIDC) trong CR này — phạm vi chỉ là refresh **session của Orca**, không phải renew OAuth token với IdP (giữ đúng comment sẵn có ở `auth-api-client.ts`: không giữ token phía client).

## Changes Required

| File | Thay đổi |
|------|---------|
| `backend-go/services/auth-service/internal/usecase/ports.go` | `VerifiedSsoIdentity` thêm `Groups []string` |
| `backend-go/services/auth-service/internal/adapter/oauth/oidc.go` | Đọc claim `groups` từ ID token/userinfo |
| `backend-go/services/auth-service/internal/adapter/oauth/github.go` | Đọc org/team membership |
| `backend-go/services/auth-service/internal/usecase/login_or_provision_sso_user.go` | Nhánh gán role theo group (chỉ nâng quyền) |
| `backend-go/services/auth-service/internal/domain/session.go` | Thêm refresh-token fields |
| `backend-go/services/auth-service/internal/adapter/grpc/server.go` | RPC `RefreshSession` |
| `backend-go/services/api-gateway/internal/adapter/httpgateway/auth_routes.go` | `POST /auth/refresh` |
| `frontend/src/renderer/src/auth/auth-api-client.ts` | Gọi refresh trước khi hết hạn |
| Config | `SsoProvidersConfig` (hoặc bảng DB mới) cho group→role mapping |

## Không thuộc phạm vi CR này

- SAML (CR-RBAC-007).
- Google Workspace group mapping qua Directory API (cần OAuth scope + service account riêng, effort lớn hơn hẳn — để backlog nếu có nhu cầu thật).
- Renew OAuth token với IdP gốc (chỉ refresh session nội bộ Orca).

## Tiêu chí chấp nhận

- [ ] User đăng nhập OIDC/Keycloak thuộc group đã map → được gán đúng role khi tài khoản được tạo lần đầu.
- [ ] User đăng nhập GitHub thuộc org/team đã map → tương tự.
- [ ] Session sắp hết hạn tự refresh không cần user đăng nhập lại; session bị revoke thì refresh thất bại rõ ràng (403), không silently issue token mới.
- [ ] Test: group mapping không tự động hạ quyền user hiện có.

## Liên quan

- [F32-team-rbac.md](../../../features/F32-team-rbac.md) §Phase 2
- CR-RBAC-002 (role model phải chốt trước khi map group→role)
- CR-RBAC-007 (SAML, tách riêng)
