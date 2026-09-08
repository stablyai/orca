# SOL-FE-TASKV1-004 — "Run with Agent": input bị bỏ qua, không Activity Feed, không batch, không comment UI

**Bug:** [BUG-FE-TASKV1-004](../BUG-FE-TASKV1-004-run-agent-ux-gaps.md)
**Loại giải pháp:** Hỗn hợp — mục 1+2 là **Loại A (pointer, một phần)**, mục 3+4 (batch execute + comment UI) là **Loại B (full design)**
**Status:** 📋 Proposed — chưa triển khai

---

## Phần 1 — Mục "prompt bị bỏ qua" và "Activity Feed" (pointer, MỘT PHẦN)

### 1.1. Field `prompt` cho `task.execute` (mục 1 của bug gốc)

Theo brief điều phối: đây là phần *"CHỈ MỘT PHẦN được giải quyết"* bởi
FE-SOL-001. Xác nhận lại bằng cách đọc trực tiếp CR mà FE-SOL-001 hiện thực
(`docs/crs/v3/flow-task/CR-FLOW-TASK-005-frontend-unified-task-execution-ui.md`
mục 3):

> *"`TaskPromptEditor.tsx`: `task.execute` cần nhận field `prompt` tùy chọn...
> cần bổ sung field này ở `task.proto`'s `ExecuteRequest` trước (theo dõi ở
> `specs/backend-go/bugs/task-v1`, **không phải phạm vi sửa của CR frontend
> này**)."*

Nghĩa là ngay cả **CR mà FE-SOL-001 hiện thực cũng tự loại phần này ra khỏi
phạm vi của chính nó** — không phải solution này diễn giải sai, mà CR gốc
đã nói rõ "không phải phạm vi". Xác nhận thêm bằng đọc trực tiếp
`backend-go/proto/orca/task/v1/task.proto:124-127`:

```protobuf
message TaskServiceExecuteRequest {
  string task_id = 1;
  string request_id = 2;
}
```

— **0 field `prompt`** ở cả backend-go lẫn (theo BUG-FE-TASKV1-004's trích
dẫn) schema Node hiện tại. Vậy hiện trạng thật là: **không component frontend
nào (kể cả sau FE-SOL-001) có thể gửi `prompt` đi**, vì trường này chưa tồn
tại trên wire ở bất kỳ backend nào. Đây là **phụ thuộc backend chưa sẵn
sàng** — theo dõi ở
[BUG-TASKV1-004](../../../../backend-go/bugs/task-v1/BUG-TASKV1-004-orcatask-run-agent-execution-gaps.md),
cụ thể là hạng mục "Context preamble + env-var injection" trong
[SOL-TG-04](../../../../backend-go/bugs/logic-v1/solutions/SOL-TG-04-task-agent-execution.md)
(`TASK-TG-04-06`).

**Fix tạm khả thi ngay bây giờ (không cần đợi backend), theo đề xuất #2 của
bug gốc — làm trong solution này:**

`frontend/src/renderer/src/components/task/TaskPromptEditor.tsx:41-49` — đổi
`<textarea>` từ input-có-vẻ-quan-trọng thành hiển thị tĩnh (readonly) của
`task.promptTemplate` hiện có, kèm dòng chú thích nhỏ *"Agent sẽ chạy theo
Prompt Template đã lưu của task này — sửa Prompt Template trong tab Details,
không phải ở đây"*. Bỏ nút bị disable theo `!prompt.trim()` (dòng 52) vì input
không còn giả vờ quan trọng nữa. Đây là fix UX-honesty, không phải fix tính
năng — đúng tinh thần đề xuất #2 gốc: *"tránh UX-lie"*.

