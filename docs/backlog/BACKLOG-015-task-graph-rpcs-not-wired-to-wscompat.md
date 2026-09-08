# BACKLOG-015: `task.addComment`/`task.listComments` không tồn tại ở bất kỳ tầng nào

**Origin:** Phát hiện trong lúc thực thi `docs/crs/v3/flow-task` + `specs/{backend-go,frontend}/bugs/task-v1` (2026-09-08) — `SOL-FE-TASKV1-002/003/008`, `TASK-FE-TASKV1-04/06/08`
**Priority:** Medium — chặn 1 tính năng UI đã build sẵn (`TaskComments`) nhưng chưa hoạt động thật
**Blocked on:** Cần thiết kế usecase + RPC mới (bảng `task.task_comments` đã tồn tại ở migration nhưng chết — 0 Go code nào dùng)
**Update 2026-09-08:** `task.addEdge`/`task.grant`/`task.resolvePermission` đã được đăng ký trong `channels_automation_task.go` (gọi thẳng RPC gRPC có sẵn) + test (`TestTaskAddEdgeChannel_ParsesTypeAndForwards`, `TestTaskGrantChannel_ParsesLevelAndForwards`, `TestTaskResolvePermissionChannel_ReturnsLowercaseLevel`). Phần còn lại của backlog này chỉ còn `AddComment`/`ListComments`.

---

## Hiện trạng đã xác nhận (đọc code thật, không phải audit cũ)

| RPC | proto/usecase | `wscompat` (frontend gọi được) |
|---|---|---|
| `task.addEdge` | ✅ Có | ✅ Đã wire |
| `task.removeEdge` | ❌ Không tồn tại | ❌ |
| `task.grant` | ✅ Có | ✅ Đã wire |
| `task.resolvePermission` | ✅ Có | ✅ Đã wire |
| `task.addComment` | ❌ Không tồn tại (bảng `task.task_comments` tồn tại nhưng chết — 0 Go code nào dùng) | ❌ |
| `task.listComments` | ❌ Không tồn tại | ❌ |

## Tác động

Frontend đã build sẵn UI cho tính năng comment trong đợt thực thi flow-task (`TaskComments`) theo đúng thiết kế "optimistic UI + fallback rõ ràng khi RPC chưa sẵn sàng" — UI hiển thị đúng trạng thái "chưa khả dụng", không giả vờ hoạt động. Khi RPC này được thiết kế/wire xong, chỉ cần bỏ phần fallback, không cần viết lại UI.

`TaskDAGView`'s add-edge dialog và `TaskAccessPanel` có thể bỏ fallback ngay — RPC nền đã sẵn sàng.

## Việc cần làm khi triển khai

`AddComment`/`ListComments`: cần thiết kế usecase + RPC mới (bảng đã có sẵn ở migration, chỉ chưa có code) — proto message, usecase, postgres repository, grpc handler, rồi mới wire vào `wscompat`.

## Tham khảo
- `specs/backend-go/bugs/task-v1/BUG-TASKV1-001-orcatask-data-model-and-state-machine-gap.md` (bảng comment chết)
- `specs/frontend/bugs/task-v1/solutions/SOL-FE-TASKV1-002-*.md`, `SOL-FE-TASKV1-003-*.md`, `SOL-FE-TASKV1-004-*.md` (thiết kế UI đã chờ sẵn RPC này)
