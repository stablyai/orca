# FE-TASK-003: Thêm `'paused'` vào `WorkflowExecutionStatus` + nút Pause/Resume

**Domain:** workflow
**Solution Ref:** FE-SOL-001 Phần 3
**Priority:** 🟠 P1
**Estimated:** 45 phút
**Status:** ✅ DONE — 2026-09-09

### Kết quả thực tế

Làm đúng thứ tự bước 1 (đổi type) trước bước 2-4, đúng file `shared/workflow-types.ts` (không
đụng file trùng tên ở `renderer/src/types/`):

- `WorkflowExecutionStatus` thêm `'paused'`.
- `useWorkflowExecution.ts` thêm `pauseExecution`/`resumeExecution`, cả 2 tự
  `updateExecutionStatus` optimistic ngay sau RPC thành công (đúng pattern `cancelExecution`) —
  vá đúng lỗ hổng polling-kẹt-sau-resume task đã flag. Thêm `toast.error` khi RPC lỗi (import
  `sonner`, trước đây file chưa có).
- `ExecutionMonitor.tsx` thêm nút Pause (khi `running`) / Resume (khi `paused`), giữ Cancel chỉ
  hiện khi `running` đúng như task chỉ định.
- `WorkflowMonitor.tsx`'s `STATUS_LABEL` thêm `paused: 'Paused'`.
- **Gap phát sinh ngoài "Files cần sửa" của task, nhưng là hệ quả bắt buộc của bước 1**:
  `StepStatusBadge.tsx`'s `STEP_STATUS` map (kiểu `Record<BadgeStatus, ...>` với
  `BadgeStatus = StepStatus | WorkflowExecutionStatus`) cũng exhaustive trên
  `WorkflowExecutionStatus` — thêm `'paused'` vào union làm `ExecutionMonitor.tsx`'s
  `<StepStatusBadge status={execution.status} />` crash thật khi `status==='paused'` (`Cannot
  destructure property 'icon' of undefined`, xác nhận bằng test thất bại thật, không phải suy
  đoán). Vá bằng cách thêm entry `paused` vào `STEP_STATUS` (icon `Pause` từ lucide-react, màu
  `text-amber-500` — theo đúng convention màu Tailwind thô đã dùng sẵn trong file, không phải
  token `main.css`). Đã chạy `impact({target:"StepStatusBadge"})` trước khi sửa — risk LOW.
- Test: cập nhật `useWorkflowExecution.test.ts` (thêm 4 case pause/resume + 1 case xác nhận resume
  làm polling restart thật bằng `vi.useFakeTimers`), `ExecutionMonitor.test.tsx` (4 case mới),
  thêm 2 case vào `StepStatusBadge.test.tsx` cho `'paused'`. 37/37 pass.
- `npx tsc --noEmit -p .`: không có lỗi mới ngoài lỗi `@shared/workflow-types` tiền tồn tại (xem
  ghi chú ở FE-TASK-001).
- `detect_changes()`: không có execution flow Workflow nào bị ảnh hưởng xấu.

Không có gap chưa xử lý — cả phần type, RPC, UI, và regression phát sinh từ `StepStatusBadge` đều
đã vá và có test.

---

## Mục tiêu

Backend-go's `domain.WorkflowExecution.Status` đã có giá trị `paused`
(`specs/backend-go/tdd/services/workflow-service.md` §4:
*"`pending|running|paused|completed|failed|cancelled`"*, và `workflow.proto:94` comment xác nhận
`status` field: *"pending|running|paused|completed|failed|cancelled"*) — RPC `workflow.pause`/
`workflow.resume` **đã tồn tại thật** ở wscompat. Nhưng frontend's `WorkflowExecutionStatus` type
**thiếu hẳn `'paused'`**, và không có nút Pause/Resume nào ở `ExecutionMonitor.tsx`. **Bước 1 (đổi
type) phải làm TRƯỚC bước 2 (thêm nút)** — đây không phải 2 việc độc lập, thêm nút trước khi type
hỗ trợ `'paused'` sẽ gây lỗi TypeScript ở so sánh `execution.status === 'paused'`.

