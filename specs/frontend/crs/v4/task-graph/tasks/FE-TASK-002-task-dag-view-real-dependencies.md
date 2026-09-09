# FE-TASK-002: `TaskDAGView` dùng dependency thật + UI "+ Add dependency"

**Domain:** task-graph
**Solution Ref:** FE-SOL-001 Phần 2
**Priority:** 🟠 P1
**Estimated:** 55 phút
**Status:** ✅ DONE — 2026-09-09

### Kết quả thực tế

- `TaskDAGView.tsx`: thêm `useDependencyEdges(tasks)` fetch `task.getDependencies` per-task (N+1,
  đúng như lường trước), `buildDAGLayout()` nhận thêm tham số `depsById` thay vì đọc
  `(task as any).dependsOn`. UI "+ Add dependency" (2 `<select>` from/to) gọi `task.addEdge`.
- **Sai lệch so với code mẫu trong spec (bắt buộc phải sửa, không phải optional polish):** code mẫu
  gốc của task này gọi `addDependency` trực tiếp trong `onChange` không có `try/catch` — nếu
  `task.addEdge` reject (ví dụ backend từ chối do cycle-detection), promise reject không có handler
  → **unhandled promise rejection** thật (xác nhận bằng cách chạy test, Vitest báo
  "Unhandled Rejection" dù test case "pass" về mặt logic). Đã thêm `try/catch` quanh
  `callRuntimeRpc('task.addEdge', ...)` + `toast.error(...)` khi lỗi (giữ đúng hành vi spec yêu
  cầu: không reset `addingFor`, người dùng thử lại được) — không đổi ý nghĩa test case "task.addEdge
  lỗi → không crash, addingFor không reset", chỉ làm nó thật sự không phát sinh lỗi ẩn.
- `impact({target: "TaskDAGView", direction: "upstream"})`: 3 symbol trùng tên `TaskDAGView` khớp
  (component thật, default-export const ở `TaskGraph.tsx`, và const cùng tên) — risk **LOW** ở cả 3
  candidate (max 2 impacted), khớp kỳ vọng "chỉ `TaskGraph.tsx` lazy-import".
- Test mới `TaskDAGView.test.tsx` (file này trước đó chưa tồn tại, dù bảng "Files cần sửa" ghi
  MODIFY — tạo mới NEW): mock `@xyflow/react` theo đúng pattern đã dùng ở
  `components/workflow/__tests__/DAGPreview.test.tsx` (ReactFlow không render được trong
  happy-dom/jsdom nếu không mock). 4 test case theo đúng "Test cases cần cover". Kết quả
  `npx vitest run`: **4/4 pass**, không còn Unhandled Rejection. `npx tsc --noEmit -p .`: 0 lỗi mới.
- Task hoàn toàn độc lập, không có blocker.

---

## Mục tiêu

`TaskDAGView.tsx` (đọc trực tiếp hôm nay, dòng 28-32) vẫn tự thú trong comment: *"OrcaTask has no
embedded `dependsOn`... Always [] until that's wired in (out of scope here)."* —
`(task as any).dependsOn ?? []` luôn trả `[]`, nên DAG view hôm nay render đúng node nhưng **không
bao giờ vẽ cạnh phụ thuộc nào**, bất kể dữ liệu thật. Thay nguồn dữ liệu bằng RPC
`task.getDependencies` (đã tồn tại thật), và thêm UI "+ Add dependency" gọi `task.addEdge` (cũng đã
tồn tại thật).

## Xác nhận đã đọc code thật trước khi viết task (2026-09-09)

- `task.getDependencies` **đã tồn tại thật**, đăng ký ở
  `backend-go/services/api-gateway/internal/adapter/wscompat/channels_automation_task.go:330-347`.
  `TaskDetail.tsx` (dòng 42-58) **đã dùng RPC này** để hiển thị Dependencies ở tab Details — response
  shape xác nhận trực tiếp từ code đó: **flat array `{ task: OrcaTask; edgeType: TaskEdgeType }[]`**,
  KHÔNG phải `{ dependencies: { taskId }[] }` như code mẫu gốc ở FE-SOL-001 §2 giả định
  (`d.dependencies.map(d => d.taskId)`). Copy đúng theo cách `TaskDetail.tsx` đã làm, không theo mẫu
  gốc của solution.
