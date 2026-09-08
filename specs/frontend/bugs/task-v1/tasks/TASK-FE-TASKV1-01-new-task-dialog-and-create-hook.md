# TASK-FE-TASKV1-01 — Dialog "New Task" + `createTask()` trong `useTasks.ts`

**Solution:** [SOL-FE-TASKV1-001](../solutions/SOL-FE-TASKV1-001-orcatask-crud-va-tree-navigation.md)
**Bug:** [BUG-FE-TASKV1-001](../BUG-FE-TASKV1-001-orcatask-crud-va-tree-navigation.md)
**File:** `frontend/src/renderer/src/components/task/TaskCreateDialog.tsx` (mới), `frontend/src/renderer/src/hooks/useTasks.ts`, `frontend/src/renderer/src/components/task/TaskGraph.tsx`, `frontend/src/renderer/src/components/task/TaskCard.tsx`
**Estimated:** 90 phút (bao gồm sửa gap wscompat mới phát hiện — xem bên dưới)
**Status:** [ ] TODO
**Phụ thuộc:** BLOCKED một phần — xem "Phát hiện quan trọng" bên dưới, cần 1 fix nhỏ ở `backend-go` trước khi task hoàn thành đúng nghĩa.

---

## Mục tiêu

Thêm nút "+ New Task" (và "+ subtask" trên từng `TaskCard` khi hover) mở dialog tạo task mới, gọi RPC `task.create` đã có sẵn ở cả gRPC lẫn wscompat. Vá thêm 1 field mặc định ở client để `OrcaTask` trả về không "què" (thiếu field bắt buộc theo type).

---

## Phát hiện quan trọng khi viết task này (KHÔNG có trong SOL-FE-TASKV1-001 gốc)

Đọc trực tiếp `backend-go/services/api-gateway/internal/adapter/wscompat/channels.go:277-291` xác nhận
**`task.create` ở wscompat KHÔNG forward `projectId`**:

```go
r.Register("task.create", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
    type createArgs struct {
        Title    string `json:"title"`
        ParentID string `json:"parentId"`
    }
    // ...
    resp, err := client.CreateTask(ctx, &taskv1.CreateTaskRequest{
        TenantId: id.TenantID, Title: in.Title, ParentId: in.ParentID,
    })
```

`createArgs` không có field `ProjectID`, và request gửi lên gRPC cũng không set `ProjectId`. Đối chiếu
`backend-go/services/task-service/internal/adapter/grpc/server.go:70-82` và
`.../internal/usecase/create_task.go:21-46`: **toàn bộ pipeline gRPC → usecase → domain ĐÃ hỗ trợ
đầy đủ `ProjectID`** (proto `CreateTaskRequest.project_id`, `CreateTaskInput.ProjectID`,
`domain.NewTask(..., in.ProjectID)`) — chỉ riêng handler wscompat quên decode/forward field này.

**Hệ quả im lặng, nghiêm trọng:** mọi task tạo qua dialog "New Task" sẽ có `projectId` rỗng ở
backend. `useTasks.ts:16` lọc `tasks.filter(t => t.projectId === projectId)` — task vừa tạo sẽ
**biến mất khỏi `TaskGraph` ngay sau khi tạo** (không hiện lỗi, RPC trả 200 OK bình thường), dù
client tự thêm task vào store qua `addTask()` (sẽ tạm thấy được cho tới lần `task.list` refetch kế
tiếp, sau đó biến mất do server trả về task không có `projectId` khớp).

**Depends on: backend-go task (chưa track ở task-v1 — đây là gap MỚI phát hiện khi viết task này,
không có trong BUG-TASKV1-001 hay SOL-FE-TASKV1-001 gốc)** — cần sửa
`channels.go`'s `task.create` handler để decode `projectId` từ args và forward vào
`taskv1.CreateTaskRequest{..., ProjectId: in.ProjectID}`. Task frontend này **chỉ làm được phần UI
+ hook**; nút "New Task" sẽ tạo task "biến mất" cho tới khi backend-go vá xong. Nếu cần demo/test
task này độc lập trước khi backend fix xong, có thể tạm patch `channels.go` cục bộ (2 dòng) trong
lúc dev — nhưng đừng merge phần đó vào PR frontend, báo riêng cho backend-go team.

---

## Context

Đọc trước:
- `backend-go/proto/orca/task/v1/task.proto:14, 49-67` — `CreateTaskRequest`/`Task`/`CreateTaskResponse`: chỉ có `{tenant_id, title, parent_id, project_id}` / response `Task` chỉ có `{id, tenant_id, title, status, parent_id, project_id}` — **không có** `type/priority/description/labels/visibility/progressPercent/createdAt/updatedAt`.
- `frontend/src/shared/task-types.ts:39-63` — `OrcaTask` type đầy đủ (các field bắt buộc backend không trả).
- `frontend/src/renderer/src/hooks/useTasks.ts` (toàn bộ, 95 dòng) — cấu trúc hook hiện tại, đặc biệt dòng 3 (`callRuntimeRpc`/`getActiveRuntimeTarget` đã import sẵn) và dòng 83-94 (object trả về, cần thêm `createTask`).
- `frontend/src/renderer/src/components/task/TaskGraph.tsx` (37 dòng) — toolbar hiện tại, chỗ thêm nút.
- `frontend/src/renderer/src/components/task/TaskCard.tsx` (40 dòng) — chỗ thêm nút "+ subtask" khi hover.
- `frontend/src/renderer/src/components/ui/dialog.tsx` — component `Dialog` sẵn có, dùng lại nguyên (đã xác nhận tồn tại).

