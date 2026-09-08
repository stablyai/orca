# SOL-FE-TASKV1-001 — OrcaTask: thêm UI tạo task thủ công + progress hiển thị đúng hơn

**Bug:** [BUG-FE-TASKV1-001](../BUG-FE-TASKV1-001-orcatask-crud-va-tree-navigation.md)
**Loại giải pháp:** B — Full design
**Status:** 📋 Proposed — chưa triển khai

---

## Xác nhận lại RPC surface trước khi thiết kế (quan trọng — thu hẹp phạm vi khả thi)

Đọc trực tiếp `backend-go/proto/orca/task/v1/task.proto` và
`backend-go/services/api-gateway/internal/adapter/wscompat/channels.go:277-306`:

- `task.create` **đã được wire đầy đủ cả 2 tầng** (gRPC `CreateTask` +
  wscompat channel `task.create`) — khác với `AddEdge`/`Grant` (xem
  SOL-FE-TASKV1-002/003), đây là RPC **có thể gọi thật ngay hôm nay**.
- Nhưng `CreateTaskRequest` (`task.proto:58-63`) chỉ có
  **`tenant_id`, `title`, `parent_id`, `project_id`** — khớp đúng
  [BUG-TASKV1-001](../../../../backend-go/bugs/task-v1/BUG-TASKV1-001-orcatask-data-model-and-state-machine-gap.md):
  `domain.Task` chỉ có 6 field, thiếu `description/type/priority/labels/...`.
  **Dialog "New Task" chỉ có thể thu thập Title + Parent (optional)** — mọi
  field khác (`type`, `priority`, `description`, `labels`) hiển thị trong
  form là vô nghĩa vì backend-go sẽ bỏ qua, không lưu.
- Response của `task.create` (`resp.GetTask()`) trả về `Task` message chỉ có
  `{id, tenant_id, title, status, parent_id, project_id}` — **thiếu** hầu
  hết field mà `shared/task-types.ts`'s `OrcaTask` type khai là **bắt buộc**
  (`type`, `priority`, `labels: string[]`, `visibility`, `progressPercent:
  number`, `createdAt`, `updatedAt`). Đẩy thẳng object trả về vào
  `useAppStore.getState().addTask()` sẽ tạo 1 `OrcaTask` "què" (thiếu field
  bắt buộc theo type), gây lỗi hiển thị ở `TaskCard.tsx` (đọc `task.type`,
  `task.priority`, `task.progressPercent` không optional-chain).
- `task.recalculateProgress` **không tồn tại ở backend-go** — không phải
  "chưa wire", mà bug backend đã xác nhận **0 dòng code nào tính progress
  cascade** ở `task-service` (`grep -rn "progress\|CalculateProgress"` → 0
  kết quả ngoài chuỗi `"in_progress"`). Đề xuất #2 gốc ("gọi thêm
  `task.recalculateProgress`") **không khả thi trên backend-go hôm nay** —
  chỉ khả thi trên backend Node.

## Thiết kế

### 1. Nút "New Task" + dialog — CHỈ Title + Parent (khớp thật CreateTaskRequest)

**File mới:** `frontend/src/renderer/src/components/task/TaskCreateDialog.tsx`

```tsx
// frontend/src/renderer/src/components/task/TaskCreateDialog.tsx (MỚI)
import { useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../ui/dialog'
import { Input } from '../ui/input'
import { Button } from '../ui/button'

type TaskCreateDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  // parentId khi mở từ context "+ subtask" trên 1 TaskCard cụ thể; undefined = root task
  parentId?: string
  onCreate: (title: string, parentId?: string) => Promise<void>
}

export function TaskCreateDialog({ open, onOpenChange, parentId, onCreate }: TaskCreateDialogProps) {
  const [title, setTitle] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const submit = async () => {
    if (!title.trim()) return
    setSubmitting(true)
    try {
      await onCreate(title.trim(), parentId)
      setTitle('')
      onOpenChange(false)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{parentId ? 'New Subtask' : 'New Task'}</DialogTitle>
        </DialogHeader>
        {/* Chỉ Title — backend-go's CreateTaskRequest không nhận type/priority/
            description; xem BUG-TASKV1-001. Thêm field khác vào form này là UX-lie
            (đúng loại lỗi mà BUG-FE-TASKV1-004 đã cảnh báo cho TaskPromptEditor). */}
        <Input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Task title..."
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          data-testid="new-task-title-input"
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={submitting || !title.trim()} data-testid="new-task-submit">
            {submitting ? 'Creating…' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
```

**Hook mới trong `useTasks.ts`** — thêm `createTask`, tự điền default cho
các field `OrcaTask` bắt buộc mà backend-go không trả về (tránh object "què"
nêu trên):

```typescript
// frontend/src/renderer/src/hooks/useTasks.ts — thêm vào return của useTasks()
const createTask = async (title: string, parentId?: string) => {
  const target = getActiveRuntimeTarget(useAppStore.getState().settings)
  const created = await callRuntimeRpc<Partial<OrcaTask>>(target, 'task.create', {
    title, parentId, projectId
  })
  // backend-go's CreateTaskResponse chỉ trả {id, title, status, parentId, projectId} —
  // các field bắt buộc còn lại của OrcaTask type chưa tồn tại ở backend-go
  // (BUG-TASKV1-001) nên phải default ở client để tránh object thiếu field
  // làm vỡ TaskCard/TaskDetail (đọc task.type/priority/progressPercent không optional).
  const withDefaults: OrcaTask = {
    id: created.id!,
    projectId: created.projectId ?? projectId,
    parentId: created.parentId,
    title: created.title ?? title,
    type: 'task',
    status: (created.status as OrcaTask['status']) ?? 'todo',
    priority: 'medium',
    labels: [],
    visibility: 'private',
    progressPercent: 0,
    createdAt: new Date(),
    updatedAt: new Date()
  }
  useAppStore.getState().addTask(withDefaults)
  return withDefaults
}
```