## Xác nhận đã đọc code thật trước khi viết task (2026-09-09)

- ⚠️ **Phát hiện quan trọng, KHÔNG có trong FE-SOL-001**: có **2 file `workflow-types.ts` riêng biệt**
  trong frontend, không phải 1:
  - `frontend/src/shared/workflow-types.ts` — file **THẬT SỰ được dùng** bởi
    `useWorkflowExecution.ts`, `useWorkflow.ts`, `ExecutionMonitor.tsx`, `WorkflowMonitor.tsx`,
    `StepStatusBadge.tsx`, `StepList.tsx`, `store/slices/workflow.ts` (xác nhận
    `grep -rln "@shared/workflow-types\|shared/workflow-types'" frontend/src` → 7 file, tất cả
    component/hook thật của Workflow). File này có `WorkflowExecutionStatus = 'pending' | 'running' |
    'completed' | 'failed' | 'cancelled'` (dòng 47) — **đúng là file cần sửa**.
  - `frontend/src/renderer/src/types/workflow-types.ts` — chỉ 1 file duy nhất import nó:
    `DAGPreview.tsx` (chỉ dùng `WorkflowStep`, không dùng `WorkflowExecutionStatus`). File này **không
    liên quan** tới task này — sửa nhầm file này sẽ không ảnh hưởng gì tới Pause/Resume thật (silent
    no-op).
  **Kết luận: sửa đúng `frontend/src/shared/workflow-types.ts`, KHÔNG phải
  `frontend/src/renderer/src/types/workflow-types.ts`** — FE-SOL-001 chỉ ghi "workflow-types.ts"
  không phân biệt rõ 2 file, task này chốt lại đường dẫn chính xác.
- `workflow.pause`/`workflow.resume` **đã tồn tại thật**,
  `channels_workflow.go:147-178`, args `{executionId}` cả 2 RPC.
- ⚠️ **Phát hiện quan trọng thứ 2, KHÔNG có trong FE-SOL-001**: `useWorkflowExecution.ts`'s polling
  effect (dòng 31-57) có guard `if (!executionId || executionStatus !== 'running') return` — **chỉ
  poll khi status là `'running'`**. Nếu `pauseExecution()`/`resumeExecution()` chỉ gọi RPC mà không
  tự cập nhật `execution.status` trong store ngay (optimistic), polling sẽ **kẹt vĩnh viễn**: sau
  Pause, store vẫn giữ status cũ `'running'` cho tới lần poll kế tiếp mới thấy `'paused'` (chấp nhận
  được, trễ tối đa 4s) — nhưng sau Resume, nếu store vẫn còn `'paused'` (do lần poll gần nhất trước
  khi bấm Resume trả về `'paused'`), effect's dep `executionStatus` không đổi thành `'running'` cho
  tới khi... không bao giờ, vì poll đã dừng hẳn lúc status rời `'running'` — **không có gì kích hoạt
  lại polling nữa**, UI kẹt ở `'paused'` mãi mãi dù backend đã resume thật. Bắt buộc
  `pauseExecution`/`resumeExecution` tự `updateExecutionStatus` ngay khi RPC thành công, đúng pattern
  `cancelExecution()` đã làm (dòng 68-69: `useAppStore.getState().updateExecutionStatus(executionId,
  'cancelled')` ngay sau `callRuntimeRpc` thành công) — code mẫu gốc FE-SOL-001 §3 **thiếu bước này**,
  bổ sung ở task này.

## Files cần sửa

