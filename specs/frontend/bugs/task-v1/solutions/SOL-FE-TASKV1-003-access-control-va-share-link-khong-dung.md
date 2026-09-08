# SOL-FE-TASKV1-003 — `task.grant`/`task.resolvePermission` mồ côi ở UI

**Bug:** [BUG-FE-TASKV1-003](../BUG-FE-TASKV1-003-access-control-va-share-link-khong-dung.md)
**Loại giải pháp:** B — Full design (một phần — xem giới hạn RPC dưới đây)
**Status:** 📋 Proposed — chưa triển khai

---

## Xác nhận lại RPC surface trước khi thiết kế (2 phát hiện mới, quan trọng)

### 1. `Grant`/`ResolvePermission` chưa được wire vào wscompat

Đọc toàn bộ `backend-go/services/api-gateway/internal/adapter/wscompat/`:
danh sách đầy đủ channel `task.*` đã wire là `create, get, execute, list,
update, delete, getDependencies, aiDecompose, aiApply` — **9 channel, không
có `grant` hay `resolvePermission`**. Giống hệt tình trạng `AddEdge` ở
[SOL-FE-TASKV1-002](./SOL-FE-TASKV1-002-orcatask-dependency-graph-gia.md):
RPC tồn tại ở gRPC/proto (`task.proto:17-18`) nhưng **chưa lộ ra cho
client**. Đây là điều kiện tiên quyết bắt buộc, không phải optional.

### 2. Model quyền thật (`GrantLevel`) KHÁC hoàn toàn model mà frontend type đã khai

`shared/task-types.ts:29-32` khai:

```typescript
/**
 * Permission levels for task grants.
 * Hierarchy (highest → lowest): manage > execute > edit > comment > view
 */
export type TaskPermission = 'view' | 'comment' | 'edit' | 'execute' | 'manage'
```

Đây là **action scale** (làm được gì). Nhưng backend-go's `GrantLevel` thật
(`task.proto:92-99`, xác nhận lại bởi
[BUG-TASKV1-003](../../../../backend-go/bugs/task-v1/BUG-TASKV1-003-orcatask-access-control-model-mismatch.md)):

```protobuf
enum GrantLevel {
  GRANT_LEVEL_UNSPECIFIED = 0;
  GRANT_LEVEL_OWNER = 1;
  GRANT_LEVEL_ADMIN = 2;
  GRANT_LEVEL_USER = 3;
  GRANT_LEVEL_TEAM = 4;
  GRANT_LEVEL_COMPANY = 5;
}
```

Đây là **grantee-kind scale** (grant dành cho ai: 1 user cụ thể / 1 team /
cả company), **không phải** action scale. `TaskPermission` (frontend type)
hiện là 1 type **aspirational không khớp thực tế backend-go** — nếu thiết
kế UI theo `TaskPermission` (dropdown "view/comment/edit/execute/manage")
thì mọi giá trị gửi lên `task.grant` sẽ **sai enum**, bị backend reject.
**UI phải thiết kế theo `GrantLevel` thật**, không theo
`shared/task-types.ts`'s `TaskPermission` — đây là 1 gap kiểu tương tự
BUG-FE-TASKV1-008 (frontend type lệch backend thật), cần sửa
`shared/task-types.ts`'s `TaskPermission` (hoặc thêm 1 type riêng
`TaskGrantLevel` khớp enum thật) trong lúc làm solution này, không chỉ thêm
UI mới lên trên type sai.

### 3. Không có RPC liệt kê grant hiện có

`BUG-TASKV1-003` xác nhận: *"No grant listing on the public API surface —
`ListGrantsForAncestors` remains internal-only, consumed solely by
`ResolvePermission`"*. Nghĩa là UI **không thể hiển thị "ai đang có quyền
gì"** — chỉ có thể: (a) tự kiểm tra quyền của chính mình
(`resolvePermission`), (b) thêm 1 grant mới mù (`grant`, không thấy lại
được sau khi thêm). Đề xuất #1 gốc ("hiển thị danh sách grant hiện có") **không
khả thi** cho tới khi có RPC list mới.

