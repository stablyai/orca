# CR-RBAC-004 — Nối dây visibility server theo team/department (đang là dead code)

| Trường | Giá trị |
|--------|---------|
| **CR ID** | CR-RBAC-004 |
| **Tên** | Fix `selectSshTargetsForCurrentUser` dead code (frontend); backend team-grant gap đã được vá từ trước |
| **Loại** | Bug Fix |
| **Priority** | 🟡 P1 (hạ từ 🔴 P0 — xem "Cập nhật 2026-09-09": phần backend nghiêm trọng nhất đã được vá) |
| **Effort** | Small (0.5–1 ngày — hạ từ Medium 2–3 ngày sau khi xác nhận backend đã xong) |
| **Phiên bản** | v1.1 |
| **Ngày tạo** | 2026-09-09 |
| **Trạng thái** | 🟡 Một phần đã fix trước đó (backend) — phần còn lại (frontend dead code + 2 việc dọn dẹp nhỏ) chưa triển khai |
| **Tác giả** | Rà soát frontend RBAC theo yêu cầu hoàn thiện F32 |
| **Tác động HLD** | C3.1 |
| **Tác động Features** | F32, F27 (Fleet Health Monitoring), F31 (Fleet Provisioning) |
| **Phụ thuộc** | Không |

---

## Cập nhật 2026-09-09 — Backend đã được vá từ trước, KHÔNG còn là gap mở

Khi soạn giải pháp thực thi ([BE-SOL-004](../../../../specs/backend-go/crs/v4/team-rbac/solutions/BE-SOL-004-team-grant-visibility-verification.md)),
đã xác minh trực tiếp bằng source code (không suy đoán) rằng **gap "Team grant luôn rỗng" mô tả ở mục 3
bên dưới đã được vá trước đó**, dưới 1 fix ghi chú trong code là "BUG-013":

- `backend-go/.../wscompat/channels_dev_server_access_control.go`'s `devServer.listForUser` VÀ
  `channels_onboarding.go`'s `onboardingDetectAgentsAllServers` **đều đã** gọi
  `tenantClient.ListTeamsForUser` thật và forward `TeamIds` vào `ListDevServersForUser` — không còn rỗng.
- `infra-fleet-service`'s `list_dev_servers_for_user.go` đã implement nhánh `GranteeKindTeam` với test
  `TestListDevServersForUser_TeamGrantMatches` sẵn có.
