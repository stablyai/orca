# TASK-FE-TASKV1-05 — Sửa type `TaskGrantLevel` khớp `GrantLevel` thật + hook `useTaskPermission`

**Solution:** [SOL-FE-TASKV1-003](../solutions/SOL-FE-TASKV1-003-access-control-va-share-link-khong-dung.md) (mục 1-2)
**Bug:** [BUG-FE-TASKV1-003](../BUG-FE-TASKV1-003-access-control-va-share-link-khong-dung.md)
**File:** `frontend/src/shared/task-types.ts`, `frontend/src/renderer/src/hooks/useTaskPermission.ts` (mới)
**Estimated:** 45 phút
**Status:** [ ] TODO
**Phụ thuộc:** Không (đứng trước [TASK-FE-TASKV1-06](./TASK-FE-TASKV1-06-task-access-panel-and-execute-gate.md), task đó cần type + hook này)

---

## Phát hiện quan trọng khi viết task này — sửa lại thiết kế của SOL-FE-TASKV1-003

### 1. `TaskGrantLevel` ĐÃ TỒN TẠI — nhưng trỏ sai model

SOL-FE-TASKV1-003 mục 1 đề xuất *"thêm mới `TaskGrantLevel`"*. Đọc trực tiếp
`frontend/src/shared/task-types.ts:137`:

```typescript
/** Alias for TaskPermission — used by TaskGrantService API (TDD-18) */
export type TaskGrantLevel = TaskPermission
```

Type này **đã tồn tại**, nhưng là alias sai của `TaskPermission` (action scale:
`view/comment/edit/execute/manage`) — đúng loại lệch mà chính solution gốc mô tả (action scale vs
grantee-kind scale). Không thể "thêm mới" 1 type trùng tên — phải **sửa lại định nghĩa dòng 137
này** để khớp `GrantLevel` thật (`owner/admin/user/team/company`), không tạo tên khác.

`grep -rn "TaskGrantLevel" frontend/src` xác nhận **type này chưa được dùng ở bất kỳ đâu khác**
trong codebase ngoài định nghĩa của chính nó — an toàn để đổi nghĩa hoàn toàn, không có consumer
nào bị breaking change.

### 2. `currentUserId` không tồn tại trong store — field thật là `currentUser: OrcaUser | null`

SOL-FE-TASKV1-003 mục 2-3 giả định `useAppStore(s => s.currentUserId)`. Đọc
`frontend/src/renderer/src/store/slices/auth.ts:9-16,27`: store có `currentUser: OrcaUser | null`
(`OrcaUser.id: string`), **không có field `currentUserId`**. Dùng
`useAppStore(s => s.currentUser?.id)` ở nơi cần.

---

## Context

Đọc trước:
- `frontend/src/shared/task-types.ts:29-32, 117-124, 136-137` — `TaskPermission`, `TASK_PERMISSION_ORDER`, `TaskGrantLevel` (định nghĩa sai hiện tại).
- `backend-go/proto/orca/task/v1/task.proto:92-99, 113-120` — `GrantLevel` enum thật, `ResolvePermissionResponse.effective_level`.
- `frontend/src/renderer/src/store/slices/auth.ts:9-16` — `OrcaUser` type thật.
- `frontend/src/renderer/src/runtime/runtime-rpc-client.ts` — `callRuntimeRpc`/`getActiveRuntimeTarget` (đã dùng ở nhiều hook khác trong `task/`).

## Thay đổi cần thực hiện

### 1. `frontend/src/shared/task-types.ts` — sửa dòng 136-137

```typescript
// Before
/** Alias for TaskPermission — used by TaskGrantService API (TDD-18) */
export type TaskGrantLevel = TaskPermission

// After
// Grantee-kind scale thật của backend-go's `GrantLevel` (task.proto:92-99) — KHÁC
// TaskPermission (action scale) ở trên. TaskPermission tài liệu hoá ý định thiết kế
// ban đầu (BL-TG-03) chưa từng được backend-go hiện thực; dùng TaskGrantLevel khi gọi
// task.grant/resolvePermission, KHÔNG dùng TaskPermission cho việc đó (BUG-TASKV1-003).
export type TaskGrantLevel = 'owner' | 'admin' | 'user' | 'team' | 'company'
```

