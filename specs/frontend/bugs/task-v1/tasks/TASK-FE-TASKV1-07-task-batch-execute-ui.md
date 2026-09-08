# TASK-FE-TASKV1-07 — Batch Execute UI (chọn nhiều task, chạy agent hàng loạt)

**Solution:** [SOL-FE-TASKV1-004](../solutions/SOL-FE-TASKV1-004-run-agent-ux-gaps.md) (Phần 2)
**Bug:** [BUG-FE-TASKV1-004](../BUG-FE-TASKV1-004-run-agent-ux-gaps.md)
**File:** `frontend/src/renderer/src/hooks/useTasks.ts`, `frontend/src/renderer/src/hooks/useTaskBatchExecution.ts` (mới), `frontend/src/renderer/src/components/task/TaskGraph.tsx`, `frontend/src/renderer/src/components/task/TaskTreeView.tsx`, `frontend/src/renderer/src/components/task/TaskCard.tsx`
**Estimated:** 75 phút
**Status:** [ ] TODO
**Phụ thuộc:** Không — dùng `task.execute` đã tồn tại và hoạt động, gọi tuần tự/song song có giới hạn (không cần RPC batch mới)

---

## Phát hiện quan trọng khi viết task này — bổ sung so với SOL-FE-TASKV1-004

Solution gốc chỉ liệt kê sửa `useTasks.ts`/`TaskGraph.tsx`/`TaskCard.tsx`, **thiếu**
`TaskTreeView.tsx`. Đọc `frontend/src/renderer/src/components/task/TaskTreeView.tsx` (40 dòng)
xác nhận: đây là component đệ quy đứng GIỮA `TaskGraph.tsx` và `TaskCard.tsx`
(`renderLevel()` dòng 6-28 gọi `<TaskCard>` với props cố định `task/depth/isExpanded/onToggle/
onSelect` — không có chỗ nào truyền thêm props tuỳ ý xuống). Muốn `TaskCard` nhận được
`selectMode`/`isSelected`/`onToggleSelect`, **bắt buộc phải sửa `TaskTreeView.tsx`** để thread thêm
3 props này qua cả `TaskTreeViewProps` lẫn tham số của `renderLevel()` — nếu chỉ sửa `TaskCard.tsx`
một mình như solution liệt kê, props mới sẽ không bao giờ tới nơi.

## Mục tiêu

Cho phép chọn nhiều task trong Tree view, chạy `task.execute` hàng loạt (giới hạn concurrency),
hiển thị kết quả tổng hợp qua toast — thay vì chỉ chạy được từng task 1 qua `TaskDetail`.

## Context

Đọc trước:
- `frontend/src/renderer/src/hooks/useTasks.ts` (toàn bộ 95 dòng).
- `frontend/src/renderer/src/components/task/TaskGraph.tsx` (37 dòng).
- `frontend/src/renderer/src/components/task/TaskTreeView.tsx` (40 dòng) — đặc biệt `renderLevel()` dòng 6-28.
- `frontend/src/renderer/src/components/task/TaskCard.tsx` (40 dòng).
- `frontend/src/renderer/src/context/WorkspaceContext.tsx:89` — `currentWorktree: Worktree | null`, field `.path` (khớp `shared/types.ts:480`).
- `frontend/src/shared/trace/tracers.ts:88` — `Tracers.uiTaskGraphExecuteFlow` đã tồn tại, dùng đúng span pattern như `TaskDetail.tsx`/`TaskPromptEditor.tsx` đã làm.

## Thay đổi cần thực hiện

### 1. `useTasks.ts` — thêm selection state vào cuối hook, trước `return`

```typescript
const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
const toggleSelected = useCallback((id: string) => {
  setSelectedIds(prev => {
    const next = new Set(prev)
    next.has(id) ? next.delete(id) : next.add(id)
    return next
  })
}, [])
const clearSelection = useCallback(() => setSelectedIds(new Set()), [])
```

Thêm `selectedIds, toggleSelected, clearSelection` vào object `return` (dòng 83-94). Reset
`selectedIds` khi `projectId` đổi: thêm `setSelectedIds(new Set())` vào effect fetch tasks (dòng
29-55) ngay đầu, trước `setIsLoading(true)`.

### 2. File mới — `frontend/src/renderer/src/hooks/useTaskBatchExecution.ts`

Copy nguyên thiết kế trong SOL-FE-TASKV1-004 Phần 2 mục 2 — dùng `currentWorktree.path` (đã xác
nhận field tồn tại thật), pool giới hạn `MAX_CONCURRENCY = 3`, ghi `results: Map<string, 'ok' |
'error'>` cho từng `taskId`.

### 3. `TaskTreeView.tsx` — thread 3 prop mới qua `renderLevel()`

