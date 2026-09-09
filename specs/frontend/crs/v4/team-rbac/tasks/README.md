# Tasks — CR series `team-rbac` (v4)

**Nguồn:** [solutions/](../solutions/)
**Mục tiêu:** Chia 6 solution FE thành 27 task nhỏ, độc lập, AI có thể thực thi tuần tự từng cái mà
không cần đọc lại toàn bộ solution gốc.
**Trạng thái:** ✅ Toàn bộ 27/27 task đã DONE (Sprint 1: 001-004, 006-010, 022, 024-026 —
2026-09-09; Sprint 1.5: 005, 011, 012, 013 — 2026-09-09; Sprint 2/3: 014-017, 019-021 — 2026-09-09/11;
Sprint 4: 018, 023 — 2026-09-11; Sprint 5: 027 — 2026-09-11). Không còn task nào ⚠️ chờ backend-go —
FE-TASK-014/015/017's backend-go dependency đã hết (TASK-BE-016/029-032 đều DONE). FE-TASK-018 DONE
nhưng vẫn hiển thị banner cảnh báo trong UI vì backend-go's CR-RBAC-006 (`NoopPublisher` →
implementation thật) chưa merge — xem file task đó trước khi gỡ banner.
FE-TASK-024 (verify-only) phát hiện gap thật giữa Hệ B và Hệ A ở 3 route fleet/ai-providers/profile
— xem file task để biết chi tiết trước khi chạy FE-TASK-023. FE-TASK-011/012 (Sprint 1.5) phát hiện
premise gốc "chưa có API liệt kê teams" đã lỗi thời: backend-go's `team.list` wscompat channel đã
sống (wired vào `RegisterRealChannels`) — gap thật còn lại chỉ là 1 dòng bridge chưa thêm ở
`frontend/src/renderer/src/web/web-preload-api.ts` (ngoài phạm vi 2 task này), không phải chờ
backend-go nữa — xem "Kết quả thực tế" trong từng file.

---

## Danh sách Tasks

