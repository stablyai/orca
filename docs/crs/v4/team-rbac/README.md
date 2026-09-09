# Team RBAC — Change Requests (v4)

> **Bối cảnh:** Yêu cầu "rà soát `backend-go` và `frontend` vì đã triển khai SSO và RBAC → tạo CR để thực
> hiện đầy đủ [F32](../../../features/F32-team-rbac.md)". F32 và CR gốc
> [CR-006](../../v1/remote-server/CR-006-team-rbac.md) được viết cho kiến trúc TS Electron cũ (`src/`);
> từ đó codebase đã chuyển sang `backend-go` (Go microservices, OPA/Rego) + `frontend` (Electron renderer
> hiện tại). Khảo sát bằng GitNexus/CodeGraph cho thấy: **SSO (OIDC/GitHub) và RBAC lõi (OPA/Rego theo
> project/repo, dev-server grant theo team/department) đã triển khai thật và đang chạy** — nhiều hơn những
> gì F32 gốc mô tả — nhưng **Admin UI/RBAC surface mà F32's acceptance criteria trỏ tới vẫn là một hệ
> song song, chưa nói chuyện với backend-go thật** (xem CR-RBAC-001). 7 CR dưới đây đóng từng gap cụ thể
> đã tìm thấy, độc lập với nhau ở mức triển khai nhưng cần đúng thứ tự khi cutover.

## Tổng quan gap đã xác nhận (bằng chứng chi tiết ở từng CR)

| Gap | Trạng thái thật | CR |
|-----|-----------------|-----|
| SSO OIDC/GitHub login | ✅ Đã hoàn chỉnh, có test (PKCE, account-linking) — không cần CR | — |
| SSO group→role mapping | ❌ Chưa có | CR-RBAC-003 |
| SSO token refresh | ❌ Chưa có (chỉ session issue/revoke) | CR-RBAC-003 |
| SSO SAML | ❌ 0% code | CR-RBAC-007 (backlog) |
| Role model 3 tier (developer/lead/admin) | ⚠️ UI giả định có, backend thật chỉ 2 tier (`user/admin`) — "lead" không thể tồn tại qua login thật | CR-RBAC-002 |
| Global-admin override ở project/repo RPC | ❌ Dead code — `callerGlobalRole` hard-code rỗng | CR-RBAC-002 |
| Policy admin sửa có hiệu lực | ❌ `PolicyDataPublisher` là `NoopPublisher` — write "thành công" nhưng không áp dụng | CR-RBAC-006 |
| Audit log outcome/ip + phủ hết service | ❌ Thiếu field `outcome`/`ip_address`; chỉ auth-service tự audit | CR-RBAC-005 |
| Server visibility theo team/project | ❌ 2 cơ chế đều chết (`selectSshTargetsForCurrentUser` dead code + input rỗng; Team grant ở infra-fleet-service luôn rỗng — BE-SOL-003) | CR-RBAC-004 |
| Admin UI (Users/Policies/Teams/Audit/Sessions) | ❌ Sống trên **legacy `backend/`** (SQLite + Unix-socket RPC), tách biệt hoàn toàn khỏi backend-go thật | CR-RBAC-001 |

