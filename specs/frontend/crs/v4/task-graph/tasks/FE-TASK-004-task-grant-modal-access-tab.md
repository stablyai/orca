# FE-TASK-004: `TaskGrantModal` — tab Access + permission badge

**Domain:** task-graph
**Solution Ref:** FE-SOL-001 Phần 4
**Priority:** 🟠 P1
**Estimated:** 65 phút
**Status:** ✅ DONE (một phần mock có chủ đích, đúng như spec lường trước) — 2026-09-09

### Kết quả thực tế

- `task-types.ts`: thêm `RealGrantLevel = 'owner'|'admin'|'user'|'team'|'company'` (tên mới, KHÔNG
  tái dùng `TaskPermission`/`TaskGrant`/`TaskGrantLevel` cũ, đúng đính chính bắt buộc của task này).
- `useTaskGrants.ts` (mới): `addGrant` gọi `task.grant` thật; `grants` trả rỗng (chưa có
  `task.listGrants`); `revoke`/`generateShareLink` no-op + `toast.info` rõ ràng "pending
  BE-SOL-003" — không giả lập dữ liệu, không im lặng thất bại, đúng yêu cầu.
- `TaskGrantModal.tsx` (mới): form Add Grant + danh sách grant (rỗng, có thông báo) + nút Revoke
  (ẩn/hiện theo `grants`) + nút Generate share link — sao chép đúng code mẫu của spec.
- `TaskDetail.tsx`: thêm tab thứ 4 "Access" (mount `TaskGrantModal`), permission badge dạng ẩn/hiện
  nút "Execute with Agent" theo `canManage` (mặc định `true` để không ẩn nhầm trong lúc đang fetch).
  `currentUserId` lấy qua `useAuthUser()` (`../../hooks/useAuthSession`, field `.id`) — xác nhận
  đúng hook thật của app thay vì đoán tên biến (khớp pattern `useAppStore.getState().currentUser`
  đã dùng ở `ProjectSettings.tsx`).
- **Xác nhận thêm khi đọc code thật `channels_automation_task.go:465-479`**: `task.resolvePermission`
  THẬT SỰ nhận `userId` từ client args (`{taskId, userId}` → forward nguyên vào
  `ResolvePermissionRequest`) — không giống một số RPC khác trong hệ thống có cơ chế chống giả mạo
  "userId đến từ Identity, bỏ qua args" (`UserIDComesFromIdentityNotArgs`, xác nhận qua backend
  test khác). Với RPC này, gửi `userId: currentUser.id` trong args là đúng theo thiết kế thật —
  không phải giả định sai.
- `impact({target: "TaskDetail", direction: "upstream"})`: risk **LOW** (0 caller tìm thấy qua
  call-graph — component được mount qua JSX động, không phải call trực tiếp; không có symbol nào bị
  ảnh hưởng ngoài chính `TaskDetail.tsx`).
- Test mới: `useTaskGrants.test.ts` (4 case), `TaskGrantModal.test.tsx` (4 case), `TaskDetail.test.tsx`
  (+3 case: `canManage=false` ẩn nút Run, `canManage=true` (owner) hiện nút Run, tab Access render
  đúng `taskId`). **Vấn đề kỹ thuật gặp phải**: Radix `Tabs` thật không đổi tab dưới `fireEvent.click`
  trong môi trường happy-dom (đã xác nhận đây là vấn đề đã biết trong repo — 3 file test khác đã
  từng gặp và giải quyết bằng cách mock `ui/tabs` với 1 controlled component tối giản, ví dụ
  `CreateProjectDialog.test.tsx`) — áp dụng lại đúng pattern đó cho `TaskDetail.test.tsx`.
  Kết quả `npx vitest run` cho cả 3 file: **18/18 pass**. `npx tsc --noEmit -p .`: 0 lỗi mới.
- **Gap thật, đúng như spec đã lường trước** (không phải lỗi của task này): phần xem danh sách
  grant hiện có / Revoke / Generate share link vẫn chỉ là no-op + thông báo — chờ BE-SOL-003's 3
  RPC mới (`ListGrants`/`RevokeGrant`/`GenerateShareLink`, còn 📋 Proposed).