| ID | Solution | CR | Tiêu đề | Priority | Status |
|----|----------|----|---------|----------|--------|
| [FE-TASK-001](./FE-TASK-001-drop-lead-role-types.md) | FE-SOL-001 | CR-RBAC-002 | Bỏ `'lead'` khỏi `OrcaUserRole`/`AuthUser.role` | 🔴 P0 | ✅ DONE |
| [FE-TASK-002](./FE-TASK-002-userrolebadge-drop-lead-label.md) | FE-SOL-001 | CR-RBAC-002 | `UserRoleBadge.tsx` bỏ nhãn "lead" | 🔴 P0 | ✅ DONE |
| [FE-TASK-003](./FE-TASK-003-preload-ipc-drop-lead.md) | FE-SOL-001 | CR-RBAC-002 | Preload type + `onAuthStateChanged` bỏ "lead" | 🔴 P0 | ✅ DONE |
| [FE-TASK-004](./FE-TASK-004-legacy-admin-spa-drop-lead.md) | FE-SOL-001 | CR-RBAC-002 | Hệ B (Admin SPA cũ) bỏ role "lead" | 🔴 P0 | ✅ DONE |
| [FE-TASK-005](./FE-TASK-005-f32-doc-role-model-update.md) | FE-SOL-001 | CR-RBAC-002 | F32 doc — bảng Role 2-tier/3-tier | 🔴 P0 | ✅ DONE |
| [FE-TASK-006](./FE-TASK-006-remove-dead-ssh-target-selector.md) | FE-SOL-002 | CR-RBAC-004 | Xoá `selectSshTargetsForCurrentUser` (dead) | 🔴 P0 | ✅ DONE |
| [FE-TASK-007](./FE-TASK-007-orcauser-drop-teams-projects.md) | FE-SOL-002 | CR-RBAC-004 | `OrcaUser` bỏ field `teams`/`projects` | 🔴 P0 | ✅ DONE |
| [FE-TASK-008](./FE-TASK-008-webroot-drop-teams-projects.md) | FE-SOL-002 | CR-RBAC-004 | `WebRoot`'s `useEffect` bỏ `teams`/`projects` | 🔴 P0 | ✅ DONE |
| [FE-TASK-009](./FE-TASK-009-ipc-event-drop-teams-projects.md) | FE-SOL-002 | CR-RBAC-004 | `useIpcEvents.ts` + preload bỏ `teams`/`projects` | 🔴 P0 | ✅ DONE |
| [FE-TASK-010](./FE-TASK-010-delete-dead-rbac-files.md) | FE-SOL-002 | CR-RBAC-004 | Xoá `UserProfileBadge.tsx` + `shared/rbac-types.ts` | 🔴 P0 | ✅ DONE |
| [FE-TASK-011](./FE-TASK-011-tenantteam-type-and-preload.md) | FE-SOL-002 | CR-RBAC-004 | Thêm type `TenantTeam` + preload `listTeams` | 🔴 P0 | ✅ DONE — backend `team.list` đã sống, gap thật còn lại là 1 dòng bridge `web-preload-api.ts` (xem file) |
| [FE-TASK-012](./FE-TASK-012-team-grant-picker-ui.md) | FE-SOL-002 | CR-RBAC-004 | Wire Team grant picker (`GroupsAndGrantsTab`) | 🔴 P0 | ✅ DONE — UI wired đầy đủ, chờ bridge trên (xem file) |
| [FE-TASK-013](./FE-TASK-013-f32-doc-scoping-axis-update.md) | FE-SOL-002 | CR-RBAC-004 | F32 doc — scoping axis Team/Department | 🔴 P0 | ✅ DONE |
| [FE-TASK-014](./FE-TASK-014-audit-filter-types.md) | FE-SOL-003 | CR-RBAC-005 | Mở rộng type `AdminAuditEntry`/`Query`/`Outcome` | 🟡 P1 | ✅ DONE — đã viết đủ ở FE-TASK-017 |
| [FE-TASK-015](./FE-TASK-015-audit-filter-preload.md) | FE-SOL-003 | CR-RBAC-005 | Preload `admin.queryAuditLog` filter mới | 🟡 P1 | ✅ DONE — đã forward đủ ở FE-TASK-017 |
| [FE-TASK-016](./FE-TASK-016-audit-filter-ui.md) | FE-SOL-003 | CR-RBAC-005 | UI filter actor + outcome trong tab Audit | 🟡 P1 | ✅ DONE |
| [FE-TASK-017](./FE-TASK-017-admin-preload-namespace-extension.md) | FE-SOL-004 | CR-RBAC-001 | Mở rộng preload `admin.*` (Policies/Teams/Sessions/Audit) | 🔴 P0 | ✅ DONE — backend Wave 8 xong, channel thật khác sketch (xem file) |
| [FE-TASK-018](./FE-TASK-018-policies-tab.md) | FE-SOL-004 | CR-RBAC-001 | Tab "Policies" trong `AdminOrgConsole` | 🔴 P0 | ✅ DONE — banner cảnh báo CR-RBAC-006 chưa xong |
| [FE-TASK-019](./FE-TASK-019-audit-tab-skeleton.md) | FE-SOL-004 | CR-RBAC-001 | Tab "Audit Log" (khung cơ bản) | 🔴 P0 | ✅ DONE |
| [FE-TASK-020](./FE-TASK-020-teams-tab.md) | FE-SOL-004 | CR-RBAC-001 | Tab "Teams" (chuyển sang wscompat) | 🔴 P0 | ✅ DONE |
| [FE-TASK-021](./FE-TASK-021-sessions-tab.md) | FE-SOL-004 | CR-RBAC-001 | Tab/panel "Sessions" (theo-user) | 🔴 P0 | ✅ DONE |
| [FE-TASK-022](./FE-TASK-022-confirm-users-tab-complete.md) | FE-SOL-004 | CR-RBAC-001 | Xác nhận Users tab đã đầy đủ (verify-only) | 🔴 P0 | ✅ DONE |
| [FE-TASK-023](./FE-TASK-023-remove-legacy-admin-spa.md) | FE-SOL-004 | CR-RBAC-001 | Xoá Hệ B (Admin SPA cũ) | 🔴 P0 | ✅ DONE — pivot: xoá 9/11 file, giữ+trim AdminApp/Layout cho Fleet/AI-providers/Profile (gap thật, xem file) |
| [FE-TASK-024](./FE-TASK-024-confirm-fleet-ai-providers-profile-parity.md) | FE-SOL-004 | CR-RBAC-001 | Xác nhận Fleet/AI-providers/Profile tương đương (verify-only) | 🔴 P0 | ✅ DONE — gap thật phát hiện, xem file task |
| [FE-TASK-025](./FE-TASK-025-refresh-session-api.md) | FE-SOL-005 | CR-RBAC-003 | Thêm `refreshSession()` + test | 🟡 P1 | ✅ DONE |
| [FE-TASK-026](./FE-TASK-026-webroot-session-refresh-timer.md) | FE-SOL-005 | CR-RBAC-003 | Hẹn giờ refresh định kỳ (`WebRootBoundary`) | 🟡 P1 | ✅ DONE |
| [FE-TASK-027](./FE-TASK-027-saml-investigation-design-confirmation.md) | FE-SOL-006 | CR-RBAC-007 | SAML — investigation/design-confirmation | ⚪ P3 Backlog | ✅ DONE — 3 điểm mở re-verify, vẫn cần business chốt |

