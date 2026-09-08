# TASK-FE-TASKV1-06 — Tab "Access" (`TaskAccessPanel`) + ẩn nút Execute theo quyền

**Solution:** [SOL-FE-TASKV1-003](../solutions/SOL-FE-TASKV1-003-access-control-va-share-link-khong-dung.md) (mục 3-4)
**Bug:** [BUG-FE-TASKV1-003](../BUG-FE-TASKV1-003-access-control-va-share-link-khong-dung.md)
**File:** `frontend/src/renderer/src/components/task/TaskAccessPanel.tsx` (mới), `frontend/src/renderer/src/components/task/TaskDetail.tsx`
**Estimated:** 60 phút
**Status:** [ ] TODO
**Phụ thuộc:** [TASK-FE-TASKV1-05](./TASK-FE-TASKV1-05-task-grant-level-type-fix-and-permission-hook.md) (cần `TaskGrantLevel` đã sửa + `useTaskPermission`). **BLOCKED một phần** — xem "Depends on" bên dưới.

---

## ⚠️ Depends on: backend-go task chưa sẵn sàng (BLOCKING cho phần "ghi")

`Grant`/`ResolvePermission` **có ở gRPC/proto** (`task.proto:17-18`) nhưng **chưa wire vào wscompat**
— xác nhận bằng grep toàn bộ danh sách channel `task.*` đã đăng ký
(`channels.go:277,295` + `channels_automation_task.go:223-330`): chỉ có 9 channel
`create/get/execute/list/update/delete/getDependencies/aiDecompose/aiApply`, **không có
`grant`/`resolvePermission`**.

**Depends on: backend-go task (chưa track thành 1 file riêng ở `specs/backend-go/bugs/task-v1` tại
thời điểm viết task này — cần: (1) wire `Grant`+`ResolvePermission` vào wscompat theo pattern các
channel `task.*` khác; (2) `StubTeamScopeResolver.ResolveTeams`
(`team_scope_resolver.go:24-26`) vẫn là stub cứng — mọi grant `GRANT_LEVEL_TEAM` sẽ không bao giờ
match cho tới khi resolver này thật).** Task frontend này chỉ làm được phần UI; nút "Cấp quyền" sẽ
luôn fail cho tới khi backend sẵn sàng — panel phải tự phát hiện qua `isSupported` (từ
`useTaskPermission`, TASK-05) và hiển thị thông báo rõ ràng thay vì form chết lặng.

**Không có RPC list-grant công khai** — `ListGrantsForAncestors` chỉ internal
(`BUG-TASKV1-003` xác nhận). Panel này **không** hiển thị "ai đang có quyền gì" — chỉ: (a) quyền
của chính user hiện tại, (b) form cấp quyền mới (ghi, không đọc lại được).

---

## Mục tiêu

Thêm tab "Access" vào `TaskDetail.tsx`: hiển thị quyền hiện tại của user + form cấp quyền cho
user/team khác. Ẩn nút "Execute with Agent" khi user không đủ quyền (chỉ áp dụng khi
`isSupported === true`, tránh khoá nhầm UI khi RPC còn chưa wire).

## Context

Đọc trước:
- [TASK-FE-TASKV1-05](./TASK-FE-TASKV1-05-task-grant-level-type-fix-and-permission-hook.md) — `TaskGrantLevel`, `useTaskPermission`.
- `frontend/src/renderer/src/components/task/TaskDetail.tsx:30-35, 64-113` — cấu trúc component, `TASK_STATUSES`, `TabsList`/`TabsContent` hiện tại (3 tab: `details/subtasks/ai`), nút Execute ở dòng 102-104.
- `backend-go/proto/orca/task/v1/task.proto:92-120` — `GrantLevel`, `GrantRequest`, `ResolvePermissionResponse`.

## Thay đổi cần thực hiện

### 1. File mới — `frontend/src/renderer/src/components/task/TaskAccessPanel.tsx`

Theo đúng thiết kế SOL-FE-TASKV1-003 mục 3 (copy khối JSX/logic ở đó), với 2 sửa bắt buộc so với
bản gốc trong solution:

- Dùng `useAppStore(s => s.currentUser?.id)` thay vì `s.currentUserId` (field không tồn tại — xem
  TASK-05).
- `level`/`grantLevel` gõ kiểu `TaskGrantLevel` (đã sửa nghĩa ở TASK-05), giá trị gửi lên
  `task.grant` là `GRANT_LEVEL_${grantLevel.toUpperCase()}` khớp enum string thật.

