# FE-SOL-001: Task CRUD dialog, real DAG dependencies, Board/Kanban view, Grant/Share modal

> **📋 Proposed — chưa triển khai.** Solution này đọc code frontend **thật
> tại thời điểm viết** (2026-09-09) — một phát hiện của CR-TG-007 hoá ra đã
> **được sửa rồi** kể từ lúc CR được viết (repo này có nhiều phiên làm việc
> song song, xem "Đính chính so với CR-TG-007" ngay dưới) — không giả định
> nội dung CR là hiện trạng cuối cùng mà đọc lại trực tiếp trước khi thiết
> kế.

## CR Reference

- **CR:** [CR-TG-007](../../../../../../docs/crs/v4/task-graph/CR-TG-007-frontend-task-crud-board-grant-ui.md) — P0
- **Phụ thuộc:** [BE-SOL-001](../../../../../backend-go/crs/v4/task-graph/solutions/BE-SOL-001-orcatask-data-model-widening.md) (7 status values, `GetSubtree`), [BE-SOL-003](../../../../../backend-go/crs/v4/task-graph/solutions/BE-SOL-003-task-access-control-team-scope-and-sharing.md) (Grant RPC), [`CR-FLOW-TASK-005`](../../../../../../docs/crs/v3/flow-task/CR-FLOW-TASK-005-frontend-unified-task-execution-ui.md) (áp dụng `useTaskActivity`, không thiết kế lại)

## ⚠️ Đính chính so với CR-TG-007 — đọc trước khi implement

CR-TG-007 §C4 mô tả "Run with Agent" là UX-lie — prompt người dùng gõ bị
backend bỏ qua hoàn toàn. **Đọc lại `TaskPromptEditor.tsx` hôm nay cho thấy
điều này đã được sửa**:

```tsx
// TaskPromptEditor.tsx:24-34 — code thật hiện tại
// BACKLOG-016: task.execute now accepts `prompt` — an empty value
// (user never edited the textarea) falls back to the executor's own
// default (SimpleExecutor.buildExecutePrompt, built from the task's
// title), same behavior as before this field existed.
await callRuntimeRpc(target, 'task.execute', {
  taskId: task.id, projectId: project!.id, worktreePath: currentWorktree!.path,
  prompt, traceId: span.id
})
```

`prompt` đã được gửi thật, và backend-go's `ExecuteTaskInput.Prompt` +
`SimpleExecutor.Execute`'s `effectivePrompt` fallback (xác nhận trực tiếp ở
[BE-SOL-005](../../../../../backend-go/crs/v4/task-graph/solutions/BE-SOL-005-task-agent-execution-permission-and-complex-executor.md)
§1) đã tiêu thụ nó đúng cách. **§C4 của CR-TG-007 không còn là gap — mục
này bị loại khỏi phạm vi solution.** Các gap còn lại của CR (C1 CRUD, C2
DAG, C3 Grant, C5 real-time) đã xác nhận lại trực tiếp và vẫn còn nguyên —
xem từng mục dưới đây.

## ⚠️ Cập nhật sau khi viết task (2026-09-09) — 3 phát hiện mới, không có trong solution gốc

- **Mục 1 (New Task)**: `task.create` wscompat channel hôm nay **không
  decode `projectId`** (chỉ `{title, parentId}`) dù `CreateTaskRequest`
  proto đã có field này — task tạo mới sẽ có `ProjectId` rỗng và **biến
  mất khỏi UI** ngay sau khi tạo. Đây là bug backend-go riêng, không thuộc
  BE-SOL-001 — xem
  [TASK-TG-001-06](../../../../../backend-go/crs/v4/task-graph/tasks/TASK-TG-001-06-task-create-channel-project-id-fix.md)
  (task mới), phải land cùng lúc với mục 1 dưới đây.
- **Mục 3 (Board view)**: `TaskStatusBadge.tsx`'s `STATUS_CONFIG` hôm nay
  chỉ cover 4/7 giá trị status thật (thiếu `backlog`/`review`/`blocked`) —
  vá trước khi build Board, nếu không 3 cột sẽ hiển thị sai nhãn "Todo".
- **Mục 4 (Grant modal)**: codebase **đã có sẵn**
  `frontend/src/shared/task-types.ts`'s `TaskPermission`/`TaskGrant`/
  `TaskGrantLevel` dùng đúng thang `view/comment/edit/execute/manage` mà
  [BE-SOL-003](../../../../../backend-go/crs/v4/task-graph/solutions/BE-SOL-003-task-access-control-team-scope-and-sharing.md)
  đã bác bỏ (không có RPC nào dùng type này). **Không tái dùng type có
  sẵn này** — tạo type mới đúng theo `GrantLevel` thật
  (owner/admin/user/team/company), xem
  [FE-TASK-004](../tasks/FE-TASK-004-task-grant-modal-access-tab.md).

## 1. "New Task" dialog (C1)

