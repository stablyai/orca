# FE-TASK-027: SAML — investigation/design-confirmation (Backlog P3, không implement)

**Domain:** team-rbac
**Solution Ref:** [FE-SOL-006](../solutions/FE-SOL-006-saml-login-option-backlog.md)
**CR:** [CR-RBAC-007](../../../../../../docs/crs/v4/team-rbac/CR-RBAC-007-saml-support.md)
**Priority:** ⚪ P3 Backlog
**Estimated:** 30 phút (chỉ xác nhận + ghi chú, không code)
**Status:** ✅ DONE — 2026-09-11 (investigation only, không code — đúng phạm vi Backlog P3)

## Kết quả thực tế

Không thể tự thay mặt product owner xác nhận nhu cầu SAML (bước 1 — quyết định business, ngoài phạm vi
AI thực thi) — mirror đúng cách `TASK-BE-028` xử lý cùng câu hỏi ở phía backend-go. Chỉ re-verify các
điểm kiến trúc kỹ thuật (bước 2), KHÔNG tự quyết định bỏ SAML khỏi F32.md (bước 3 — cần business chốt
trước).

**Re-verify 3 điểm kiến trúc còn treo (bằng grep/đọc code thật, không suy đoán):**

1. **Cơ chế định danh tenant cho SAML redirect — vẫn CHƯA chốt, xác nhận đúng như FE-SOL-006 ghi.**
   `SsoButton.tsx` hiện tại: `PROVIDER_CONFIG` cứng 3 provider (`github|google|keycloak`), `href="/auth/sso/${provider}"`
   — không có bước chọn/định danh tenant nào trong URL hay UI trước khi redirect. Thêm SAML (vốn cần
   biết tenant TRƯỚC khi build URL redirect tới đúng IdP metadata của tenant đó) sẽ cần thiết kế mới,
   chưa có nền tảng nào để tái dùng.
2. **UI quản trị group→role mapping (CR-RBAC-003) — XÁC NHẬN CHƯA TỒN TẠI.** Backend-go's
   `UpdateSsoGroupMapping`/`ListSsoGroupMapping` RPC đã có từ Wave 5 (TASK-BE-009), nhưng
   `grep -rln` toàn `frontend/src` cho các RPC này ra **0 kết quả** — chưa có tab/form admin nào gọi
   tới, nghĩa là mapping hiện chỉ có thể set qua gọi RPC trực tiếp (script/tool ngoài UI), không qua
   pattern config-file (không đúng giả định ban đầu của task này) và cũng không qua UI (chưa build).
   Nếu sau này làm SAML, group mapping của nó nên tái dùng đúng 2 RPC này (đã provider-agnostic, xác
   nhận từ TASK-BE-028), nhưng UI quản trị chung cho cả OIDC/GitHub/SAML **vẫn là 1 task riêng chưa có
   trong bộ 59 task đã thực thi**.
3. **`OrcaSsoConfig`** — xác nhận đã bị xoá sạch cùng `frontend/src/shared/rbac-types.ts` ở FE-TASK-010
   (`grep -rn "OrcaSsoConfig" frontend/src` → 0 kết quả). Nếu cần lại, phải định nghĩa type mới, không
   còn type cũ nào để kế thừa.

**Kết luận:** cả 3 điểm mở của FE-SOL-006 vẫn đúng nguyên vẹn, không có gì trôi dạt kể từ lúc soạn
solution. Không code gì được viết ở task này. Chưa cập nhật `docs/features/F32-team-rbac.md` (bước 3)
vì chưa có xác nhận business — nếu muốn xử lý dứt điểm, cần người có thẩm quyền quyết định trước.

## Mục tiêu

CR-RBAC-007 (SAML) là Backlog P3, Effort Large, 0% code hiện tại. FE-SOL-006 chỉ ở mức thiết kế sơ
bộ, cố tình **không** cụ thể hoá chi tiết — nhiệm vụ này mirror pattern
`TASK-AG-PW-001` (investigation-only task): xác nhận lại các điểm còn treo, KHÔNG sinh ra khối
lượng công việc implement giả định.

## Việc cần làm

1. **Xác nhận với product owner** (theo đúng "Khuyến nghị" của CR-RBAC-007 và FE-SOL-006) rằng nhu
   cầu SAML thực tế còn cấp thiết — OIDC hiện đã phủ hầu hết IdP enterprise hiện đại. Đây là bước
   business, không phải kỹ thuật.
2. Nếu xác nhận **có** nhu cầu, xác nhận lại các điểm kiến trúc chưa chốt trước khi tách task chi
   tiết:
   - Cơ chế định danh tenant cho SAML redirect (subdomain/slug trong URL vs bước chọn tenant trước
     khi redirect) — quyết định này quyết định hình dạng `PROVIDER_CONFIG`/`href` trong
     `SsoButton.tsx`, chưa thể viết code cụ thể trước khi chốt.
   - Xác nhận lại: UI quản trị group→role mapping của CR-RBAC-003 phần A có tồn tại hay chỉ qua
     env/config file (reload-on-restart)? Nếu chỉ config-file, SAML nên theo cùng pattern thay vì
     tự vẽ thêm UI mapping riêng.
   - Vị trí đúng cho `OrcaSsoConfig` type (nếu vẫn cần) sau khi `frontend/src/shared/rbac-types.ts`
     bị xoá ở FE-TASK-010 — xác nhận lại bằng `grep -rn "OrcaSsoConfig" frontend/src`.
3. Nếu xác nhận **không** có nhu cầu: cập nhật `docs/features/F32-team-rbac.md` bỏ SAML khỏi phạm
   vi, thay vì giữ solution doc treo vô thời hạn (ghi chú lại quyết định trong doc, không xoá
   FE-SOL-006/CR-RBAC-007 khỏi lịch sử).

## Files cần sửa

Không có thay đổi code ở task này. Nếu bước 3 xảy ra (quyết định không làm SAML):

| File | Action |
|------|--------|
| `docs/features/F32-team-rbac.md` | MODIFY (tài liệu) — bỏ SAML khỏi phạm vi, ghi chú lý do |

## Verify

Không có lệnh build/test — kết quả của task này là 1 trong 2 kết luận bằng văn bản (bước 2 hoặc
bước 3 ở trên), không phải code.

## Không làm ở task này

- Bất kỳ code thật nào cho SAML (`SsoButton.tsx`, `admin-org-console-sso-tab.tsx`) — chờ CR được
  lấy vào sprint thật với quyết định kiến trúc đã chốt.
- Tự quyết định cơ chế định danh tenant — đây là quyết định kiến trúc cross-team, không phải quyết
  định đơn phương ở mức 1 task nhỏ.

## Depends on

FE-TASK-026 (khuyến nghị FE-SOL-005/CR-RBAC-003's token refresh xong trước, để SAML tái dùng đúng
pattern group→role mapping đã tổng quát hoá — nếu có).

## Blocking

Không có.