```tsx
// Before (TaskPromptEditor.tsx) — textarea trông như sẽ được gửi đi nhưng bị bỏ qua
<textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} ... />
<Button disabled={isRunning || !prompt.trim()} ...>

// After — hiển thị đúng sự thật: promptTemplate là nguồn thật, không phải ô nhập tạm
<div className="rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground" data-testid="prompt-template-readonly">
  {task.promptTemplate?.trim()
    ? task.promptTemplate
    : 'Task này chưa có Prompt Template — agent sẽ chạy không kèm hướng dẫn riêng.'}
</div>
<p className="text-xs text-muted-foreground">
  Sửa Prompt Template ở tab Details. Trường `prompt` ghi đè riêng cho từng lần chạy
  chưa được backend hỗ trợ (xem BUG-TASKV1-004).
</p>
<Button onClick={runWithAgent} disabled={isRunning} data-testid="run-agent-btn">
  {isRunning ? <>...</> : '▶ Run with Agent'}
</Button>
```

Khi backend thêm field `prompt` (theo dõi ở `specs/backend-go/bugs/task-v1`),
quay lại bật `<textarea>` thật và gửi `prompt` trong payload `task.execute`.

### 1.2. Activity Feed (mục 2 của bug gốc)

Pointer đầy đủ tới
[SOL-FE-TASKV1-005](./SOL-FE-TASKV1-005-missing-realtime-event-subscriptions.md)
— cùng root cause, không lặp lại ở đây. Lưu ý theo solution 005: `useTaskActivity`
phụ thuộc `CR-FLOW-TASK-003` chưa xong ở backend, nên ngay cả sau FE-SOL-001,
Activity Feed cho Engine 1/2 (Task/Orchestration) vẫn sẽ trống cho tới khi đó.

---

## Phần 2 — Batch Execute UI (Loại B — thiết kế đầy đủ, KHÔNG thuộc phạm vi FE-SOL-001)

### Hiện trạng (đọc code thật)

`frontend/src/renderer/src/components/task/TaskGraph.tsx:8-26` — toolbar chỉ
có Search + filter Status + toggle Tree/DAG. `TaskTreeView.tsx`/`TaskCard.tsx`
không có checkbox chọn nhiều. Mỗi lần chỉ Run được 1 task qua
`TaskDetail`/`TaskPromptEditor`.

RPC `task.execute` đã có sẵn, được gọi độc lập theo từng `taskId` — không có
RPC batch nào ở backend-go (`TaskServiceExecuteRequest` chỉ nhận 1
`task_id`), nên "batch execute" ở frontend nghĩa là **gọi tuần tự/song song
có giới hạn** `task.execute` nhiều lần, không phải 1 RPC mới.

### Thiết kế

**1. Thêm selection state — mở rộng `useTasks.ts`**

```typescript
// frontend/src/renderer/src/hooks/useTasks.ts — thêm vào return của useTasks()
const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
const toggleSelected = useCallback((id: string) => {
  setSelectedIds(prev => {
    const next = new Set(prev)
    next.has(id) ? next.delete(id) : next.add(id)
    return next
  })
}, [])
const clearSelection = useCallback(() => setSelectedIds(new Set()), [])
// selectedIds phải reset khi projectId đổi — cùng effect với chỗ đang fetch task.list
```

**2. Hook mới — `useTaskBatchExecution.ts`** (file mới, không phải mở rộng
`useTask.ts` vì đây là thao tác trên NHIỀU task, khác trách nhiệm của hook
theo dõi 1 task đơn):

