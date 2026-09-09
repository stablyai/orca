# FE-SOL-002: Consume live execution events (subscription, polling as fallback)

> **📋 Proposed — chưa triển khai, blocked on backend.** Đọc code frontend
> thật tại thời điểm viết (2026-09-09).

## CR Reference

- **CR:** [CR-WF-007](../../../../../../docs/crs/v4/workflow/CR-WF-007-execution-live-streaming.md) (frontend portion — backend portion là [BE-SOL-006](../../../../../backend-go/crs/v4/workflow/solutions/BE-SOL-006-execution-live-streaming.md))
- **Phụ thuộc cứng:** [BE-SOL-006](../../../../../backend-go/crs/v4/workflow/solutions/BE-SOL-006-execution-live-streaming.md), qua đó phụ thuộc [`CR-FLOW-TASK-003`](../../../../../../docs/crs/v3/flow-task/CR-FLOW-TASK-003-unified-task-activity-event-catalog.md) — không build trước khi kênh event tồn tại

## Current state

`useWorkflowExecution.ts` poll `workflow.getExecution` mỗi 4 giây — tự
comment nhận đây là "interim, pre-Phase-D stopgap" thay cho 1 cầu nối
`window.api.on(...)` từng bị hỏng (no-op trên Web mode). `ExecutionMonitor.tsx`'s
`streamingOutput` (destructured từ hook, dòng 7) hiện luôn rỗng trong thực
tế — dead code path chờ nguồn dữ liệu chưa từng tồn tại.

## Design

```tsx
// useWorkflowExecution.ts
useEffect(() => {
  const channel = execution?.originTaskId
    ? `task.activity:${execution.originTaskId}`
    : `workflow.activity:${executionId}` // BE-SOL-006's fallback channel cho execution không qua Task
  const unsub = subscribeRuntimeEvent(target, channel, (frame) => {
    dispatch({ type: 'step-update', frame })
  })
  return unsub
}, [executionId, execution?.originTaskId])

// Giữ nguyên polling 4s làm fallback — không xoá, chỉ hạ ưu tiên khi subscription hoạt động
```

`ExecutionMonitor.tsx` không cần đổi UI — `streamingOutput` nay có nguồn dữ
liệu thật thay vì dead code path; chỉ cần xác nhận `groupStepsByWave` phản
ứng đúng với update từ subscription giống như update từ poll hiện tại
(cùng 1 reducer, khác nguồn trigger).

## Not in scope

- Backend event schema — dùng nguyên của CR-FLOW-TASK-003/BE-SOL-006, không thiết kế lại.
- Continuous stdout streaming — task-graph series' [SOL-AG-TG-002](../../../../../agent/crs/v4/task-graph/solutions/SOL-AG-TG-002-agent-chunk-streaming.md), khác phạm vi.

## Test plan

- Execution có `originTaskId` → nhận event qua `task.activity:{taskId}`;
  không có → qua `workflow.activity:{executionId}`.
- Tắt subscription giả lập (Web mode không có WS) → polling 4s vẫn hoạt động bình thường.
- Không duplicate update khi cả subscription và poll cùng trả về cùng 1 step.

## References

- [CR-WF-007](../../../../../../docs/crs/v4/workflow/CR-WF-007-execution-live-streaming.md)
- `frontend/src/renderer/src/hooks/useWorkflowExecution.ts`