---

## ⚠️ Đính chính bắt buộc đọc trước khi implement — KHÔNG dùng thang `view/comment/edit/execute/manage`

[BE-SOL-003](../../../../../backend-go/crs/v4/task-graph/solutions/BE-SOL-003-task-access-control-team-scope-and-sharing.md)
đính chính CR-TG-003 §2.2: đề xuất tách `GrantLevel` thành `GranteeKind` (User/Team/Company) +
`PermissionLevel` (`view<comment<edit<execute<manage`) là **không cần thiết và rủi ro hơn** so với
hiện trạng thật. Backend-go's `taskv1.GrantLevel` (proto thật, generated) **gộp grantee-kind vào
chính level**:

```go
// backend-go/services/task-service/internal/domain/grant.go — enum THẬT
GrantLevelOwner | GrantLevelAdmin | GrantLevelUser | GrantLevelTeam | GrantLevelCompany
```

`task.grant` RPC (`channels_automation_task.go:369-388`) nhận `level` là string parse qua
`taskv1.GrantLevel_value` — tức chuỗi hợp lệ là **`"owner"|"admin"|"user"|"team"|"company"`**, không
phải `"view"|"comment"|"edit"|"execute"|"manage"`.

**⚠️ Phát hiện thêm, không có trong FE-SOL-001**: `frontend/src/shared/task-types.ts` (dòng 29-33,
82-96, 116-123, 136-137) **hiện đã có sẵn** `TaskPermission = 'view'|'comment'|'edit'|'execute'|'manage'`,
`TaskGrant` (dùng field `permission: TaskPermission`, `scope: 'user'|'team'|'role'|'everyone'`),
`TASK_PERMISSION_ORDER`, và alias `TaskGrantLevel = TaskPermission` — **đây chính xác là cái thang
CR-TG-003 gốc đề xuất mà BE-SOL-003 đã bác bỏ**. Những type này KHÔNG khớp backend thật
(`taskv1.GrantLevel`) và KHÔNG được dùng bởi bất kỳ RPC call nào hôm nay (xác nhận `grep -rn
"TaskPermission\|TaskGrant\b" frontend/src/renderer/src` chỉ trả về chính file định nghĩa, không có
call site thật nào import). Task này phải **thêm type mới đúng thang thật** (`TaskGrantLevelReal`
hoặc tương đương) thay vì tái dùng `TaskPermission`/`TaskGrant`/`TaskGrantLevel` hiện có — dùng nhầm
3 type này cho UI mới sẽ lặp lại đúng sai lầm CR-TG-003 mắc phải. Không tự xoá `TaskPermission`/
`TaskGrant` cũ ở task này (ngoài phạm vi, có thể có chỗ khác đang tham chiếu type dù chưa gọi RPC
nào bằng nó) — chỉ không dùng chúng cho UI mới.

## Mục tiêu

`TaskDetail.tsx` hôm nay chỉ có 3 tab (`'details' | 'subtasks' | 'ai'`, dòng 35, 108-113) — không có
UI nào cho Grant/Share. Thêm tab thứ 4 "Access" + `TaskGrantModal` (thêm/xem grant, permission badge
ẩn nút theo quyền).

## Xác nhận đã đọc code thật trước khi viết task (2026-09-09) — RPC nào dùng được NGAY, RPC nào chưa

| RPC | Trạng thái thật | Nguồn xác nhận |
|-----|-----------------|----------------|
| `task.grant` | ✅ Tồn tại, dùng được ngay | `channels_automation_task.go:369-388` |
| `task.resolvePermission` | ✅ Tồn tại, dùng được ngay | `channels_automation_task.go:391-403` — trả `{ effectiveLevel: string }` (đã lowercase, đã strip prefix `GRANT_LEVEL_`) |
| `task.listGrants` (xem danh sách grant hiện có) | ❌ Chưa tồn tại | 0 kết quả `grep "ListGrants\|listGrants"` trên `wscompat/*.go` + `task.proto` |
| `task.revokeGrant` | ❌ Chưa tồn tại | 0 kết quả `grep "RevokeGrant\|revokeGrant"` |
| `task.generateShareLink` | ❌ Chưa tồn tại | 0 kết quả `grep "GenerateShareLink\|generateShareLink"` |

