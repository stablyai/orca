# TASK-FE-TASKV1-03 — `TaskDAGView` vẽ dependency thật + sửa `TaskDetail.tsx` đọc sai shape `task.getDependencies`

**Solution:** [SOL-FE-TASKV1-002](../solutions/SOL-FE-TASKV1-002-orcatask-dependency-graph-gia.md) (Phần A)
**Bug:** [BUG-FE-TASKV1-002](../BUG-FE-TASKV1-002-orcatask-dependency-graph-gia.md)
**File:** `frontend/src/renderer/src/hooks/useTaskDependencyEdges.ts` (mới), `frontend/src/renderer/src/components/task/TaskGraph.tsx`, `frontend/src/renderer/src/components/task/TaskDAGView.tsx`, `frontend/src/renderer/src/components/task/TaskDetail.tsx`
**Estimated:** 90 phút
**Status:** [ ] TODO
**Phụ thuộc:** Không — dùng đúng RPC `task.getDependencies` đã tồn tại và hoạt động ở cả 2 tầng (gRPC + wscompat)

---

## Phát hiện quan trọng khi viết task này — sửa lại thiết kế của SOL-FE-TASKV1-002

SOL-FE-TASKV1-002's `useTaskDependencyEdges` (và code THẬT đang chạy ở `TaskDetail.tsx:47-58`)
đều giả định `task.getDependencies` trả về `{ task: OrcaTask; edgeType: TaskEdgeType }[]`. Đọc trực
tiếp response thật:

- `backend-go/proto/orca/task/v1/task.proto:172-177`:
  ```protobuf
  message GetDependenciesRequest { string task_id = 1; }
  message GetDependenciesResponse { repeated Task dependencies = 1; }
  ```
  — không có field `edgeType` nào cả.
- `backend-go/services/api-gateway/internal/adapter/wscompat/channels_automation_task.go:296-308`:
  wscompat trả thẳng `resp.GetDependencies()` — tức là **1 mảng `Task[]` phẳng**, không bọc
  `{task, edgeType}`.
- Comment ngay tại `task.proto:169-171` xác nhận RPC này **chỉ đi 1 chiều**: *"GetDependencies walks
  depends_on edges FROM task_id"* — nghĩa là danh sách trả về LUÔN là "task này phụ thuộc vào
  (blockedBy)", không có cách nào lấy "blocks" (ai phụ thuộc vào task này) từ 1 lệnh gọi đơn — và
  hoàn toàn không có `edgeType` để phân biệt vì RPC chỉ trả về 1 loại quan hệ.

**Hệ quả:** code thật hiện tại ở `TaskDetail.tsx:51-55`
(`edges.filter(e => e.edgeType === 'depends_on')`) đang chạy trên 1 mảng `Task[]` chứ không phải
`{task, edgeType}[]` — `e.edgeType` luôn là `undefined`, nên **`deps.blockedBy` và `deps.blocks`
LUÔN rỗng ngay cả khi task có dependency thật**. Đây là 1 bug run-time đang tồn tại, độc lập với
`TaskDAGView`'s bug đã biết (`(task as any).dependsOn`) — chưa từng được BUG-FE-TASKV1-002 hay
solution gốc ghi nhận cụ thể (solution chỉ đề cập sửa `.catch(() => {})`, không đề cập response
shape sai). Task này sửa luôn cả 2.

**Thiết kế đúng:** `useTaskDependencyEdges` fetch cho TOÀN BỘ task đang hiển thị (đã đúng theo
solution gốc), nhưng với response thật là `Task[]` (blockedBy trực tiếp), rồi **tự suy ra chiều
ngược `blocks`** bằng cách quét chéo tập đã fetch (task X blocks task Y nếu Y's blockedBy list chứa
X) — không cần RPC thứ 2, chỉ cần xử lý lại dữ liệu đã có.

## Context