```tsx
type TaskTreeViewProps = {
  tasks: OrcaTask[]
  expandedNodes: Set<string>
  toggleExpanded: (id: string) => void
  setActiveTask: (id: string | null) => void
  selectMode?: boolean
  selectedIds?: Set<string>
  onToggleSelect?: (id: string) => void
}

function renderLevel(
  tasks: OrcaTask[],
  parentId: string | null,
  depth: number,
  expandedNodes: Set<string>,
  toggleExpanded: (id: string) => void,
  setActiveTask: (id: string | null) => void,
  selectMode: boolean,
  selectedIds: Set<string>,
  onToggleSelect: (id: string) => void
): ReactNode {
  return tasks
    .filter(t => t.parentId === parentId)
    .map(task => (
      <TaskCard
        key={task.id}
        task={task}
        depth={depth}
        isExpanded={expandedNodes.has(task.id)}
        onToggle={toggleExpanded}
        onSelect={setActiveTask}
        selectMode={selectMode}
        isSelected={selectedIds.has(task.id)}
        onToggleSelect={onToggleSelect}
      >
        {expandedNodes.has(task.id) && renderLevel(tasks, task.id, depth + 1, expandedNodes, toggleExpanded, setActiveTask, selectMode, selectedIds, onToggleSelect)}
      </TaskCard>
    ))
}

export function TaskTreeView({ tasks, expandedNodes, toggleExpanded, setActiveTask, selectMode = false, selectedIds = new Set(), onToggleSelect = () => {} }: TaskTreeViewProps) {
  return <div data-testid="task-tree-view">{renderLevel(tasks, null, 0, expandedNodes, toggleExpanded, setActiveTask, selectMode, selectedIds, onToggleSelect)}</div>
}
```

Props mới đều optional với default — không phá vỡ chỗ khác đang dùng `<TaskTreeView>` không truyền
3 prop này.

### 4. `TaskCard.tsx` — checkbox khi `selectMode`

```tsx
type TaskCardProps = {
  task: OrcaTask
  depth: number
  isExpanded: boolean
  onToggle: (id: string) => void
  onSelect: (id: string) => void
  children?: ReactNode
  selectMode?: boolean
  isSelected?: boolean
  onToggleSelect?: (id: string) => void
}

export function TaskCard({ task, depth, isExpanded, onToggle, onSelect, children, selectMode, isSelected, onToggleSelect }: TaskCardProps) {
  ...
  {selectMode && (
    <input
      type="checkbox"
      checked={isSelected}
      onClick={e => e.stopPropagation()}
      onChange={() => onToggleSelect?.(task.id)}
      data-testid={`task-select-${task.id}`}
    />
  )}
  ...
}
```

Đặt checkbox trước `hasChildren` chevron (dòng 22-28 hiện tại).

### 5. `TaskGraph.tsx` — nút Select mode + Run Selected

```tsx
const [selectMode, setSelectMode] = useState(false)
const { filteredTasks, ..., selectedIds, toggleSelected, clearSelection } = useTasks(projectId)
const { running, runSelected } = useTaskBatchExecution()

<button onClick={() => setSelectMode(v => !v)} data-testid="toggle-select-mode">
  {selectMode ? 'Cancel' : 'Select'}
</button>
{selectMode && selectedIds.size > 0 && (
  <Button
    size="sm"
    disabled={running}
    onClick={() => runSelected([...selectedIds]).then(clearSelection)}
    data-testid="run-selected-btn"
  >
    {running ? 'Running…' : `▶ Run Selected (${selectedIds.size})`}
  </Button>
)}
...
<TaskTreeView
  tasks={filteredTasks}
  expandedNodes={expandedNodes}
  toggleExpanded={toggleExpanded}
  setActiveTask={setActiveTask}
  selectMode={selectMode}
  selectedIds={selectedIds}
  onToggleSelect={toggleSelected}
/>
```

Sau `runSelected` hoàn tất, hiển thị toast tổng hợp (`sonner`, đã dùng ở `TaskDetail.tsx:12`) —
ví dụ `"${okCount}/${total} task đã dispatch thành công"` — đếm từ `results` map trả về.

## Rủi ro cần lưu ý (ghi trong PR, không tự sửa ở task này)

- `task.execute` hiện **không revert status khi dispatch lỗi** (BUG-TASKV1-004) — chạy batch nhiều
  task mà dev-server offline giữa chừng sẽ để lại nhiều task kẹt `in_progress` vĩnh viễn.
- `ComplexExecutor` vẫn là stub — task có subtask/dependency (nhánh "complex") sẽ báo `ok` giả dù
  chưa chạy gì thật (BUG-TASKV1-005) — không có cách nào phân biệt ở tầng frontend.

## Verify

```bash
pnpm --filter frontend tsc --noEmit
pnpm --filter frontend test -- useTasks useTaskBatchExecution TaskGraph TaskTreeView TaskCard
```

## Definition of Done

- [ ] `useTasks.ts` có `selectedIds/toggleSelected/clearSelection`, reset khi `projectId` đổi
- [ ] `useTaskBatchExecution.ts` mới, `MAX_CONCURRENCY = 3`, dùng `currentWorktree.path` thật
- [ ] `TaskTreeView.tsx` thread đủ 3 prop mới qua `renderLevel()` (không chỉ sửa `TaskCard.tsx`)
- [ ] `TaskCard.tsx` hiện checkbox khi `selectMode`, không phá layout khi `selectMode=false`
- [ ] `TaskGraph.tsx` có nút Select + Run Selected, toast tổng hợp kết quả sau batch run
- [ ] PR ghi rõ 2 rủi ro backend đã biết (status không revert, ComplexExecutor stub) — không tự sửa trong task này
- [ ] `pnpm tsc --noEmit` sạch
