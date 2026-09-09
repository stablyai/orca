# FE-TASK-001: "New Task" dialog — tạo task mới từ toolbar `TaskGraph`

**Domain:** task-graph
**Solution Ref:** FE-SOL-001 Phần 1
**Priority:** 🟠 P1
**Estimated:** 50 phút
**Status:** ✅ DONE — 2026-09-09

### Kết quả thực tế

- Đã thêm `refetchTrigger`/`refetch()` vào `useTasks.ts` đúng như thiết kế; `TaskCreateDialog.tsx`
  (mới) gọi `task.create({ title, projectId })` — giữ nguyên ghi chú về gap backend
  `createArgs`/`ProjectId` (không tự sửa backend-go, đúng phạm vi).
- `TaskGraph.tsx` toolbar: thêm nút "+ New Task" (`data-testid="new-task-btn"`) trước ô Search,
  mount `TaskCreateDialog` khi bấm, `onCreated` gọi `refetch()`. Làm chung 1 lần với FE-TASK-003
  (nút "Board") để tránh conflict trên cùng vùng JSX, đúng khuyến nghị của README.
- `impact({target: "useTasks", direction: "upstream"})` và `impact({target: "TaskGraph",
  direction: "upstream"})`: cả 2 đều risk **LOW** (chỉ `TaskGraphPanel.tsx`/component nội bộ là
  caller) — khớp kỳ vọng của task.
- Test mới: `TaskCreateDialog.test.tsx` (5 case), `TaskGraph.test.tsx` (mới, 3 case, cover cả
  FE-TASK-001 + FE-TASK-003), `useTasks.test.ts` (+1 case `refetch()`). Tổng
  `npx vitest run` cho các file trên: **27/27 pass**. `npx tsc --noEmit -p .`: 0 lỗi mới trong
  `components/task/`/`hooks/useTasks.ts` (baseline trước khi bắt đầu có 114 lỗi tsc có sẵn ở các
  file ngoài phạm vi — không tăng thêm).
- Không có deviation so với spec. Gap backend `ProjectId` bị bỏ qua âm thầm (đã ghi trong task) vẫn
  còn nguyên — cần 1 PR backend-go riêng để tính năng "xong" end-to-end theo nghĩa người dùng thấy
  task mới xuất hiện ngay lập tức trong đúng project.

---

## Mục tiêu

`TaskGraph.tsx` (đọc trực tiếp hôm nay) chỉ có ô Search + dropdown Status filter (3 giá trị
`all/todo/in_progress/done`, thiếu 4 giá trị `backlog/review/blocked/cancelled` mà `OrcaTask['status']`
đã hỗ trợ từ lâu) + toggle Tree/DAG — **không có nút "New Task" nào**, đúng như wireframe
`specs/frontend/tdd/v5/15-task-graph-ui.md` §1 đã vẽ (`[+ New Task] [Tree ▼] [Filter ▼] [🔍 Search]`)
nhưng chưa build. Thêm nút "+ New Task" + dialog tạo task, dùng RPC `task.create`.

## Xác nhận đã đọc code thật trước khi viết task (2026-09-09)

- **`task.create` RPC đã tồn tại thật** ở `backend-go/services/api-gateway/internal/adapter/wscompat/channels.go:278-291`
  (`registerTaskChannels`) — KHÔNG cần chờ BE-SOL-001 để có RPC này. Tuy nhiên, ⚠️ **wire args hôm
  nay chỉ decode đúng 2 field**:
  ```go
  // channels.go:279-282 — shape THẬT hôm nay
  type createArgs struct {
      Title    string `json:"title"`
      ParentID string `json:"parentId"`
  }
  ```
  Handler gọi `client.CreateTask(ctx, &taskv1.CreateTaskRequest{TenantId: id.TenantID, Title: in.Title,
  ParentId: in.ParentID})` — **không set `ProjectId`**, dù `CreateTaskRequest` proto
  (`task.proto:61-66`) **đã có field `project_id = 4`**. Gửi `projectId` trong payload JSON từ
  frontend **bị Go's `encoding/json` âm thầm bỏ qua** (unknown field, không lỗi) → task tạo ra luôn
  có `ProjectId` rỗng → **biến mất khỏi `useTasks(projectId)`'s `allTasks.filter(t => t.projectId
  === projectId)`** ngay cả sau khi `refetch()` load lại `task.list`. Đây là gap có thật, không phải
  gap của CR/solution này — cần 1 thay đổi backend-go song song (thêm `ProjectID string
  \`json:"projectId"\`` vào `createArgs` + set `ProjectId: in.ProjectID` khi gọi `CreateTaskRequest`)
  trước khi task này coi là "xong end-to-end". Ghi rõ trong PR description, mở issue backend riêng
  nếu cần track.
