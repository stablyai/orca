# BUG-FE-TASKV1-003 — `task.grant`/`task.resolvePermission` mồ côi ở UI; không có khái niệm share-link cho Task

**Mức độ:** 🟡 Medium
**Status:** 🔴 Open
**Module:** `frontend/src/renderer/src/components/task/` (toàn bộ)
**Phát hiện:** 2026-09-08 (audit frontend vs 3 hệ Task: OrcaTask/Task Execute/Workflow Orchestration)

---

## Mô tả

Cả 2 backend đều có cơ chế phân quyền per-task đầy đủ:

- Node (`desktop/src/main/task/task-rpc-handler.ts` và bản sao
  `backend/src/main/task/task-rpc-handler.ts`): `task.grant` (dòng 319-322) và
  `task.resolvePermission` (dòng 340-347, gọi `grantService.resolvePermission`).
  Comment ở đầu file (dòng 13): `"grant: task.grant → manage"`.
- `backend-go` (`task.proto`): `rpc Grant(GrantRequest)` (dòng 17) và
  `rpc ResolvePermission(ResolvePermissionRequest)` (dòng 18), có
  `enum GrantLevel` (dòng 92) và thuật toán BFS ancestor-resolution riêng
  (`domain/grant_resolution.go`).

Grep toàn bộ `frontend/src` cho `task.grant`/`resolvePermission` — **0 kết
quả**. Không component nào trong `components/task/` hiển thị ai đang có quyền
gì trên 1 task, không có dialog "Share task with…", không có UI chọn
`GrantLevel` (view/edit/manage).

Về "share-link" (dạng URL public/semi-public để chia sẻ 1 task, tương tự mô
hình `linkSourceProject` đã ghi nhận ở
[BUG-FE-PW-002](../project-workspace/BUG-FE-PW-002-orcaproject-source-project-sharing-no-ui.md)
cho `OrcaProject`): không tìm thấy khái niệm này ở bất kỳ đâu trong
`components/task/` hay backend task-service/proto — không phải "có nhưng
frontend chưa làm" mà là **tính năng share-link chưa tồn tại ở tầng thiết kế
cho Task** (khác với `OrcaProject`, nơi share qua `OrcaProjectSourceProject`
đã được thiết kế). Do đó mục "share-link" trong báo cáo này chỉ ghi nhận
khoảng trống concept, không phải 1 RPC bị bỏ quên như `task.grant`.

## Hậu quả

- Không ai (kể cả owner) có thể mời người khác xem/sửa 1 task cụ thể qua UI —
  quyền truy cập task hiện chỉ ngầm định qua quyền truy cập `Project` chứa
  nó (all-or-nothing ở cấp project), làm vô hiệu hoá mục đích của cơ chế
  `GrantLevel` per-task đã thiết kế ở backend.
- Không có cách nào qua UI để kiểm tra "tôi có quyền gì trên task này" —
  `task.resolvePermission` chỉ dùng nội bộ ở backend cho việc enforce, không
  bao giờ hiển thị lại cho user.
- Nếu sản phẩm thực sự cần share-link cho Task (không chỉ Project), đây là
  gap thiết kế cần 1 CR riêng, không chỉ là việc nối dây RPC có sẵn.

## Bằng chứng

```
desktop/src/main/task/task-rpc-handler.ts:13, 319-322, 340-347  → task.grant + task.resolvePermission tồn tại đầy đủ, có access-control theo GrantLevel
backend/src/main/task/task-rpc-handler.ts:13, 319-322, 340-347  → bản sao Node giống hệt (server/web mode)
backend-go/proto/orca/task/v1/task.proto:17-18, 92, 101-119      → rpc Grant/ResolvePermission + GrantLevel enum tồn tại ở backend-go
grep -rn "task.grant\|resolvePermission" frontend/src            → 0 kết quả (không tính comment nội bộ backend đã liệt kê ở trên)
grep -rni "sharelink\|share-link\|share_link" frontend/src/renderer/src/components/task  → 0 kết quả
```

## Đề xuất fix

1. Thêm 1 tab/section "Access" trong `TaskDetail.tsx` (song song "Details/Subtasks/AI") hiển thị danh sách grant hiện có + form thêm grant mới (chọn user + `GrantLevel`) → gọi `task.grant`.
2. Hiển thị permission hiện tại của user đang xem (badge nhỏ trong header `TaskDetail`) bằng cách gọi `task.resolvePermission` khi mount, ẩn các action ghi (Run/Delete/Update) nếu permission dưới mức cần thiết — hiện tại UI không tự ẩn nút dựa theo quyền, chỉ dựa vào backend reject khi bấm.
3. Nếu sản phẩm cần share-link thật cho Task: mở 1 CR riêng theo mẫu `OrcaProjectSourceProject`, không tự chế trong phạm vi bug này.

## Tham khảo

- Backend liên quan: [BUG-TASKV1-003](../../../backend-go/bugs/task-v1/BUG-TASKV1-003-orcatask-access-control-model-mismatch.md) (Grant/ResolvePermission RPC wiring qua wscompat/api-gateway)
- Liên quan: specs/frontend/bugs/project-workspace/BUG-FE-PW-002-orcaproject-source-project-sharing-no-ui.md (mô hình share tương tự đã ghi nhận cho OrcaProject, dùng làm tham chiếu pattern UI)
