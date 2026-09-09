# FE-TASK-003: `TaskBoardView` — Board/Kanban view mới

**Domain:** task-graph
**Solution Ref:** FE-SOL-001 Phần 3
**Priority:** 🔴 P0 — gap chính ma trận hoàn thành nêu
**Estimated:** 70 phút
**Status:** ✅ DONE — 2026-09-09

### Kết quả thực tế

- Bước 1 (vá `TaskStatusBadge.tsx`'s `STATUS_CONFIG` thêm `backlog`/`review`/`blocked`) làm trước,
  đúng thứ tự bắt buộc. Màu giữ đúng theo `TaskDAGView.tsx`'s `STATUS_COLORS` (review=tím,
  blocked=đỏ) như spec yêu cầu — không tự bịa màu mới.
- `TaskBoardView.tsx` (mới): 7 cột theo `STATUS_ORDER`, optimistic move + rollback cục bộ qua
  `statusOverride` state (không sửa `useTask.ts`'s `updateTask`, đúng phạm vi). Dùng lại
  `TaskCard` nguyên trạng (`depth=0, isExpanded=false, onToggle={()=>{}}`, không `children`).
- `TaskGraph.tsx`: thêm `viewMode: 'board'`, nút "Board" trong toolbar, `TaskBoardView` lazy-load.
  Làm chung 1 lần với FE-TASK-001 (nút "+ New Task") trong cùng file/cùng lượt sửa để tránh xung
  đột merge trên cùng vùng JSX, đúng khuyến nghị.
- `impact({target: "TaskStatusBadge"})` và `impact({target: "TaskCard"})`: cả 2 risk **LOW** (3
  caller mỗi bên, toàn bộ trong module `Task`) — thay đổi ở `STATUS_CONFIG` chỉ **thêm** key mới,
  không đổi/xoá key cũ, không phá caller nào đang dùng 4 status cũ.
- Test mới: `TaskStatusBadge.test.tsx` (+3 case), `TaskBoardView.test.tsx` (mới, 4 case),
  `TaskGraph.test.tsx` (case "Board", chung file với FE-TASK-001). **Vấn đề kỹ thuật gặp phải khi
  viết test kéo-thả**: `@testing-library/dom`'s `fireEvent.dragStart`/`fireEvent.drop` luôn tạo
  MỘT `DataTransfer` gốc (native) MỚI cho mỗi lệnh gọi (xem `events.js`'s comment "DataTransfer is
  not supported in jsdom"), nên dữ liệu `setData` ở `dragStart` không sống sót sang `drop` nếu dùng
  API cấp cao `fireEvent.dragStart(el, {dataTransfer})`. Khắc phục bằng cách dispatch event thủ công
  qua `fireEvent(el, new Event(...))` với `Object.defineProperty(event, 'dataTransfer', ...)`, chia
  sẻ 1 instance `FakeDataTransfer` xuyên suốt 2 event — pattern này chưa có tiền lệ trong repo, có
  thể tái dùng cho các test kéo-thả HTML5 khác sau này.
- Kết quả `npx vitest run` cho `TaskStatusBadge.test.tsx` + `TaskBoardView.test.tsx` +
  `TaskGraph.test.tsx`: **27/27 pass** (chung với FE-TASK-001, cùng lệnh verify). `npx tsc --noEmit
  -p .`: 0 lỗi mới trong `components/task/`.
- Không có deviation về hành vi so với spec, chỉ có vấn đề kỹ thuật khi viết test (đã giải quyết,
  nêu trên).

---

## Mục tiêu

Xác nhận còn thiếu hoàn toàn: `grep -rli "board|kanban" frontend/src/renderer/src/components/task/`
= 0 kết quả. `TaskGraph.tsx`'s `viewMode` hôm nay chỉ có `'tree' | 'dag'` — không có view Kanban nào,
dù `OrcaTask['status']` đã có đủ 7 giá trị (`backlog/todo/in_progress/review/done/blocked/cancelled`,
`task-types.ts:14-21`) sẵn sàng cho 7 cột. Đây là **gap ưu tiên cao nhất** theo ma trận hoàn thành
của CR-TG-007.

## Xác nhận đã đọc code thật trước khi viết task (2026-09-09)

- ⚠️ **Phát hiện quan trọng, KHÔNG có trong FE-SOL-001**: `TaskStatusBadge.tsx`'s `STATUS_CONFIG`
  (dòng 3-8) hôm nay **chỉ có 4 trong 7 giá trị status** —
  `todo/in_progress/done/cancelled` — thiếu hẳn `backlog`, `review`, `blocked`. Component tự fallback
  `STATUS_CONFIG[status] || STATUS_CONFIG.todo` (dòng 18) khi thiếu key, nghĩa là dùng thẳng
  `<TaskStatusBadge status={status} />` cho header 7 cột như code mẫu gốc của FE-SOL-001 §3 sẽ khiến
  **3 cột (Backlog/Review/Blocked) đều hiện nhãn "⏳ Todo"** — sai lệch UI nghiêm trọng, không phải
  bug của task này nhưng phải sửa trước khi Board view dùng được. Thêm bước 1 dưới đây để vá trước.
- `useTask.ts`'s `updateTask()` (dòng 9-14) gọi `task.update` rồi cập nhật store optimistic **không
  có try/catch / rollback nào** — nếu backend từ chối (ví dụ do permission — xem FE-TASK-004), store
  đã đổi status rồi, task hiện sai cột vĩnh viễn cho tới khi F5. FE-SOL-001 §3 giả định "optimistic
  update ở store rồi revert nếu backend từ chối" nhưng `updateTask` **không hỗ trợ revert** — Board
  view phải tự làm phần revert này ở component, không dựa vào `useTask`.
- `TaskCard.tsx` đã tồn tại và đúng như FE-SOL-001 gợi ý tái sử dụng — nhận `{ task, depth, isExpanded,
  onToggle, onSelect, children }`. Board view dùng lại được nhưng **`depth`/`onToggle`/`children`
  không có ý nghĩa ở context Kanban** (Board không lồng cây) — truyền `depth={0}`,
  `isExpanded={false}`, `onToggle={() => {}}`, không truyền `children`.
- `task.update` RPC (`useTask.ts:12`) đã hoạt động thật, nhận `{ taskId, patch }` — patch
  `{ status }` là hợp lệ ngay hôm nay, không cần đổi backend.

## Files cần sửa

| File | Action |
|------|--------|
| `frontend/src/renderer/src/components/task/TaskStatusBadge.tsx` | MODIFY — thêm 3 entry `backlog`/`review`/`blocked` vào `STATUS_CONFIG` (bước 1, làm TRƯỚC bước 2) |
| `frontend/src/renderer/src/components/task/TaskBoardView.tsx` | NEW |
| `frontend/src/renderer/src/components/task/TaskGraph.tsx` | MODIFY — `viewMode` thêm `'board'`, thêm nút toggle, mount `TaskBoardView` |
| `frontend/src/renderer/src/components/task/__tests__/TaskStatusBadge.test.tsx` | MODIFY — case 3 status mới render đúng label (không fallback về Todo) |
| `frontend/src/renderer/src/components/task/__tests__/TaskBoardView.test.tsx` | NEW |
| `frontend/src/renderer/src/components/task/__tests__/TaskGraph.test.tsx` | MODIFY — case chuyển sang Board view |

## Các bước thực thi

### 1. Vá `TaskStatusBadge.tsx`'s `STATUS_CONFIG` trước (bắt buộc, không phải optional polish)

```tsx
// TaskStatusBadge.tsx
const STATUS_CONFIG = {
  backlog:     { label: 'Backlog',     icon: '📋', className: 'text-slate-400' },
  todo:        { label: 'Todo',        icon: '⏳', className: 'text-gray-500' },
  in_progress: { label: 'In Progress', icon: '🔄', className: 'text-blue-600' },
  review:      { label: 'Review',      icon: '👀', className: 'text-purple-600' },
  done:        { label: 'Done',        icon: '✅', className: 'text-green-600' },
  blocked:     { label: 'Blocked',     icon: '🚫', className: 'text-red-600' },
  cancelled:   { label: 'Cancelled',   icon: '❌', className: 'text-gray-400' },
}
```

Màu `text-purple-600`/`text-red-600` lấy đúng theo tông màu `TaskDAGView.tsx`'s `STATUS_COLORS`
(dòng 12-20: `review` dùng tím `#9333ea`, `blocked` dùng đỏ `#dc2626`) để 2 view (DAG + Board) nhất
quán màu theo cùng 1 status — không tự bịa màu mới, đúng AGENTS.md's Design System.

### 2. Tạo `TaskBoardView.tsx`

```tsx
import { useState } from 'react'
import type { OrcaTask, TaskStatus } from '../../../../shared/task-types'
import { TaskStatusBadge } from './TaskStatusBadge'
import { TaskCard } from './TaskCard'
import { useAppStore } from '../../store'
import { callRuntimeRpc, getActiveRuntimeTarget } from '../../runtime/runtime-rpc-client'
import { toast } from 'sonner'

const STATUS_ORDER: TaskStatus[] = ['backlog', 'todo', 'in_progress', 'blocked', 'review', 'done', 'cancelled']

export function TaskBoardView({ tasks, onSelect }: { tasks: OrcaTask[]; onSelect: (id: string) => void }) {
  // Optimistic move + rollback cục bộ — useTask.ts's updateTask() không tự revert khi
  // backend từ chối (ví dụ permission denied, xem FE-TASK-004), nên Board view tự quản lý
  // 1 override cục bộ theo taskId thay vì dựa store cho tới khi confirm thành công.
  const [statusOverride, setStatusOverride] = useState<Record<string, TaskStatus>>({})

  const effectiveStatus = (task: OrcaTask): TaskStatus => statusOverride[task.id] ?? task.status

  const handleDrop = async (taskId: string, newStatus: TaskStatus) => {
    const task = tasks.find((t) => t.id === taskId)
    if (!task || effectiveStatus(task) === newStatus) {
      return
    }
    const previousStatus = effectiveStatus(task)
    setStatusOverride((prev) => ({ ...prev, [taskId]: newStatus }))
    const target = getActiveRuntimeTarget(useAppStore.getState().settings)
    try {
      await callRuntimeRpc(target, 'task.update', { taskId, patch: { status: newStatus } })
      useAppStore.getState().updateTask(taskId, { status: newStatus })
      setStatusOverride((prev) => {
        const { [taskId]: _drop, ...rest } = prev
        return rest
      })
    } catch (err: any) {
      // Rollback: xoá override để card quay lại cột cũ (dựa vào task.status thật trong store)
      setStatusOverride((prev) => {
        const { [taskId]: _drop, ...rest } = prev
        return rest
      })
      toast.error(`Cannot move "${task.title}" to ${newStatus}: ${err.message}`)
      void previousStatus
    }
  }

  return (
    <div className="task-board-view flex gap-3 overflow-x-auto p-2 h-full" data-testid="task-board-view">
      {STATUS_ORDER.map((status) => {
        const columnTasks = tasks.filter((t) => effectiveStatus(t) === status)
        return (
          <div key={status} className="flex-shrink-0 w-64 flex flex-col" data-testid={`board-column-${status}`}>
            <div className="text-xs font-medium px-2 py-1 flex items-center gap-1">
              <TaskStatusBadge status={status} /> ({columnTasks.length})
            </div>
            <div
              className="flex-1 space-y-2 overflow-y-auto min-h-[100px]"
              onDrop={(e) => { e.preventDefault(); handleDrop(e.dataTransfer.getData('taskId'), status) }}
              onDragOver={(e) => e.preventDefault()}
              data-testid={`board-dropzone-${status}`}
            >
              {columnTasks.map((task) => (
                <div
                  key={task.id}
                  draggable
                  onDragStart={(e) => e.dataTransfer.setData('taskId', task.id)}
                  data-testid={`board-card-${task.id}`}
                >
                  <TaskCard task={task} depth={0} isExpanded={false} onToggle={() => {}} onSelect={onSelect} />
                </div>
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}
```

### 3. Gắn `viewMode: 'board'` vào `TaskGraph.tsx`

```tsx
// TaskGraph.tsx
const TaskBoardView = lazy(() => import('./TaskBoardView').then(m => ({ default: m.TaskBoardView })))
const [viewMode, setViewMode] = useState<'tree' | 'dag' | 'board'>('tree')

// Trong div.flex.border.rounded.overflow-hidden hiện có (dòng 22-25), thêm nút thứ 3:
<button onClick={() => setViewMode('board')} className={`px-2 py-1 text-xs ${viewMode === 'board' ? 'bg-primary text-primary-foreground' : ''}`} data-testid="view-board">Board</button>

// Trong div.flex-1.overflow-auto, thêm nhánh thứ 3:
{viewMode === 'board' ? (
  <Suspense fallback={<div className="p-4 text-sm">Loading Board...</div>}>
    <TaskBoardView tasks={filteredTasks} onSelect={setActiveTask} />
  </Suspense>
) : viewMode === 'tree' ? (
  // ...giữ nguyên...
) : (
  // ...giữ nguyên...
)}
```

## Không làm ở task này

- Không thêm sort/reorder trong cùng 1 cột (drag để đổi thứ tự trong cùng status) — chỉ kéo-thả đổi
  cột (đổi status), đúng phạm vi FE-SOL-001 §3.
- Không đổi `TaskCard.tsx` để thêm chế độ hiển thị riêng cho Board (compact card) — dùng lại nguyên
  component hiện có, đúng chỉ dẫn "tái sử dụng, không viết lại rendering" của solution.
- Không sửa `useTask.ts`'s `updateTask()` để thêm rollback chung — Board view tự quản lý override cục
  bộ (bước 2) thay vì đổi hành vi dùng chung của `updateTask` cho mọi call site khác (TaskDetail's
  Select cũng dùng `updateTask`, đổi hành vi chung có thể ảnh hưởng ngoài phạm vi task này).

## Test cases cần cover

```
TaskStatusBadge.test.tsx (case mới)
├── status='backlog' → label "Backlog", không fallback "Todo"
├── status='review'  → label "Review"
└── status='blocked' → label "Blocked"

TaskBoardView.test.tsx
├── render 7 cột đúng thứ tự STATUS_ORDER, mỗi cột đếm đúng số task
├── kéo card từ cột A thả vào cột B → gọi task.update({taskId, patch:{status: B}}), card chuyển cột
│   ngay (optimistic)
├── task.update reject → card quay lại cột cũ, toast.error hiện đúng message
└── click card → gọi onSelect(taskId)

TaskGraph.test.tsx (case mới)
└── bấm nút "Board" → viewMode đổi, TaskBoardView render thay Tree/DAG
```

## Verify

```bash
cd frontend && npx vitest run \
  src/renderer/src/components/task/__tests__/TaskStatusBadge.test.tsx \
  src/renderer/src/components/task/__tests__/TaskBoardView.test.tsx \
  src/renderer/src/components/task/__tests__/TaskGraph.test.tsx
cd frontend && npx tsc --noEmit -p .
```

## gitnexus

Chạy trước khi sửa (bắt buộc theo CLAUDE.md):
```
impact({target: "TaskStatusBadge", direction: "upstream"})
impact({target: "TaskCard", direction: "upstream"})
```
`TaskStatusBadge` được dùng ở nhiều nơi (`TaskCard.tsx`, `TaskDetail.tsx` gián tiếp qua Select values,
Board view mới) — kỳ vọng risk LOW vì bước 1 chỉ **thêm** key mới vào object literal, không đổi/xoá
key cũ nào (không phá bất kỳ caller nào đang dùng 4 status cũ). Xác nhận thật bằng impact trước khi
sửa, dán kết quả vào PR.

## Depends on

Không có (mọi RPC dùng — `task.update` — đã tồn tại thật). Bước 1 (vá `TaskStatusBadge`) phải làm
**trước** bước 2 trong cùng PR, không phải 2 PR tách rời — Board view build sai nhãn nếu thiếu bước 1.

## Blocking

Không có
