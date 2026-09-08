# TASK-FE-TASKV1-10 — `TaskDispatchStatusPanel` gắn vào `TaskDetail`

**Solution:** [SOL-FE-TASKV1-006](../solutions/SOL-FE-TASKV1-006-task-execute-orchestration-ui-khong-ton-tai.md) (mục 2-4)
**Bug:** [BUG-FE-TASKV1-006](../BUG-FE-TASKV1-006-task-execute-orchestration-ui-khong-ton-tai.md)
**File:** `frontend/src/renderer/src/components/task/TaskDispatchStatusPanel.tsx` (mới), `frontend/src/renderer/src/components/task/TaskDetail.tsx`
**Estimated:** 60 phút
**Status:** [ ] TODO
**Phụ thuộc:** [TASK-FE-TASKV1-09](./TASK-FE-TASKV1-09-orchestration-page-rename.md) không bắt buộc (độc lập, có thể làm song song) — nhưng nên xong trước để tránh xung đột tên `Orchestration*` trong cùng PR review.

---

## Xác nhận phạm vi khả thi (đã đúng theo SOL-FE-TASKV1-006, xác nhận lại bằng code thật)

`backend-go/services/api-gateway/internal/adapter/wscompat/channels_orchestration.go` — đọc toàn bộ
file: **`orchestration.dispatchShow`** (gọi `GetDispatchContextForTask`) là channel `orchestration.*`
duy nhất phục vụ 1 task đơn. Panel này CHỈ hiển thị dispatch của ĐÚNG 1 task đang xem — không phải
dashboard nhiều dòng (dữ liệu đó không tồn tại cho tới khi `StartCoordinatorRun` và
`orchestration.messages` reader được xây — xem BUG-TASKV1-005).

## Phát hiện mới khi viết task này (KHÔNG có trong SOL-FE-TASKV1-006 — cập nhật sau khi solution viết)

`channels_orchestration.go` giờ có thêm **`agentSession.listActive`** (gọi
`ListActiveDispatchContextsForUser`) — RPC mà SOL-FE-TASKV1-006 liệt kê là *"có ở gRPC, chưa wire
wscompat"* **đã được wire xong** dưới namespace `agentSession.*` (không phải `orchestration.*` —
đúng lý do solution grep không thấy nó khi chỉ tìm tiền tố `orchestration.`). RPC này trả về
**danh sách TẤT CẢ dispatch đang active của user hiện tại** (`agentSessionView[]`: id,
orchestrationTaskId, assigneeHandle, status, failureCount, lastHeartbeatAt) — khác phạm vi
"1 task" của `dispatchShow`.

**Không bắt buộc trong task này** (giữ đúng phạm vi tối thiểu solution đã chốt), nhưng ghi nhận cơ
hội cải thiện: 1 task riêng sau này có thể thêm 1 panel "My Active Agent Sessions" ở cấp
project/sidebar (không phải trong `TaskDetail` của 1 task) dùng RPC này — nên báo lại cho người
review bug BUG-FE-TASKV1-006 để cân nhắc mở rộng phạm vi, không tự ý làm thêm ở đây.

## Mục tiêu

Thay thế "không có bất kỳ hình thức giám sát nào ngoài đọc log terminal thô" bằng 1 panel nhỏ hiển
thị trạng thái dispatch (nếu có) ngay trong `TaskDetail`.

## Context

Đọc trước:
- `backend-go/services/api-gateway/internal/adapter/wscompat/channels_orchestration.go` (toàn bộ, ~95 dòng) — response shape thật `dispatchView{id, orchestration_task_id, assignee_handle, status}`.
- `frontend/src/renderer/src/components/terminal-pane/terminal-orchestration-task-links.ts:50-70` — `focusRuntimeOrchestrationTask(taskId, runtimeEnvironmentId, focusRendererTerminal?)`, tái dùng nguyên vẹn.
- `frontend/src/renderer/src/runtime/runtime-rpc-client.ts:8` — `RuntimeClientTarget = {kind:'local'} | {kind:'environment', environmentId}`.
- `frontend/src/renderer/src/components/task/TaskDetail.tsx:100-105` — nơi gắn panel, ngay dưới nút Execute.

## Thay đổi cần thực hiện

### 1. File mới — `frontend/src/renderer/src/components/task/TaskDispatchStatusPanel.tsx`