```bash
grep -n "task.create\b" backend-go/services/api-gateway/internal/adapter/wscompat/channels.go
```

---

## Thay đổi cần thực hiện

### 1. File mới — `frontend/src/renderer/src/components/task/TaskCreateDialog.tsx`

Theo đúng thiết kế trong SOL-FE-TASKV1-001 mục 1 (copy nguyên khối JSX/props ở đó) — **chỉ Title +
Parent (ẩn)**, không thêm field `type`/`priority`/`description`/`labels` vào form vì backend-go sẽ
bỏ qua, không lưu (khớp BUG-TASKV1-001).

### 2. `useTasks.ts` — thêm `createTask()`

Thêm vào cuối hook, trước `return`:

```typescript
// backend-go's CreateTaskResponse chỉ trả {id, title, status, parentId, projectId} —
// các field bắt buộc còn lại của OrcaTask (BUG-TASKV1-001) chưa tồn tại ở backend-go
// nên phải default ở client để tránh object thiếu field làm vỡ TaskCard/TaskDetail
// (đọc task.type/priority/progressPercent không optional-chain).
const createTask = useCallback(async (title: string, parentId?: string) => {
  const target = getActiveRuntimeTarget(useAppStore.getState().settings)
  const created = await callRuntimeRpc<Partial<OrcaTask>>(target, 'task.create', {
    title, parentId, projectId
  })
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
}, [projectId])
```

Thêm `createTask` vào object `return` cuối hook (dòng 83-94 hiện tại).

> [!IMPORTANT]
> `useAppStore.getState().addTask` đã tồn tại thật (`renderer/src/store/slices/task.ts:11,31`) —
> không cần tạo mới action store.

### 3. `TaskGraph.tsx` — nút "+ New Task" + dialog

```tsx
const [createDialogOpen, setCreateDialogOpen] = useState(false)
const { filteredTasks, ..., createTask } = useTasks(projectId) // thêm createTask vào destructure

<Button size="sm" onClick={() => setCreateDialogOpen(true)} data-testid="new-task-btn">
  + New Task
</Button>
<TaskCreateDialog
  open={createDialogOpen}
  onOpenChange={setCreateDialogOpen}
  onCreate={(title, parentId) => createTask(title, parentId)}
/>
```

Đặt nút cạnh ô Search trong thanh toolbar hiện có (dòng 14-24).

### 4. `TaskCard.tsx` — nút "+ subtask" khi hover

Thêm 1 nút nhỏ (icon `Plus` từ `lucide-react`, đã dùng `ChevronDown/ChevronRight` cùng thư viện)
hiện khi hover row, gọi `onCreateSubtask(task.id)` — prop mới optional, truyền xuống từ
`TaskTreeView.tsx` → `TaskGraph.tsx` theo cùng cách `onSelect`/`onToggle` đã được truyền (xem
`TaskTreeView.tsx` dòng 6-28 — phải thread thêm 1 prop qua `renderLevel()`, không chỉ sửa
`TaskCard.tsx` một mình).

---

## Verify

```bash
pnpm --filter frontend tsc --noEmit
pnpm --filter frontend test -- useTasks TaskCreateDialog TaskGraph TaskCard TaskTreeView
```

Kiểm tra thủ công (sau khi backend-go vá gap `projectId`): tạo task mới qua dialog → task xuất
hiện ngay trong tree VÀ vẫn còn sau khi tab đổi project rồi quay lại (tức là `task.list` refetch
vẫn thấy nó — bằng chứng `projectId` đã được lưu đúng ở server).

## Definition of Done

- [ ] `TaskCreateDialog.tsx` mới, chỉ có field Title (+ Parent ẩn qua context), không có field vô nghĩa
- [ ] `useTasks.ts` có `createTask()`, default đủ field bắt buộc của `OrcaTask`
- [ ] Nút "+ New Task" trong `TaskGraph.tsx` toolbar; nút "+ subtask" khi hover trên `TaskCard`
- [ ] Đã báo/ghi nhận rõ ràng gap `projectId` ở `channels.go`'s `task.create` cho backend-go team (không tự sửa file backend-go trong PR frontend này, trừ khi được yêu cầu riêng)
- [ ] `pnpm tsc --noEmit` không có lỗi mới liên quan các file đã sửa
- [ ] Test mới cho `createTask()` (mock `callRuntimeRpc` trả object thiếu field, assert `withDefaults` đủ field)