```typescript
// frontend/src/renderer/src/hooks/useTaskBatchExecution.ts (MỚI)
import { useState } from 'react'
import { useAppStore } from '../store'
import { callRuntimeRpc, getActiveRuntimeTarget } from '../runtime/runtime-rpc-client'
import { useWorkspace } from '../context/WorkspaceContext'
import { Tracers } from '../../../shared/trace/tracers'

const MAX_CONCURRENCY = 3 // tránh dispatch hàng chục agent cùng lúc lên 1 dev-server

export function useTaskBatchExecution() {
  const [running, setRunning] = useState(false)
  const [results, setResults] = useState<Map<string, 'ok' | 'error'>>(new Map())
  const { project, currentWorktree } = useWorkspace()

  // Mọi task trong 1 lần chọn đều thuộc cùng project (useTasks lọc theo
  // projectId) nên dùng chung 1 worktree đang active — không cần resolve
  // worktree riêng cho từng task (task-service's Execute cũng chỉ nhận 1
  // worktreePath, xem TaskDetail.tsx's handleRunAgent).
  const runSelected = async (taskIds: string[]) => {
    if (!project || !currentWorktree) return
    setRunning(true)
    setResults(new Map())
    const target = getActiveRuntimeTarget(useAppStore.getState().settings)
    const queue = [...taskIds]
    const runOne = async (taskId: string) => {
      const span = Tracers.uiTaskGraphExecuteFlow.start({ taskId, entryPoint: 'batch-run' })
      try {
        await callRuntimeRpc(target, 'task.execute', {
          taskId, projectId: project.id, worktreePath: currentWorktree.path, traceId: span.id
        })
        span.ok({ taskId })
        setResults(prev => new Map(prev).set(taskId, 'ok'))
      } catch (err) {
        span.fail(err, { taskId })
        setResults(prev => new Map(prev).set(taskId, 'error'))
      }
    }
    // Pool đơn giản, giới hạn MAX_CONCURRENCY — không kéo thêm thư viện ngoài.
    const workers = Array.from({ length: MAX_CONCURRENCY }, async () => {
      while (queue.length > 0) {
        const taskId = queue.shift()
        if (taskId) await runOne(taskId)
      }
    })
    await Promise.all(workers)
    setRunning(false)
  }

  return { running, results, runSelected }
}
```

**3. UI — `TaskGraph.tsx` toolbar + `TaskCard.tsx` checkbox**

```tsx
// TaskGraph.tsx — thêm nút toggle "Select" + nút "Run Selected (N)" khi có chọn
const [selectMode, setSelectMode] = useState(false)
const { selectedIds, toggleSelected, clearSelection } = useTasks(projectId) // đã mở rộng ở bước 1
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
```

```tsx
// TaskCard.tsx — thêm checkbox khi selectMode bật (prop mới, optional — không phá vỡ
// chữ ký hiện tại khi selectMode=false ở mọi nơi khác đang dùng TaskCard)
{selectMode && (
  <input
    type="checkbox"
    checked={isSelected}
    onClick={e => e.stopPropagation()}
    onChange={() => onToggleSelect(task.id)}
    data-testid={`task-select-${task.id}`}
  />
)}
```

**4. Kết quả sau batch run:** hiển thị toast tổng hợp (`sonner`, đã dùng sẵn
trong codebase — xem `TaskDetail.tsx:12`) — ví dụ `"3/5 task đã dispatch
thành công, 2 lỗi"` thay vì im lặng.

### Rủi ro cần lưu ý khi triển khai

- `task.execute` hiện **không revert status khi dispatch lỗi**
  ([BUG-TASKV1-004](../../../../backend-go/bugs/task-v1/BUG-TASKV1-004-orcatask-run-agent-execution-gaps.md):
  *"never reverts a task's status if dispatch fails"*) — chạy batch 10 task
  mà dev-server offline giữa chừng sẽ để lại nhiều task kẹt ở `in_progress`
  vĩnh viễn. Đây là backend gap có sẵn, batch UI chỉ khuếch đại tần suất gặp
  phải nó — không tự sửa trong solution này, chỉ ghi nhận rủi ro.
- `ComplexExecutor` vẫn là stub — nếu 1 task trong batch có subtask/dependency
  (nhánh "complex"), nó sẽ "thành công" giả (`stub-orchestration-exec:...`)
  ngay cả khi chưa chạy gì thật — batch UI sẽ hiển thị `ok` sai sự thật cho
  các task này. Không có cách nào ở tầng frontend phân biệt được điều này
  cho tới khi `ComplexExecutor` thật được xây (xem
  [BUG-TASKV1-005](../../../../backend-go/bugs/task-v1/BUG-TASKV1-005-task-execute-orchestration-coordinator-not-autonomous.md)).

---

## Phần 3 — Comment UI (Loại B — thiết kế đầy đủ, phụ thuộc backend CHƯA sẵn sàng ở backend-go)

### Hiện trạng (đọc code thật + xác nhận lại RPC surface)

