# FE-TASK-005: Cập nhật `docs/features/F32-team-rbac.md` — bảng Role phản ánh 2-tier global / 3-tier repo-scoped

**Domain:** team-rbac
**Solution Ref:** [FE-SOL-001](../solutions/FE-SOL-001-drop-lead-from-global-role-model.md) Bước 6
**CR:** [CR-RBAC-002](../../../../../../docs/crs/v4/team-rbac/CR-RBAC-002-unify-role-model-and-propagate-claims.md)
**Priority:** 🔴 P0
**Estimated:** 20 phút
**Status:** ✅ DONE — 2026-09-09

## Kết quả thực tế

- Phát hiện khi thực thi: `docs/features/F32-team-rbac.md` đã bị backend-go's **TASK-BE-006**
  sửa song song (uncommitted, cùng working tree) — đã thêm sẵn 1 note ngay dưới `### Roles` mô tả
  đúng 2 trục Global role (`user`/`admin`, `auth-service`'s `domain.Role`, `admin.rego`) vs
  Repo-scoped role (`developer`/`lead`/`admin`, `RepoRole`, `repo.rego`) — khớp phần lớn yêu cầu
  của task này.
- Không ghi đè/xoá note của TASK-BE-006. Chỉ **bổ sung 1 đoạn addendum** ngay sau note đó, nêu rõ:
  frontend's `OrcaUserRole` (`frontend/src/renderer/src/store/slices/auth.ts:11`) là
  `'developer' | 'admin'` — nhãn `'developer'` là cách frontend hiển thị backend's global `user`
  value; và khẳng định rõ ràng đây là **"a deliberate simplification" đã tồn tại từ trước ở backend
  thật (auth-service/api-gateway)**, CR-RBAC-002 không quyết định mới, chỉ đồng bộ lại type
  frontend cho khớp (yêu cầu cụ thể của FE-TASK-005 mà note TASK-BE-006 chưa nêu rõ).
- Cũng sửa nhẹ câu mở đầu ở mục "Mô tả" (dòng 18) — trước đó viết "phân quyền theo role (developer
  / lead / admin)" gây hiểu lầm "lead" là role toàn cục; sửa thành phân biệt rõ global vs
  repo-scoped ngay từ câu đầu.
- Bảng Role gốc (dòng ~66-69, liệt kê `lead` như 1 hàng ngang hàng developer/admin) **giữ nguyên**
  theo đúng cách TASK-BE-006 đã xử lý phần "Project-scoped Server Visibility" tương tự (thêm note
  giải thích phía trên, không sửa nội dung lịch sử bên dưới) — tránh xung đột định dạng với 2 note
  đã có.
- Verify: `grep -n "lead" docs/features/F32-team-rbac.md` — mọi dòng còn lại đều nằm trong (a) note
  mới ghi rõ "repo-scoped only"/"no global lead", hoặc (b) bảng/code lịch sử đã được note phía trên
  đánh dấu "OLD design sketch — kept for history". Không còn chỗ nào mô tả "lead" là role toàn cục
  mà không có disclaimer.
- Đây là thay đổi tài liệu thuần tuý — không có symbol code nào bị sửa, không cần `impact()`/`tsc`/
  vitest cho task này.

## Mục tiêu

CR-002's tiêu chí chấp nhận yêu cầu tài liệu phản ánh đúng model thật. Đây là thay đổi **tài liệu**
(không phải code) — cập nhật bảng Role trong F32 để khớp với FE-TASK-001..004 đã áp dụng.

## Files cần sửa

| File | Action |
|------|--------|
| `docs/features/F32-team-rbac.md` | MODIFY (tài liệu) |

## Các bước thực thi

Mở `docs/features/F32-team-rbac.md`, tìm bảng/mục mô tả Role model. Sửa lại đúng nội dung sau:

- **Global role** (toàn hệ thống, gắn với `AuthUser.role`/`OrcaUserRole`): 2 tier —
  `developer` (hiển thị cho mọi non-admin) / `admin`. **Không còn "lead" ở cấp toàn cục.**
- **Repo-scoped role** (`RepoRole`, gắn với từng repo cụ thể, khớp
  `backend-go/policy/orca-authz/repo.rego`): giữ nguyên 3 tier —
  `developer` / `lead` / `admin`. "Lead" chỉ có ý nghĩa trong ngữ cảnh 1 repo, không phải role
  toàn cục.

Ghi rõ trong doc lý do: role toàn cục 2-tier là "a deliberate simplification" đã có sẵn ở backend
thật (auth-service/api-gateway), không phải quyết định mới của CR này — CR chỉ đồng bộ UI cho khớp
thực tế đã tồn tại.

## Verify

```bash
grep -n "lead" docs/features/F32-team-rbac.md
```

Đọc lại đoạn liên quan để xác nhận không còn mô tả "lead" là role toàn cục.

## Depends on

FE-TASK-001, FE-TASK-002, FE-TASK-003, FE-TASK-004 (nên hoàn tất trước để tài liệu mô tả đúng
trạng thái code cuối cùng — không bắt buộc về mặt kỹ thuật, chỉ để tránh tài liệu đi trước code).

## Blocking

FE-TASK-013 (FE-SOL-002 cũng sửa cùng file `docs/features/F32-team-rbac.md`, phần scoping
axis) — làm task này **trước** FE-TASK-013 để tránh 2 patch vào cùng file gây conflict khi áp dụng
tuần tự.