Đọc trước:
- `frontend/src/renderer/src/components/task/TaskDAGView.tsx` (166 dòng, đặc biệt dòng 28-32, 106) — `(task as any).dependsOn ?? []` luôn `[]`.
- `frontend/src/renderer/src/components/task/TaskDetail.tsx:37-58` — state `deps` + effect gọi `task.getDependencies`, `.catch(() => {})` ở dòng 57.
- `frontend/src/renderer/src/components/task/TaskGraph.tsx` (37 dòng).
- `backend-go/proto/orca/task/v1/task.proto:169-177`.

## Thay đổi cần thực hiện

### 1. File mới — `frontend/src/renderer/src/hooks/useTaskDependencyEdges.ts`

```typescript
import { useState, useEffect } from 'react'
import { useAppStore } from '../store'
import { callRuntimeRpc, getActiveRuntimeTarget } from '../runtime/runtime-rpc-client'
import type { OrcaTask } from '../../../shared/task-types'

export type TaskEdgeMap = Map<string, { blockedBy: string[]; blocks: string[] }>

const FETCH_CONCURRENCY = 4

// N+1 call vì task.getDependencies không có biến thể batch-theo-projectId ở
// backend-go hôm nay. Response thật là Task[] phẳng (KHÔNG có edgeType — xem
// task.proto:169-177 + channels_automation_task.go:296-308), luôn là chiều
// "task này phụ thuộc vào" — suy ra chiều "blocks" ngược lại bằng cách quét
// chéo sau khi có đủ dữ liệu của mọi task trong batch.
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
    const blockedByMap = new Map<string, string[]>()
    let hadError = false
    const queue = [...tasks.map(t => t.id)]

    const worker = async () => {
      while (queue.length > 0) {
        const taskId = queue.shift()
        if (!taskId) continue
        try {
          const deps = await callRuntimeRpc<OrcaTask[]>(target, 'task.getDependencies', { taskId })
          blockedByMap.set(taskId, (deps ?? []).map(d => d.id))
        } catch {
          // TaskDetail.tsx's `.catch(() => {})` trước đây nuốt lỗi hoàn toàn — ở
          // đây set cờ error thay vì im lặng.
          hadError = true
        }
      }
    }
    Promise.all(Array.from({ length: FETCH_CONCURRENCY }, worker)).then(() => {
      // Suy ra "blocks" (chiều ngược) từ blockedByMap đã fetch đủ cho mọi task trong batch.
      const result: TaskEdgeMap = new Map()
      for (const taskId of blockedByMap.keys()) {
        result.set(taskId, { blockedBy: blockedByMap.get(taskId) ?? [], blocks: [] })
      }
      for (const [taskId, blockedBy] of blockedByMap) {
        for (const depId of blockedBy) {
          const entry = result.get(depId)
          if (entry) entry.blocks.push(taskId)
        }
      }
      setEdges(result)
      setError(hadError)
      setLoading(false)
    })
  }, [tasks])

  return { edges, loading, error }
}
```

### 2. `TaskGraph.tsx` — fetch 1 lần cho `filteredTasks`

```tsx
const { edges: dependencyEdges, loading: depsLoading, error: depsError } = useTaskDependencyEdges(filteredTasks)
...
<TaskDAGView tasks={filteredTasks} dependencyEdges={dependencyEdges} onSelect={setActiveTask} />
{depsLoading && <div className="text-xs text-muted-foreground px-2">Loading dependencies…</div>}
{depsError && <div className="text-xs text-destructive px-2">Một số dependency có thể chưa tải được</div>}
```

### 3. `TaskDAGView.tsx` — bỏ `(task as any).dependsOn`, nhận prop mới

```tsx
// Thay type ở dòng 6-9
type TaskDAGViewProps = {
  tasks: OrcaTask[]
  dependencyEdges: TaskEdgeMap
  onSelect: (taskId: string) => void
}

// buildDAGLayout (dòng 22) nhận thêm tham số, dùng ở dòng 30-33 và 105-107:
function buildDAGLayout(tasks: OrcaTask[], dependencyEdges: TaskEdgeMap): { nodes: Node[]; edges: Edge[] } {
  ...
  const dependsOnMap = new Map<string, string[]>()
  for (const task of tasks) {
    dependsOnMap.set(task.id, dependencyEdges.get(task.id)?.blockedBy ?? [])
  }
  ...
  // dòng 105-107, thay (task as any).dependsOn bằng:
  const deps = dependencyEdges.get(task.id)?.blockedBy ?? []
}

export function TaskDAGView({ tasks, dependencyEdges, onSelect }: TaskDAGViewProps) {
  const { nodes, edges } = useMemo(() => buildDAGLayout(tasks, dependencyEdges), [tasks, dependencyEdges])
  ...
}
```