- `task.addEdge` **đã tồn tại thật**,
  `channels_automation_task.go:348-367`, args thật `{ fromTaskId, toTaskId, type }` (field `type` là
  string parse qua `parseEdgeType`, khớp `TaskEdgeType = 'depends_on'|'blocks'|'relates_to'|'duplicates'`
  ở `task-types.ts:36`).
- `TaskDAGView` được `TaskGraph.tsx` lazy-load và nhận đúng 2 prop `{ tasks, onSelect }`
  (`TaskGraph.tsx:6,32`) — không có prop nào khác được truyền, cần thêm truyền qua nếu muốn dùng
  `onAddDependency` (xem bước 3).

## Files cần sửa

| File | Action |
|------|--------|
| `frontend/src/renderer/src/components/task/TaskDAGView.tsx` | MODIFY — `buildDAGLayout()` đổi nguồn dữ liệu, thêm state deps + UI add-edge |
| `frontend/src/renderer/src/components/task/TaskGraph.tsx` | MODIFY — không đổi props truyền (giữ `{tasks, onSelect}`), chỉ xác nhận `refetch` từ FE-TASK-001 sẵn sàng để gọi lại sau khi add-edge (không bắt buộc — xem bước 3) |
| `frontend/src/renderer/src/components/task/__tests__/TaskDAGView.test.tsx` | MODIFY — case cạnh thật render đúng, case add-edge |

## Các bước thực thi

### 1. Fetch dependency thật trong `TaskDAGView.tsx`

Thay vì tính `dependsOnMap` đồng bộ từ `(task as any).dependsOn`, fetch bất đồng bộ theo đúng shape
thật `TaskDetail.tsx` đã dùng:

```tsx
// TaskDAGView.tsx
import { useMemo, useCallback, useEffect, useState } from 'react'
import { callRuntimeRpc, getActiveRuntimeTarget } from '../../runtime/runtime-rpc-client'
import { useAppStore } from '../../store'
import type { OrcaTask, TaskEdgeType } from '../../../../shared/task-types'

// ... STATUS_COLORS giữ nguyên ...

function useDependencyEdges(tasks: OrcaTask[]) {
  const [depsById, setDepsById] = useState<Map<string, string[]>>(new Map())

  useEffect(() => {
    let cancelled = false
    const target = getActiveRuntimeTarget(useAppStore.getState().settings)
    Promise.all(
      tasks.map(async (t) => {
        // Shape thật channels_automation_task.go:330-347 — flat { task, edgeType }[],
        // giống hệt cách TaskDetail.tsx (dòng 47-57) đã dùng, KHÔNG phải { dependencies: [...] }.
        const edges = (await callRuntimeRpc(target, 'task.getDependencies', { taskId: t.id })) as {
          task: OrcaTask
          edgeType: TaskEdgeType
        }[]
        return [t.id, edges.filter((e) => e.edgeType === 'depends_on').map((e) => e.task.id)] as const
      })
    )
      .then((pairs) => {
        if (!cancelled) {
          setDepsById(new Map(pairs))
        }
      })
      .catch(() => {
        /* giữ depsById cũ nếu 1 request lỗi — DAG vẫn render với dữ liệu đã có */
      })
    return () => {
      cancelled = true
    }
  }, [tasks])

  return depsById
}
```

N+1 RPC (1 lần gọi/task) chấp nhận được cho dataset hiện tại (dozens of tasks/project) — đúng như
FE-SOL-001 §2 đã lường trước; không tự chế batch endpoint ở đây (việc backend-go nếu cần sau này).

### 2. Đổi `buildDAGLayout()` dùng `depsById` thay vì đọc từ `task`

```tsx
function buildDAGLayout(tasks: OrcaTask[], depsById: Map<string, string[]>): { nodes: Node[]; edges: Edge[] } {
  if (tasks.length === 0) {
    return { nodes: [], edges: [] }
  }
  const dependsOnMap = new Map<string, string[]>()
  for (const task of tasks) {
    dependsOnMap.set(task.id, depsById.get(task.id) ?? [])
  }
  // ...phần wave assignment + nodes giữ nguyên, chỉ đổi dependsOnMap.set(...) ở trên...
  // Tương tự phần tạo edges: đổi `(task as any).dependsOn ?? []` thành `depsById.get(task.id) ?? []`
}

export function TaskDAGView({ tasks, onSelect }: TaskDAGViewProps) {
  const depsById = useDependencyEdges(tasks)
  const { nodes, edges } = useMemo(() => buildDAGLayout(tasks, depsById), [tasks, depsById])
  // ...phần còn lại giữ nguyên...
}
```