| CR | Vấn đề | Priority | Effort | Status |
|----|--------|----------|--------|--------|
| [CR-RBAC-001](./CR-RBAC-001-consolidate-admin-surface-to-backend-go.md) | 2 Admin UI song song (legacy `backend/` vs backend-go), không liên thông | 🔴 P0 | Large | 🔲 Chưa triển khai |
| [CR-RBAC-002](./CR-RBAC-002-unify-role-model-and-propagate-claims.md) | Role model 3-tier ảo (UI) vs 2-tier thật (backend); `callerGlobalRole` dead code | 🔴 P0 | Medium | 🔲 Chưa triển khai |
| [CR-RBAC-003](./CR-RBAC-003-sso-group-role-mapping-and-token-refresh.md) | SSO Phase 2 còn thiếu group→role mapping + token refresh | 🟡 P1 | Medium | 🔲 Chưa triển khai |
| [CR-RBAC-004](./CR-RBAC-004-project-team-scoped-server-visibility.md) | Server visibility theo team/project: 2 cơ chế đều dead/rỗng | 🔴 P0 | Medium | 🔲 Chưa triển khai |
| [CR-RBAC-005](./CR-RBAC-005-audit-log-outcome-and-coverage.md) | Audit log thiếu outcome/ip, chỉ 1/5 service ghi audit | 🟡 P1 | Medium | 🔲 Chưa triển khai |
| [CR-RBAC-006](./CR-RBAC-006-live-policy-publish.md) | Policy CRUD thành công nhưng không có hiệu lực (NoopPublisher) | 🟠 P1 | Medium–Large | 🔲 Chưa triển khai |
| [CR-RBAC-007](./CR-RBAC-007-saml-support.md) | SAML — 0% code, effort lớn, cần product owner xác nhận nhu cầu | ⚪ P3 Backlog | Large | 🔲 Backlog |

## Thứ tự thực thi

```
CR-RBAC-002 (role model + claim propagation) ─┐
CR-RBAC-004 (server visibility)               ├─ độc lập nhau, làm song song được
CR-RBAC-005 (audit schema + coverage)         │
CR-RBAC-006 (policy publish thật)             ─┘
                    │
                    ▼
CR-RBAC-001 (cutover Admin UI → backend-go)   ← chạy SAU CÙNG, phụ thuộc 002/005/006
                    │
CR-RBAC-003 (SSO group mapping + refresh) ─── phụ thuộc CR-RBAC-002 (role model đã chốt)
                    │
CR-RBAC-007 (SAML) ─────────────────────────── Backlog, chờ xác nhận business, phụ thuộc CR-RBAC-003
```

## Impact analysis (gitnexus, chạy trước khi sửa — bắt buộc theo CLAUDE.md)

| Symbol sửa | Risk | Impacted count | CR |
|---|---|---|---|
| `callerGlobalRole` (`project-service/internal/usecase/authorization.go`) | MEDIUM | 30 (2 direct) | CR-RBAC-002 |
| `NoopPublisher` (`auth-service/internal/adapter/policypublisher/publisher.go`) | LOW | 3 (1 direct, 1 process ảnh hưởng) | CR-RBAC-006 |
| `AuditEntry` (`auth-service/internal/domain/audit.go`) | LOW | 14 (1 direct, 1 process ảnh hưởng) | CR-RBAC-005 |
| `AdminApp` (`frontend/.../admin/AdminApp.tsx`) | LOW | 1 direct (`admin-main.tsx`) | CR-RBAC-001 |

`selectSshTargetsForCurrentUser`, `OrcaUser`, và các symbol cụ thể khác của từng CR **chưa được chạy impact** ở bước khảo sát này — mỗi CR đã ghi rõ symbol cần chạy `impact()` lại ngay trước khi implement, theo đúng quy tắc bắt buộc của repo. Không CR nào trong bộ này được thực thi (code) trong lần rà soát này — toàn bộ 7 file trên là tài liệu đặc tả, chưa có thay đổi code nào.

## Việc chưa làm ngoài bộ CR này

- Cập nhật bảng "CRs" và mô tả role/scoping trong [F32-team-rbac.md](../../../features/F32-team-rbac.md) — vài CR (002, 004) đề xuất sửa F32.md như một phần acceptance criteria của chính CR đó, chưa sửa trước khi CR được duyệt/triển khai.
- Di trú dữ liệu lịch sử SQLite (`orca_access_policies`, `orca_teams`, `orca_audit_log`) sang backend-go trước khi xoá — quyết định business, xem "Không thuộc phạm vi" của CR-RBAC-001.