| File | Action |
|------|--------|
| `frontend/src/shared/workflow-types.ts` | MODIFY — `WorkflowExecutionStatus` thêm `'paused'` (dòng 47) |
| `frontend/src/renderer/src/hooks/useWorkflowExecution.ts` | MODIFY — thêm `pauseExecution`/`resumeExecution`, cả 2 tự `updateExecutionStatus` optimistic |
| `frontend/src/renderer/src/components/workflow/ExecutionMonitor.tsx` | MODIFY — thêm nút Pause (khi `running`) / Resume (khi `paused`) cạnh nút Cancel hiện có |
| `frontend/src/renderer/src/components/workflow/WorkflowMonitor.tsx` | MODIFY — `STATUS_LABEL` (dòng 14-20) thêm entry `paused` — object này exhaustive theo `Record<WorkflowExecutionStatus, string>`, thiếu key mới sẽ lỗi TypeScript ngay khi bước 1 áp dụng |
| `frontend/src/renderer/src/hooks/__tests__/useWorkflowExecution.test.ts` | MODIFY — case pause/resume |
| `frontend/src/renderer/src/components/workflow/__tests__/ExecutionMonitor.test.tsx` | MODIFY — case nút Pause/Resume hiện đúng theo status |

## Các bước thực thi

### 1. Thêm `'paused'` vào `WorkflowExecutionStatus` (BẮT BUỘC làm trước bước 2-4)

```typescript
// frontend/src/shared/workflow-types.ts — dòng 47
export type WorkflowExecutionStatus = 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'
```

Sau bước này, TypeScript sẽ báo lỗi ngay tại `WorkflowMonitor.tsx:14`'s `STATUS_LABEL` (object
`Record<WorkflowExecutionStatus, string>` thiếu key `paused`) — đây là tín hiệu đúng để nhắc sửa
bước 4, không phải lỗi ngoài ý muốn.

### 2. Thêm `pauseExecution`/`resumeExecution` vào `useWorkflowExecution.ts`

```typescript
// useWorkflowExecution.ts — cạnh cancelExecution (sau dòng 75)
const pauseExecution = useCallback(async () => {
  const target = getActiveRuntimeTarget(useAppStore.getState().settings)
  try {
    await callRuntimeRpc(target, 'workflow.pause', { executionId })
    // Bắt buộc cập nhật optimistic — polling effect (dòng 31-57) chỉ chạy khi status==='running',
    // không tự nhận ra 'paused' cho tới lần poll kế tiếp nếu không set ở đây.
    useAppStore.getState().updateExecutionStatus(executionId, 'paused')
  } catch (err) {
    toast.error('Failed to pause workflow')
    throw err
  }
}, [executionId])

const resumeExecution = useCallback(async () => {
  const target = getActiveRuntimeTarget(useAppStore.getState().settings)
  try {
    await callRuntimeRpc(target, 'workflow.resume', { executionId })
    // Bắt buộc cập nhật optimistic — đưa status về 'running' để polling effect's dep
    // [executionId, executionStatus] kích hoạt lại interval (nếu không làm bước này, polling
    // kẹt vĩnh viễn ở trạng thái dừng, xem "Xác nhận đã đọc code thật" ở trên).
    useAppStore.getState().updateExecutionStatus(executionId, 'running')
  } catch (err) {
    toast.error('Failed to resume workflow')
    throw err
  }
}, [executionId])

// return { execution, stepStatuses, streamingOutput, cancelExecution, pauseExecution, resumeExecution }
```

Cần import `toast` từ `'sonner'` (chưa có trong `useWorkflowExecution.ts` hôm nay — `cancelExecution`
hiện `throw err` thẳng không toast; giữ nguyên hành vi `cancelExecution`, chỉ thêm toast cho 2 hàm
mới theo yêu cầu UX rõ ràng khi Pause/Resume thất bại).

### 3. Thêm nút Pause/Resume vào `ExecutionMonitor.tsx`

```tsx
// ExecutionMonitor.tsx — dòng 6-8, cạnh nút Cancel hiện có (dòng 39-43)
const { execution, stepStatuses, streamingOutput, cancelExecution, pauseExecution, resumeExecution } =
  useWorkflowExecution(executionId)
// ...
{execution.status === 'running' && (
  <Button size="sm" variant="outline" onClick={pauseExecution} data-testid="pause-btn">Pause</Button>
)}
{execution.status === 'paused' && (
  <Button size="sm" variant="outline" onClick={resumeExecution} data-testid="resume-btn">Resume</Button>
)}
{execution.status === 'running' && (
  <Button size="sm" variant="outline" onClick={cancelExecution} data-testid="cancel-btn">Cancel</Button>
)}
```

