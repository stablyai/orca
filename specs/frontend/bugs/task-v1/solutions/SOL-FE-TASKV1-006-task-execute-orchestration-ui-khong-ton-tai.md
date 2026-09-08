# SOL-FE-TASKV1-006 — Task Execute/Orchestration (Engine 2): UI tối thiểu thay cho storyboard giả

**Bug:** [BUG-FE-TASKV1-006](../BUG-FE-TASKV1-006-task-execute-orchestration-ui-khong-ton-tai.md)
**Loại giải pháp:** B — Full design tối thiểu (KHÔNG thiết kế lại toàn bộ TaskRow/dashboard — backend RPC chưa đủ)
**Status:** 📋 Proposed — chưa triển khai

---

## Xác nhận lại RPC surface trước khi thiết kế (quyết định phạm vi)

Theo yêu cầu: dùng RPC đã xác nhận hoạt động (`orchestration.dispatchShow`),
không thiết kế lại toàn bộ dashboard vì backend thiếu RPC. Xác nhận lại bằng
đọc trực tiếp:

- `backend-go/services/api-gateway/internal/adapter/wscompat/channels_orchestration.go` —
  **chỉ có đúng 1 channel wire**: `orchestration.dispatchShow` (gọi
  `GetDispatchContextForTask`). Không có `list`/`create`/`resolve gate`/bất
  kỳ channel `orchestration.*` nào khác lộ ra cho frontend.
- Response shape thật của `orchestration.dispatchShow` (đọc
  `channels_orchestration.go:14-21`):
  ```typescript
  type DispatchView = {
    id: string
    orchestration_task_id: string
    assignee_handle: string
    status: string
  }
  ```
- [BUG-TASKV1-005](../../../../backend-go/bugs/task-v1/BUG-TASKV1-005-task-execute-orchestration-coordinator-not-autonomous.md)
  xác nhận: không có `StartCoordinatorRun`, không có background loop, không
  có `ListPendingDecisionGates`, `orchestration.messages` chết hoàn toàn. Kể
  cả nếu wire thêm `ListActiveDispatchContextsForUser` (đã có ở gRPC, chưa
  wscompat) thì cũng **không có gì để "list" ra nhiều dòng có ý nghĩa** —
  không có coordinator run nào tồn tại để liệt kê, vì không RPC nào tạo ra
  nó (`StartCoordinatorRun` không tồn tại).

**Kết luận về phạm vi:** không thể xây "TaskRow list dashboard" (nhiều dòng
dispatch, message log giữa coordinator/agent) như đề xuất #2 gốc mong muốn —
dữ liệu đó không tồn tại ở backend. Phạm vi khả thi hôm nay: **1 panel hiển
thị trạng thái dispatch của ĐÚNG 1 task đang xem**, dùng lại đúng RPC mà
`terminal-orchestration-task-links.ts` đã dùng thật.

## Thiết kế

### 1. Đổi tên `OrchestrationPage.tsx` — trả về đúng tên gọi nó là gì (đề xuất #1 gốc)

```
frontend/src/renderer/src/components/feature-wall/agents-orchestration/OrchestrationPage.tsx
  → OrchestrationStoryboard.tsx (RENAME)
```

Cập nhật mọi import chỗ gọi component này theo tên mới. Đây là rename an
toàn, không đổi hành vi — chỉ giảm rủi ro hiểu nhầm đã ghi trong bug gốc
("Rủi ro hiểu nhầm cao trong nội bộ team").

### 2. Component mới — `TaskDispatchStatusPanel.tsx` (panel nhỏ, KHÔNG phải dashboard)

```tsx
// frontend/src/renderer/src/components/task/TaskDispatchStatusPanel.tsx (MỚI)
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

// Chỉ hiển thị dispatch của 1 task — KHÔNG phải danh sách nhiều dispatch/coordinator
// run (dữ liệu đó không tồn tại ở backend hôm nay, xem BUG-TASKV1-005). Tái sử dụng
// đúng RPC + logic mà terminal-orchestration-task-links.ts đã dùng thật (không viết
// lại phần "focus terminal" — chỉ thêm phần hiển thị mà chỗ đó chưa làm).
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
        Task này chưa có dispatch orchestration nào (chưa chạy qua Engine 2,
        hoặc đang chạy trực tiếp qua Engine 1 — xem CR-FLOW-TASK-001).
      </div>
    )
  }

  return (
    <div className="text-xs border rounded p-2 space-y-1" data-testid="task-dispatch-status">
      <div><span className="font-medium">Status:</span> {dispatch.status}</div>
      <div><span className="font-medium">Assignee:</span> {dispatch.assignee_handle || '—'}</div>
      {dispatch.assignee_handle && (
        <button
          className="text-blue-600 underline"
          onClick={() => focusRuntimeOrchestrationTask(taskId, null)}
          data-testid="task-dispatch-focus-terminal"
        >
          Focus terminal đang chạy dispatch này
        </button>
      )}
    </div>
  )
}
```

