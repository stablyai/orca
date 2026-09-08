# TASK-FE-TASKV1-08 — Tab "Comments" trên `TaskDetail`

**Solution:** [SOL-FE-TASKV1-004](../solutions/SOL-FE-TASKV1-004-run-agent-ux-gaps.md) (Phần 3)
**Bug:** [BUG-FE-TASKV1-004](../BUG-FE-TASKV1-004-run-agent-ux-gaps.md)
**File:** `frontend/src/renderer/src/hooks/useTaskComments.ts` (mới), `frontend/src/renderer/src/components/task/TaskComments.tsx` (mới), `frontend/src/renderer/src/components/task/TaskDetail.tsx`
**Estimated:** 60 phút
**Status:** [ ] TODO
**Phụ thuộc:** BLOCKED trên `backend-go` — xem "Depends on" bên dưới. Chỉ chạy thật được trên deploy target Node (Desktop Electron / server-web hiện tại).

---

## ⚠️ Depends on: backend-go task chưa sẵn sàng — CHƯA CÓ CẢ RPC LẪN USECASE (sâu hơn AddEdge/Grant)

Khác với `AddEdge`/`Grant` (có ở gRPC, chỉ thiếu wscompat), `AddComment`/`ListComments` **không tồn
tại ở bất kỳ tầng nào của backend-go**. Xác nhận trực tiếp:

- `task.addComment` chỉ tồn tại ở Node (`desktop/src/main/task/task-rpc-handler.ts:304`,
  `backend/src/main/task/task-rpc-handler.ts:304`).
- Đọc toàn bộ `backend-go/proto/orca/task/v1/task.proto`'s `service TaskService` (dòng 13-47):
  **0 RPC nào tên `AddComment`/`ListComments`**.
- Khớp `BUG-TASKV1-001`: bảng `task.task_comments` tồn tại (RLS enabled) nhưng **0 dòng Go code
  nào tham chiếu tới nó** — có schema, không có RPC, không có usecase.

**Depends on: backend-go task (chưa track ở `specs/backend-go/bugs/task-v1` tại thời điểm viết task
này — cần: (1) thêm `rpc AddComment`/`rpc ListComments` vào `task.proto`; (2) thêm usecase +
repository method đọc/ghi bảng `task.task_comments`; (3) wire 2 RPC này vào wscompat theo pattern
các channel `task.*` khác).** Task frontend này chỉ làm được phần UI + hook, với gate `isSupported`
tự ẩn khi RPC không tồn tại (đúng như deploy target `backend-go`/`deploy/dev` hôm nay) — **không**
implement RPC nào ở backend-go trong phạm vi task này.

---

## Phát hiện quan trọng khi viết task này — sửa lại shape `TaskComment` trong SOL-FE-TASKV1-004

Solution gốc viết component dùng `c.authorId`/`c.body`, nhưng **`TaskComment` type ĐÃ tồn tại**
ở `frontend/src/shared/task-types.ts:99-106` với field khác:

```typescript
export type TaskComment = {
  id: number
  taskId: string
  userId: string        // KHÔNG phải authorId
  content: string        // KHÔNG phải body
  type: 'comment' | 'activity'
  createdAt: Date
}
```

Dùng đúng field thật (`userId`, `content`) — không tự đặt tên khác (`authorId`/`body`) cho cùng 1
type đã có sẵn, tránh tạo thêm 1 lớp lệch shape mới giữa các phần code khác nhau trong cùng
codebase (đúng tinh thần BUG-FE-TASKV1-008 đang cảnh báo).

## Context

Đọc trước:
- `frontend/src/shared/task-types.ts:99-106` — `TaskComment` type thật.
- `frontend/src/renderer/src/components/task/TaskDetail.tsx:30-35, 108-113, 175-177` — nơi thêm tab thứ 4.
- `frontend/src/renderer/src/runtime/runtime-rpc-client.ts` — `callRuntimeRpc`/`getActiveRuntimeTarget`.

## Thay đổi cần thực hiện

### 1. File mới — `frontend/src/renderer/src/hooks/useTaskComments.ts`

