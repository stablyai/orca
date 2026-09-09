# CR-RBAC-007 — SAML provider support (backlog)

| Trường | Giá trị |
|--------|---------|
| **CR ID** | CR-RBAC-007 |
| **Tên** | Thêm SAML bên cạnh OIDC/GitHub đã có |
| **Loại** | Feature (mới hoàn toàn) |
| **Priority** | ⚪ P3 — Backlog, chỉ làm khi có khách hàng/enterprise yêu cầu cụ thể |
| **Effort** | Large (5–7 ngày — SAML phức tạp hơn hẳn OIDC: XML signing/encryption, metadata exchange, ACS endpoint, clock-skew handling) |
| **Phiên bản** | v1.0 |
| **Ngày tạo** | 2026-09-09 |
| **Trạng thái** | 🔲 Chưa triển khai — Backlog |
| **Tác giả** | Rà soát backend-go SSO theo yêu cầu hoàn thiện F32 |
| **Tác động HLD** | C3.1 |
| **Tác động Features** | F32 |
| **Phụ thuộc** | CR-RBAC-003 (group→role mapping nên tổng quát hoá đủ để tái dùng cho SAML assertion attributes, tránh viết 2 lần) |

---

## Bối cảnh & Vấn đề

F32 Phase 2 liệt kê SAML cạnh OIDC như 2 lựa chọn ngang hàng. Khảo sát xác nhận: **0% code liên quan SAML tồn tại trong `backend-go/`** — tìm kiếm toàn repo (case-insensitive "saml") chỉ ra kết quả trong tài liệu (chính F32, roadmap, C4 doc), không có trong code. Trong khi đó OIDC/GitHub đã hoàn chỉnh, có test, đang chạy production.

**Đây là CR có effort/priority khác hẳn phần còn lại của bộ** — tách riêng để không làm chậm 6 CR còn lại (vốn đều là "hoàn thiện cái đã có 80%"), trong khi SAML là "xây từ 0".

## Khuyến nghị trước khi làm

Trước khi implement, xác nhận lại với business: SAML chủ yếu cần cho các tổ chức enterprise dùng ADFS/Okta-SAML/Azure AD (SAML mode) mà **không hỗ trợ OIDC** — nhiều IdP hiện đại (Okta, Azure AD, Keycloak, Google) đều hỗ trợ OIDC song song, nên nhu cầu SAML thực tế có thể không còn cấp thiết như lúc F32 được viết. Nếu không có khách hàng cụ thể yêu cầu, cân nhắc **đóng gap này bằng cách sửa F32.md** (bỏ SAML khỏi phạm vi, hoặc hạ xuống "nice to have") thay vì implement — quyết định này nên do product owner chốt, không phải kỹ thuật đơn phương.

## Giải pháp đề xuất (nếu quyết định làm)

1. Thêm `SsoExchanger` implementation mới cho SAML (interface đã tồn tại ở `backend-go/services/auth-service/internal/usecase/ports.go`, hiện có `github.go`/`oidc.go` implement — SAML là implementation thứ 3 của cùng interface, tái dùng được toàn bộ `LoginOrProvisionSsoUser`/session issuance).
2. Dùng thư viện SAML SP đã kiểm chứng (vd. `crewjam/saml` cho Go) thay vì tự viết XML signing/parsing.
3. Endpoint ACS (Assertion Consumer Service) mới ở api-gateway, song song `/auth/callback` hiện có.
4. Đọc SAML attribute tương đương "groups" để tái dùng mapping đã xây ở CR-RBAC-003 (không viết lại logic map group→role riêng cho SAML).
5. `SsoButton.tsx` (frontend, hoặc UI tương đương sau CR-RBAC-001): thêm option "SAML" — nhưng vì SAML thường cấu hình per-tenant (mỗi công ty enterprise có metadata IdP riêng), cần UI admin để nhập SAML metadata URL/cert — khác hẳn OIDC discovery hiện tại (1 URL chung).

## Changes Required (ước tính — sẽ cụ thể hoá khi CR được lấy vào sprint)

| File | Thay đổi |
|------|---------|
| `backend-go/services/auth-service/internal/adapter/oauth/` (hoặc thư mục mới `adapter/saml/`) | Implementation `SsoExchanger` cho SAML |
| `backend-go/services/auth-service/internal/config/config.go` | `SsoProvidersConfig` thêm SAML (metadata URL/cert, không chỉ client ID/secret) |
| `backend-go/services/api-gateway/internal/adapter/httpgateway/auth_routes.go` | Endpoint ACS |
| Frontend | UI chọn SAML + admin cấu hình per-tenant metadata |

## Tiêu chí chấp nhận (khi được lấy vào sprint)

- [ ] Login qua SAML IdP thật (test với ít nhất 1 IdP — Okta hoặc Azure AD SAML mode) thành công end-to-end.
- [ ] Group/attribute mapping tái dùng bảng đã có ở CR-RBAC-003.
- [ ] Test chữ ký SAML assertion giả mạo bị từ chối (an ninh — đây là lớp tấn công phổ biến nhất của SAML SP triển khai sai).

## Liên quan

- [F32-team-rbac.md](../../../features/F32-team-rbac.md) §Phase 2
- CR-RBAC-003 (nền tảng group→role mapping)