Giữ `Cancel` chỉ hiện khi `running` (hành vi cũ không đổi) — có thể cân nhắc cho phép Cancel cả khi
`paused` (huỷ 1 execution đang tạm dừng) nhưng đó là quyết định UX ngoài phạm vi granularize của task
này; nếu cần, mở task follow-up riêng.

### 4. Vá `STATUS_LABEL` ở `WorkflowMonitor.tsx`

```typescript
// WorkflowMonitor.tsx — dòng 14-20
const STATUS_LABEL: Record<WorkflowExecutionStatus, string> = {
  pending: 'Pending',
  running: 'Running',
  paused: 'Paused',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled'
}
```

## Không làm ở task này

- Không đổi `StepStatusBadge.tsx`'s `StepStatus` — type đó riêng (`pending|running|completed|failed|
  skipped`), không có `paused` ở cấp step, chỉ cấp execution. `WorkflowMonitor.tsx`'s comment
  (dòng 10-13) đã tự giải thích lý do 2 type tách biệt — không gộp lại ở đây.
- Không đổi `renderer/src/types/workflow-types.ts` (file không liên quan, xem "Xác nhận đã đọc code
  thật" ở trên) — chỉ sửa `shared/workflow-types.ts`.
- Không cho phép Cancel khi `paused` — xem ghi chú ở bước 3.

## Test cases cần cover

```
useWorkflowExecution.test.ts (case mới)
├── pauseExecution() → gọi workflow.pause({executionId}), updateExecutionStatus(executionId,'paused')
├── pauseExecution() RPC lỗi → toast.error, KHÔNG gọi updateExecutionStatus
├── resumeExecution() → gọi workflow.resume({executionId}), updateExecutionStatus(executionId,'running')
└── resumeExecution() thành công → polling effect's dep đổi, interval được set lại (dùng
    vi.useFakeTimers xác nhận task.get/workflow.getExecution được gọi lại sau resume)

ExecutionMonitor.test.tsx (case mới)
├── execution.status='running' → nút Pause hiện, Resume KHÔNG hiện
├── execution.status='paused' → nút Resume hiện, Pause KHÔNG hiện, Cancel KHÔNG hiện
└── bấm Pause → gọi pauseExecution từ hook (mock useWorkflowExecution)
```

## Verify

```bash
cd frontend && npx vitest run \
  src/renderer/src/hooks/__tests__/useWorkflowExecution.test.ts \
  src/renderer/src/components/workflow/__tests__/ExecutionMonitor.test.tsx \
  src/renderer/src/components/workflow/__tests__/WorkflowMonitor.test.tsx
cd frontend && npx tsc --noEmit -p .
```

`npx tsc --noEmit` đặc biệt quan trọng ở task này — bước 1 đổi 1 type union dùng ở nhiều nơi
(`Record<WorkflowExecutionStatus, ...>` exhaustive maps), compiler sẽ tự chỉ ra hết những chỗ cần
cập nhật thêm ngoài danh sách "Files cần sửa" nếu có sót.

## gitnexus

Chạy trước khi sửa (bắt buộc theo CLAUDE.md):
```
impact({target: "useWorkflowExecution", direction: "upstream"})
```
Kỳ vọng caller là `ExecutionMonitor.tsx` (trực tiếp) + `WorkflowMonitor.tsx` (gián tiếp qua
`ExecutionMonitor`) — risk dự kiến LOW, thay đổi chỉ thêm field mới vào return object, không đổi
field cũ. Dán kết quả thật vào PR.

## Depends on

Không có (cả `workflow.pause`/`workflow.resume` đã tồn tại thật). Bước 1 phải xong trước bước 2-4
trong cùng PR.

## Blocking

Không có