- **`creatorId` KHÔNG có chỗ nhận** — `CreateTaskRequest` proto hôm nay chỉ có
  `tenant_id/title/parent_id/project_id`, không có `creator_id`. Field này là 1 phần đề xuất của
  [BE-SOL-003](../../../../../backend-go/crs/v4/task-graph/solutions/BE-SOL-003-task-access-control-team-scope-and-sharing.md)
  (chưa triển khai — owner-grant tự động khi tạo task chưa hoạt động hôm nay). **Không gửi
  `creatorId` trong payload ở task này** — gửi cũng bị bỏ qua như trên, chỉ gây hiểu nhầm là đã hoạt
  động.
- `useTasks.ts` hiện chỉ fetch khi `projectId` đổi (`useEffect`'s dep array `[projectId, setTasks]`,
  dòng 29-55) — không có cách nào trigger refetch thủ công sau khi tạo task mới. Cần thêm 1
  `refetchTrigger` state.
- `TaskGraph.tsx` hôm nay (9 dòng import, không có `Button`/dialog nào) — xác nhận toàn bộ toolbar
  hiện tại chỉ có `Input` (search) + `<select>` filter (dòng 14-21) + 2 nút Tree/DAG.

## Files cần sửa

| File | Action |
|------|--------|
| `frontend/src/renderer/src/hooks/useTasks.ts` | MODIFY — thêm `refetchTrigger` state + export `refetch()`, thêm vào dep array effect fetch (dòng 29, 55) |
| `frontend/src/renderer/src/components/task/TaskGraph.tsx` | MODIFY — thêm nút "+ New Task" + state `showCreateDialog`, mount `TaskCreateDialog` |
| `frontend/src/renderer/src/components/task/TaskCreateDialog.tsx` | NEW |
| `frontend/src/renderer/src/components/task/__tests__/TaskCreateDialog.test.tsx` | NEW |
| `frontend/src/renderer/src/components/task/__tests__/TaskGraph.test.tsx` | MODIFY — case nút "+ New Task" mở dialog |
| `frontend/src/renderer/src/hooks/__tests__/useTasks.test.ts` | MODIFY — case `refetch()` gọi lại `task.list` |

## Các bước thực thi

### 1. Thêm `refetchTrigger` + `refetch()` vào `useTasks.ts`

```typescript
// useTasks.ts
const [refetchTrigger, setRefetchTrigger] = useState(0)
const refetch = useCallback(() => setRefetchTrigger((n) => n + 1), [])

useEffect(() => {
  if (!projectId) {
    return
  }
  // ...code fetch hiện có giữ nguyên...
}, [projectId, setTasks, refetchTrigger]) // + refetchTrigger vào dep array

return {
  // ...các field hiện có...
  refetch
}
```

### 2. Tạo `TaskCreateDialog.tsx`

```tsx
import { useState } from 'react'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { callRuntimeRpc, getActiveRuntimeTarget } from '../../runtime/runtime-rpc-client'
import { useAppStore } from '../../store'
import { toast } from 'sonner'

export function TaskCreateDialog({
  projectId,
  onCreated,
  onCancel
}: {
  projectId: string
  onCreated: () => void
  onCancel: () => void
}) {
  const [title, setTitle] = useState('')
  const [isCreating, setIsCreating] = useState(false)

  const create = async () => {
    if (!title.trim()) {
      return
    }
    setIsCreating(true)
    const target = getActiveRuntimeTarget(useAppStore.getState().settings)
    try {
      // LƯU Ý: backend hôm nay CHỈ decode {title, parentId} — projectId gửi ở đây
      // bị bỏ qua âm thầm cho tới khi channels.go's createArgs được thêm field
      // ProjectID (theo dõi ở phần "Xác nhận đã đọc code thật" của task này).
      // Vẫn gửi projectId ngay từ bây giờ để không phải sửa lại call site khi
      // backend fix xong.
      await callRuntimeRpc(target, 'task.create', { title: title.trim(), projectId })
      toast.success(`Task "${title.trim()}" created`)
      onCreated()
    } catch (err: any) {
      toast.error(`Failed to create task: ${err.message}`)
    } finally {
      setIsCreating(false)
    }
  }

  return (
    <div className="task-create-dialog border rounded p-3 bg-background shadow-sm" data-testid="task-create-dialog">
      <Input
        autoFocus
        placeholder="Task title..."
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && create()}
        data-testid="task-create-title-input"
        className="mb-2"
      />
      <div className="flex gap-2 justify-end">
        <Button size="sm" variant="ghost" onClick={onCancel} data-testid="task-create-cancel">
          Cancel
        </Button>
        <Button size="sm" disabled={!title.trim() || isCreating} onClick={create} data-testid="task-create-submit">
          {isCreating ? 'Creating...' : 'Create'}
        </Button>
      </div>
    </div>
  )
}
```

