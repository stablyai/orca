| Solution | CR | Status |
|---|---|---|
| [FE-SOL-001](./FE-SOL-001-drop-lead-from-global-role-model.md) | CR-RBAC-002 | 🔲 Proposed |
| [FE-SOL-002](./FE-SOL-002-remove-dead-server-visibility-selector-and-wire-team-grant.md) | CR-RBAC-004 | 🔲 Proposed |
| [FE-SOL-003](./FE-SOL-003-audit-log-filter-actor-and-outcome.md) | CR-RBAC-005 | 🔲 Proposed |
| [FE-SOL-004](./FE-SOL-004-consolidate-admin-spa-into-admin-org-console.md) | CR-RBAC-001 | 🔲 Proposed |
| [FE-SOL-005](./FE-SOL-005-session-refresh-before-expiry.md) | CR-RBAC-003 | 🔲 Proposed |
| [FE-SOL-006](./FE-SOL-006-saml-login-option-backlog.md) | CR-RBAC-007 | 🔲 Proposed — Backlog |
| — | CR-RBAC-006 | Không có solution FE — xem "Ghi chú" bên dưới |

## Ghi chú

- **CR-RBAC-006** (wire `AccessPolicy` CRUD → OPA bundle thật, thay `policypublisher.NoopPublisher`)
  hoàn toàn backend-go (`common/policy/evaluator.go`, `adapter/policypublisher/`,
  `usecase/update_access_policy.go`) — không có file frontend nào trong "Changes Required" của CR
  gốc. FE-SOL-004 (CR-RBAC-001) chỉ cần **chờ** CR-RBAC-006 xong trước khi merge tab "Policies" vào
  `AdminOrgConsole` (nếu không, tab đó tạo ảo giác "đã cấu hình" giống hệt gap mà CR-006 mô tả) —
  xem cảnh báo trong FE-SOL-004's Bước 1.
- **Thứ tự thực thi khuyến nghị** (theo `docs/crs/v4/team-rbac/README.md`, áp dụng vào các solution
  ở đây):

  ```
  FE-SOL-001 (CR-RBAC-002 role model) ─┐
  FE-SOL-002 (CR-RBAC-004 server visibility) ├─ độc lập nhau, làm song song được
  FE-SOL-003 (CR-RBAC-005 audit filter — cần backend-go's outcome/actor_id trước) ─┘
                      │
                      ▼
  FE-SOL-004 (CR-RBAC-001 cutover Admin SPA) ← chờ backend-go's BE-SOL-006 (policy publish thật)
                      │                          + wscompat channel mới (xem FE-SOL-004 Bối cảnh #3)
  FE-SOL-005 (CR-RBAC-003 session refresh) ─── độc lập, không phụ thuộc các solution trên
                      │
  FE-SOL-006 (CR-RBAC-007 SAML) ──────────────── Backlog, chờ xác nhận business + FE-SOL-005 xong
  ```

- **Mỗi solution đã được viết lại dựa trên xác minh trực tiếp bằng `codegraph_explore`/
  `gitnexus impact()`** tại thời điểm viết (2026-09-09), không chỉ dựa vào tóm tắt audit ban đầu —
  một số chi tiết đã được cập nhật/sửa lại so với CR gốc sau khi verify (ví dụ: `AdminOrgConsole`'s
  `UsersTab` xác nhận đã đầy đủ create/deactivate/reactivate, không cần bổ sung — xem FE-SOL-004
  Bối cảnh #1; `OrcaUser.teams`/`.projects` có 1 consumer sống nhưng chính consumer đó
  (`UserProfileBadge.tsx`) cũng là dead code — xem FE-SOL-002 Bối cảnh #2). Mỗi solution ghi số liệu
  `impact()` thật trong mục "Impact analysis" của chính nó, không dùng số liệu suy đoán.
- Tất cả solution ở đây là **tài liệu thiết kế (chưa cài đặt)** — không có thay đổi code sản xuất
  nào đi kèm bộ solution này. Trạng thái "🔲 Proposed" áp dụng cho toàn bộ, khác quy ước
  "✅ Completed" đã dùng ở `specs/frontend/crs/v3/project-workspace/solutions/`.
