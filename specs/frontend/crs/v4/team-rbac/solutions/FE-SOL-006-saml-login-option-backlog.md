# FE-SOL-006: SAML — thêm option đăng nhập + admin cấu hình per-tenant metadata (Backlog, thiết kế sơ bộ)

> 🔲 Proposed — Backlog. Không triển khai chi tiết vì CR gốc cũng ở mức backlog, chờ product owner
> xác nhận nhu cầu trước khi đầu tư effort thiết kế đầy đủ.

## CR Reference

- **CR:** [CR-RBAC-007](../../../../../../docs/crs/v4/team-rbac/CR-RBAC-007-saml-support.md)
- **Mức độ:** ⚪ P3 Backlog, Effort Large
- **Phụ thuộc:** [FE-SOL-005](./FE-SOL-005-session-refresh-before-expiry.md) (CR-RBAC-003) nên xong
  trước — SAML nên tái dùng bảng group→role mapping đã tổng quát hoá ở đó, tránh viết 2 lần.

## Impact analysis (gitnexus, đã chạy lại)

| Symbol | Direction | Risk | Impacted | Ghi chú |
|---|---|---|---|---|
| `SsoButton` (`web/login/SsoButton.tsx`) | upstream | LOW | 1 (`LoginPage`) | Nơi thêm option SAML |

## Bối cảnh (đã xác nhận lại)

- `SsoButton.tsx` (đã đọc verbatim): hard-code `PROVIDER_CONFIG: Record<SsoProvider, {...}>` với
  đúng 3 key `github|google|keycloak`; render `<a href="/auth/sso/${provider}">` — full-page
  redirect, không phải fetch. `SsoProvider` type (`auth-types.ts`) cũng chỉ 3 giá trị này.
- `grep -rn "saml" frontend/src -i` không ra kết quả nào ngoài chính comment trong CR — xác nhận
  đúng "0% code SAML" như CR đã nêu, kể cả ở frontend.
- SAML khác OIDC/GitHub ở đúng điểm CR đã nêu: **cấu hình per-tenant** (mỗi công ty enterprise có
  metadata IdP riêng — URL/cert), trong khi OIDC hiện tại (`OrcaSsoConfig`,
  `frontend/src/shared/rbac-types.ts` — **lưu ý file này bị xoá ở FE-SOL-002 vì dead code, type
  `OrcaSsoConfig` nếu còn cần phải chuyển sang 1 file sống**, xác nhận lại vị trí đúng khi cài đặt)
  là 1 config chung toàn hệ thống. Đây là lý do UI admin cấu hình SAML **không thể** chỉ thêm 1 dòng
  vào `PROVIDER_CONFIG` như 3 provider hiện có — cần 1 màn hình admin riêng.

## Giải pháp (mức thiết kế sơ bộ — cụ thể hoá khi CR được lấy vào sprint)

### Phần 1 — Thêm option SAML vào màn login

**File:** `frontend/src/renderer/src/web/login/SsoButton.tsx` (MODIFY)

```tsx
// SsoProvider mở rộng thành union có 'saml' — nhưng khác 3 provider kia,
// SAML redirect cần biết "tenant nào" trước khi biết IdP nào (mỗi tenant 1
// IdP SAML riêng) — /auth/sso/saml không đủ thông tin như
// /auth/sso/github. Cần backend-go quyết định: định danh tenant qua
// subdomain/slug trong URL, hay 1 bước chọn tenant trước khi redirect.
// Ghi rõ quyết định này khi CR được lấy vào sprint — chưa chốt ở mức backlog.
type SsoProvider = 'github' | 'google' | 'keycloak' | 'saml'
```

Vì quyết định "định danh tenant cho SAML" chưa chốt, code sketch cho nhánh `saml` trong
`PROVIDER_CONFIG`/`href` KHÔNG viết cụ thể ở solution này — chỉ ghi nhận đây là điểm khác biệt kiến
trúc quan trọng nhất cần giải quyết trước khi implement thật (khác hẳn 3 provider hiện có, vốn
dùng chung 1 URL cho mọi tenant).

### Phần 2 — UI admin cấu hình per-tenant SAML metadata

**File mới (dự kiến):** `frontend/src/renderer/src/components/settings/admin-org-console-sso-tab.tsx`

Sống trong `AdminOrgConsole` (sau khi [FE-SOL-004](./FE-SOL-004-consolidate-admin-spa-into-admin-org-console.md)
cutover xong — tab mới này không nên thêm vào Hệ B sắp bị xoá). Form tối thiểu:
metadata URL hoặc XML paste, certificate fingerprint, ACS URL hiển thị (read-only, để admin copy
sang cấu hình IdP phía họ). Không thiết kế chi tiết field-by-field ở mức backlog này.

### Phần 3 — Group/attribute mapping tái dùng CR-RBAC-003

Theo đúng khuyến nghị CR gốc: không viết lại UI mapping riêng cho SAML — tái dùng bảng/UI đã xây
ở [FE-SOL-005](./FE-SOL-005-session-refresh-before-expiry.md)'s phần group→role (nếu solution đó mở
rộng UI quản trị mapping — hiện FE-SOL-005 chỉ làm phần token refresh; UI quản trị group→role mapping
của CR-RBAC-003 phần A hiện được backend-go thiết kế "qua env/config file, reload-on-restart" —
nghĩa là có thể **không có UI admin nào cho việc này ở cả CR-003** — xác nhận lại khi CR-003 được
implement, vì nếu đúng vậy, SAML cũng nên theo cùng pattern config-file thay vì tự vẽ thêm 1 UI).

## Files cần sửa (ước tính — cụ thể hoá khi CR được lấy vào sprint)

| File | Thay đổi |
|------|---------|
| `frontend/src/renderer/src/web/login/SsoButton.tsx` | Thêm provider `saml` — cần chốt cơ chế định danh tenant trước |
| `frontend/src/renderer/src/auth/auth-types.ts` | `SsoProvider` thêm `'saml'` |
| `frontend/src/renderer/src/components/settings/admin-org-console-sso-tab.tsx` | CREATE — UI cấu hình per-tenant metadata (sau FE-SOL-004) |

## Không làm ở solution này

- Bất kỳ code thật nào — đây là thiết kế sơ bộ cho 1 CR Backlog P3, đúng tinh thần "không chi tiết
  hoá sâu" mà nhiệm vụ yêu cầu.
- Quyết định cơ chế định danh tenant cho SAML redirect — cần chốt kiến trúc trước khi viết code
  (xem Phần 1), không phải quyết định kỹ thuật đơn phương ở mức solution doc.
- ACS endpoint, XML signing/parsing — backend-go (`crewjam/saml` theo đề xuất CR gốc).

## Khuyến nghị

Trước khi đầu tư thời gian cụ thể hoá solution này, xác nhận lại với product owner theo đúng
"Khuyến nghị trước khi làm" của CR-RBAC-007 — nhiều khả năng nhu cầu SAML thực tế không còn cấp
thiết (OIDC đã phủ hầu hết IdP enterprise hiện đại). Nếu quyết định không làm, cập nhật
`docs/features/F32-team-rbac.md` bỏ SAML khỏi phạm vi thay vì giữ solution doc này treo vô thời hạn.