### 3. Gắn vào `TaskGraph.tsx` toolbar

```tsx
// TaskGraph.tsx
import { TaskCreateDialog } from './TaskCreateDialog'
// ...
const { filteredTasks, expandedNodes, toggleExpanded, setActiveTask, filterStatus, setFilterStatus,
  searchQuery, setSearchQuery, refetch } = useTasks(projectId)
const [showCreateDialog, setShowCreateDialog] = useState(false)

// Trong toolbar div (trước Input search):
<Button size="sm" onClick={() => setShowCreateDialog(true)} data-testid="new-task-btn">+ New Task</Button>
{showCreateDialog && (
  <TaskCreateDialog
    projectId={projectId}
    onCreated={() => { setShowCreateDialog(false); refetch() }}
    onCancel={() => setShowCreateDialog(false)}
  />
)}
```

Cần import `Button` từ `'../ui/button'` (chưa có trong `TaskGraph.tsx` hôm nay).

## Không làm ở task này

- Không thêm `parentId` vào dialog (tạo task con) — CR-TG-007's wireframe §1 chỉ vẽ "New Task" ở
  toolbar cấp root; tạo subtask đã có đường riêng qua `TaskAIDecompose`/`acceptSubtasks`
  (`useTask.ts:48-60`). Nếu cần "New Subtask" từ `TaskDetail`, đó là 1 task riêng, dùng lại chính
  `TaskCreateDialog` này với prop `parentId` (component đã đủ tổng quát, không cần build lại — chỉ
  chưa có call site).
- Không đổi Status filter dropdown's 3 giá trị hiện tại (`all/todo/in_progress/done`) sang đủ 7 giá
  trị — ngoài phạm vi §1 của FE-SOL-001, cứ để nguyên; ghi lại thành ghi chú nếu người review muốn mở
  task riêng.
- Không tự sửa `channels.go`'s `createArgs` (backend-go) — chỉ ghi rõ gap trong PR description, việc
  sửa backend đi theo quy trình backend-go riêng.
- Không thay `task.list` bằng `task.getSubtree` — `GetSubtree` **xác nhận chưa tồn tại ở bất kỳ đâu**
  (0 kết quả cho `GetSubtree` trên toàn `backend-go/proto` + `backend-go/services/api-gateway`),
  BE-SOL-001 vẫn 📋 Proposed. `task.list` + client-filter tiếp tục dùng được.

## Test cases cần cover

```
TaskCreateDialog.test.tsx
├── nhập title, bấm Create → gọi task.create({ title, projectId }), gọi onCreated khi thành công
├── title rỗng → nút Create disabled
├── Enter trong input title → submit giống bấm Create
├── RPC lỗi → toast.error, dialog không tự đóng (onCreated không được gọi)
└── bấm Cancel → gọi onCancel, không gọi RPC nào

TaskGraph.test.tsx (case mới)
├── bấm "+ New Task" → TaskCreateDialog xuất hiện
└── TaskCreateDialog's onCreated → gọi refetch() (mock useTasks, assert refetch được gọi)

useTasks.test.ts (case mới)
└── gọi refetch() → task.list được gọi lại lần 2 với cùng projectId
```

## Verify

```bash
cd frontend && npx vitest run \
  src/renderer/src/components/task/__tests__/TaskCreateDialog.test.tsx \
  src/renderer/src/components/task/__tests__/TaskGraph.test.tsx \
  src/renderer/src/hooks/__tests__/useTasks.test.ts
cd frontend && npx tsc --noEmit -p .
```

## gitnexus

Chạy trước khi sửa (bắt buộc theo CLAUDE.md):
```
impact({target: "useTasks", direction: "upstream"})
impact({target: "TaskGraph", direction: "upstream"})
```
Kỳ vọng caller trực tiếp là `TaskGraphPanel.tsx` (component lá theo comment của chính nó — "just
gives it the panel-level container WorkspaceLayout expects") — risk dự kiến LOW. Dán kết quả thật
vào PR description; nếu `useTasks` xuất hiện thêm caller ngoài `TaskGraph.tsx`, xác nhận thêm
`refetchTrigger` vào dep array effect không đổi hành vi fetch-on-projectId-change hiện có của
caller đó trước khi kết luận an toàn.

## Depends on

Không có RPC-blocking cứng — `task.create` đã tồn tại thật. **Khuyến nghị** phối hợp với 1 thay đổi
backend-go nhỏ (thêm `ProjectID` vào `createArgs`/`CreateTaskRequest` call ở `channels.go:278-291`)
để task mới tạo thật sự xuất hiện đúng project — không phải hard blocker cho việc build UI (dialog
vẫn build/test được độc lập với mock), nhưng cần trước khi tính năng "xong" theo nghĩa người dùng
thấy task mới ngay lập tức.

## Blocking

Không có
