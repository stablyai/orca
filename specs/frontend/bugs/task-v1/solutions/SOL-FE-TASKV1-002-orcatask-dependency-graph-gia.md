# SOL-FE-TASKV1-002 — `TaskDAGView` vẽ dependency graph giả

**Bug:** [BUG-FE-TASKV1-002](../BUG-FE-TASKV1-002-orcatask-dependency-graph-gia.md)
**Loại giải pháp:** B — Full design
**Status:** 📋 Proposed — chưa triển khai

---

## Xác nhận lại RPC surface trước khi thiết kế (phát hiện mới, quan trọng)

Bug gốc đề xuất: *"gọi `task.addEdge`/tương đương `AddEdge`; xác nhận trước
với backend cypher/tên RPC chính xác đang lộ ra ở tầng RPC (không phải chỉ
proto)"*. Đã xác nhận trực tiếp bằng cách đọc toàn bộ
`backend-go/services/api-gateway/internal/adapter/wscompat/`:

```
grep -rn "r.Register(\"task\." backend-go/services/api-gateway/internal/adapter/wscompat/*.go
→ task.create, task.get (channels.go)
→ task.execute, task.list, task.update, task.delete, task.getDependencies,
  task.aiDecompose, task.aiApply (channels_automation_task.go)
```

**`AddEdge` KHÔNG có trong danh sách này** — RPC tồn tại ở tầng gRPC/proto
(`task.proto:16`) nhưng **chưa được wire vào wscompat**, khác hẳn giả định
ngầm của bug gốc ("chỉ frontend chưa gọi"). Đây là 1 tầng chặn nữa, y hệt
tình trạng `orchestration.*` mà BUG-FE-TASKV1-006 mô tả.

Thêm 1 phát hiện quan trọng hơn: đọc toàn bộ `TaskService` (`task.proto:13-47`)
xác nhận **không có RPC `RemoveEdge`/`DeleteEdge` nào cả** — không phải
thiếu wiring, mà **chưa từng được thiết kế** ở tầng proto. Đề xuất "thêm UI
thêm/xoá edge" của bug gốc chỉ khả thi được **nửa** (thêm) sau khi backend
wire `AddEdge` vào wscompat; nửa còn lại (xoá) cần 1 RPC mới hoàn toàn ở
backend-go, ngoài phạm vi frontend.

## Thiết kế

### Phần A — Sửa DAG hiển thị đúng dependency thật (khả thi ngay, chỉ dùng `task.getDependencies` đã có)

**1. Fetch dependencies theo batch cho toàn bộ task đang hiển thị**

Không có RPC batch (`task.getDependencies` chỉ nhận 1 `taskId` —
`GetDependenciesRequest.task_id`, `task.proto:172-174`) nên phải gọi N lần,
giới hạn concurrency giống cách `useTaskBatchExecution` làm ở
[SOL-FE-TASKV1-004](./SOL-FE-TASKV1-004-run-agent-ux-gaps.md):