Xác nhận còn thiếu: `grep "'task.create'"` trên toàn `frontend/src` = 0 kết
quả; `TaskGraph.tsx` hiện tại (đọc trực tiếp) chỉ có Search + Status filter
(3 giá trị `all/todo/in_progress/done` — thiếu 4 giá trị CR-TG-001 sẽ thêm)
+ toggle Tree/DAG — không có nút "New Task", đúng như wireframe của
`specs/frontend/tdd/v5/15-task-graph-ui.md` §1 đã vẽ sẵn
(`[+ New Task] [Tree ▼] [Filter ▼] [🔍 Search]`) nhưng chưa build.

```tsx
// TaskGraph.tsx — thêm vào toolbar hiện có
<Button size="sm" onClick={() => setShowCreateDialog(true)}>+ New Task</Button>
{showCreateDialog && (
  <TaskCreateDialog projectId={projectId} onCreated={() => setShowCreateDialog(false)} />
)}

// TaskCreateDialog.tsx (MỚI)
const create = async (title: string, parentId?: string) => {
  await callRuntimeRpc(target, 'task.create', { projectId, title, parentId, creatorId: currentUser.id })
  // BE-SOL-003 §Design — CreatorID cần truyền để backend tự tạo owner grant
  refetch() // useTasks.ts's existing fetch-on-projectId-change effect — trigger via a refetch counter, not a re-mount
}
```

`useTasks.ts` cần thêm 1 `refetchTrigger` state (hoặc export `refetch()`
trực tiếp) — hiện hook chỉ fetch khi `projectId` đổi (`useEffect`'s dep
array chỉ có `[projectId, setTasks]`), không có cách nào trigger lại thủ
công sau khi tạo task mới.

Sau BE-SOL-001 thêm `GetSubtree`, cân nhắc thay `task.list` (load toàn bộ
project) bằng `task.getSubtree` cho view theo từng epic — không bắt buộc
ngay, có thể để `task.list` + client-filter tiếp tục hoạt động cho tới khi
dataset đủ lớn để cần tối ưu (tránh optimize sớm không cần thiết).

## 2. `TaskDAGView` dùng dependency thật (C2)

Xác nhận còn nguyên, `TaskDAGView.tsx` vẫn tự thú trong comment (dòng
28-29): *"OrcaTask has no embedded `dependsOn`... Always [] until that's
wired in (out of scope here)."* — `(task as any).dependsOn ?? []` luôn trả
`[]`.

```tsx
// TaskDAGView.tsx — buildDAGLayout(), sửa nguồn dữ liệu
const depsById = new Map<string, string[]>()
await Promise.all(tasks.map(async (t) => {
  const { dependencies } = await callRuntimeRpc(target, 'task.getDependencies', { taskId: t.id })
  depsById.set(t.id, dependencies.map(d => d.taskId))
}))
// thay dependsOnMap.set(task.id, (task as any).dependsOn ?? []) bằng depsById.get(task.id) ?? []
```

