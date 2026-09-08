# BUG-FE-TASKV1-001 — OrcaTask: không có UI tạo task thủ công, cây task tự build phía client

**Mức độ:** 🟠 High
**Status:** 🔴 Open
**Module:** `frontend/src/renderer/src/components/task/TaskGraph.tsx`, `TaskTreeView.tsx`, `TaskCard.tsx`, `hooks/useTask.ts`, `hooks/useTasks.ts`
**Phát hiện:** 2026-09-08 (audit frontend vs 3 hệ Task: OrcaTask/Task Execute/Workflow Orchestration)

---

## Mô tả

Backend Node (`desktop/src/main/task/task-rpc-handler.ts` và bản sao
`backend/src/main/task/task-rpc-handler.ts`) có RPC `task.create` đầy đủ
(`name: 'task.create'`, dòng 151-154 ở cả 2 file) và `task.recalculateProgress`
(dòng 290-297 — tính lại `progressPercent` đệ quy: leaf theo status, parent =
trung bình cộng của children). `backend-go`'s `task.proto` cũng có
`rpc CreateTask`. Nhưng grep toàn bộ `frontend/src` cho `'task.create'` /
`"task.create"` cho **0 kết quả** — không có form/dialog/button nào trong
frontend gọi RPC này.

Đường DUY NHẤT hiện có để tạo task mới là gián tiếp qua AI decompose
(`useTask.ts`'s `aiDecompose()` → `task.aiDecompose`, rồi `acceptSubtasks()` →
`task.aiApply`) — tạo **subtask** của 1 task cha có sẵn, không tạo được task
gốc (root, không cha) theo cách thủ công. `TaskGraph.tsx` (nơi hiển thị toàn
bộ danh sách task của project, có thanh search + filter status + toggle
Tree/DAG) không có bất kỳ nút "New Task"/"+" nào.

Về việc dựng cây: `TaskTreeView.tsx`'s `renderLevel()` tự filter
`tasks.filter(t => t.parentId === parentId)` phía client trên toàn bộ mảng
task đã tải về (từ `task.list`), đệ quy theo `parentId`. Backend-go thực tế
**không** có RPC nào lộ ra ngoài để lấy children/ancestors/subtree theo cây —
`GetAncestors`/`GetSubtree` (`backend-go/services/task-service/internal/...`)
chỉ là **method nội bộ** của `TaskRepository`/domain layer, dùng riêng cho
thuật toán BFS của `ResolvePermission` (comment tự thú tại
`get_dependencies.go:19`: *"GetAncestors (parent_child, not on this proto's
surface yet either)"*) — không phải RPC `task.getChildren`/`getAncestors`/
`getSubtree` lộ ra cho client như đôi khi bị hiểu nhầm. Nói cách khác: frontend
build cây bằng filter client-side không phải vì "lười gọi RPC có sẵn", mà vì
**chưa từng có RPC cây nào được expose** — với dự án lớn, tải toàn bộ task rồi
filter đệ quy phía client sẽ không scale.

`task.recalculateProgress` tồn tại ở backend nhưng không UI nào gọi — `TaskCard.tsx`
chỉ hiển thị `task.progressPercent` tĩnh (đọc từ `task.list`, dòng 33-34), không
có nút "Recalculate" nào sau khi user đổi status của 1 subtask — nghĩa là % của
task cha có thể lệch (stale) cho tới khi có 1 hành động khác kích hoạt refetch
toàn bộ danh sách.

## Hậu quả

- Người dùng không thể tạo 1 task mới (kể cả task gốc của project) mà không đi
  qua luồng AI decompose — nếu chỉ muốn ghi nhanh 1 task thủ công (không cần
  AI), không có đường nào trong UI.
- Cây task dựng bằng filter client-side trên toàn bộ mảng — không phân trang
  được theo nhánh, tốn băng thông/bộ nhớ khi project có nhiều task.
- `progressPercent` hiển thị cho task cha có thể sai lệch (stale) vì không có
  cơ chế UI nào trigger `task.recalculateProgress` sau khi subtask đổi status.

## Bằng chứng

```
frontend/src/renderer/src/components/task/TaskGraph.tsx:8-26      → toolbar chỉ có Search + filter Status + toggle Tree/DAG, không có nút "New Task"
frontend/src/renderer/src/hooks/useTask.ts:22-60                  → chỉ có aiDecompose()/acceptSubtasks() (task.aiDecompose/task.aiApply) tạo subtask, không có createTask() nào gọi task.create
frontend/src/renderer/src/components/task/TaskTreeView.tsx:14-15  → renderLevel() filter `tasks.filter(t => t.parentId === parentId)` phía client, đệ quy theo depth
frontend/src/renderer/src/components/task/TaskCard.tsx:33-34      → progressPercent chỉ hiển thị tĩnh, không có nút recalculate
desktop/src/main/task/task-rpc-handler.ts:151-154, 290-297         → task.create và task.recalculateProgress tồn tại đầy đủ ở backend Node, 0 lời gọi từ frontend
backend-go/services/task-service/internal/usecase/get_dependencies.go:19 → comment tự thú "GetAncestors (parent_child, not on this proto's surface yet either)" — xác nhận GetAncestors/GetSubtree KHÔNG phải RPC public, chỉ là domain-internal
```

## Đề xuất fix

1. Thêm nút "New Task" trong `TaskGraph.tsx` toolbar → dialog nhập title/type/priority tối thiểu → gọi `task.create`.
2. Sau khi đổi `status` của 1 task có cha (`useTask.ts`'s `updateTask()`), gọi thêm `task.recalculateProgress({ taskId: parentId })` cho từng ancestor bị ảnh hưởng, hoặc để backend tự trigger side-effect này trong `task.update` handler (tránh round-trip thêm ở FE).
3. Nếu cần cây scale cho project lớn: đề xuất backend-go thêm 1 RPC `ListTasks` có `parentId` filter + phân trang (tái dùng `ListTasksRequest` đã có), thay vì tải toàn bộ rồi filter client-side — đây là việc backend, theo dõi ở `specs/backend-go/bugs/task-v1`.

## Tham khảo

- Backend liên quan: [BUG-TASKV1-001](../../../backend-go/bugs/task-v1/BUG-TASKV1-001-orcatask-data-model-and-state-machine-gap.md) (RPC cây task chưa có, task.create/recalculateProgress chưa lộ ra ở backend-go)
- CR liên quan: docs/crs/v3/flow-task/CR-FLOW-TASK-005-frontend-unified-task-execution-ui.md (phạm vi không bao gồm CRUD/tree, chỉ đề cập Run + Activity Feed)
- Liên quan: BUG-FE-TASKV1-002 (dependency graph cùng cụm `task/` component)