```tsx
export function TaskAccessPanel({ taskId }: { taskId: string }) {
  const currentUserId = useAppStore(s => s.currentUser?.id)
  const { level, isSupported } = useTaskPermission(taskId, currentUserId)
  const [subjectId, setSubjectId] = useState('')
  const [grantLevel, setGrantLevel] = useState<TaskGrantLevel>('user')
  const [applyTree, setApplyTree] = useState(false)
  const [granting, setGranting] = useState(false)

  if (!isSupported) {
    return (
      <div className="text-xs text-muted-foreground p-3" data-testid="task-access-unsupported">
        Access control chưa khả dụng — RPC `task.grant`/`task.resolvePermission` chưa được wire ở
        backend hiện tại. Theo dõi: BUG-TASKV1-003.
      </div>
    )
  }

  const submitGrant = async () => {
    if (!subjectId.trim()) return
    setGranting(true)
    try {
      const target = getActiveRuntimeTarget(useAppStore.getState().settings)
      await callRuntimeRpc(target, 'task.grant', {
        taskId, subjectId: subjectId.trim(),
        level: `GRANT_LEVEL_${grantLevel.toUpperCase()}`,
        applyTree
      })
      toast.success(`Đã cấp quyền ${grantLevel} cho ${subjectId}`)
      setSubjectId('')
    } catch (err) {
      toast.error(`Không thể cấp quyền: ${(err as Error).message}`)
    } finally {
      setGranting(false)
    }
  }

  return (
    <div className="space-y-4 p-3" data-testid="task-access-panel">
      <div className="text-xs">
        <span className="font-medium">Quyền của bạn trên task này: </span>
        <span data-testid="own-permission-badge">{level ?? 'đang tải…'}</span>
      </div>
      <div className="space-y-2 border-t pt-3">
        <p className="text-xs font-semibold">Cấp quyền cho user/team khác</p>
        <p className="text-xs text-muted-foreground">
          Lưu ý: chưa có cách xem lại danh sách đã cấp sau khi submit (backend chưa có RPC
          list-grants công khai — BUG-TASKV1-003).
        </p>
        <Input value={subjectId} onChange={e => setSubjectId(e.target.value)} placeholder="User ID hoặc Team ID" />
        <Select value={grantLevel} onValueChange={v => setGrantLevel(v as TaskGrantLevel)}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            {(['admin', 'user', 'team', 'company'] as const).map(l => (
              <SelectItem key={l} value={l}>{l}</SelectItem>
            ))}
            {/* 'owner' cố tình không cho chọn ở đây — cấp owner nên là hành động riêng */}
          </SelectContent>
        </Select>
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={applyTree} onChange={e => setApplyTree(e.target.checked)} />
          Áp dụng cho toàn bộ subtask (apply_tree)
        </label>
        <Button size="sm" disabled={granting || !subjectId.trim()} onClick={submitGrant}>
          {granting ? 'Đang cấp…' : 'Cấp quyền'}
        </Button>
      </div>
    </div>
  )
}
```

### 2. `TaskDetail.tsx` — thêm tab "Access" + gate nút Execute

```tsx
// Dòng 35: mở rộng union type activeTab
const [activeTab, setActiveTab] = useState<'details' | 'subtasks' | 'ai' | 'access'>('details')

// Trước return, sau khai báo handleRunAgent (dòng 87):
const currentUserId = useAppStore(s => s.currentUser?.id)
const { level: myLevel, isSupported: permissionSupported } = useTaskPermission(task.id, currentUserId)
const canExecute = !permissionSupported || (myLevel && ['owner', 'admin', 'user'].includes(myLevel))

// Dòng 101-105: gate nút Execute
{canExecute && (
  <Button variant="default" onClick={handleRunAgent} data-testid="run-agent-btn">
    ▶ Execute with Agent
  </Button>
)}

// TabsList (dòng 109-113): thêm tab thứ 4
<TabsTrigger value="access">Access</TabsTrigger>

// Sau TabsContent "ai" (dòng 175-177): thêm
<TabsContent value="access">
  <TaskAccessPanel taskId={task.id} />
</TabsContent>
```

> [!IMPORTANT]
> `canExecute` chỉ có ý nghĩa quyết định sản phẩm tạm thời (owner/admin/user đủ để thao tác,
> team/company chỉ xem) — **chưa phải quy tắc đã chốt với chủ sở hữu BL-TG-03**, vì `GrantLevel` là
> grantee-kind (ai được cấp), không phải action-scale (làm được gì). Ghi rõ trong PR description để
> reviewer biết đây là 1 giả định cần xác nhận sản phẩm, không phải spec đã duyệt.

## Verify

```bash
pnpm --filter frontend tsc --noEmit
pnpm --filter frontend test -- TaskAccessPanel TaskDetail
```

Kiểm tra thủ công: với `isSupported === false` (mặc định hôm nay), tab Access hiện thông báo rõ
ràng, nút Execute vẫn hiện bình thường (không bị ẩn nhầm khi RPC chưa wire).

## Definition of Done

- [ ] `TaskAccessPanel.tsx` mới, dùng đúng `TaskGrantLevel` (đã sửa ở TASK-05), không dùng `currentUserId`
- [ ] Tab "Access" xuất hiện trong `TaskDetail.tsx`, panel tự ẩn form khi `isSupported === false`
- [ ] Nút Execute chỉ bị ẩn khi `isSupported === true` VÀ quyền không đủ — không bao giờ ẩn khi RPC chưa wire
- [ ] PR ghi rõ: tính năng cấp quyền sẽ lỗi 100% cho tới khi backend-go wire `task.grant`/`task.resolvePermission` (chưa có task backend-go riêng track — cần mở), và quy tắc "quyền nào được Execute" là giả định tạm, cần xác nhận sản phẩm
- [ ] `pnpm tsc --noEmit` sạch