3 RPC ở dưới là đề xuất **mới** của BE-SOL-003 (`RevokeGrant`/`ListGrants`/`GenerateShareLink`,
📋 Proposed — chưa triển khai). **Kết luận:** form "Add Grant" + permission badge build được thật
100% hôm nay; phần "xem danh sách grant hiện có" / "Revoke" / "Generate share link" phải mock/no-op
tạm thời cho tới khi BE-SOL-003 merge — không phải lỗi của task này, ghi rõ trong PR.

## Files cần sửa

| File | Action |
|------|--------|
| `frontend/src/shared/task-types.ts` | MODIFY — thêm `export type RealGrantLevel = 'owner' \| 'admin' \| 'user' \| 'team' \| 'company'` (tên mới, KHÔNG tái dùng `TaskGrantLevel`/`TaskPermission` cũ) |
| `frontend/src/renderer/src/hooks/useTaskGrants.ts` | NEW |
| `frontend/src/renderer/src/components/task/TaskGrantModal.tsx` | NEW |
| `frontend/src/renderer/src/components/task/TaskDetail.tsx` | MODIFY — mở rộng `activeTab` union (dòng 35) + thêm `TabsTrigger`/`TabsContent` thứ 4, thêm permission badge cạnh nút Run |
| `frontend/src/renderer/src/hooks/__tests__/useTaskGrants.test.ts` | NEW |
| `frontend/src/renderer/src/components/task/__tests__/TaskGrantModal.test.tsx` | NEW |
| `frontend/src/renderer/src/components/task/__tests__/TaskDetail.test.tsx` | MODIFY — case tab Access render, case permission badge ẩn nút Run |

## Các bước thực thi

### 1. Thêm type đúng thang thật (`task-types.ts`)

```typescript
/** Thang GrantLevel THẬT khớp backend taskv1.GrantLevel (BE-SOL-003's correction — KHÔNG phải
 * TaskPermission's view/comment/edit/execute/manage, thang đó không có backend tương ứng). */
export type RealGrantLevel = 'owner' | 'admin' | 'user' | 'team' | 'company'
```

### 2. Tạo `useTaskGrants.ts`

```typescript
import { useState, useCallback } from 'react'
import { useAppStore } from '../store'
import { callRuntimeRpc, getActiveRuntimeTarget } from '../runtime/runtime-rpc-client'
import { toast } from 'sonner'
import type { RealGrantLevel } from '../../../shared/task-types'

export function useTaskGrants(taskId: string) {
  const [isGranting, setIsGranting] = useState(false)

  const addGrant = useCallback(async (subjectId: string, level: RealGrantLevel, applyTree: boolean) => {
    setIsGranting(true)
    const target = getActiveRuntimeTarget(useAppStore.getState().settings)
    try {
      // Shape thật channels_automation_task.go:369-388 — level là string ('owner'|'admin'|
      // 'user'|'team'|'company'), parse server-side qua taskv1.GrantLevel_value.
      await callRuntimeRpc(target, 'task.grant', { taskId, subjectId, level, applyTree })
      toast.success(`Granted ${level} to ${subjectId}`)
    } catch (err: any) {
      toast.error(`Failed to grant: ${err.message}`)
      throw err
    } finally {
      setIsGranting(false)
    }
  }, [taskId])

  // task.listGrants CHƯA tồn tại (BE-SOL-003 📋 Proposed) — trả rỗng tạm thời, không giả lập
  // dữ liệu giả để tránh hiểu nhầm là đã hoạt động thật.
  const grants: { subjectId: string; level: RealGrantLevel }[] = []

  // revoke/generateShareLink CHƯA có RPC — no-op + toast thông báo rõ, không im lặng thất bại.
  const revoke = useCallback((_subjectId: string) => {
    toast.info('Revoke grant is not available yet (pending BE-SOL-003)')
  }, [])
  const generateShareLink = useCallback(() => {
    toast.info('Share link is not available yet (pending BE-SOL-003)')
  }, [])

  return { grants, addGrant, revoke, generateShareLink, isGranting }
}
```