- `task.addComment` tồn tại **chỉ ở Node** (`desktop/src/main/task/task-rpc-handler.ts:304`,
  `backend/src/main/task/task-rpc-handler.ts:304`).
- Xác nhận lại trực tiếp trên `backend-go/proto/orca/task/v1/task.proto`
  (đọc toàn bộ service definition, dòng 13-47): **0 RPC nào tên
  `AddComment`/`ListComments`** trên `TaskService`. Khớp với
  [BUG-TASKV1-001](../../../../backend-go/bugs/task-v1/BUG-TASKV1-001-orcatask-data-model-and-state-machine-gap.md):
  *"`task.task_comments` table còn tồn tại (RLS enabled) nhưng 0 dòng Go code
  nào tham chiếu tới nó"* — bảng có, RPC không có, hoàn toàn khác `AddEdge`/
  `Grant` (những RPC ít nhất đã có ở tầng proto/gRPC, chỉ thiếu wscompat).

**Kết luận: đây là phụ thuộc backend-go CHƯA sẵn sàng ở mức sâu nhất (chưa
có cả RPC lẫn usecase), không chỉ "frontend chưa gọi".** Không thể thiết kế
UI Comment hoạt động thật trên `backend-go` hôm nay.

### Thiết kế UI (chỉ thực thi được trên deploy target Node — Desktop Electron / server-web hiện tại; PHẢI ẩn/disable trên backend-go cho tới khi RPC tồn tại)

**1. Component mới — `TaskComments.tsx`**

```tsx
// frontend/src/renderer/src/components/task/TaskComments.tsx (MỚI)
export function TaskComments({ taskId }: { taskId: string }) {
  const { comments, addComment, isSupported } = useTaskComments(taskId)
  const [text, setText] = useState('')

  if (!isSupported) {
    // backend-go chưa có AddComment RPC — không giả vờ tính năng hoạt động
    return (
      <div className="text-xs text-muted-foreground p-3" data-testid="task-comments-unsupported">
        Comments chưa khả dụng trên backend hiện tại (chỉ hỗ trợ ở Node deploy target).
        Theo dõi: BUG-TASKV1-001 (task_comments table chưa có RPC ở backend-go).
      </div>
    )
  }

  return (
    <div className="task-comments space-y-2 p-3" data-testid="task-comments">
      <div className="space-y-1 max-h-64 overflow-y-auto">
        {comments.map(c => (
          <div key={c.id} className="text-xs">
            <span className="font-medium">{c.authorId}</span>{' '}
            <span className="text-muted-foreground">{formatRelativeTime(c.createdAt)}</span>
            <p>{c.body}</p>
          </div>
        ))}
        {comments.length === 0 && <p className="text-xs text-muted-foreground">Chưa có comment nào.</p>}
      </div>
      <div className="flex gap-2">
        <Input value={text} onChange={e => setText(e.target.value)} placeholder="Viết comment..." />
        <Button size="sm" disabled={!text.trim()} onClick={() => { addComment(text); setText('') }}>
          Gửi
        </Button>
      </div>
    </div>
  )
}
```

**2. Hook mới — `useTaskComments.ts`**

```typescript
// frontend/src/renderer/src/hooks/useTaskComments.ts (MỚI)
// `isSupported` feature-detect: gọi thử task.addComment và bắt lỗi
// "method not found" 1 lần khi mount, cache theo target — tránh spam lỗi
// mỗi lần user gõ. Cách chắc chắn hơn (nhưng cần backend hợp tác) là thêm 1
// RPC capability-probe chung — ngoài phạm vi solution này.
export function useTaskComments(taskId: string) {
  const [comments, setComments] = useState<TaskComment[]>([])
  const [isSupported, setIsSupported] = useState(true) // optimistic, hạ xuống false nếu list lỗi

  useEffect(() => {
    const target = getActiveRuntimeTarget(useAppStore.getState().settings)
    callRuntimeRpc<{ comments: TaskComment[] }>(target, 'task.listComments', { taskId })
      .then(r => setComments(r.comments ?? []))
      .catch(() => setIsSupported(false)) // backend-go: "method not found" → ẩn UI thay vì lỗi vô nghĩa
  }, [taskId])

  const addComment = async (body: string) => {
    const target = getActiveRuntimeTarget(useAppStore.getState().settings)
    const created = await callRuntimeRpc<TaskComment>(target, 'task.addComment', { taskId, body })
    setComments(prev => [...prev, created])
  }

  return { comments, addComment, isSupported }
}
```