```typescript
import { useState, useEffect } from 'react'
import { useAppStore } from '../store'
import { callRuntimeRpc, getActiveRuntimeTarget } from '../runtime/runtime-rpc-client'
import type { TaskComment } from '../../../shared/task-types'

// isSupported feature-detect: gọi thử task.listComments khi mount, bắt lỗi "method not
// found" — cách chắc chắn hơn (RPC capability-probe chung) là ngoài phạm vi task này.
export function useTaskComments(taskId: string) {
  const [comments, setComments] = useState<TaskComment[]>([])
  const [isSupported, setIsSupported] = useState(true) // optimistic, hạ false nếu list lỗi

  useEffect(() => {
    const target = getActiveRuntimeTarget(useAppStore.getState().settings)
    callRuntimeRpc<{ comments: TaskComment[] }>(target, 'task.listComments', { taskId })
      .then(r => setComments(r.comments ?? []))
      .catch(() => setIsSupported(false))
  }, [taskId])

  const addComment = async (content: string) => {
    const target = getActiveRuntimeTarget(useAppStore.getState().settings)
    const created = await callRuntimeRpc<TaskComment>(target, 'task.addComment', { taskId, content })
    setComments(prev => [...prev, created])
  }

  return { comments, addComment, isSupported }
}
```

> [!IMPORTANT]
> Trước khi implement, xác nhận Node's `task-rpc-handler.ts` có RPC đọc tương ứng — bug gốc chỉ
> audit `addComment`, chưa xác nhận tên RPC đọc thật (`task.listComments`? `task.getComments`?).
> Nếu Node cũng chưa có RPC đọc, đây là phần cần bổ sung ở Node trước — ngoài phạm vi task này,
> báo cáo riêng thay vì đoán tên RPC.

### 2. File mới — `frontend/src/renderer/src/components/task/TaskComments.tsx`

```tsx
import { useState } from 'react'
import { useTaskComments } from '../../hooks/useTaskComments'
import { Input } from '../ui/input'
import { Button } from '../ui/button'

export function TaskComments({ taskId }: { taskId: string }) {
  const { comments, addComment, isSupported } = useTaskComments(taskId)
  const [text, setText] = useState('')

  if (!isSupported) {
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
            <span className="font-medium">{c.userId}</span>
            <p>{c.content}</p>
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

### 3. `TaskDetail.tsx` — thêm tab "Comments"

```tsx
const [activeTab, setActiveTab] = useState<'details' | 'subtasks' | 'ai' | 'comments'>('details')
// (nếu TASK-FE-TASKV1-06 đã merge trước, union type sẽ có cả 'access' — 5 tab tổng)

<TabsTrigger value="comments">Comments</TabsTrigger>
...
<TabsContent value="comments">
  <TaskComments taskId={task.id} />
</TabsContent>
```

## Verify

```bash
pnpm --filter frontend tsc --noEmit
pnpm --filter frontend test -- TaskComments useTaskComments TaskDetail
```

Kiểm tra thủ công trên `deploy/dev` (backend-go): tab Comments hiện thông báo "chưa khả dụng"
(đúng kỳ vọng, không phải lỗi). Trên Node deploy target: cần xác nhận `task.listComments` tồn tại
thật trước khi coi task hoàn thành đầy đủ.

## Definition of Done

- [ ] `useTaskComments.ts`/`TaskComments.tsx` dùng đúng field `TaskComment` thật (`userId`, `content` — không tự đặt `authorId`/`body`)
- [ ] `isSupported` tự ẩn UI khi RPC không tồn tại (đúng cho `backend-go` hôm nay)
- [ ] Tab "Comments" thêm vào `TaskDetail.tsx`
- [ ] Đã xác nhận (hoặc ghi rõ chưa xác nhận được) tên RPC đọc thật ở Node trước khi merge
- [ ] PR ghi rõ: tính năng chỉ chạy thật trên Node; trên `backend-go` sẽ luôn hiện "chưa khả dụng" cho tới khi có 3 việc backend-go liệt kê ở "Depends on" (chưa có task backend-go riêng track)
- [ ] `pnpm tsc --noEmit` sạch