### 3. Tạo `TaskGrantModal.tsx`

```tsx
import { useState } from 'react'
import { useTaskGrants } from '../../hooks/useTaskGrants'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '../ui/select'
import type { RealGrantLevel } from '../../../../shared/task-types'

const GRANT_LEVELS: RealGrantLevel[] = ['owner', 'admin', 'user', 'team', 'company']

export function TaskGrantModal({ taskId }: { taskId: string }) {
  const { grants, addGrant, revoke, generateShareLink, isGranting } = useTaskGrants(taskId)
  const [subjectId, setSubjectId] = useState('')
  const [level, setLevel] = useState<RealGrantLevel>('user')
  const [applyTree, setApplyTree] = useState(false)

  return (
    <div className="task-grant-modal space-y-3" data-testid="task-grant-modal">
      <div>
        <p className="text-xs font-semibold mb-1">Current grants</p>
        {grants.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No grant list available yet — pending backend `ListGrants` (BE-SOL-003).
          </p>
        ) : (
          grants.map((g) => (
            <div key={g.subjectId} className="flex items-center justify-between text-xs py-1">
              <span>{g.subjectId} — {g.level}</span>
              <Button size="sm" variant="ghost" onClick={() => revoke(g.subjectId)} data-testid={`revoke-${g.subjectId}`}>
                Revoke
              </Button>
            </div>
          ))
        )}
      </div>

      <div className="space-y-2 border-t pt-2">
        <p className="text-xs font-semibold">Add grant</p>
        <Input
          placeholder="User/Team/Company id..."
          value={subjectId}
          onChange={(e) => setSubjectId(e.target.value)}
          data-testid="grant-subject-input"
        />
        <Select value={level} onValueChange={(v) => setLevel(v as RealGrantLevel)}>
          <SelectTrigger data-testid="grant-level-select"><SelectValue /></SelectTrigger>
          <SelectContent>
            {GRANT_LEVELS.map((l) => <SelectItem key={l} value={l}>{l}</SelectItem>)}
          </SelectContent>
        </Select>
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={applyTree} onChange={(e) => setApplyTree(e.target.checked)} />
          Apply to descendants
        </label>
        <Button
          size="sm"
          disabled={!subjectId.trim() || isGranting}
          onClick={() => addGrant(subjectId.trim(), level, applyTree)}
          data-testid="grant-submit"
        >
          {isGranting ? 'Granting...' : 'Grant access'}
        </Button>
      </div>

      <Button size="sm" variant="outline" onClick={generateShareLink} data-testid="grant-share-link">
        Generate share link
      </Button>
    </div>
  )
}
```

### 4. Gắn tab "Access" + permission badge vào `TaskDetail.tsx`

```tsx
// TaskDetail.tsx — dòng 35
const [activeTab, setActiveTab] = useState<'details' | 'subtasks' | 'ai' | 'access'>('details')
const [canManage, setCanManage] = useState(true) // mặc định true tránh ẩn nút khi resolvePermission chưa trả lời

useEffect(() => {
  if (!task?.id) {
    return
  }
  const target = getActiveRuntimeTarget(useAppStore.getState().settings)
  // task.resolvePermission trả { effectiveLevel } (đã lowercase, đã strip GRANT_LEVEL_ prefix) —
  // channels_automation_task.go:391-403. "manage" = quyền cao nhất theo level_actions OPA bundle.
  callRuntimeRpc<{ effectiveLevel: string }>(target, 'task.resolvePermission', {
    taskId: task.id, userId: currentUserId
  })
    .then((r) => setCanManage(r.effectiveLevel === 'owner' || r.effectiveLevel === 'admin'))
    .catch(() => setCanManage(false))
}, [task?.id])

// Action Buttons row (dòng 100-105):
<div className="flex gap-2 mt-2">
  {canManage && (
    <Button variant="default" onClick={handleRunAgent} data-testid="run-agent-btn">
      ▶ Execute with Agent
    </Button>
  )}
</div>

// TabsList (dòng 109-113): thêm <TabsTrigger value="access">Access</TabsTrigger>
// TabsContent: thêm <TabsContent value="access"><TaskGrantModal taskId={task.id} /></TabsContent>
```

