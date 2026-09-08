# FE-TASK-001: `ExecutionEngineBadge` — badge suy luận Engine phía client

**Domain:** flow-task
**Solution Ref:** FE-SOL-001 Phần 1
**Priority:** 🟠 P1 — prerequisite cho FE-TASK-002
**Estimated:** 45 phút
**Status:** [ ] TODO

---

## Mục tiêu

`TaskDetail.tsx` hiện chỉ có 1 nút "Execute with Agent", không hiển thị task đang/sẽ chạy qua
Engine nào trong 3 Engine của CR-FLOW-TASK-001 (`direct_agent`/`orchestration`/`workflow`). Thêm
component `ExecutionEngineBadge` suy luận Engine **hoàn toàn phía client** từ dữ liệu đã có sẵn
trong store, và gắn cạnh nút Run.

**Xác nhận trước khi làm (đã đọc code thật):**
- `backend-go/proto/orca/task/v1/task.proto`'s `message Task` **không có** field
  `workflow_template_id`/`engine` — badge không thể đọc field này từ backend, phải suy luận.
- `frontend/src/shared/task-types.ts:39-62`'s `OrcaTask` cũng chưa có field `workflowTemplateId`
  — cần thêm mới (optional), field này sẽ được set optimistic ở FE-TASK-002.

## Files cần sửa

| File | Action |
|------|--------|
| `frontend/src/shared/task-types.ts` | MODIFY — thêm `OrcaTask.workflowTemplateId?: string` sau dòng 58 (`promptTemplate?: string`) |
| `frontend/src/renderer/src/components/task/ExecutionEngineBadge.tsx` | NEW |
| `frontend/src/renderer/src/components/task/TaskDetail.tsx` | MODIFY — gắn `<ExecutionEngineBadge task={task} />` vào Action Buttons row (`TaskDetail.tsx:100-105`) |
| `frontend/src/renderer/src/components/task/__tests__/ExecutionEngineBadge.test.tsx` | NEW |
| `frontend/src/renderer/src/components/task/__tests__/TaskDetail.test.tsx` | MODIFY — mock `s.tasks`/`s.templates` cho badge, thêm case assert badge render |

## Các bước thực thi

### 1. Thêm field vào `task-types.ts` (sau dòng 58)

```typescript
/** Set khi user "Attach Workflow Template" (FE-TASK-002). Backend hiện CHƯA
 * lưu/trả field này (CR-FLOW-TASK-002 chưa triển khai) — luôn `undefined` sau
 * khi load lại task cho tới khi backend field tồn tại. */
workflowTemplateId?: string
```

### 2. Tạo `ExecutionEngineBadge.tsx`

Copy gần như nguyên văn code mẫu ở FE-SOL-001 Phần 1 (hook `useInferredExecutionEngine` +
component `ExecutionEngineBadge`). Thứ tự ưu tiên suy luận **PHẢI giữ đúng**: có
`task.workflowTemplateId` (tra `useAppStore(s => s.templates)` lấy tên) → `workflow`; không thì có
task con (`useAppStore(s => s.tasks.some(t => t.parentId === task.id))`, cùng cách
`TaskTreeView.tsx:108` đã tính `hasChildren`) → `orchestration`; mặc định → `direct_agent`. Giữ
đúng thứ tự này để khi backend field `engine` xuất hiện thật (CR-001), badge không "giật" ngược
thứ tự CR-001 đã chốt.

Style tokens tái dùng nguyên xi từ `TaskStatusBadge`/`TaskPriorityBadge`
(`frontend/src/renderer/src/components/task/TaskStatusBadge.tsx:20,30`: `text-xs px-1.5 py-0.5
rounded border`, màu `text-*-600`/`border-*-200`) — không phát minh token mới, đúng AGENTS.md's
Design System.

### 3. Gắn vào `TaskDetail.tsx` (Action Buttons, dòng 100-105)

```tsx
{/* Action Buttons */}
<div className="flex gap-2 mt-2 items-center">
  <ExecutionEngineBadge task={task} />
  <Button variant="default" onClick={handleRunAgent} data-testid="run-agent-btn">
    ▶ Execute with Agent
  </Button>
</div>
```

(Thêm `items-center` để badge căn giữa theo chiều dọc với nút — nút hiện dùng `flex gap-2 mt-2`
không có `items-center`.)

## Giới hạn đã biết (không phải hard blocker, nhưng bắt buộc ghi trong PR)

- Đây **chỉ là suy luận client-side tạm thời**, không phải Engine thật lưu ở backend.
  `CR-FLOW-TASK-001`'s `execution_links` bảng + `selectEngine()` phía backend **chưa triển khai**
  — khi triển khai, cần 1 task follow-up đổi `useInferredExecutionEngine` sang đọc trực tiếp
  `task.engine` từ response `task.get` thay vì suy luận. Không phải việc của task này.
- Badge hiển thị `workflow: <tên template>` chỉ đúng sau khi FE-TASK-002 chạy xong (set
  `workflowTemplateId` optimistic) — trước đó `task.workflowTemplateId` luôn `undefined`, badge
  luôn hiện `Direct Agent` hoặc `Orchestration`.

## Test cases cần cover

```
ExecutionEngineBadge.test.tsx
├── không có subtasks, không có workflowTemplateId → renders "Direct Agent"
├── có subtasks (store.tasks có t.parentId === task.id) → renders "Orchestration"
├── có workflowTemplateId + template tìm thấy trong store.templates → renders "Workflow: <name>"
└── có workflowTemplateId NHƯNG cũng có subtasks → vẫn ưu tiên "Workflow" (đúng thứ tự CR-001)

TaskDetail.test.tsx (case mới, giữ nguyên case cũ)
└── renders ExecutionEngineBadge cạnh nút Run — cần mock `s.tasks`/`s.templates` trong
    `vi.mock('../../../store', ...)` hiện tại (đang chỉ mock `activeTaskId`/`settings`)
```

## Verify

```bash
cd frontend && npx vitest run \
  src/renderer/src/components/task/__tests__/ExecutionEngineBadge.test.tsx \
  src/renderer/src/components/task/__tests__/TaskDetail.test.tsx
cd frontend && npx tsc --noEmit -p .
```

## gitnexus

Chạy trước khi sửa (bắt buộc theo CLAUDE.md):
```
impact({target: "TaskDetail", direction: "upstream"})
```
Kỳ vọng risk LOW — `TaskDetail` là component lá, chỉ `TaskGraphPanel.tsx` import nó (theo ghi chú
"Impact analysis" của FE-SOL-001). Dán kết quả thật vào PR description.

## Depends on
Không có

## Blocking
FE-TASK-002 (cần field `OrcaTask.workflowTemplateId` đã thêm ở task này)
