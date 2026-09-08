# TASK-FE-TASKV1-04 — Thêm dependency edge qua kéo-nối trên `TaskDAGView`

**Solution:** [SOL-FE-TASKV1-002](../solutions/SOL-FE-TASKV1-002-orcatask-dependency-graph-gia.md) (Phần B)
**Bug:** [BUG-FE-TASKV1-002](../BUG-FE-TASKV1-002-orcatask-dependency-graph-gia.md)
**File:** `frontend/src/renderer/src/components/task/TaskDAGView.tsx`
**Estimated:** 45 phút (code), nhưng KHÔNG chạy được thật cho tới khi backend-go wire xong
**Status:** [ ] TODO
**Phụ thuộc:** [TASK-FE-TASKV1-03](./TASK-FE-TASKV1-03-taskdagview-real-dependency-data.md) (cần `dependencyEdges` prop + `onEdgeAdded` refetch đã có trước)

---

## ⚠️ Depends on: backend-go task chưa sẵn sàng (BLOCKING)

**RPC `AddEdge` đã tồn tại ở gRPC/proto** (`backend-go/proto/orca/task/v1/task.proto:16`,
`AddEdgeRequest{from_task_id, to_task_id, type}` dòng 84-90) **nhưng CHƯA được wire vào wscompat**
— xác nhận bằng grep toàn bộ
`backend-go/services/api-gateway/internal/adapter/wscompat/*.go`: danh sách channel `task.*` đã
đăng ký chỉ có `create, get` (`channels.go:277,295`) và
`execute, list, update, delete, getDependencies, aiDecompose, aiApply`
(`channels_automation_task.go:223-330`) — **không có `task.addEdge`**.

**Depends on: backend-go task (chưa track thành 1 file riêng ở `specs/backend-go/bugs/task-v1` tại
thời điểm viết task này — xem SOL-FE-TASKV1-002 mục "Việc backend cần làm" để biết chi tiết yêu
cầu: thêm 1 dòng `r.Register("task.addEdge", ...)` theo đúng pattern các channel `task.*` khác
trong `channels_automation_task.go`).** Task frontend này chỉ làm được phần UI (kéo-nối trên canvas
+ gọi RPC); mọi lần thử connect sẽ nhận lỗi "method not found" cho tới khi backend-go wire xong.
**Không release tính năng này ra sau feature flag "ẩn khi lỗi" tuỳ tiện** — hiển thị lỗi rõ ràng qua
toast (đã có sẵn pattern `toast.error` trong `TaskDetail.tsx`), không im lặng nuốt lỗi.

Thêm nữa: **RPC xoá edge (`RemoveEdge`/`DeleteEdge`) không tồn tại ở BẤT KỲ tầng nào** (không phải
thiếu wiring — chưa từng được thiết kế ở `task.proto`). Task này **không** làm UI xoá edge — nếu
cần cho phép right-click 1 cạnh trên canvas, phải disable kèm tooltip
*"Xoá dependency chưa được backend hỗ trợ"*, không giả vờ hoạt động.

---

## Mục tiêu

Bật `nodesConnectable` trên `TaskDAGView`, cho phép user kéo-nối 2 node để tạo dependency mới qua
`task.addEdge` (sẵn sàng để cắm vào ngay khi backend wire xong — không cần sửa lại code UI lúc đó).

## Context

Đọc trước:
- `frontend/src/renderer/src/components/task/TaskDAGView.tsx:144-163` (sau khi TASK-03 áp dụng: `ReactFlow` props `nodesDraggable={false} nodesConnectable={false}`).
- `backend-go/proto/orca/task/v1/task.proto:77-90` — `EdgeType` enum, `AddEdgeRequest`.

## Thay đổi cần thực hiện

**File:** `frontend/src/renderer/src/components/task/TaskDAGView.tsx`