## Thiết kế (thu hẹp theo đúng RPC thật có sẵn)

### 1. Sửa type trước — `TaskGrantLevel` khớp `GrantLevel` thật

```typescript
// frontend/src/shared/task-types.ts — thêm mới, KHÔNG xoá TaskPermission
// (một số chỗ khác trong codebase có thể đã dùng nó cho mục đích UI-only
// filter, không liên quan RPC) — nhưng ghi rõ nó KHÔNG khớp GrantLevel thật.
/**
 * Grantee-kind scale thật của backend-go's `GrantLevel` (task.proto:92-99).
 * KHÁC `TaskPermission` ở trên (action scale) — đó là 1 type tài liệu hoá
 * ý định thiết kế ban đầu (BL-TG-03) chưa từng được backend-go hiện thực.
 * Dùng type này khi gọi task.grant/resolvePermission, không dùng TaskPermission.
 */
export type TaskGrantLevel = 'owner' | 'admin' | 'user' | 'team' | 'company'
```

### 2. Badge quyền hiện tại — `useTaskPermission.ts` (hook mới)

```typescript
// frontend/src/renderer/src/hooks/useTaskPermission.ts (MỚI)
import { useState, useEffect } from 'react'
import { useAppStore } from '../store'
import { callRuntimeRpc, getActiveRuntimeTarget } from '../runtime/runtime-rpc-client'
import type { TaskGrantLevel } from '../../../shared/task-types'

// isSupported: false khi target đang chạy chưa wire task.resolvePermission
// ở wscompat (hôm nay: LUÔN false, xem xác nhận RPC surface ở trên) — hook
// tự phát hiện qua lỗi "method not found" thay vì hard-code true/false theo
// deploy target, để tự động hết cảnh báo khi backend wire xong mà không cần
// sửa lại hook này.
export function useTaskPermission(taskId: string, userId: string | undefined) {
  const [level, setLevel] = useState<TaskGrantLevel | null>(null)
  const [isSupported, setIsSupported] = useState(true)

  useEffect(() => {
    if (!userId) return
    const target = getActiveRuntimeTarget(useAppStore.getState().settings)
    callRuntimeRpc<{ effectiveLevel: string }>(target, 'task.resolvePermission', { taskId, userId })
      .then(r => setLevel(r.effectiveLevel.toLowerCase() as TaskGrantLevel))
      .catch(() => setIsSupported(false))
  }, [taskId, userId])

  return { level, isSupported }
}
```

### 3. Tab "Access" trong `TaskDetail.tsx` — chỉ Grant (viết) + permission badge (đọc quyền chính mình), KHÔNG có danh sách grant

```tsx
// frontend/src/renderer/src/components/task/TaskAccessPanel.tsx (MỚI)
export function TaskAccessPanel({ taskId }: { taskId: string }) {
  const currentUserId = useAppStore(s => s.currentUserId) // giả định store đã có; xác nhận tên field thật khi implement
  const { level, isSupported } = useTaskPermission(taskId, currentUserId)
  const [subjectId, setSubjectId] = useState('')
  const [grantLevel, setGrantLevel] = useState<TaskGrantLevel>('user')
  const [applyTree, setApplyTree] = useState(false)
  const [granting, setGranting] = useState(false)

  if (!isSupported) {
    return (
      <div className="text-xs text-muted-foreground p-3" data-testid="task-access-unsupported">
        Access control chưa khả dụng — RPC `task.grant`/`task.resolvePermission`
        chưa được wire ở backend hiện tại. Theo dõi: BUG-TASKV1-003.
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
        level: `GRANT_LEVEL_${grantLevel.toUpperCase()}`, // khớp enum string thật
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
          Lưu ý: chưa có cách xem lại danh sách đã cấp sau khi submit (backend
          chưa có RPC list-grants công khai — BUG-TASKV1-003).
        </p>
        <Input value={subjectId} onChange={e => setSubjectId(e.target.value)} placeholder="User ID hoặc Team ID" />
        <Select value={grantLevel} onValueChange={v => setGrantLevel(v as TaskGrantLevel)}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            {(['admin', 'user', 'team', 'company'] as const).map(l => (
              <SelectItem key={l} value={l}>{l}</SelectItem>
            ))}
            {/* 'owner' cố tình không cho chọn ở đây — cấp owner nên là hành động
                riêng, không lẫn trong form share thông thường */}
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

```tsx
// TaskDetail.tsx — thêm tab "Access" (tương tự cách SOL-FE-TASKV1-004 thêm tab "Comments";
// nếu cả 2 solution triển khai cùng lúc, TaskDetail sẽ có 5 tab: Details/Subtasks/AI/Comments/Access)
<TabsTrigger value="access">Access</TabsTrigger>
...
<TabsContent value="access">
  <TaskAccessPanel taskId={task.id} />