```typescript
// frontend/src/renderer/src/hooks/useTaskDependencyEdges.ts (MỚI)
import { useState, useEffect } from 'react'
import { useAppStore } from '../store'
import { callRuntimeRpc, getActiveRuntimeTarget } from '../runtime/runtime-rpc-client'
import type { OrcaTask, TaskEdgeType } from '../../../shared/task-types'

export type TaskEdgeMap = Map<string, { blockedBy: string[]; blocks: string[] }>

const FETCH_CONCURRENCY = 4

// N+1 call vì task.getDependencies không có biến thể batch-theo-projectId
// ở backend-go hôm nay — xem đề xuất #1 gốc, theo dõi ở specs/backend-go/bugs/task-v1
// nếu backend thêm batch endpoint sau này thì thay thế hàm này bằng 1 call.
export function useTaskDependencyEdges(tasks: OrcaTask[]): { edges: TaskEdgeMap; loading: boolean; error: boolean } {
  const [edges, setEdges] = useState<TaskEdgeMap>(new Map())
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)

  useEffect(() => {
    if (tasks.length === 0) {
      setEdges(new Map())
      return
    }
    setLoading(true)
    setError(false)
    const target = getActiveRuntimeTarget(useAppStore.getState().settings)
    const result: TaskEdgeMap = new Map()
    let hadError = false
    const queue = [...tasks.map(t => t.id)]

    const worker = async () => {
      while (queue.length > 0) {
        const taskId = queue.shift()
        if (!taskId) continue
        try {
          const raw = await callRuntimeRpc<{ task: OrcaTask; edgeType: TaskEdgeType }[]>(
            target, 'task.getDependencies', { taskId }
          )
          result.set(taskId, {
            blockedBy: raw.filter(e => e.edgeType === 'depends_on').map(e => e.task.id),
            blocks: raw.filter(e => e.edgeType === 'blocks').map(e => e.task.id)
          })
        } catch {
          // Trước đây TaskDetail.tsx's `.catch(() => {})` nuốt lỗi hoàn toàn (bug gốc
          // đề xuất #3) — ở đây set cờ error thay vì im lặng, để DAG có thể báo
          // "dependency data có thể thiếu" thay vì hiển thị y hệt "không có dependency".
          hadError = true
        }
      }
    }
    Promise.all(Array.from({ length: FETCH_CONCURRENCY }, worker)).then(() => {
      setEdges(result)
      setError(hadError)
      setLoading(false)
    })
  }, [tasks])

  return { edges, loading, error }
}
```

**2. `TaskGraph.tsx`** — fetch 1 lần cho toàn bộ `filteredTasks`, truyền
xuống `TaskDAGView` qua prop mới:

```tsx
// TaskGraph.tsx
const { edges: dependencyEdges, loading: depsLoading, error: depsError } = useTaskDependencyEdges(filteredTasks)
...
<TaskDAGView tasks={filteredTasks} dependencyEdges={dependencyEdges} onSelect={setActiveTask} />
{depsLoading && <div className="text-xs text-muted-foreground px-2">Loading dependencies…</div>}
{depsError && <div className="text-xs text-destructive px-2">Một số dependency có thể chưa tải được</div>}
```

**3. `TaskDAGView.tsx`** — xoá hoàn toàn đọc `(task as any).dependsOn`, dùng
prop mới:

```tsx
// Before
type TaskDAGViewProps = { tasks: OrcaTask[]; onSelect: (taskId: string) => void }
function buildDAGLayout(tasks: OrcaTask[]) {
  const dependsOnMap = new Map<string, string[]>()
  for (const task of tasks) {
    dependsOnMap.set(task.id, (task as any).dependsOn ?? []) // luôn []
  }
  ...
}

// After
type TaskDAGViewProps = {
  tasks: OrcaTask[]
  dependencyEdges: TaskEdgeMap // từ useTaskDependencyEdges, MỚI
  onSelect: (taskId: string) => void
}
function buildDAGLayout(tasks: OrcaTask[], dependencyEdges: TaskEdgeMap) {
  const dependsOnMap = new Map<string, string[]>()
  for (const task of tasks) {
    dependsOnMap.set(task.id, dependencyEdges.get(task.id)?.blockedBy ?? [])
  }
  ...
  // Ở đoạn build edges (dòng 104-118 hiện tại), thay `(task as any).dependsOn ?? []`
  // bằng `dependencyEdges.get(task.id)?.blockedBy ?? []`
}

export function TaskDAGView({ tasks, dependencyEdges, onSelect }: TaskDAGViewProps) {
  const { nodes, edges } = useMemo(() => buildDAGLayout(tasks, dependencyEdges), [tasks, dependencyEdges])
  ...
}
```

Đây là fix có thể merge **ngay hôm nay**, không phụ thuộc backend — dùng
đúng RPC đã tồn tại và đã đúng (`task.getDependencies`, đã được
`TaskDetail.tsx` chứng minh hoạt động).

### Phần B — Thêm edge qua UI kéo-nối (PHỤ THUỘC backend: cần wire `task.addEdge` vào wscompat trước)