⚠️ = task cần backend-go/CR khác xong mới có tác dụng thật; xem mục "Depends on" trong từng file để
biết chi tiết (BE-TASK tương ứng ở `specs/backend-go/crs/v4/team-rbac/tasks/`, đang soạn song song,
chưa tồn tại lúc bộ task FE này được viết).

---

## Thứ Tự Thực Hiện

Nhóm theo dependency thật giữa các file code bị đụng (không chỉ theo thứ tự số/solution — số thứ
tự file chỉ liên tục cho dễ tham chiếu, xem ghi chú cuối mỗi nhóm về lý do thứ tự lệch so với số).

```
Sprint 1 — Nền tảng, độc lập hoàn toàn, chạy song song ngay:

  Nhóm A (CR-RBAC-002 — role model):
    FE-TASK-001 → FE-TASK-002 (cần type đã thu hẹp)
    FE-TASK-003 (song song, độc lập file)
    FE-TASK-004 (song song, độc lập file — bỏ qua nếu Hệ B đã bị xoá trước)

  Nhóm B (CR-RBAC-004 — dọn dead code, Phần A):
    FE-TASK-006 (độc lập)
    FE-TASK-007 → FE-TASK-008, FE-TASK-009 (song song sau 007)
    FE-TASK-010 (độc lập)

  Nhóm C (CR-RBAC-003 — session refresh, hoàn toàn độc lập với A/B):
    FE-TASK-025 → FE-TASK-026

  Nhóm D (CR-RBAC-001 — verify-only, không phụ thuộc gì, tranh thủ làm sớm):
    FE-TASK-022, FE-TASK-024

Sprint 1.5 — hoàn tất CR-RBAC-002/004 (sau khi nhóm A/B ở Sprint 1 xong):

  FE-TASK-005 (F32 doc, sau 001-004)
  FE-TASK-011 → FE-TASK-012 (Team grant UI — code độc lập, nhưng chỉ có tác dụng
    thật sau khi backend-go's team-listing API xong; không cần chờ để merge UI)
  FE-TASK-013 (F32 doc scoping axis — SAU FE-TASK-005 vì cùng file, và sau 006-012)

Sprint 2 — CR-RBAC-001 cutover, nền tảng preload (cần backend-go's wscompat channels mới —
  channels_admin_policies.go / _teams.go / _sessions.go / _audit.go, hiện chưa tồn tại):

  FE-TASK-017 (preload foundation cho cả 4 tab)
    → FE-TASK-018 (Policies — CHỜ THÊM CR-RBAC-006 xong trước khi merge)
    → FE-TASK-019 (Audit skeleton)
    → FE-TASK-020 (Teams)
    → FE-TASK-021 (Sessions)
  (4 tab trên chạy song song sau 017, độc lập nhau về file)

Sprint 3 — CR-RBAC-005 audit filter (cần FE-TASK-019 đã tạo tab Audit + backend-go's
  outcome/actor_id schema — đây là lý do FE-TASK-014-016 đứng SAU FE-TASK-017-021 trong thứ tự
  thực hiện dù số thứ tự file nhỏ hơn — số thứ tự chỉ theo thứ tự solution 001→006, không phải
  thứ tự chạy):

  FE-TASK-014 → FE-TASK-015 → FE-TASK-016

Sprint 4 — Đóng CR-RBAC-001 (sau khi toàn bộ 4 tab mới + audit filter sống ổn định):

  FE-TASK-023 (xoá Hệ B — chạy `impact()` từng symbol trước khi xoá, `detect_changes()` trước khi
    commit, theo đúng quy tắc bắt buộc của repo)

Sprint 5 — Backlog (không tính vào timeline chính, chờ business xác nhận):

  FE-TASK-027 (sau FE-TASK-026, theo khuyến nghị FE-SOL-006)
```