- **Kết luận:** đây là gap "client wiring", không phải "thiếu RPC" như nghi ngờ ban đầu — và wiring đó
  **đã xong**. Câu trích dẫn ở mục 3 dưới đây (comment trong `AdminDevServerConsole.tsx`: *"tenant-service
  has no 'list teams for a user' RPC..."*) đã **lỗi thời** tại thời điểm audit ban đầu (2026-09-09).

**Phạm vi còn lại của CR này** (đã hạ Priority P0→P1, Effort Medium→Small):
1. Xoá dead code phía frontend (`selectSshTargetsForCurrentUser`, `OrcaUser.teams`/`projects` hard-code rỗng) — mục 2 bước 3 vẫn đúng, không đổi.
2. Sửa lại comment lỗi thời ở `AdminDevServerConsole.tsx` + thêm UI chọn Team cho `GroupsAndGrantsTab` (hiện chỉ có Department).
3. Thêm 1 test hồi quy ở tầng wscompat (không chỉ tầng usecase) khẳng định `TeamIds` thật sự được forward — xem BE-SOL-004 §3.2.
4. `docs/features/F32-team-rbac.md` xác nhận scoping axis là Team/Department (đã đúng hướng, chỉ cần xác nhận).

Chi tiết đầy đủ: [BE-SOL-004](../../../../specs/backend-go/crs/v4/team-rbac/solutions/BE-SOL-004-team-grant-visibility-verification.md),
task thực thi: [TASK-BE-013](../../../../specs/backend-go/crs/v4/team-rbac/tasks/TASK-BE-013-devserver-team-grant-wiring-regression-test.md).

---

## Bối cảnh & Vấn đề (nguyên trạng lúc audit ban đầu — giữ nguyên để tham chiếu lịch sử, xem mục cập nhật ở trên cho kết luận mới nhất)

Đây là gap nghiêm trọng nhất tìm thấy trong khảo sát: **cơ chế lọc server theo project/team code đã viết nhưng không hoạt động, và ngay cả khi được gọi cũng sẽ không lọc được gì.**

1. `selectSshTargetsForCurrentUser` (`frontend/src/renderer/src/store/selectors.ts:265-281`) implement đúng logic F32 mô tả (admin thấy hết, developer/lead chỉ thấy server thuộc `project`/`team` của mình) — nhưng **không có nơi nào trong app gọi selector này**. Mọi view (`SshStatusSection.tsx`, `SshTargetGroupedList.tsx`, fleet dashboard…) đọc thẳng `state.sshTargets` không qua lọc.
2. Ngay cả khi nối dây selector vào UI, nó vẫn sẽ **không lọc được gì** vì input của nó luôn rỗng: `OrcaUser.teams`/`projects` bị hard-code `[]` ở cả 2 nơi khởi tạo — `store/slices/auth.ts:69-77` (`checkSession`) và `web/main-web-bootstrap.tsx:234-242` — không có logic nào từ backend đổ dữ liệu team/project thật của user vào đây.
3. Cơ chế lọc **thật sự đang chạy** là ở tầng khác hẳn: `infra-fleet-service`'s `ListDevServersForUser` (theo Department/Team của tenant-service, có test `TestListDevServersForUser_DirectDepartmentGrantMatches` v.v.), phục vụ `AdminDevServerConsole`/fleet UI mới. Nhưng theo comment tại `GroupsAndGrantsTab` (`AdminDevServerConsole.tsx:349-352`), **nhánh Team grant chưa nối dây**: *"tenant-service has no 'list teams for a user' RPC, so ListDevServersForUser's team_ids is always empty server-side too (documented gap, BE-SOL-003)"* — chỉ Department grant hoạt động, Team grant vẫn rỗng dù `GranteeKind` đã hỗ trợ `team`.

**Kết luận:** hiện có 2 hệ scoping riêng (selector cũ theo `project`/`team` phía frontend — chết; grant mới theo `department`/`team` phía infra-fleet-service — team nhánh cũng chết) — không hệ nào lọc server theo team/project một cách sống động cho end-user hôm nay ngoài Department.

## Giải pháp đề xuất

Không dùng lại `selectSshTargetsForCurrentUser` (nó nói về "project", trong khi cơ chế RBAC thật của server visibility đã chốt là `infra-fleet-service`'s Department/Team grant — xem CR-RBAC-001's ghi chú "quyết định đã chốt"). Thay vào đó, **hoàn thiện đúng 1 hệ đang sống**:

1. **Đóng gap BE-SOL-003**: thêm RPC `ListTeamsForUser` phía `tenant-service` được expose ra ngoài cho `infra-fleet-service` gọi (RPC nội bộ `ListTeamsForUser` đã tồn tại ở tenant-service theo audit trước — kiểm tra lại tại sao `infra-fleet-service` chưa gọi được nó, có thể chỉ thiếu client wiring, không phải thiếu RPC).
2. `ListDevServersForUser`: điền `team_ids` thật (đang luôn rỗng) bằng kết quả gọi trên.
3. Xoá `selectSshTargetsForCurrentUser` + field `teams`/`projects` trên `OrcaUser` nếu xác nhận không còn dùng ở đâu khác (chạy `impact` trước khi xoá theo đúng quy tắc bắt buộc) — tránh giữ lại dead code gây hiểu lầm là "đã có RBAC" khi review sau này.
4. Sidebar/fleet UI hiện tại đã đọc dữ liệu server đã được lọc sẵn từ backend (`ListDevServersForUser` trả list đã filter) hay đọc raw list rồi tự lọc? Xác nhận lại khi cài đặt — nếu đang đọc raw list ở đâu đó ngoài `AdminDevServerConsole`, cần trỏ lại đúng RPC đã lọc.

## Changes Required

| File | Thay đổi |
|------|---------|
| ~~`backend-go/services/tenant-service/...`~~ | ~~Xác nhận/expose `ListTeamsForUser`~~ — **đã xong từ trước**, không cần đổi |
| ~~`backend-go/services/infra-fleet-service/internal/usecase/list_dev_servers_for_user.go`~~ | ~~Điền `team_ids` thật~~ — **đã xong từ trước**, không cần đổi |
| `backend-go/.../wscompat/channels_dev_server_access_control.go`, `channels_onboarding.go` | Thêm 1 dòng comment xác nhận fail-closed là chủ đích (không đổi behavior) + test hồi quy tầng wscompat (BE-SOL-004 §3.2/§3.3) |
| `frontend/src/renderer/src/store/selectors.ts` | Xoá `selectSshTargetsForCurrentUser` (dead code) sau khi xác nhận không dùng |
| `frontend/src/renderer/src/store/slices/auth.ts`, `web/main-web-bootstrap.tsx` | Xoá field `teams`/`projects` hard-code rỗng trên `OrcaUser` nếu không còn dùng nơi nào |
| `frontend/.../components/settings/AdminDevServerConsole.tsx` | Sửa comment lỗi thời (BUG-013 đã fix) + thêm Team picker vào `GroupsAndGrantsTab` (hiện chỉ có Department) |

## Không thuộc phạm vi CR này

- Thêm 1 trục scoping mới theo "Project" (project-service) cho server visibility — F32 gốc mô tả theo project, nhưng kiến trúc hiện tại đã chọn Team/Department (infra-fleet-service); CR này **hiện thực hoá quyết định đã chọn**, không mở thêm trục mới. Nếu sau này business cần lọc theo Project thật, đó là CR riêng, có info từ CR-RBAC-002's cập nhật F32.md.

## Tiêu chí chấp nhận

- [x] `ListDevServersForUser` trả đúng server theo Team grant (không còn luôn rỗng) — `TestListDevServersForUser_TeamGrantMatches` đã tồn tại và pass. **Xác nhận xong 2026-09-09, không cần làm lại.**
- [ ] Test hồi quy ở tầng wscompat (không chỉ usecase) khẳng định `TeamIds` được forward — BE-SOL-004 §3.2.
- [ ] Không còn dead code selector/field liên quan đến "project" scoping đã xác nhận không dùng (frontend).
- [ ] `docs/features/F32-team-rbac.md` cập nhật đúng: scoping axis là Team/Department, không phải Project.
- [ ] Comment lỗi thời ở `AdminDevServerConsole.tsx` được sửa + Team picker được thêm vào `GroupsAndGrantsTab`.

## Impact analysis (gitnexus)

Chạy `impact({target:"selectSshTargetsForCurrentUser", direction:"upstream"})` và `impact({target:"OrcaUser", direction:"upstream"})` trước khi xoá field — cả 2 chưa chạy ở bước khảo sát này, **bắt buộc chạy lại ngay trước khi sửa** theo quy tắc repo.

## Liên quan

- [F32-team-rbac.md](../../../features/F32-team-rbac.md) §Project-scoped Server Visibility
- `frontend/src/renderer/src/components/settings/AdminDevServerConsole.tsx` (comment lỗi thời cần sửa)
- [BE-SOL-004](../../../../specs/backend-go/crs/v4/team-rbac/solutions/BE-SOL-004-team-grant-visibility-verification.md) — giải pháp thực thi, xác nhận backend đã fix
- [TASK-BE-013](../../../../specs/backend-go/crs/v4/team-rbac/tasks/TASK-BE-013-devserver-team-grant-wiring-regression-test.md) — task thực thi phần còn lại
- CR-RBAC-002 (cập nhật F32.md role/scoping model)