Giữ nguyên `TaskPermission` — không xoá, một số chỗ khác có thể dùng nó cho mục đích UI-only filter
không liên quan RPC (đã xác nhận: không có consumer nào của `TaskGrantLevel` bị ảnh hưởng, nhưng
`TaskPermission` tự nó vẫn có consumer khác — không đụng vào).

### 2. File mới — `frontend/src/renderer/src/hooks/useTaskPermission.ts`

```typescript
import { useState, useEffect } from 'react'
import { useAppStore } from '../store'
import { callRuntimeRpc, getActiveRuntimeTarget } from '../runtime/runtime-rpc-client'
import type { TaskGrantLevel } from '../../../shared/task-types'

// isSupported: false khi target đang chạy chưa wire task.resolvePermission ở wscompat
// (hôm nay: LUÔN false — task.* channel đã wire chỉ có create/get/execute/list/update/
// delete/getDependencies/aiDecompose/aiApply, xem channels.go + channels_automation_task.go).
// Hook tự phát hiện qua lỗi RPC thay vì hard-code true/false theo deploy target, để tự
// động hết cảnh báo khi backend wire xong mà không cần sửa lại hook này.
export function useTaskPermission(taskId: string, userId: string | undefined) {
  const [level, setLevel] = useState<TaskGrantLevel | null>(null)
  const [isSupported, setIsSupported] = useState(true)

  useEffect(() => {
    if (!userId) return
    const target = getActiveRuntimeTarget(useAppStore.getState().settings)
    callRuntimeRpc<{ effectiveLevel: string }>(target, 'task.resolvePermission', { taskId, userId })
      .then(r => setLevel(r.effectiveLevel.replace('GRANT_LEVEL_', '').toLowerCase() as TaskGrantLevel))
      .catch(() => setIsSupported(false))
  }, [taskId, userId])

  return { level, isSupported }
}
```

> [!IMPORTANT]
> `effective_level` thật trả về dạng enum string proto (`GRANT_LEVEL_OWNER`, ...) khi serialize qua
> JSON mặc định của `encoding/json` cho enum Go — **xác nhận lại giá trị thật khi backend wire
> xong** (có thể là số nguyên `1` thay vì chuỗi nếu wscompat không tự chuyển đổi qua `protojson`;
> theo pattern `dispatchView`/`agentSessionView` ở `channels_orchestration.go`, wscompat trong repo
> này thường tự viết struct chuyển đổi tường minh — task tiếp theo (TASK-06 hoặc lúc backend wire)
> cần đối chiếu lại struct chuyển đổi thật, không giả định `.replace('GRANT_LEVEL_', '')` là đúng
> tuyệt đối cho tới khi thấy code thật).

## Verify

```bash
pnpm --filter frontend tsc --noEmit
grep -rn "TaskGrantLevel" frontend/src
# Chỉ nên thấy: 1 định nghĩa (task-types.ts) + import ở useTaskPermission.ts (và TASK-06 sau này)
pnpm --filter frontend test -- useTaskPermission
```

## Definition of Done

- [ ] `TaskGrantLevel` ở `task-types.ts` đổi thành `'owner' | 'admin' | 'user' | 'team' | 'company'`, không còn alias `TaskPermission`
- [ ] `useTaskPermission.ts` mới, dùng `useAppStore(s => s.currentUser?.id)` pattern đúng (không dùng `currentUserId` không tồn tại)
- [ ] `isSupported` hạ xuống `false` khi RPC lỗi (feature-detect, không hard-code)
- [ ] Test mới: mock RPC thành công → parse đúng `level`; mock RPC lỗi (404/method not found) → `isSupported === false`
- [ ] `pnpm tsc --noEmit` sạch