**Thiết kế phía frontend (sẵn sàng để cắm vào ngay khi backend wire xong):**

```tsx
// TaskDAGView.tsx — bật nodesConnectable có kiểm soát + onConnect handler
<ReactFlow
  nodes={nodes}
  edges={edges}
  onNodeClick={onNodeClick}
  onConnect={onConnect} // MỚI
  nodesDraggable={false}
  nodesConnectable // MỚI — bỏ `={false}` cũ
  ...
>
```

```typescript
// TaskDAGView.tsx — thêm handler, đặt sau khai báo edges/nodes
const onConnect = useCallback(async (connection: { source: string | null; target: string | null }) => {
  if (!connection.source || !connection.target) return
  const confirmed = window.confirm(
    `Đặt dependency: "${taskTitleById(connection.target)}" phụ thuộc vào "${taskTitleById(connection.source)}"?`
  )
  if (!confirmed) return
  try {
    const target = getActiveRuntimeTarget(useAppStore.getState().settings)
    // Tên channel wscompat giả định "task.addEdge" theo đúng convention camelCase
    // của các channel task.* khác (task.getDependencies, task.aiDecompose) — XÁC NHẬN
    // LẠI tên thật khi backend wire xong, có thể khác (ví dụ "task.dependency.add").
    await callRuntimeRpc(target, 'task.addEdge', {
      fromTaskId: connection.source,
      toTaskId: connection.target,
      type: 'EDGE_TYPE_DEPENDS_ON' // khớp EdgeType enum, task.proto:78-82
    })
    onEdgeAdded?.() // caller (TaskGraph.tsx) refetch useTaskDependencyEdges
  } catch (err) {
    toast.error(`Không thể thêm dependency: ${(err as Error).message}`)
  }
}, [onEdgeAdded])
```

**Không hiện thực nút "xoá edge"** trong solution này — không có RPC nào ở
backend-go để gọi (xem xác nhận ở trên). Nếu UI cần cho phép click-chuột-
phải-xoá 1 edge trên canvas, hành động đó phải disable/ẩn kèm tooltip *"Xoá
dependency chưa được backend hỗ trợ"* cho tới khi có RPC mới.

## Việc backend cần làm trước khi Phần B dùng được (ngoài phạm vi frontend)

Theo dõi ở `specs/backend-go/bugs/task-v1`:
1. Wire `AddEdge` (đã có ở gRPC) vào wscompat — thêm 1 dòng
   `r.Register("task.addEdge", ...)` theo đúng pattern
   `channels_automation_task.go`.
2. Thiết kế + thêm RPC `RemoveEdge` mới hoàn toàn ở `task.proto` +
   `task-service` — hiện chưa tồn tại ở bất kỳ tầng nào (proto/usecase/wscompat).

## Files cần sửa

| File | Action |
|------|--------|
| `frontend/src/renderer/src/hooks/useTaskDependencyEdges.ts` | NEW |
| `frontend/src/renderer/src/components/task/TaskGraph.tsx` | MODIFY — fetch dependencyEdges, truyền xuống DAG |
| `frontend/src/renderer/src/components/task/TaskDAGView.tsx` | MODIFY — bỏ `(task as any).dependsOn`, nhận prop `dependencyEdges`, thêm `onConnect` (Phần B, giữ sau flag/feature-detect nếu `task.addEdge` chưa sẵn sàng trên target đang chạy) |
| `frontend/src/renderer/src/components/task/TaskDetail.tsx` | MODIFY — mục nhỏ: đổi `.catch(() => {})` (dòng 57) thành set 1 state lỗi hiển thị được, theo cùng tinh thần Phần A |

## Tham khảo

- [BUG-TASKV1-001](../../../../backend-go/bugs/task-v1/BUG-TASKV1-001-orcatask-data-model-and-state-machine-gap.md) — `AddEdge`'s cycle-check thật đã có ở domain layer
- [SOL-FE-TASKV1-004](./SOL-FE-TASKV1-004-run-agent-ux-gaps.md) — pattern concurrency-limited fetch pool tương tự
