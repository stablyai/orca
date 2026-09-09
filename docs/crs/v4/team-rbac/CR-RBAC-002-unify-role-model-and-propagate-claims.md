# CR-RBAC-002 — Thống nhất mô hình role + truyền role claim tới project-service

| Trường | Giá trị |
|--------|---------|
| **CR ID** | CR-RBAC-002 |
| **Tên** | Unify role model (`developer/lead/admin`) + fix `callerGlobalRole` inert trong project-service |
| **Loại** | Bug Fix + Architectural Decision |
| **Priority** | 🔴 P0 (an ninh: "admin thấy tất cả" hiện KHÔNG đúng cho project/repo RPC) |
| **Effort** | Medium (2–3 ngày) |
| **Phiên bản** | v1.0 |
| **Ngày tạo** | 2026-09-09 |
| **Trạng thái** | 🔲 Chưa triển khai |
| **Tác giả** | Rà soát backend-go RBAC theo yêu cầu hoàn thiện F32 |
| **Tác động HLD** | C3.1 |
| **Tác động Features** | F32, F33 (User Profile Hierarchy) |
| **Phụ thuộc** | Không — có thể làm độc lập, nên làm **trước** CR-RBAC-001 |

---

## Bối cảnh & Vấn đề

### 1. Role model không nhất quán giữa UI và backend thật

- Frontend (mọi nơi — `AdminUser.role`, `AdminPolicy.roles`, `OrcaUserRole` ở `frontend/src/renderer/src/store/slices/auth.ts:7`) giả định 3 role: `developer | lead | admin`.
- `auth-service`'s domain thật (`backend-go/services/auth-service/internal/domain/user.go:15-20`) chỉ có 2 giá trị: `RoleUser | RoleAdmin`, với comment tự nhận thức: *"fine-grained authorization is OPA's job, not an enum grown over time here."*
- `api-gateway`'s `toAuthUserResponse` (`auth_routes.go:36-40`) xác nhận: mọi user non-admin đều map cứng thành `"developer"` khi trả về `/auth/me` — **không có user thật nào có thể mang role "lead"** dù UI có ô chọn "lead" ở `UserForm.tsx`.
- Role gần nhất với ý nghĩa "lead" trong hệ thống thật là `RepoRole` (`developer|lead|admin`, `backend-go/policy/orca-authz/repo.rego:12-26`) — nhưng đây là role **theo từng repo**, không phải role toàn cục của user.

### 2. `callerGlobalRole` luôn trả về rỗng — override "global admin" là dead code

- `backend-go/services/project-service/internal/usecase/authorization.go:57-59`: `callerGlobalRole(ctx)` hard-code `return ""`, tự comment: *"no role claim propagates from api-gateway into a service's request context yet."*
- `project.rego`/`repo.rego` có nhánh "global admin override" (admin thấy/sửa mọi project bất kể membership) — nhánh này **đúng trong Rego unit test nhưng không bao giờ kích hoạt trong Go runtime thật**, vì context luôn thiếu role claim.
- `backend-go/common/tenant/tenant.go:39-49,63-72` xác nhận cùng 1 gap ở tầng chung: chỉ auth-flow qua **cookie/session** mới gán role vào context; auth-flow qua **bearer JWT** thì không.
- Hệ quả: một `admin` global đăng nhập qua session cookie mà không phải owner/member của 1 project → **không quản lý được project đó qua RPC của project-service**, trái với F32 ("admin: toàn quyền tất cả servers/projects") và trái với chính comment thiết kế trong `project.rego`.

## Giải pháp đề xuất

### A. Quyết định kiến trúc: role toàn cục ở đâu, "lead" nghĩa là gì

Không mở rộng `domain.Role` (auth-service) thành 3 giá trị — giữ đúng chủ đích thiết kế hiện tại ("global role chỉ nên phân biệt admin/không-admin, phần còn lại là OPA"). Thay vào đó:

1. **Sửa UI để phản ánh đúng thực tế**: `OrcaUserRole`, `AdminUser.role` chỉ còn 2 giá trị hợp lệ ở tầng *global* (`user`/`developer` hiển thị, `admin`) — bỏ lựa chọn "lead" khỏi form sửa role toàn cục (`UserForm.tsx`).
2. **"Lead" tồn tại đúng 1 nơi: `RepoRole` theo từng repo** (`repo.rego`) — UI hiển thị "lead" phải gắn với ngữ cảnh 1 repo cụ thể (vd. trang quản lý member của 1 repo), không phải role user toàn cục. Đây khớp với `project-service`'s `update_repo_member_role.go` đã có sẵn.
3. Ghi rõ quyết định này vào `docs/features/F32-team-rbac.md` (cập nhật bảng Role) khi CR này merge — F32 gốc mô tả 3-role phẳng đã lỗi thời so với kiến trúc OPA hiện tại.

### B. Truyền role claim xuyên suốt (fix `callerGlobalRole`)

1. api-gateway: ở middleware xác thực bearer-JWT (song song với đường cookie/session), thêm resolve role của actor (gọi `auth-service` hoặc đọc claim JWT nếu đã ký kèm role) và gán vào `tenant.WithRole(ctx, role)` — cùng cơ chế cookie path đang dùng.
2. `project-service`'s `callerGlobalRole(ctx)`: đọc từ `tenant.Role(ctx)` thay vì hard-code `""`.
3. Thêm test tái hiện đúng gap đã tìm thấy: global-admin (không phải project member) gọi `requireProjectAccess` qua **cả 2** đường (cookie session và bearer JWT) → phải luôn được phép.
4. Rà lại toàn bộ service khác dùng cùng `tenant.WithRole`/`tenant.Role` (`task-service`, `annotation-service` nếu có) để đảm bảo không có service nào khác lặp lại đúng gap này.

## Changes Required

| File | Thay đổi |
|------|---------|
| `frontend/src/renderer/src/store/slices/auth.ts` | `OrcaUserRole` bỏ `'lead'` khỏi role toàn cục (giữ lại nếu cần cho `RepoRole` ở type riêng) |
| `frontend/src/renderer/src/components/admin/UserForm.tsx` (hoặc tương đương sau CR-RBAC-001) | Bỏ option "lead" khỏi `<select>` role toàn cục |
| `backend-go/services/api-gateway/internal/adapter/httpgateway/*` (middleware xác thực bearer JWT) | Resolve + gán role claim vào context, giống đường cookie |
| `backend-go/common/tenant/tenant.go` | Không đổi API — chỉ cần chắc mọi caller đều gọi `WithRole` |
| `backend-go/services/project-service/internal/usecase/authorization.go` | `callerGlobalRole` đọc `tenant.Role(ctx)` |
| `docs/features/F32-team-rbac.md` | Cập nhật bảng Role — global 2 tier (`user/admin`) + repo-scoped 3 tier (`developer/lead/admin`) |

## Không thuộc phạm vi CR này

- Thêm role toàn cục thứ 3 thật sự (nếu business sau này cần "lead" toàn cục thật) — đây là quyết định sản phẩm, không phải bug fix, cần CR riêng nếu phát sinh.
- Đổi `TeamMember.role` (tenant-service) — xem CR-RBAC-004 (Team hiện không có role field, ngoài phạm vi CR này).

## Tiêu chí chấp nhận

- [ ] Global admin (session cookie **hoặc** bearer JWT) quản lý được mọi project/repo dù không phải member — test tự động cho cả 2 đường auth.
- [ ] `callerGlobalRole` không còn hard-code `""`.
- [ ] UI không còn cho phép gán "lead" như 1 role toàn cục của user.
- [ ] `docs/features/F32-team-rbac.md` phản ánh đúng mô hình role hiện tại.

## Impact analysis (gitnexus)

| Symbol | Direction | Risk | Impacted |
|---|---|---|---|
| `callerGlobalRole` (`project-service/internal/usecase/authorization.go`) | upstream | MEDIUM | 30 (2 direct, module `Usecase`) |

30 symbol phụ thuộc gián tiếp nằm trong `Usecase` module của project-service — rà lại toàn bộ usecase gọi `requireProjectAccess`/`requireRepoAccess` sau khi sửa, chạy `detect_changes({scope:"compare", base_ref:"main"})` trước khi commit.

## Liên quan

- [F32-team-rbac.md](../../../features/F32-team-rbac.md)
- `backend-go/policy/orca-authz/project.rego`, `repo.rego`
- CR-RBAC-001 (cutover phụ thuộc vào role model đã ổn định)