```tsx
import { useState, useEffect } from 'react'
import { useAppStore } from '../../store'
import { callRuntimeRpc, getActiveRuntimeTarget } from '../../runtime/runtime-rpc-client'
import { focusRuntimeOrchestrationTask } from '../terminal-pane/terminal-orchestration-task-links'

type DispatchView = {
  id: string
  orchestration_task_id: string
  assignee_handle: string
  status: string
}

// Chỉ hiển thị dispatch của 1 task — KHÔNG phải danh sách nhiều dispatch/coordinator run
// (dữ liệu đó không tồn tại ở orchestration.* hôm nay, xem BUG-TASKV1-005). Tái sử dụng
// đúng RPC + logic mà terminal-orchestration-task-links.ts đã dùng thật.
export function TaskDispatchStatusPanel({ taskId }: { taskId: string }) {
  const [dispatch, setDispatch] = useState<DispatchView | null | 'not-dispatched'>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    const target = getActiveRuntimeTarget(useAppStore.getState().settings)
    callRuntimeRpc<{ dispatch: DispatchView | null }>(target, 'orchestration.dispatchShow', { task: taskId })
      .then(r => setDispatch(r.dispatch ?? 'not-dispatched'))
      .catch(() => setDispatch('not-dispatched'))
      .finally(() => setLoading(false))
  }, [taskId])

  if (loading) return <div className="text-xs text-muted-foreground p-2">Loading dispatch status…</div>

  if (dispatch === 'not-dispatched') {
    return (
      <div className="text-xs text-muted-foreground p-2" data-testid="task-dispatch-none">
        Task này chưa có dispatch orchestration nào (chưa chạy qua Engine 2, hoặc đang chạy trực
        tiếp qua Engine 1 — xem CR-FLOW-TASK-001).
      </div>
    )
  }

  const focusTerminal = () => {
    // Dùng đúng target đang active (SSH/environment aware) thay vì hard-code null — task
    // đang mở có thể thuộc 1 SSH-hosted environment, không chỉ local (xem AGENTS.md "SSH
    // Use Case").
    const target = getActiveRuntimeTarget(useAppStore.getState().settings)
    const environmentId = target.kind === 'environment' ? target.environmentId : null
    focusRuntimeOrchestrationTask(taskId, environmentId).catch(() => {})
  }

  return (
    <div className="text-xs border rounded p-2 space-y-1" data-testid="task-dispatch-status">
      <div><span className="font-medium">Status:</span> {dispatch.status}</div>
      <div><span className="font-medium">Assignee:</span> {dispatch.assignee_handle || '—'}</div>
      {dispatch.assignee_handle && (
        <button className="text-blue-600 underline" onClick={focusTerminal} data-testid="task-dispatch-focus-terminal">
          Focus terminal đang chạy dispatch này
        </button>
      )}
    </div>
  )
}
```

> [!IMPORTANT]
> Khác bản gốc trong SOL-FE-TASKV1-006 (gọi `focusRuntimeOrchestrationTask(taskId, null)` cứng),
> task này derive `environmentId` thật từ `getActiveRuntimeTarget()` — theo đúng yêu cầu SSH Use
> Case ở `AGENTS.md`. Hard-code `null` sẽ luôn ép về `{kind: 'local'}`, sai khi user đang làm việc
> trên 1 SSH-hosted environment.

### 2. `TaskDetail.tsx` — gắn panel dưới nút Execute (dòng 100-105)

```tsx
<div className="flex gap-2 mt-2">
  {canExecute && ( {/* nếu TASK-FE-TASKV1-06 đã merge trước; nếu chưa, giữ nguyên không điều kiện */}
    <Button variant="default" onClick={handleRunAgent} data-testid="run-agent-btn">
      ▶ Execute with Agent
    </Button>
  )}
</div>
<TaskDispatchStatusPanel taskId={task.id} />
```

## Verify

```bash
pnpm --filter frontend tsc --noEmit
pnpm --filter frontend test -- TaskDispatchStatusPanel TaskDetail
```

Kiểm tra thủ công: mở 1 task chưa từng dispatch → thấy "chưa có dispatch nào"; mở 1 task đã dispatch
qua orchestration-service thật → thấy status/assignee đúng, bấm "Focus terminal" điều hướng đúng.

## Definition of Done

- [ ] `TaskDispatchStatusPanel.tsx` mới, dùng đúng response shape thật (`assignee_handle`, `status`)
- [ ] Gắn vào `TaskDetail.tsx` ngay dưới nút Execute
- [ ] `focusRuntimeOrchestrationTask` gọi với `environmentId` thật (không hard-code `null`) — SSH-aware
- [ ] Không implement lại `terminal-orchestration-task-links.ts` — import và dùng nguyên vẹn
- [ ] PR ghi chú phát hiện `agentSession.listActive` đã wire (cơ hội mở rộng tương lai, không làm trong task này)
- [ ] `pnpm tsc --noEmit` sạch