**3. Thêm tab "Comments" vào `TaskDetail.tsx`**

```tsx
// TaskDetail.tsx — thêm tab thứ 4 (Details/Subtasks/AI/Comments), giữ nguyên 3 tab cũ
<TabsList>
  <TabsTrigger value="details">Details</TabsTrigger>
  <TabsTrigger value="subtasks">Subtasks</TabsTrigger>
  <TabsTrigger value="ai">AI Agent</TabsTrigger>
  <TabsTrigger value="comments">Comments</TabsTrigger>
</TabsList>
...
<TabsContent value="comments">
  <TaskComments taskId={task.id} />
</TabsContent>
```

**4. `task.listComments`** — RPC đọc kèm theo cũng cần tồn tại (bug gốc chỉ
nhắc `addComment`, nhưng hiển thị danh sách cần 1 RPC đọc — kiểm tra lại
Node's `task-rpc-handler.ts` xem có `task.listComments` hay tương đương
(`task.getComments`?) trước khi hiện thực hook trên; nếu Node cũng chưa có
RPC đọc, đây là phần cần bổ sung ở Node trước, ngoài phạm vi bug này ghi
nhận (bug gốc chỉ audit `addComment`).

### Việc backend cần làm trước khi UI này dùng được trên backend-go

Không nằm trong phạm vi frontend — ghi nhận rõ ở đây theo yêu cầu, theo dõi
tại `specs/backend-go/bugs/task-v1`:
1. Thêm `rpc AddComment`/`rpc ListComments` vào `task.proto`.
2. Thêm usecase + repository method đọc/ghi bảng `task.task_comments` (đã
   có sẵn schema + RLS, chỉ thiếu code Go — xem BUG-TASKV1-001).
3. Wire 2 RPC này vào wscompat (`task.addComment`/`task.listComments`) —
   theo đúng pattern các `task.*` channel khác trong
   `channels_automation_task.go`.

## Files cần sửa (Phần 2 + 3 — Loại B)

| File | Action |
|------|--------|
| `frontend/src/renderer/src/hooks/useTasks.ts` | MODIFY — thêm `selectedIds`/`toggleSelected`/`clearSelection` |
| `frontend/src/renderer/src/hooks/useTaskBatchExecution.ts` | NEW |
| `frontend/src/renderer/src/components/task/TaskGraph.tsx` | MODIFY — nút Select mode + Run Selected |
| `frontend/src/renderer/src/components/task/TaskCard.tsx` | MODIFY — checkbox khi selectMode |
| `frontend/src/renderer/src/components/task/TaskPromptEditor.tsx` | MODIFY — textarea → readonly promptTemplate display (Phần 1.1) |
| `frontend/src/renderer/src/hooks/useTaskComments.ts` | NEW (chỉ hoạt động thật trên Node) |
| `frontend/src/renderer/src/components/task/TaskComments.tsx` | NEW |
| `frontend/src/renderer/src/components/task/TaskDetail.tsx` | MODIFY — thêm tab "Comments" |

## Tham khảo

- [SOL-FE-TASKV1-005](./SOL-FE-TASKV1-005-missing-realtime-event-subscriptions.md) — Activity Feed (mục 2)
- [BUG-TASKV1-004](../../../../backend-go/bugs/task-v1/BUG-TASKV1-004-orcatask-run-agent-execution-gaps.md) — field `prompt`, status-revert-on-failure
- [BUG-TASKV1-001](../../../../backend-go/bugs/task-v1/BUG-TASKV1-001-orcatask-data-model-and-state-machine-gap.md) — `task_comments` table chết, chưa có RPC ở backend-go