### 3. Gắn panel vào `TaskDetail.tsx`

```tsx
// TaskDetail.tsx — hiển thị ngay dưới nút "Execute with Agent", không cần tab riêng
// (khác Comments/Access — đây là trạng thái đọc-only, hợp lý đặt luôn ở header)
<div className="flex gap-2 mt-2">
  <Button variant="default" onClick={handleRunAgent} data-testid="run-agent-btn">
    ▶ Execute with Agent
  </Button>
</div>
<TaskDispatchStatusPanel taskId={task.id} />
```

Đây thay thế đúng phần "không có bất kỳ hình thức giám sát nào ngoài đọc log
terminal thô" mà bug gốc mô tả — user giờ thấy trạng thái dispatch ngay
trong `TaskDetail`, không cần chủ động tìm `task_xxxx` token trong terminal
log rồi click.

### 4. Giữ nguyên `terminal-orchestration-task-links.ts` (đề xuất #3 gốc)

Không sửa file này — tái sử dụng `focusRuntimeOrchestrationTask` y nguyên
(đã import ở bước 2), đúng khuyến nghị gốc *"tái sử dụng cùng RPC làm nền
cho dashboard mới thay vì viết lại từ đầu"*.

## Việc KHÔNG làm trong solution này — cần backend trước (ghi rõ theo yêu cầu)

Toàn bộ phần "dashboard thật" theo đúng tinh thần đề xuất #2 gốc (danh sách
dispatch đang chạy, message log coordinator/agent, huỷ/retry dispatch)
**chặn cứng** trên các RPC chưa tồn tại ở `orchestration-service`, theo
[BUG-TASKV1-005](../../../../backend-go/bugs/task-v1/BUG-TASKV1-005-task-execute-orchestration-coordinator-not-autonomous.md):

| Tính năng dashboard mong muốn | RPC cần | Trạng thái |
|---|---|---|
| Danh sách dispatch đang chạy (nhiều dòng) | `ListActiveDispatchContextsForUser` | Có ở gRPC, **chưa wire wscompat** |
| Coordinator run nào đang tồn tại | `StartCoordinatorRun`/`GetCoordinatorRun` | **Không tồn tại** ở proto |
| Message log coordinator ↔ agent | Đọc `orchestration.messages` | **0 RPC nào** đọc bảng này |
| Huỷ 1 dispatch | (không có RPC cancel) | **Không tồn tại** |
| Retry 1 dispatch | (không có RPC retry) | **Không tồn tại** |
| Heartbeat / tiến trình theo thời gian thực | `RecordHeartbeat` | **Không tồn tại** ở proto |

Khi các RPC trên lần lượt được xây (theo dõi tiến độ ở
`specs/backend-go/bugs/task-v1/BUG-TASKV1-005...`), mở rộng
`TaskDispatchStatusPanel` này thành 1 dashboard đầy đủ hơn — không cần viết
lại từ đầu, vì cấu trúc panel (fetch theo taskId, hiển thị theo `DispatchView`)
đã đúng hướng, chỉ cần thêm biến thể "list" khi RPC list tồn tại.

## Files cần sửa

| File | Action |
|------|--------|
| `frontend/src/renderer/src/components/feature-wall/agents-orchestration/OrchestrationPage.tsx` | RENAME → `OrchestrationStoryboard.tsx` + cập nhật import |
| `frontend/src/renderer/src/components/task/TaskDispatchStatusPanel.tsx` | NEW |
| `frontend/src/renderer/src/components/task/TaskDetail.tsx` | MODIFY — gắn `TaskDispatchStatusPanel` dưới nút Execute |

## Tham khảo

- [BUG-TASKV1-005](../../../../backend-go/bugs/task-v1/BUG-TASKV1-005-task-execute-orchestration-coordinator-not-autonomous.md) — bảng đối chiếu 11 RPC TDD-sketched vs 7 RPC thật
- `frontend/src/renderer/src/components/terminal-pane/terminal-orchestration-task-links.ts` — RPC/logic tái sử dụng nguyên vẹn
- Không nhầm với `specs/frontend/bugs/agent-orchestration/BUG-FE-ORCH-001-no-ipc-bridge-agent-start-stop-resume.md` (Agent Orchestration, khác Task Execute/Orchestration-service)