### 4. `TaskDetail.tsx` — sửa cả shape đọc sai LẪN `.catch(() => {})` (dòng 37-58)

```tsx
// Before (dòng 37-58)
const [deps, setDeps] = useState<{ blockedBy: OrcaTask[]; blocks: OrcaTask[] }>({ blockedBy: [], blocks: [] })
useEffect(() => {
  if (!task?.id) return
  const target = getActiveRuntimeTarget(useAppStore.getState().settings)
  callRuntimeRpc(target, 'task.getDependencies', { taskId: task.id })
    .then((d) => {
      const edges = d as { task: OrcaTask; edgeType: TaskEdgeType }[]
      setDeps({
        blockedBy: edges.filter((e) => e.edgeType === 'depends_on').map((e) => e.task),
        blocks: edges.filter((e) => e.edgeType === 'blocks').map((e) => e.task)
      })
    })
    .catch(() => {})
}, [task?.id])

// After — dùng chung useTaskDependencyEdges (task đơn: truyền mảng 1 phần tử là chưa đủ để suy
// ra "blocks" chéo, nên vẫn cần fetch riêng "blockedBy" của chính task này qua 1 lệnh gọi trực
// tiếp cho tab Details; "blocks" tab Details không suy ra được nếu không có toàn bộ project trong
// tay — chấp nhận: TaskDetail chỉ hiển thị blockedBy chính xác, "blocks" hiển thị "—" kèm ghi chú).
const [blockedBy, setBlockedBy] = useState<OrcaTask[]>([])
const [depsError, setDepsError] = useState(false)
useEffect(() => {
  if (!task?.id) return
  setDepsError(false)
  const target = getActiveRuntimeTarget(useAppStore.getState().settings)
  callRuntimeRpc<OrcaTask[]>(target, 'task.getDependencies', { taskId: task.id })
    .then((deps) => setBlockedBy(deps ?? []))
    .catch(() => setDepsError(true)) // không còn nuốt lỗi im lặng
}, [task?.id])
```

Cập nhật JSX phần "Dependencies" (dòng 152-169) để dùng `blockedBy` thay `deps.blockedBy`, bỏ hẳn
`deps.blocks` (ghi chú `"Blocks: chưa hỗ trợ hiển thị ở tab Details — xem tab DAG"`), và hiện dòng
lỗi khi `depsError`.

> [!IMPORTANT]
> Import `TaskEdgeType` ở đầu `TaskDetail.tsx` (dòng 14) không còn dùng sau thay đổi này — xoá khỏi
> import nếu không còn chỗ nào khác trong file dùng tới (kiểm tra bằng `grep -n TaskEdgeType`).

## Verify

```bash
pnpm --filter frontend tsc --noEmit
pnpm --filter frontend test -- TaskDAGView TaskDetail useTaskDependencyEdges TaskGraph
grep -n "TaskEdgeType" frontend/src/renderer/src/components/task/TaskDetail.tsx
# Không còn import thừa nếu đã xoá dùng
```

## Definition of Done

- [ ] `useTaskDependencyEdges.ts` mới, xử lý đúng response thật (`Task[]` phẳng, không `edgeType`), tự suy `blocks` ngược chiều
- [ ] `TaskDAGView.tsx` không còn `(task as any).dependsOn` ở bất kỳ dòng nào
- [ ] `TaskDetail.tsx` không còn `.catch(() => {})` im lặng; không còn giả định response có `edgeType`
- [ ] Test mới: mock `task.getDependencies` trả `Task[]` thật (không phải `{task, edgeType}`), assert DAG vẽ đúng cạnh + `TaskDetail` hiển thị đúng `blockedBy`
- [ ] `pnpm tsc --noEmit` sạch
