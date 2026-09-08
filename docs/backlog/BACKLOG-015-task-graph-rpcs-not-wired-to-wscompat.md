# BACKLOG-015: OrcaTask RPC đã có ở proto/usecase nhưng chưa wire ở `wscompat` (AddEdge, Grant, ResolvePermission) — Comment RPC không tồn tại ở bất kỳ tầng nào

**Origin:** Phát hiện trong lúc thực thi `docs/crs/v3/flow-task` + `specs/{backend-go,frontend}/bugs/task-v1` (2026-09-08) — `SOL-FE-TASKV1-002/003/008`, `TASK-FE-TASKV1-04/06/08`
**Priority:** Medium — chặn 3 tính năng UI đã build sẵn (add-edge, access panel, comments) nhưng chưa hoạt động thật
**Blocked on:** Không có blocker kỹ thuật thật — thuần túy engineering time chưa được lên lịch (wire RPC đã tồn tại vào `wscompat`, hoặc thiết kế mới cho phần chưa có)

---

## Hiện trạng đã xác nhận (đọc code thật, không phải audit cũ)

| RPC | proto/usecase | `wscompat` (frontend gọi được) |
|---|---|---|
| `task.addEdge` | ✅ Có | ❌ Chưa đăng ký ở `channels_automation_task.go` |
| `task.removeEdge` | ❌ Không tồn tại | ❌ |
| `task.grant` | ✅ Có | ❌ Chưa đăng ký |
| `task.resolvePermission` | ✅ Có | ❌ Chưa đăng ký |
| `task.addComment` | ❌ Không tồn tại (bảng `task.task_comments` tồn tại nhưng chết — 0 Go code nào dùng) | ❌ |
| `task.listComments` | ❌ Không tồn tại | ❌ |

## Tác động

Frontend đã build sẵn UI cho cả 3 tính năng này trong đợt thực thi flow-task (`TaskDAGView`'s add-edge dialog, `TaskAccessPanel`, `TaskComments`) theo đúng thiết kế "optimistic UI + fallback rõ ràng khi RPC chưa sẵn sàng" — UI hiển thị đúng trạng thái "chưa khả dụng", không giả vờ hoạt động. Khi các RPC này được wire/thiết kế xong, chỉ cần bỏ phần fallback, không cần viết lại UI.

## Việc cần làm khi triển khai

1. `AddEdge`/`Grant`/`ResolvePermission`: chỉ cần đăng ký handler mới trong `channels_automation_task.go` gọi RPC gRPC đã có sẵn — việc nhỏ, không cần thiết kế mới.
2. `AddComment`/`ListComments`: cần thiết kế usecase + RPC mới (bảng đã có sẵn ở migration, chỉ chưa có code) — việc lớn hơn, nên tách task riêng khi lên lịch.

## Tham khảo
- `specs/backend-go/bugs/task-v1/BUG-TASKV1-001-orcatask-data-model-and-state-machine-gap.md` (bảng comment chết)
- `specs/frontend/bugs/task-v1/solutions/SOL-FE-TASKV1-002-*.md`, `SOL-FE-TASKV1-003-*.md`, `SOL-FE-TASKV1-004-*.md` (thiết kế UI đã chờ sẵn RPC này)