**`TaskGraph.tsx` toolbar** — thêm nút mở dialog:

```tsx
// TaskGraph.tsx — thêm state + nút, đặt trước ô Search
const [createDialogOpen, setCreateDialogOpen] = useState(false)
const { createTask } = useTasks(projectId) // đã có sẵn từ destructure hiện tại

<Button size="sm" onClick={() => setCreateDialogOpen(true)} data-testid="new-task-btn">
  + New Task
</Button>
<TaskCreateDialog
  open={createDialogOpen}
  onOpenChange={setCreateDialogOpen}
  onCreate={(title, parentId) => createTask(title, parentId)}
/>
```

Đặt tương tự 1 nút "+" nhỏ trên mỗi `TaskCard` (khi hover, cạnh nút
`MoreHorizontal` đã có comment placeholder ở TDD) để tạo subtask trực tiếp
dưới 1 task cha — dùng lại cùng `TaskCreateDialog` với `parentId` = task đó.

### 2. Progress hiển thị — KHÔNG dùng `task.recalculateProgress` (không tồn tại ở backend-go)

Thay vì gọi RPC không tồn tại, tính progress **client-side, chỉ để hiển
thị** (không ghi ngược lại backend — đây là giới hạn cố ý, không phải thiếu
sót) từ dữ liệu đã có sẵn trong store sau mỗi lần `task.list`/`task.update`:

```typescript
// frontend/src/renderer/src/hooks/useTasks.ts — thêm 1 selector suy ra, KHÔNG persist
// Progress hiển thị = tỉ lệ subtask trực tiếp có status 'done' — chỉ là ước lượng
// client-side cho tới khi backend-go có calculateProgress() thật (BUG-TASKV1-001).
// KHÔNG ghi đè lên task.progressPercent trong store — trả ra 1 giá trị riêng để
// TaskCard tự quyết định hiển thị cái nào.
export function computeClientProgress(tasks: OrcaTask[], taskId: string): number | null {
  const children = tasks.filter(t => t.parentId === taskId)
  if (children.length === 0) return null // leaf task: dùng progressPercent thật của chính nó
  const done = children.filter(c => c.status === 'done').length
  return Math.round((done / children.length) * 100)
}
```

```tsx
// TaskCard.tsx — dùng computeClientProgress thay vì đọc progressPercent tĩnh khi có con
const allTasks = useAppStore(s => s.tasks)
const clientProgress = computeClientProgress(allTasks, task.id)
const displayProgress = clientProgress ?? task.progressPercent
{hasChildren && (
  <span className="text-xs text-muted-foreground" title="Ước lượng client-side, xem BUG-TASKV1-001">
    {displayProgress}%
  </span>
)}
```

Đây KHÔNG phải progress "chính xác" theo spec BL-TG-01 (không có
estimated-hours-weighted, không cascade nhiều tầng đúng thuật toán backend)
— chỉ là fix UX tối thiểu để số % không **tĩnh cứng mãi mãi** (bug gốc: "có
thể lệch stale tới khi có action khác kích hoạt refetch") mà không cần chờ
RPC backend không tồn tại.

### 3. Cây task build client-side — GIỮ NGUYÊN, ghi nhận backend-dependent

Bug gốc xác nhận `GetAncestors`/`GetSubtree` chỉ là domain-internal, **không
có RPC public nào** để thay thế cách filter client-side hiện tại của
`TaskTreeView.tsx`. Không có gì để "sửa" ở đây trong phạm vi frontend —
`renderLevel()`'s `tasks.filter(t => t.parentId === parentId)` (hiện đã
đúng đắn given dữ liệu có sẵn) **giữ nguyên**. Theo dõi đề xuất backend
(`ListTasks` với filter/pagination theo `parentId`) ở
[BUG-TASKV1-001](../../../../backend-go/bugs/task-v1/BUG-TASKV1-001-orcatask-data-model-and-state-machine-gap.md).

## Files cần sửa

| File | Action |
|------|--------|
| `frontend/src/renderer/src/components/task/TaskCreateDialog.tsx` | NEW |
| `frontend/src/renderer/src/hooks/useTasks.ts` | MODIFY — `createTask()`, `computeClientProgress()` |
| `frontend/src/renderer/src/components/task/TaskGraph.tsx` | MODIFY — nút "+ New Task" + dialog |
| `frontend/src/renderer/src/components/task/TaskCard.tsx` | MODIFY — nút "+ subtask" khi hover, dùng `computeClientProgress` |

## Không làm ở solution này

- Không gọi `task.recalculateProgress` — RPC không tồn tại ở backend-go.
- Không thêm field `type`/`priority`/`description`/`labels` vào dialog tạo
  task — backend-go chưa lưu các field này (chờ
  [SOL-TG-01](../../../../backend-go/bugs/logic-v1/solutions/SOL-TG-01-task-graph-structural-management.md)).
- Không tối ưu tải cây cho project lớn (phân trang theo nhánh) — cần RPC
  backend mới, theo dõi ở `specs/backend-go/bugs/task-v1`.

## Tham khảo

- [BUG-TASKV1-001](../../../../backend-go/bugs/task-v1/BUG-TASKV1-001-orcatask-data-model-and-state-machine-gap.md)
- [SOL-TG-01](../../../../backend-go/bugs/logic-v1/solutions/SOL-TG-01-task-graph-structural-management.md) — thiết kế đầy đủ field còn thiếu + progress cascade thật ở backend