</TabsContent>
```

### 4. Ẩn action ghi theo quyền (đề xuất #2 gốc) — CHỈ áp dụng được sau khi có `isSupported === true`

```tsx
// TaskDetail.tsx — handleRunAgent's nút Execute, ví dụ áp dụng cho quyền 'user' trở lên
const { level, isSupported } = useTaskPermission(task.id, currentUserId)
const canExecute = !isSupported || (level && ['owner', 'admin', 'user'].includes(level))
// isSupported === false → không ẩn gì cả (giữ hành vi hiện tại, dựa vào backend reject
// khi bấm) — tránh khoá nhầm toàn bộ UI khi RPC còn chưa wire.
{canExecute && <Button onClick={handleRunAgent}>▶ Execute with Agent</Button>}
```

Lưu ý: vì `GrantLevel` là grantee-kind (owner/admin/user/team/company),
không phải action scale, "quyền nào được Execute" ở đây là 1 **quyết định
sản phẩm cần xác nhận với chủ sở hữu BL-TG-03** — ví dụ tạm trên chỉ là gợi
ý hợp lý (owner/admin/user được xem là "đủ để thao tác", team/company chỉ
xem), không phải quy tắc đã chốt.

## Share-link — KHÔNG thiết kế trong solution này

Giữ nguyên khuyến nghị gốc: khái niệm share-link cho Task chưa tồn tại ở
tầng thiết kế (khác `OrcaProjectSourceProject` đã có cho Project) — cần 1 CR
riêng, không tự chế ở đây.

## Việc backend cần làm trước khi solution này dùng được (ngoài phạm vi frontend)

Theo dõi ở `specs/backend-go/bugs/task-v1`:
1. Wire `Grant` + `ResolvePermission` vào wscompat (`task.grant`,
   `task.resolvePermission`) — RPC gRPC đã có, chỉ thiếu wiring.
2. `StubTeamScopeResolver.ResolveTeams` vẫn là stub cứng
   (`team_scope_resolver.go:24-26`) — mọi grant `GRANT_LEVEL_TEAM` sẽ không
   bao giờ match cho tới khi resolver này thật.
3. (Tuỳ chọn, cải thiện UX) Thêm 1 RPC list-grants công khai cho task —
   hiện `ListGrantsForAncestors` chỉ internal.

## Files cần sửa

| File | Action |
|------|--------|
| `frontend/src/shared/task-types.ts` | MODIFY — thêm `TaskGrantLevel` khớp `GrantLevel` thật |
| `frontend/src/renderer/src/hooks/useTaskPermission.ts` | NEW |
| `frontend/src/renderer/src/components/task/TaskAccessPanel.tsx` | NEW |
| `frontend/src/renderer/src/components/task/TaskDetail.tsx` | MODIFY — thêm tab "Access", ẩn nút Execute theo quyền (khi `isSupported`) |

## Tham khảo

- [BUG-TASKV1-003](../../../../backend-go/bugs/task-v1/BUG-TASKV1-003-orcatask-access-control-model-mismatch.md) — xác nhận `GrantLevel` là grantee-kind, team resolver là stub, không có Revoke/expiry/list công khai
- [SOL-FE-TASKV1-002](./SOL-FE-TASKV1-002-orcatask-dependency-graph-gia.md) — cùng loại phát hiện (RPC có ở proto, chưa wire wscompat)