### 3. Thêm UI "+ Add dependency"

Thêm 1 nút nổi trên toolbar của `TaskDAGView` (không phải trong node — giữ node rendering đơn giản,
đúng theo cách `TaskGraph.tsx` đặt toolbar bên ngoài view hiện tại):

```tsx
// TaskDAGView.tsx — thêm state + handler, đặt nút phía trên <ReactFlow>
const [addingFor, setAddingFor] = useState<string | null>(null)

const addDependency = useCallback(async (fromTaskId: string, toTaskId: string) => {
  const target = getActiveRuntimeTarget(useAppStore.getState().settings)
  await callRuntimeRpc(target, 'task.addEdge', { fromTaskId, toTaskId, type: 'depends_on' })
  setAddingFor(null)
  // Không có cách nào refetch depsById từ đây khác ngoài đợi `tasks` prop đổi (trigger useEffect ở
  // useDependencyEdges) — chấp nhận được vì `tasks` re-render mỗi khi useTasks's refetch chạy; nếu
  // cần cập nhật ngay lập tức không đợi refetch cha, thêm 1 forceRefresh cục bộ ở bước follow-up.
}, [])
```

```tsx
// JSX — nút đơn giản mở dropdown chọn task đích, đặt trước <ReactFlow>
<div className="flex items-center gap-2 p-1 border-b text-xs">
  <select
    className="border rounded px-1 py-0.5"
    onChange={(e) => setAddingFor(e.target.value || null)}
    value={addingFor ?? ''}
    data-testid="dag-add-dependency-select-from"
  >
    <option value="">+ Add dependency: select task...</option>
    {tasks.map((t) => (
      <option key={t.id} value={t.id}>{t.title}</option>
    ))}
  </select>
  {addingFor && (
    <select
      className="border rounded px-1 py-0.5"
      onChange={(e) => e.target.value && addDependency(addingFor, e.target.value)}
      data-testid="dag-add-dependency-select-to"
    >
      <option value="">depends on...</option>
      {tasks.filter((t) => t.id !== addingFor).map((t) => (
        <option key={t.id} value={t.id}>{t.title}</option>
      ))}
    </select>
  )}
</div>
```

Theo [`guides/STYLEGUIDE.md`](../../../../../../guides/STYLEGUIDE.md) — dùng `border rounded`
tokens đã thấy lặp lại ở `TaskGraph.tsx`'s filter `<select>` (dòng 16), không tự vẽ dropdown mới.

## Không làm ở task này

- Không thêm batch endpoint cho `task.getDependencies` — N+1 chấp nhận được ở dataset hiện tại, việc
  backend-go nếu cần tối ưu sau này.
- Không đổi `TaskDetail.tsx`'s cách hiển thị Dependencies (tab Details) — nó đã đúng, không cần sửa.
- Không validate cycle ở phía client trước khi gọi `task.addEdge` — `AddEdge` ở backend-go's
  task-service đã atomic + có cycle-detection riêng (theo BE-SOL-001's thiết kế); để backend từ chối
  và hiển thị lỗi qua toast là đủ, không tự trùng lặp logic.

## Test cases cần cover

```
TaskDAGView.test.tsx (case mới, giữ nguyên case cũ)
├── 2 tasks, task.getDependencies trả 1 cạnh depends_on → edges render đúng 1 cạnh giữa 2 node
├── task.getDependencies lỗi cho 1 task → DAG vẫn render nodes, cạnh liên quan task đó = rỗng
├── chọn "from" rồi "to" trong dropdown add-dependency → gọi task.addEdge({ fromTaskId, toTaskId,
│   type: 'depends_on' })
└── task.addEdge lỗi → không crash, addingFor không reset (người dùng có thể thử lại)
```

## Verify

```bash
cd frontend && npx vitest run src/renderer/src/components/task/__tests__/TaskDAGView.test.tsx
cd frontend && npx tsc --noEmit -p .
```

## gitnexus

Chạy trước khi sửa (bắt buộc theo CLAUDE.md):
```
impact({target: "TaskDAGView", direction: "upstream"})
```
Kỳ vọng chỉ `TaskGraph.tsx` (lazy import) là caller — risk LOW. Dán kết quả thật vào PR.

## Depends on

Không có (cả `task.getDependencies` và `task.addEdge` đã tồn tại thật, xác nhận ở trên)

## Blocking

Không có