```tsx
// Props — thêm onEdgeAdded (caller = TaskGraph.tsx, refetch useTaskDependencyEdges)
type TaskDAGViewProps = {
  tasks: OrcaTask[]
  dependencyEdges: TaskEdgeMap
  onSelect: (taskId: string) => void
  onEdgeAdded?: () => void
}

// Handler mới, đặt trong component TaskDAGView
const onConnect = useCallback(async (connection: { source: string | null; target: string | null }) => {
  if (!connection.source || !connection.target) return
  const sourceTitle = tasks.find(t => t.id === connection.source)?.title ?? connection.source
  const targetTitle = tasks.find(t => t.id === connection.target)?.title ?? connection.target
  const confirmed = window.confirm(`Đặt dependency: "${targetTitle}" phụ thuộc vào "${sourceTitle}"?`)
  if (!confirmed) return
  try {
    const target = getActiveRuntimeTarget(useAppStore.getState().settings)
    // Tên channel wscompat giả định "task.addEdge" theo đúng convention camelCase của các
    // channel task.* khác — XÁC NHẬN LẠI tên thật khi backend wire xong (theo dõi task chưa
    // được track, xem "Depends on" ở trên).
    await callRuntimeRpc(target, 'task.addEdge', {
      fromTaskId: connection.source,
      toTaskId: connection.target,
      type: 'EDGE_TYPE_DEPENDS_ON'
    })
    onEdgeAdded?.()
  } catch (err) {
    toast.error(`Không thể thêm dependency: ${(err as Error).message}`)
  }
}, [tasks, onEdgeAdded])

// JSX <ReactFlow>: bật kết nối
<ReactFlow
  nodes={nodes}
  edges={edges}
  onNodeClick={onNodeClick}
  onConnect={onConnect}
  nodesDraggable={false}
  nodesConnectable
  ...
>
```

Cần thêm import `toast` từ `sonner` (đã dùng ở `TaskDetail.tsx`) và
`callRuntimeRpc, getActiveRuntimeTarget` từ `../../runtime/runtime-rpc-client` +
`useAppStore` từ `../../store`.

**`TaskGraph.tsx`** — truyền `onEdgeAdded` để refetch:

```tsx
// useTaskDependencyEdges không tự expose refetch — cách đơn giản nhất: đổi `tasks` reference
// (không cần refactor hook) bằng cách bump 1 state đếm, hoặc (đơn giản hơn) để useEffect's
// dependency [tasks] tự chạy lại khi filteredTasks đổi sau khi task.update phản ánh edge mới —
// nếu edge không kèm theo thay đổi field nào trên OrcaTask, cần thêm 1 `refetchKey` state:
const [depsRefetchKey, setDepsRefetchKey] = useState(0)
const { edges: dependencyEdges, ... } = useTaskDependencyEdges(filteredTasks) // xem ghi chú dưới
...
<TaskDAGView
  tasks={filteredTasks}
  dependencyEdges={dependencyEdges}
  onSelect={setActiveTask}
  onEdgeAdded={() => setDepsRefetchKey(k => k + 1)}
/>
```

> [!IMPORTANT]
> `useTaskDependencyEdges` (TASK-03) hiện chỉ re-fetch khi `tasks` array đổi reference. Để
> `onEdgeAdded` thực sự trigger refetch, cần sửa hook đó thêm 1 tham số phụ trợ
> (`refetchKey: number`) vào mảng dependency của `useEffect`, hoặc export 1 hàm `refetch()` từ
> hook. Chọn 1 trong 2 cách khi implement — không để `onEdgeAdded` gọi mà không có gì xảy ra.

## Verify

```bash
pnpm --filter frontend tsc --noEmit
pnpm --filter frontend test -- TaskDAGView
```

Kiểm tra thủ công: kéo nối 2 node → thấy toast lỗi "method not found" (đúng như kỳ vọng cho tới khi
backend-go wire `task.addEdge`) — đây là bằng chứng UI đã sẵn sàng, không phải bug.

## Definition of Done

- [ ] `TaskDAGView.tsx` có `onConnect` + `nodesConnectable`, gọi `task.addEdge` với đúng payload
- [ ] Lỗi RPC hiển thị qua `toast.error`, không nuốt im lặng
- [ ] Refetch dependency data sau khi thêm edge thành công (qua `onEdgeAdded` + sửa hook TASK-03 hỗ trợ refetch)
- [ ] KHÔNG có UI xoá edge trong task này (ghi rõ trong PR: chờ RPC `RemoveEdge` mới)
- [ ] PR mô tả rõ: tính năng này sẽ lỗi 100% trên mọi backend-go deploy target cho tới khi `task.addEdge` được wire ở wscompat (chưa có task backend-go riêng track việc này — cần mở)
