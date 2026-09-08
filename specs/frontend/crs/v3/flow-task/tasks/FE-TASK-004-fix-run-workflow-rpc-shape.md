# FE-TASK-004: Sửa `useWorkflow.ts`'s `runWorkflow()` đúng shape `workflow.execute` thật

**Domain:** flow-task
**Solution Ref:** FE-SOL-001 Phần 4 (nửa đầu — `runWorkflow`)
**Priority:** 🟠 P1
**Estimated:** 40 phút
**Status:** [ ] TODO

---

## Mục tiêu

`useWorkflow.ts`'s `runWorkflow()` (`frontend/src/renderer/src/hooks/useWorkflow.ts:75-99`) hiện
gửi:

```typescript
// dòng 82 — SAI, không khớp bất kỳ backend nào đang tồn tại thật
const result = await callRuntimeRpc<{ id: string }>(target, 'workflow.execute', { templateId, inputs, traceId: span.id })
```

Đọc thật `backend-go`'s `workflow.execute` handler
(`backend-go/services/api-gateway/internal/adapter/wscompat/channels_workflow.go:47-67`) xác nhận
`executeArgs` struct chỉ nhận đúng 4 field, **tên khác hẳn** và **không có `inputs`**:

```go
// channels_workflow.go:48-53 — shape THẬT
type executeArgs struct {
    TemplateID  string `json:"templateId"`
    ProjectID   string `json:"projectId"`
    RootTraceID string `json:"rootTraceId"`   // KHÔNG PHẢI `traceId`
    RequestID   string `json:"requestId"`      // idempotency key
}
```

`ExecuteRequest` proto (`backend-go/proto/orca/workflow/v1/workflow.proto:84-89`) xác nhận
`workflow-service` cũng không có field `inputs` — engine hiện tại không hỗ trợ truyền input
runtime vào execution qua RPC này.

## Files cần sửa

| File | Action |
|------|--------|
| `frontend/src/renderer/src/hooks/useWorkflow.ts` | MODIFY — `runWorkflow()`, dòng 75-99 |
| `frontend/src/renderer/src/components/workflow/WorkflowBuilder.tsx` | MODIFY — call site dòng 11/35, đổi chữ ký gọi |
| `frontend/src/renderer/src/hooks/__tests__/useWorkflow.test.ts` | MODIFY — case `runWorkflow` dòng 120-140, 142-156, 158-177 |

## Các bước thực thi

### 1. Sửa `runWorkflow()` (`useWorkflow.ts:75-99`)

Chữ ký đổi từ `(inputs?: Record<string, unknown>)` sang nhận `projectId` (backend không có chỗ
nhận `inputs` nên bỏ tham số này luôn, không giữ lại gây hiểu nhầm):

```typescript
const runWorkflow = useCallback(async (projectId: string) => {
  if (!templateId) { toast.error('Save workflow first'); return null }
  const target = getActiveRuntimeTarget(useAppStore.getState().settings)
  const span = Tracers.uiWorkflowExecuteFlow.start({ templateId })
  try {
    // Shape thật channels_workflow.go:48-53 — `requestId` dùng span.id làm idempotency
    // key (1 lần bấm Run = 1 request-id, cùng convention `task.execute`'s `requestId`,
    // channels_automation_task.go:226).
    const result = await callRuntimeRpc<{ id: string; status: string }>(target, 'workflow.execute', {
      templateId,
      projectId,
      rootTraceId: span.id,
      requestId: span.id,
    })
    useAppStore.getState().addExecution({
      id: result.id, templateId, status: 'running', startedAt: Date.now(),
      triggeredBy: 'me', definition: local as WorkflowDefinition, rootTraceId: span.id,
    })
    span.ok({ executionId: result.id })
    toast.success('Workflow started')
    return result.id
  } catch (err) {
    span.fail(err, { templateId })
    toast.error('Failed to start workflow')
    return null
  }
}, [templateId, local])
```

### 2. Cập nhật call site `WorkflowBuilder.tsx`