N+1 RPC chấp nhận được cho dataset hiện tại (dozens of tasks/project); nếu
cần tối ưu sau này, thêm batch endpoint là việc của backend-go, không phải
thiết kế lại ở đây. Thêm UI "+ Add dependency" (chọn task từ dropdown) gọi
`task.addEdge` (BE-SOL-001's atomic `AddEdge`).

## 3. **Board/Kanban view** (mới — gap chính ma trận hoàn thành nêu)

Xác nhận còn thiếu: `grep -rli "board|kanban"` trên `components/task/` = 0.
`viewMode` hiện tại (`TaskGraph.tsx`) chỉ có `'tree' | 'dag'`.

```tsx
// TaskGraph.tsx
const [viewMode, setViewMode] = useState<'tree' | 'dag' | 'board'>('tree')
// + <button data-testid="view-board" onClick={() => setViewMode('board')}>Board</button>

// TaskBoardView.tsx (MỚI)
const STATUS_ORDER: OrcaTask['status'][] = ['backlog', 'todo', 'in_progress', 'blocked', 'review', 'done', 'cancelled'] // BE-SOL-001's 7 values
export function TaskBoardView({ tasks, onStatusChange }: { tasks: OrcaTask[]; onStatusChange: (id: string, status: string) => void }) {
  return (
    <div className="flex gap-3 overflow-x-auto p-2 h-full">
      {STATUS_ORDER.map((status) => (
        <div key={status} className="flex-shrink-0 w-64 flex flex-col">
          <div className="text-xs font-medium px-2 py-1"><TaskStatusBadge status={status} /> ({tasks.filter(t => t.status === status).length})</div>
          <div className="flex-1 space-y-2 overflow-y-auto" onDrop={(e) => onStatusChange(e.dataTransfer.getData('taskId'), status)} onDragOver={(e) => e.preventDefault()}>
            {tasks.filter(t => t.status === status).map(t => (
              <div key={t.id} draggable onDragStart={(e) => e.dataTransfer.setData('taskId', t.id)}>
                <TaskCard task={t} /> {/* tái sử dụng component đã có, không viết lại rendering */}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
```

Kéo-thả gọi `task.update({ id, status })` — optimistic update ở store rồi
revert nếu backend từ chối (permission — xem mục 4). Theo
[`docs/STYLEGUIDE.md`](../../../../../STYLEGUIDE.md), dùng token màu đã có
ở `TaskStatusBadge.tsx` cho header cột, không tự định nghĩa màu mới.

## 4. **Grant/Share modal** (mới) + Access tab (C3)

Xác nhận còn thiếu: `grep "task.grant|resolvePermission"` = 0.
`TaskDetail.tsx` hiện tại chỉ có 3 tab (`'details' | 'subtasks' | 'ai'`,
dòng 35, 108-113) — đúng như `15-task-graph-ui.md` §"Task Grant Resolution"
(dòng 461-485) đã mô tả model quyền (`view|comment|edit|execute|manage`,
`apply_tree`, `expires_at`) nhưng frontend chưa hề implement UI cho nó.

```tsx
// TaskDetail.tsx — mở rộng activeTab union + thêm TabsTrigger/TabsContent thứ 4
const [activeTab, setActiveTab] = useState<'details' | 'subtasks' | 'ai' | 'access'>('details')
// ...
<TabsTrigger value="access">Access</TabsTrigger>
// ...
<TabsContent value="access"><TaskGrantModal taskId={task.id} /></TabsContent>

// TaskGrantModal.tsx (MỚI)
export function TaskGrantModal({ taskId }: { taskId: string }) {
  const { grants, addGrant, revoke, generateShareLink } = useTaskGrants(taskId) // hook mới, gọi BE-SOL-003's RPC
  return (
    <div className="space-y-3">
      <GrantList grants={grants} onRevoke={revoke} />
      <GrantForm onSubmit={addGrant} /> {/* chọn granteeKind (user/team/company) + level (owner/admin/user/team/company theo BE-SOL-003 — GIỮ NGUYÊN GrantLevel, không đổi thang view/comment/edit/execute/manage như CR gốc đề xuất */}
      <Button onClick={generateShareLink}>Generate share link</Button>
    </div>
  )
}
```

**Lưu ý quan trọng:** [BE-SOL-003](../../../../../backend-go/crs/v4/task-graph/solutions/BE-SOL-003-task-access-control-team-scope-and-sharing.md)
đính chính CR-TG-003 — `GrantLevel` giữ nguyên `owner/admin/user/team/company`
(không tách `GranteeKind`/`PermissionLevel`). UI form ở đây phải map đúng
theo enum THẬT này, không theo thang `view/comment/edit/execute/manage`
CR-TG-007 (và CR-TG-003 gốc) từng mô tả — sửa lại ở đây trước khi build UI,
tránh xây form cho 1 enum không tồn tại ở backend.

Permission badge trên header `TaskDetail`:

```tsx
useEffect(() => {
  callRuntimeRpc(target, 'task.resolvePermission', { taskId: task.id, userId: currentUser.id, action: 'manage' })
    .then(setCanManage).catch(() => setCanManage(false))
}, [task.id])
// ẩn nút Run/Edit/Delete nếu !canManage tương ứng — không chỉ dựa vào backend reject
```

## 5. `useTaskActivity` (C5) — áp dụng thiết kế có sẵn, không thiết kế lại

Theo đúng `CR-FLOW-TASK-005` §2's `useTaskActivity` hook — implement khi
`CR-FLOW-TASK-003`'s kênh `task.activity:{taskId}` sẵn sàng; fallback
polling `task.get` mỗi 4s (mẫu `useWorkflowExecution.ts`) nếu chưa sẵn sàng
tại thời điểm triển khai.

## Not in scope

- §C4 (Run-Agent prompt) — đã sửa, xem đính chính ở trên.
- Comments tab — chờ BE-SOL-001's `AddComment`/`ListComments` RPC merge trước.
- Dashboard Task Execute (Engine 2) thật thay `OrchestrationPage.tsx` — CR/solution riêng.

## Test plan

- "New Task" tạo task thật, xuất hiện ngay trong Tree/Board không cần reload trang.
- DAG view render đúng cạnh thật (task A depends_on B → A→B xuất hiện).
- Board view: kéo-thả đổi cột gọi đúng `task.update`, revert khi backend từ chối.
- Grant modal: thêm/revoke/share-link hoạt động; permission badge ẩn đúng nút theo quyền thật.

## References

- [CR-TG-007](../../../../../../docs/crs/v4/task-graph/CR-TG-007-frontend-task-crud-board-grant-ui.md)
- `specs/frontend/tdd/v5/15-task-graph-ui.md` §1, §"Task Grant Resolution" (dòng 24-41, 461-485)
- `frontend/src/renderer/src/components/task/TaskGraph.tsx`, `TaskDAGView.tsx`, `TaskDetail.tsx`, `TaskPromptEditor.tsx` (đọc trực tiếp 2026-09-09)