### Vì sao FE-TASK-014/015/016 (SOL-003) đứng sau FE-TASK-017-021 (SOL-004) trong thứ tự chạy dù số nhỏ hơn

FE-SOL-003 (CR-RBAC-005) tự nhận trong chính solution: "UI đích của solution này là 1 tab do
FE-SOL-004 dựng lên (`admin-org-console-audit-tab.tsx`), không phải `AuditPage.tsx` (Hệ B)". README
gốc của `docs/crs/v4/team-rbac/` xếp CR-005 chạy **trước** CR-001 về mặt schema/RPC backend — nhưng
UI đích của nó chỉ tồn tại sau khi CR-001 cutover. Số thứ tự file (014-016 < 017-024) theo đúng thứ
tự solution (FE-SOL-003 đứng trước FE-SOL-004 trong bộ 6 solution), nhưng **thứ tự chạy thật** ở
Sprint 3/2 phía trên mới là thứ tự khuyến nghị.

---

## Phụ thuộc cross-layer (backend-go) cần lưu ý khi thực thi

Các task sau đánh dấu ⚠️ trong bảng vì cần 1 API/channel backend-go **chưa tồn tại tại thời điểm
viết bộ task này** (2026-09-09) — mỗi task ghi rõ "Depends on: backend-go's BE-TASK tương ứng" và
tên CR/RPC liên quan trong file của nó, tham chiếu `specs/backend-go/crs/v4/team-rbac/tasks/` (đang
soạn song song, chưa tồn tại lúc bộ task FE này được viết):

- ~~**FE-TASK-011/012** (CR-RBAC-004) — cần API liệt kê teams (`tenantProfile.listTeams`).~~
  **CẬP NHẬT (2026-09-09, sau khi thực thi):** premise này đã lỗi thời — backend-go's `team.list`
  wscompat channel (tenant-service's `ListTeams`) đã sống, wired vào `RegisterRealChannels`. Cả 2
  task đã ✅ DONE. Gap thật còn lại KHÔNG phải backend-go nữa, mà là 1 dòng bridge chưa thêm ở FE's
  `frontend/src/renderer/src/web/web-preload-api.ts` (`createTenantProfileApi()` thiếu
  `listTeams: () => callRuntimeResult('team.list')`) — xem "Kết quả thực tế" trong 2 file task.
- **FE-TASK-014** (CR-RBAC-005) — cần `outcome`/`actor_id` trên `AuditEntry`/`QueryAuditLog`.
- **FE-TASK-017** (CR-RBAC-001) — cần 4 wscompat channel mới (Policies/Teams/Sessions/Audit) —
  đây là phần backend-go **thật sự còn thiếu** của CR-RBAC-001 (không phải "chỉ cutover FE" như CR
  gốc ngụ ý).
- **FE-TASK-018** (CR-RBAC-001) — thêm điều kiện **merge** (không phải điều kiện code): chờ
  backend-go's CR-RBAC-006 (`NoopPublisher` → implementation thật) xong.
- **FE-TASK-025** (CR-RBAC-003) — cần `POST /auth/refresh` RPC tồn tại cho test tích hợp thật (unit
  test với `fetch` mock thì viết được ngay).

Task không đánh dấu ⚠️ tự đứng độc lập ở phía frontend, không chờ backend-go để có tác dụng đầy đủ
(dù một số vẫn liệt kê backend-go ở "Không thuộc phạm vi" cho các phần khác của CR).

---

## Format Mỗi Task File

Mỗi `FE-TASK-*.md` có cấu trúc: **tiêu đề + metadata** (Domain/Solution Ref/CR/Priority/Estimated/
Status) → **Mục tiêu** → **Files cần sửa** (bảng) → **Các bước thực thi** (code cụ thể, copy-paste
được từ solution gốc — không bắt AI đọc lại solution để tự suy luận lại) → **Verify** (lệnh build/
test/lint cụ thể) → **Depends on** / **Blocking**. Task cross-layer có thêm mục "⚠️ Phụ thuộc
backend-go" ngay đầu file.