**Xác nhận đã đọc code thật:** `WorkflowBuilder.tsx` hiện **không có `project`/`projectId` nào
trong scope** (`WorkflowBuilder({ templateId }: { templateId?: string })`, dòng 10) — chỉ nhận
`templateId`. Cũng xác nhận **`WorkflowBuilder` hiện không được mount ở bất kỳ đâu trong app thật**
(`grep -rln "WorkflowBuilder" frontend/src` chỉ ra chính file + file test của nó, không có màn
hình nào import/render nó) — đây là 1 orphan component hôm nay, nên đổi chữ ký ở đây không phá
route thật nào, nhưng vẫn cần sửa để component tự nó không giữ 1 lời gọi RPC sai:

```tsx
// dòng 10 — thêm prop projectId (optional, fallback rỗng để không phá test hiện tại
// vốn không truyền prop này — WorkflowBuilder.test.tsx mock toàn bộ useWorkflow nên
// không assert tham số gọi runWorkflow)
export function WorkflowBuilder({ templateId, projectId }: { templateId?: string; projectId?: string }) {
  const { template, addStep, removeStep, updateStep, updateTemplate, saveTemplate, runWorkflow } = useWorkflow(templateId)
  // ...
  <Button size="sm" onClick={() => runWorkflow(projectId ?? '')} data-testid="run-workflow-btn">Run</Button>
```

Khi 1 màn hình thật render `WorkflowBuilder` (ngoài phạm vi task này), phải truyền `projectId` từ
`WorkspaceContext` — ghi lại thành 1 task/TODO riêng nếu route đó xuất hiện.

### 3. Cập nhật `useWorkflow.test.ts`

Case `runWorkflow(templateId) calls workflow.execute...` (dòng 120-140) đổi assertion:

```typescript
// Trước: expect(mockRpc).toHaveBeenCalledWith('mock-target', 'workflow.execute', { templateId: 't1', inputs: { foo: 'bar' }, traceId: startEvent?.id })
// Sau:
execId = await result.current.runWorkflow('proj-1')
expect(mockRpc).toHaveBeenCalledWith('mock-target', 'workflow.execute', {
  templateId: 't1', projectId: 'proj-1', rootTraceId: startEvent?.id, requestId: startEvent?.id
})
```

Case `runWorkflow without templateId` (dòng 142-156) và `runWorkflow RPC error` (dòng 158-177) chỉ
cần đổi call site `result.current.runWorkflow()` → `result.current.runWorkflow('proj-1')` (hoặc
chuỗi bất kỳ), không đổi phần assert còn lại.

## Giới hạn đã biết (không phải hard blocker — backend đã có sẵn shape đúng)

- `inputs` bị bỏ hoàn toàn khỏi `runWorkflow` — không có cách nào truyền input runtime vào 1
  execution qua RPC `workflow.execute` hôm nay. Nếu cần, phải thêm field ở
  `workflow.proto`'s `ExecuteRequest` trước (việc backend, ngoài phạm vi task này).
- Không sửa `WorkflowBuilder.tsx`/`StepEditor.tsx`/`DAGPreview.tsx` nào khác ngoài call site
  `runWorkflow` — theo đúng phạm vi CR-FLOW-TASK-005 mục 3 (chỉ chốt sửa `useWorkflow.ts`).

## Verify

```bash
cd frontend && npx vitest run \
  src/renderer/src/hooks/__tests__/useWorkflow.test.ts \
  src/renderer/src/components/workflow/__tests__/WorkflowBuilder.test.tsx
cd frontend && npx tsc --noEmit -p .
```

## gitnexus

Chạy trước khi sửa (bắt buộc theo CLAUDE.md):
```
impact({target: "useWorkflow", direction: "upstream"})
impact({target: "runWorkflow", direction: "upstream"})
```
Kỳ vọng caller `WorkflowBuilder.tsx` xuất hiện (đúng dự kiến, đã cập nhật ở task này) — nếu
`useWorkflowExecution.ts`/`ExecutionMonitor.tsx` cũng xuất hiện, xác nhận chúng KHÔNG gọi
`runWorkflow` (chỉ gọi `workflow.getExecution`/`workflow.cancel`, hàm khác) trước khi kết luận an
toàn. Dán risk level thật vào PR.

## Depends on
Không có

## Blocking
Không có (FE-TASK-005 sửa cùng file `useWorkflow.ts` nhưng hàm khác — khuyến nghị làm nối tiếp để
tránh conflict merge, không phải phụ thuộc chức năng)