`currentUserId` cần lấy từ context/store xác thực hiện có của app (không phải phần việc mới của
task này — dùng đúng biến/hook app đã dùng ở nơi khác cần user id hiện tại, xác nhận tên biến thật
khi implement thay vì đoán).

## Không làm ở task này

- Không implement UI xem/list grant thật — chờ BE-SOL-003's `ListGrants` merge, giữ nguyên thông báo
  "not available yet".
- Không xoá `TaskPermission`/`TaskGrant`/`TaskGrantLevel`/`TASK_PERMISSION_ORDER` cũ khỏi
  `task-types.ts` — ngoài phạm vi, có thể ảnh hưởng chỗ khác chưa audit hết.
- Không tự ẩn nút `handleRunAgent` dựa CHỈ vào `canManage` mà bỏ qua backend reject — badge chỉ là
  UX hint, backend vẫn là nguồn sự thật cuối cùng (nếu API reject dù canManage=true do race condition
  permission vừa đổi, giữ nguyên xử lý lỗi hiện có của `handleRunAgent`).

## Test cases cần cover

```
useTaskGrants.test.ts
├── addGrant(subjectId, 'admin', true) → gọi task.grant({taskId, subjectId, level:'admin', applyTree:true})
├── addGrant lỗi → toast.error, throw lại cho caller
├── revoke() → toast.info "not available yet", KHÔNG gọi RPC nào
└── generateShareLink() → toast.info "not available yet", KHÔNG gọi RPC nào

TaskGrantModal.test.tsx
├── nhập subjectId, chọn level, bấm "Grant access" → gọi addGrant với đúng giá trị form
├── subjectId rỗng → nút "Grant access" disabled
└── grants rỗng → hiện message "No grant list available yet"

TaskDetail.test.tsx (case mới)
├── task.resolvePermission trả effectiveLevel='user' → canManage=false → nút Run KHÔNG render
├── task.resolvePermission trả effectiveLevel='owner' → nút Run render bình thường
└── tab "Access" render TaskGrantModal đúng taskId
```

## Verify

```bash
cd frontend && npx vitest run \
  src/renderer/src/hooks/__tests__/useTaskGrants.test.ts \
  src/renderer/src/components/task/__tests__/TaskGrantModal.test.tsx \
  src/renderer/src/components/task/__tests__/TaskDetail.test.tsx
cd frontend && npx tsc --noEmit -p .
```

## gitnexus

Chạy trước khi sửa (bắt buộc theo CLAUDE.md):
```
impact({target: "TaskDetail", direction: "upstream"})
```
Task này sửa cùng vùng `TaskDetail.tsx` (Action Buttons + Tabs) với FE-TASK-001/002/003 chỉ ở mức
component khác nhau trong cùng thư mục `components/task/` — `TaskDetail.tsx` cụ thể chỉ bị chạm bởi
task này trong series v4 (001/002/003 chạm `TaskGraph.tsx`/`TaskDAGView.tsx`/`TaskStatusBadge.tsx`,
không chạm `TaskDetail.tsx`). Risk dự kiến LOW — dán kết quả thật vào PR.

## Depends on

`task.grant`/`task.resolvePermission` đã tồn tại thật — UI Add Grant + permission badge dùng được
ngay. Phần list/revoke/share-link phụ thuộc
[BE-SOL-003](../../../../../backend-go/crs/v4/task-graph/solutions/BE-SOL-003-task-access-control-team-scope-and-sharing.md)'s
3 RPC mới (📋 Proposed) — không phải hard blocker cho việc build/ship phần Add Grant + badge trước.

## Blocking

Không có
