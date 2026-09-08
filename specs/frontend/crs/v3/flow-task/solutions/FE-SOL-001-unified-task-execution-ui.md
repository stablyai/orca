# FE-SOL-001: Task chạy qua đúng 1 trong 3 Execution Engine — badge, attach Workflow Template, Activity Feed, sửa RPC shape

> **📋 Proposed — chưa triển khai** (khớp trạng thái của
> [CR-FLOW-TASK-005](../../../../../docs/crs/v3/flow-task/CR-FLOW-TASK-005-frontend-unified-task-execution-ui.md)).
> Solution này đọc code frontend **thật tại thời điểm viết** (2026-09-08, nhánh
> `feature/project-delete-ui`) và đối chiếu với 3 file proto/wscompat thật của
> `backend-go` (không phải suy đoán) — vài chỗ **chỉnh chính xác hơn** so với
> câu chữ gốc của CR-FLOW-TASK-005 mục 3 (xem "Đính chính so với CR-005" ở mỗi
> phần) vì đọc trực tiếp `channels_workflow.go`/`*.pb.go` cho thấy shape thật
> lệch nhẹ so với mô tả tường thuật trong CR.

## CR Reference

- **CR:** [CR-FLOW-TASK-005](../../../../../docs/crs/v3/flow-task/CR-FLOW-TASK-005-frontend-unified-task-execution-ui.md) — 🟠 P1
- **Phụ thuộc (đọc để hiểu ngữ cảnh, không tự sửa):**
  - [CR-FLOW-TASK-001](../../../../../docs/crs/v3/flow-task/CR-FLOW-TASK-001-three-engine-execution-architecture.md) — mô hình `ExecutionEngine` (`direct_agent`/`orchestration`/`workflow`). **Chưa triển khai ở backend** — xác nhận `backend-go/proto/orca/task/v1/task.proto:49-56`'s `message Task` chỉ có `id/tenant_id/title/status/parent_id/project_id`, không có `workflow_template_id`/`active_execution_link_id`/`engine`. Phần 1-2 dưới đây do đó chỉ **suy ra Engine ở client** từ dữ liệu đã có, không đọc field mới nào từ backend.
  - [CR-FLOW-TASK-003](../../../../../docs/crs/v3/flow-task/CR-FLOW-TASK-003-unified-task-activity-event-catalog.md) — kênh WS `task.activity:{taskId}`. **Chưa triển khai** — 0 subject `orca.orchestration.*`/`orca.workflow.step.*` được publish, kênh `task.activity` chưa tồn tại ở `api-gateway`.
  - [CR-FLOW-TASK-004](../../../../../docs/crs/v3/flow-task/CR-FLOW-TASK-004-backend-go-cutover-and-node-sqlite-retirement.md) — 2 backend (Node/SQLite đang chạy production, `backend-go`/Postgres đang scaffold) song song; Pha 0 của CR này ("mọi RPC contract mới viết theo shape backend-go") là lý do phần 4 dưới đây chỉ target `backend-go`, chấp nhận lỗi trên Node cho tới khi CR-004 Pha 3 xong (khớp CR-005's Acceptance Criteria cuối).
- **Bug được đóng bởi solution này:**
  [BUG-FE-TASKV1-004](../../../../bugs/task-v1/BUG-FE-TASKV1-004-run-agent-ux-gaps.md) (mục 1-2),
  [BUG-FE-TASKV1-005](../../../../bugs/task-v1/BUG-FE-TASKV1-005-missing-realtime-event-subscriptions.md),
  [BUG-FE-TASKV1-007](../../../../bugs/task-v1/BUG-FE-TASKV1-007-workflow-builder-rpc-shape-mismatch.md) (mục 1),
  [BUG-FE-TASKV1-008](../../../../bugs/task-v1/BUG-FE-TASKV1-008-dual-backend-rpc-contract-drift.md) (root cause, giảm nhẹ theo Pha 0).
- **Impact analysis (gitnexus, MUST chạy trước khi implement thật):**
  `impact({target: "useWorkflow", direction: "upstream"})` trước khi sửa `runWorkflow`/`saveTemplate`
  (2 caller UI: `WorkflowBuilder.tsx`, có thể cả `ExecutionMonitor.tsx` qua `useWorkflowExecution`);
  `impact({target: "TaskDetail", direction: "upstream"})` trước khi thêm badge/dropdown (component lá,
  risk dự kiến LOW — không ai import `TaskDetail` ngoài `TaskGraphPanel.tsx`); `impact({target:
  "TaskPromptEditor"})` trước khi đổi hành vi textarea. Solution này **không tự chạy** các lệnh trên
  (không có thay đổi code thật trong phạm vi viết solution) — người implement PHẢI chạy trước khi bắt
  tay sửa, theo đúng CLAUDE.md's "MUST run impact analysis before editing any symbol", và dán kết quả
  risk level vào PR.

---

## Root Cause (tóm tắt, xem đầy đủ ở CR-005 + 4 bug tham chiếu)

1. `TaskDetail.tsx` chỉ có 1 nút "Execute with Agent" gọi `task.execute` — không hiển thị Engine, không có cách chọn Engine 3 (`frontend/src/renderer/src/components/task/TaskDetail.tsx:100-105`).
2. Không nơi nào trong `components/task/` subscribe sự kiện đẩy nào — xác nhận lại bằng chính solution này: `grep -rn "subscribeRuntimeEvent\|subscribeRuntimeClientEvents" frontend/src/renderer/src/components/task/` → 0 kết quả (khớp BUG-FE-TASKV1-005).
3. `useWorkflow.ts`'s `runWorkflow()` (`frontend/src/renderer/src/hooks/useWorkflow.ts:82`) gửi `{templateId, inputs, traceId}` — không khớp **bất kỳ** backend nào đang tồn tại thật: không khớp Node (cần `definition`, xem BUG-FE-TASKV1-007) và cũng không khớp chính xác `backend-go` (xem "Đính chính" ở Phần 4 — thiếu `projectId`/`rootTraceId`/`requestId`, thừa `inputs` mà RPC không nhận).
4. `TaskPromptEditor.tsx:24-31` tự thú `task.execute` không có param `prompt` — input người dùng gõ bị bỏ hoàn toàn (BUG-FE-TASKV1-004 mục 1), nhưng nút Run vẫn disable theo nội dung textarea trống (dòng 52) — UX nói dối.

## Giải pháp

### 1. `ExecutionEngineBadge` — hiển thị Engine hiện tại, suy ra ở client (không cần RPC mới)

**File mới:** `frontend/src/renderer/src/components/task/ExecutionEngineBadge.tsx`

Vì backend chưa có field `workflow_template_id`/`engine` (xem "Phụ thuộc" ở trên), badge suy ra Engine
theo đúng logic `selectEngine()` mà CR-FLOW-TASK-001 mục 3 đặc tả cho backend — chỉ chạy phía client,
dùng dữ liệu đã có sẵn trong store (giống cách `TaskTreeView.tsx:108`
`allTasks.filter(t => t.parentId === task.id)` đã tính `hasChildren`):

```tsx
// frontend/src/renderer/src/components/task/ExecutionEngineBadge.tsx
import { useAppStore } from '../../store'
import type { OrcaTask } from '../../../../shared/task-types'

// Suy luận CLIENT-SIDE của CR-FLOW-TASK-001's selectEngine() (execute_task.go dự kiến,
// chưa tồn tại) — KHÔNG đọc field `workflowTemplateId`/`engine` từ backend vì
// backend-go's `Task` message (task.proto:49-56) chưa có field này. Ưu tiên
// workflowTemplateId (nếu CR-002 sau này set được) > có subtask thật > mặc định direct_agent.
// Phải giữ đúng thứ tự ưu tiên này khi backend field xuất hiện, để badge không "giật"
// từ Orchestration sang Workflow ngược thứ tự CR-001 đã chốt.
export type InferredExecutionEngine = 'direct_agent' | 'orchestration' | 'workflow'

const ENGINE_CONFIG: Record<InferredExecutionEngine, { label: string; className: string }> = {
  direct_agent: { label: 'Direct Agent', className: 'text-blue-600 border-blue-200' },
  orchestration: { label: 'Orchestration', className: 'text-purple-600 border-purple-200' },
  workflow: { label: 'Workflow', className: 'text-teal-600 border-teal-200' },
}

export function useInferredExecutionEngine(task: OrcaTask): {
  engine: InferredExecutionEngine
  workflowTemplateName?: string
} {
  const hasSubtasks = useAppStore((s) => s.tasks.some((t) => t.parentId === task.id))
  const templates = useAppStore((s) => s.templates)

  if (task.workflowTemplateId) {
    const tpl = templates.find((t) => t.id === task.workflowTemplateId)
    return { engine: 'workflow', workflowTemplateName: tpl?.name }
  }
  if (hasSubtasks) return { engine: 'orchestration' }
  return { engine: 'direct_agent' }
}

export function ExecutionEngineBadge({ task }: { task: OrcaTask }) {
  const { engine, workflowTemplateName } = useInferredExecutionEngine(task)
  const config = ENGINE_CONFIG[engine]
  return (
    <span
      className={`inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded border ${config.className}`}
      data-testid="execution-engine-badge"
      title={engine === 'workflow' && workflowTemplateName ? `Workflow: ${workflowTemplateName}` : undefined}
    >
      {engine === 'workflow' && workflowTemplateName ? `Workflow: ${workflowTemplateName}` : config.label}
    </span>
  )
}
```

Style tokens (`text-xs`, `px-1.5 py-0.5`, `rounded border`, màu theo `text-*-600`/`border-*-200`) tái
dùng nguyên xi từ `TaskStatusBadge`/`TaskPriorityBadge` đã có
(`frontend/src/renderer/src/components/task/TaskStatusBadge.tsx:20,30`) — không phát minh token mới,
đúng AGENTS.md's Design System.

`task.workflowTemplateId` là field **mới, optional**, cần thêm vào
`frontend/src/shared/task-types.ts`'s `OrcaTask` (sau dòng 61 `promptTemplate?: string`):

```typescript
/** Set khi user "Attach Workflow Template" (CR-FLOW-TASK-005 mục 1). Backend
 * hiện CHƯA lưu/trả field này (CR-FLOW-TASK-002 chưa triển khai) — luôn
 * `undefined` sau khi load lại task cho tới khi backend field tồn tại; xem
 * Phần 2 của FE-SOL-001 để biết trạng thái optimistic-only tạm thời. */
workflowTemplateId?: string
```

**Gắn vào `TaskDetail.tsx`** — thêm cạnh nút "Execute with Agent"
(`frontend/src/renderer/src/components/task/TaskDetail.tsx:100-105`):

```tsx
{/* Action Buttons */}
<div className="flex items-center gap-2 mt-2">
  <ExecutionEngineBadge task={task} />
  <Button variant="default" onClick={handleRunAgent} data-testid="run-agent-btn">
    ▶ Execute with Agent
  </Button>
  <AttachWorkflowTemplateAction task={task} />
</div>
```

### 2. "Attach Workflow Template" — dropdown từ `workflow.template.list`

`workflow.template.list` **có thật** ở `backend-go` (đúng như CR-005 khẳng định) —
xác nhận `backend-go/services/api-gateway/internal/adapter/wscompat/channels_workflow.go:179-203`
đăng ký channel `workflow.template.list` gọi `WorkflowServiceClient.ListTemplates`. Nhưng
**0 nơi nào trong `frontend/src` gọi `workflow.template.list`** (xác nhận bằng
`grep -rn "workflow.template.list" frontend/src` → 0 kết quả, chỉ `.create`/`.update` được gọi ở
`useWorkflow.ts:56,64`) — khớp đúng mô tả CR-005.

**Điểm cần lưu ý khi implement (không có trong câu chữ CR-005, đọc code thật mới thấy):**
response của `workflow.template.list` serialize **trực tiếp struct Go bằng `encoding/json`**, không
qua `protojson` — nên field bên trong mỗi `WorkflowTemplate` là **snake_case**
(`backend-go/proto/gen/go/orca/workflow/v1/workflow.pb.go:84-90`: `id`, `tenant_id`, `name`,
`dag_json`, `scope`, `parent_template_id`, `version`), trong khi field bọc ngoài
(`templates`, `nextPageToken`) là camelCase vì được build thủ công qua `map[string]any`
(`channels_workflow.go:202`). Đây là 1 case hỗn hợp camelCase/snake_case trong **cùng 1 response** —
chính bug đã được flag trong comment của chính file đó (`channels_workflow.go:34-45`) nhưng cố tình
chưa fix (ngoài phạm vi CR-PW-005). Frontend PHẢI map tường minh, không thể ép kiểu thẳng sang
`WorkflowDefinition` (shape hoàn toàn khác — `templateId`/`steps[]` so với `dag_json` string).

**File mới:** `frontend/src/renderer/src/components/task/AttachWorkflowTemplateAction.tsx`

```tsx
import { useEffect, useState } from 'react'
import { useTask } from '../../hooks/useTask'
import { callRuntimeRpc, getActiveRuntimeTarget } from '../../runtime/runtime-rpc-client'
import { useAppStore } from '../../store'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '../ui/select'
import { toast } from 'sonner'
import type { OrcaTask } from '../../../../shared/task-types'

// Wire shape thật của workflow.template.list (channels_workflow.go:179-203) — snake_case bên
// trong mỗi template vì response serialize thẳng *workflowv1.WorkflowTemplate qua encoding/json,
// KHÔNG qua protojson (xem comment channels_workflow.go:34-45). Chỉ map field dropdown cần
// (id/name) — không cố map toàn bộ sang WorkflowDefinition (shape lệch hẳn: dag_json string vs
// steps[] object, xem BUG-FE-TASKV1-007 mục 3 cho lệch shape tương tự ở step type).
type RawWorkflowTemplateListItem = { id: string; name: string }

function toTemplateOption(raw: unknown): { id: string; name: string } | null {
  const r = raw as Partial<RawWorkflowTemplateListItem>
  if (!r.id || !r.name) return null
  return { id: r.id, name: r.name }
}

export function AttachWorkflowTemplateAction({ task }: { task: OrcaTask }) {
  const [templates, setTemplates] = useState<{ id: string; name: string }[]>([])
  const [loading, setLoading] = useState(false)
  const { updateTask } = useTask(task.id)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const target = getActiveRuntimeTarget(useAppStore.getState().settings)
    callRuntimeRpc<{ templates: unknown[] }>(target, 'workflow.template.list', {})
      .then((res) => {
        if (cancelled) return
        setTemplates(res.templates.map(toTemplateOption).filter((t): t is { id: string; name: string } => t !== null))
      })
      .catch(() => {
        if (!cancelled) toast.error('Failed to load workflow templates')
      })
      .finally(() => !cancelled && setLoading(false))
    return () => { cancelled = true }
  }, [])

  const attach = async (templateId: string) => {
    // task.update's `patch` hiện chỉ persist field backend biết (title/status ở backend-go —
    // xem UpdateTaskRequest, task.proto:156-160). workflowTemplateId sẽ bị backend-go IM LẶNG
    // bỏ qua (field lạ trong JSON patch) cho tới khi CR-FLOW-TASK-002 thêm cột này — cập nhật
    // store local ngay (optimistic) để badge phản ánh lựa chọn trong phiên hiện tại, nhưng
    // KHÔNG coi đây là đã lưu bền; reload trang sẽ mất lựa chọn cho tới khi backend hỗ trợ.
    useAppStore.getState().updateTask(task.id, { workflowTemplateId: templateId })
    try {
      await updateTask({ workflowTemplateId: templateId } as Partial<OrcaTask>)
    } catch {
      // Best-effort — xem comment ở trên, RPC hiện tại nhiều khả năng không có field này để lưu.
    }
  }

  return (
    <Select value={task.workflowTemplateId ?? ''} onValueChange={attach} disabled={loading}>
      <SelectTrigger className="w-48 h-8 text-xs" data-testid="attach-workflow-template-select">
        <SelectValue placeholder="Attach Workflow Template…" />
      </SelectTrigger>
      <SelectContent>
        {templates.map((t) => (
          <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
```

**Đính chính so với CR-005 mục 1:** CR-005 viết "chỉ chưa được frontend gọi bao giờ cho mục đích
này" như thể chỉ cần gọi RPC là xong. Đọc thật `UpdateTaskRequest`
(`backend-go/proto/orca/task/v1/task.proto:156-160`) cho thấy **backend-go hiện không có cách nào
persist `workflow_template_id` lên 1 task** — `UpdateTaskRequest` chỉ nhận `title`/`status`. Vậy
"Attach Workflow Template" ở solution này chỉ set được **optimistic client-side state** (đủ để hiển
thị badge + để `handleRunAgent` biết gửi gì, xem Phần 1/4), **không bền qua reload** — đúng tinh thần
CR-005's rủi ro "không tự làm quá phạm vi backend chưa có", nhưng cần ghi rõ trong PR để không ai
tưởng nhầm đây là tính năng lưu vĩnh viễn.

### 3. `useTaskActivity` — subscribe kênh Activity Feed, fallback polling vì CR-003 + hạ tầng client chưa có

**Đính chính quan trọng so với CR-005 mục 2:** CR-005's pseudocode gọi
`subscribeRuntimeEvent(target, 'task.activity:${taskId}', cb)` — hàm `subscribeRuntimeEvent` với
chữ ký `(target, channel: string, cb)` **không tồn tại ở bất kỳ đâu trong codebase**
(`grep -rn "subscribeRuntimeEvent" frontend/src` → 0 kết quả). Cơ chế push-event THẬT duy nhất hiện
có là `subscribeRuntimeClientEvents(environmentId, onEvent, onError, onReplayed)`
(`frontend/src/renderer/src/runtime/runtime-client-events.ts:12-36`), với 2 giới hạn quan trọng:

1. Chỉ nhận 1 tham số `environmentId: string` — **không có target `'local'`**. Nó gọi
   `window.api.runtimeEnvironments.subscribe({selector: environmentId, method:
   'runtime.clientEvents.subscribe', ...})`, dành cho web/remote runtime; Desktop Electron (`target.kind
   === 'local'`) không đi qua đường này.
2. Event nhận về bị giới hạn bởi **union đóng** `RuntimeClientEvent`
   (`frontend/src/shared/runtime-client-events.ts:52-77` + type guard `isRuntimeClientEvent`,
   `runtime-client-events.ts:60-75`) — không có cơ chế "arbitrary channel string" nào, và hiện
   **không có variant nào cho task/workflow/orchestration activity**.

Kết luận: `useTaskActivity` **không thể** subscribe `task.activity:{taskId}` hôm nay theo đúng nghĩa
CR-003 đặc tả — CR-003 (kênh WS phía backend) **và** hạ tầng client-side (thêm 1 variant vào
`RuntimeClientEvent` + đường bridge cho `target.kind === 'local'`) đều chưa tồn tại. Đây chính xác là
kịch bản CR-005 tự lường trước ở mục "Rủi ro": *"nếu triển khai trước khi CR-003 xong, `useTaskActivity`
phải fallback về polling `task.get` theo interval, không được để Activity Feed trống hoàn toàn"* — solution
này áp dụng đúng fallback đó cho **cả 2** target kind (không chỉ `'local'`), vì `RuntimeClientEvent`
chưa có variant `taskActivity` cho target `'environment'` nữa.

**File mới:** `frontend/src/renderer/src/hooks/useTaskActivity.ts` — polling `task.get` theo đúng
pattern đã có ở `useWorkflowExecution.ts:31-57` (cùng interval constant, cùng cleanup-on-unmount, cùng
comment "why polling" style):

```typescript
// frontend/src/renderer/src/hooks/useTaskActivity.ts
import { useEffect, useReducer } from 'react'
import { useAppStore } from '../store'
import { callRuntimeRpc, getActiveRuntimeTarget } from '../runtime/runtime-rpc-client'
import type { OrcaTask } from '@shared/task-types'

// CR-FLOW-TASK-005 mục 2 thiết kế subscribe 1 kênh WS hợp nhất `task.activity:{taskId}`
// (CR-FLOW-TASK-003). Cả 2 điều kiện tiên quyết đều CHƯA có hôm nay:
//   1. Backend: CR-FLOW-TASK-003 (outbox orchestration/workflow + kênh WS) — 🔵 Proposed.
//   2. Client: `RuntimeClientEvent` (shared/runtime-client-events.ts) là 1 union đóng, không có
//      variant `taskActivity`; và `subscribeRuntimeClientEvents` chỉ nhận `environmentId`, không
//      có đường tương đương cho `target.kind === 'local'` (Desktop IPC dùng channel riêng từng
//      loại event, xem useIpcEvents.ts — không có channel `taskActivity` nào ở đó).
// Cho tới khi cả 2 xong, hook này CHỈ poll `task.get` — đúng fallback CR-005 tự cho phép ("Rủi ro"
// mục 2). Khi CR-003 xong VÀ `RuntimeClientEvent` có variant `taskActivity`, thay thân effect dưới
// đây bằng subscribeRuntimeClientEvents(...) cho target 'environment' + 1 IPC bridge tương đương
// cho 'local' — KHÔNG xoá field `isLive` (UI dùng nó phân biệt "đang poll" / "đang nhận real-time").
const TASK_ACTIVITY_POLL_INTERVAL_MS = 4_000 // cùng hằng số CR-PW-005 dùng cho workflow execution polling

export type TaskActivityState = {
  task: OrcaTask | null
  isLive: false // luôn false cho tới khi kênh WS thật tồn tại — xem comment trên
  lastPolledAt: number | null
}

type Action = { type: 'polled'; task: OrcaTask }

function reducer(state: TaskActivityState, action: Action): TaskActivityState {
  switch (action.type) {
    case 'polled':
      return { ...state, task: action.task, lastPolledAt: Date.now() }
  }
}

export function useTaskActivity(taskId: string | null): TaskActivityState {
  const [state, dispatch] = useReducer(reducer, { task: null, isLive: false, lastPolledAt: null })

  useEffect(() => {
    if (!taskId) return
    let cancelled = false
    const poll = async () => {
      try {
        const target = getActiveRuntimeTarget(useAppStore.getState().settings)
        // task.get: RPC đã tồn tại (dùng chung với refetch thủ công hiện có), không phải RPC mới —
        // chỉ đổi cách gọi từ "thủ công theo action người dùng" (BUG-FE-TASKV1-005) sang interval.
        const task = await callRuntimeRpc<OrcaTask>(target, 'task.get', { taskId })
        if (!cancelled) dispatch({ type: 'polled', task })
      } catch {
        // Lỗi tạm thời — tick sau retry, không cần error state riêng cho 1 poll nền.
      }
    }
    void poll()
    const intervalId = setInterval(() => void poll(), TASK_ACTIVITY_POLL_INTERVAL_MS)
    return () => { cancelled = true; clearInterval(intervalId) }
  }, [taskId])

  return state
}
```

Dùng trong `TaskDetail.tsx` thay cho việc hoàn toàn im lặng sau `handleRunAgent`
(dòng 64-87 hiện tại chỉ `await` 1 lần rồi `toast`, không theo dõi gì thêm):

```tsx
const { task: polledTask, lastPolledAt } = useTaskActivity(task.id)
// polledTask.status đổi (ví dụ 'in_progress' → 'done') sẽ tự phản ánh qua state polling này —
// không cần người dùng tự F5/chuyển tab để trigger refetch nữa (đóng BUG-FE-TASKV1-005's mục Task).
```

Task breakdown khi CR-003 xong (không làm ở solution này, chỉ note để tránh lặp lại đúng gap):
đổi thân effect trên sang nhánh theo `target.kind` — `'environment'` gọi
`subscribeRuntimeClientEvents` lọc `event.type === 'taskActivity' && event.taskId === taskId`;
`'local'` cần 1 kênh IPC mới (`window.api.onTaskActivity`, theo đúng pattern
`window.api.onAutomationEvent` đã có ở `useAutomationDispatchEvents.ts` — xem TDD-FE-07 mục 4) — cả
2 việc này đụng tới `preload`/`main` process, ngoài phạm vi "Tác động" mà CR-005 khai báo
(`components/task/*`, `hooks/*`), nên **không** thực hiện ở solution này.

### 4. `useWorkflow.ts` — sửa `runWorkflow()`/`updateTemplate()` (`saveTemplate()`) theo đúng shape `backend-go` THẬT

**Đính chính so với CR-005 mục 3:** CR-005 viết shape mong muốn là
`{templateId, inputs, projectId, traceId, originTaskId}`. Đọc thật
`channels_workflow.go:47-67`'s `executeArgs` struct thì `backend-go`'s `workflow.execute` (qua
`api-gateway`) chỉ nhận đúng 4 field, **tên khác** và **không có `inputs`/`originTaskId`**:

```go
// channels_workflow.go:48-53 — shape THẬT, không phải suy đoán
type executeArgs struct {
    TemplateID  string `json:"templateId"`
    ProjectID   string `json:"projectId"`
    RootTraceID string `json:"rootTraceId"`   // KHÔNG PHẢI `traceId`
    RequestID   string `json:"requestId"`      // idempotency key — CR-005 không nhắc field này
}
```

`ExecuteRequest` proto (`backend-go/proto/orca/workflow/v1/workflow.proto:84-89`) xác nhận
`workflow-service` cũng không có field `inputs`/`origin_task_id` nào — engine hiện tại không hỗ trợ
truyền input runtime vào execution qua RPC này (out of scope sửa ở solution FE — nếu cần, phải thêm
ở `workflow.proto` trước, tương tự field `prompt` ở Phần 5).

**Sửa `runWorkflow()`** (`frontend/src/renderer/src/hooks/useWorkflow.ts:75-99`):

```typescript
// Trước (dòng 82):
const result = await callRuntimeRpc<{ id: string }>(target, 'workflow.execute', { templateId, inputs, traceId: span.id })

// Sau — đúng shape backend-go thật (channels_workflow.go:48-53). `inputs` bị bỏ (RPC không nhận,
// gửi thêm không gây lỗi vì decodeArg chỉ đọc field nó biết, nhưng giữ lại là gây hiểu nhầm — xoá
// khỏi tham số hàm luôn, xem chữ ký mới bên dưới). `requestId` mới: dùng span.id làm idempotency
// key luôn — 1 lần bấm Run = 1 request-id, khớp field `RequestID` chỉ tồn tại để chống double-submit
// (theo đúng convention `task.execute`'s `requestId`, `channels_automation_task.go:226`).
const result = await callRuntimeRpc<{ id: string; status: string }>(target, 'workflow.execute', {
  templateId,
  projectId: project?.id ?? '',
  rootTraceId: span.id,
  requestId: span.id,
})
```

Chữ ký `runWorkflow` đổi từ `(inputs?: Record<string, unknown>)` sang không nhận `inputs` nữa (backend
không có chỗ nhận) — cần `projectId`, lấy qua tham số mới hoặc từ `WorkspaceContext` tại call site
(`WorkflowBuilder.tsx`'s `onRun={runWorkflow}` — theo TDD-FE-14 mục 2 dòng 94, cần đối chiếu file thật
`WorkflowBuilder.tsx` khi implement để xác nhận có sẵn `project`/`projectId` trong scope hay phải
prop-drill; **ngoài phạm vi đọc lại ở solution này** vì `WorkflowBuilder.tsx` không nằm trong 4 mục
CR-005 chốt sửa, chỉ `useWorkflow.ts`).

**Sửa `saveTemplate()`'s nhánh update** (`frontend/src/renderer/src/hooks/useWorkflow.ts:46-73`,
cụ thể dòng 56-62):

CR-005 mục 3 viết "giữ nguyên `workflow.template.update` — method này đã đúng theo backend-go". Đọc
thật `channels_workflow.go:107-129`'s `updateArgs` cho thấy **shape khác hẳn** field hiện tại
đang gửi:

```go
// channels_workflow.go:108-115 — shape THẬT
type updateArgs struct {
    ID               string `json:"id"`                // KHÔNG PHẢI `templateId`
    Name             string `json:"name"`
    DAGJSON          string `json:"dagJson"`            // string JSON, KHÔNG PHẢI `definition: {steps}`
    Scope            string `json:"scope"`
    ParentTemplateID string `json:"parentTemplateId"`   // useWorkflow.ts hiện không gửi field này
    ExpectedVersion  int32  `json:"expectedVersion"`    // optimistic concurrency — hiện không gửi
}
```

```typescript
// Trước (dòng 56-62):
await callRuntimeRpc(target, 'workflow.template.update', {
  templateId,
  name: local.name,
  definition: { steps: local.steps ?? [] },
  scope: local.scope,
  traceId: span.id,
})

// Sau — đúng field name + serialize `steps` thành `dagJson` (string) theo đúng shape backend-go.
// `expectedVersion`: WorkflowDefinition (shared/workflow-types.ts) hiện KHÔNG có field `version` —
// gửi `local.version ?? 0` tạm thời chấp nhận luôn ghi đè (mất tính năng optimistic-concurrency
// backend cung cấp) cho tới khi field `version` được thêm vào WorkflowDefinition + BE trả về nó ở
// `workflow.template.create`/`.resolve` — ghi rõ gap này trong PR, không tự ý mở rộng
// WorkflowDefinition's type ở solution CR-005 vì đó là phạm vi component `components/workflow/*`
// (DAGPreview/StepEditor cũng đọc `WorkflowDefinition`), CR-005 chỉ chốt sửa `useWorkflow.ts`.
await callRuntimeRpc(target, 'workflow.template.update', {
  id: templateId,
  name: local.name,
  dagJson: JSON.stringify({ steps: local.steps ?? [] }),
  scope: local.scope,
  parentTemplateId: local.templateId ?? '',
  expectedVersion: (local as { version?: number }).version ?? 0,
})
```

Bỏ `traceId` khỏi payload gửi lên (không có field này ở `updateArgs`) — span vẫn dùng nội bộ để đo
latency qua `span.ok()`/`span.fail()`, chỉ không gửi id đó cho backend qua RPC này (không giống
`workflow.execute` có field `rootTraceId` thật để nhận).

**`saveTemplate()`'s nhánh create** (dòng 64) — **giữ nguyên**, không thuộc phạm vi sửa của CR-005
mục 3 (CR-005 chỉ nhắc `runWorkflow`/`updateTemplate`, không nhắc `template.create`) — nhưng ghi chú
tại đây để người review không nhầm: `workflow.template.create`'s `createArgs`
(`channels_workflow.go:86-91`, field `name`/`dagJson`/`scope`/`parentTemplateId`) cũng lệch với
`{...local, traceId}` hiện tại đang gửi (thiếu `dagJson`, thừa `id`/`traceId`/`steps` không đúng tên)
— đây là 1 gap tương tự chưa có trong bug catalog hiện tại, khuyến nghị mở 1 bug/CR riêng
(không tự sửa ở đây để tránh vượt phạm vi CR-005 đã chốt).

### 5. `TaskPromptEditor.tsx` — field `prompt` tuỳ chọn, phụ thuộc backend chưa có

Xác nhận `backend-go`'s `TaskServiceExecuteRequest`
(`backend-go/proto/orca/task/v1/task.proto:124-127`) chỉ có `task_id`/`request_id` — **không có
`prompt`**, khớp đúng CR-005 mục 3's ghi chú "cần bổ sung field này ở `task.proto`'s `ExecuteRequest`
trước... không phải phạm vi sửa của CR frontend này". Solution này **không** tự thêm field backend
(theo dõi ở `specs/backend-go/bugs/task-v1`), chỉ sửa 2 việc frontend làm được ngay, theo đúng đề
xuất fix #2 của BUG-FE-TASKV1-004: *"tối thiểu disable/ẩn textarea và thay bằng text tĩnh hiển thị
`promptTemplate` hiện tại — tránh UX-lie"*.

**Sửa `frontend/src/renderer/src/components/task/TaskPromptEditor.tsx`:**

```tsx
// Trước (dòng 50-63):
<Button
  onClick={runWithAgent}
  disabled={isRunning || !prompt.trim()}
  data-testid="run-agent-btn"
>
  {isRunning ? (<><Loader2 size={12} className="animate-spin mr-1" />Running...</>) : '▶ Run with Agent'}
</Button>

// Sau — nút không còn disable theo nội dung textarea (nội dung đó chưa từng được gửi và vẫn chưa
// gửi được cho tới khi backend có field `prompt`), cộng 1 dòng chú thích tĩnh giải thích rõ hành
// vi thật, thay vì im lặng bỏ qua input như hiện tại. `prompt` gửi optimistically nếu backend đã hỗ
// trợ (CR-005-conditional): dùng `in` để không phá `task.execute` hiện tại nếu backend chưa có field
// (giữ nguyên `promptLength` trong trace — theo dõi khi field thật xuất hiện, tỉ lệ dùng prompt override).
<>
  <p className="text-xs text-muted-foreground" data-testid="prompt-override-note">
    Note: overriding the prompt for a single run requires backend support that is not deployed yet
    (see BUG-FE-TASKV1-004). This run will use the task's saved prompt template.
  </p>
  <Button onClick={runWithAgent} disabled={isRunning} data-testid="run-agent-btn">
    {isRunning ? (<><Loader2 size={12} className="animate-spin mr-1" />Running...</>) : '▶ Run with Agent'}
  </Button>
</>
```

```tsx
// runWithAgent() — dòng 26-31, gửi `prompt` optimistically; nếu backend chưa update proto, field
// lạ trong JSON args bị decodeArg bỏ qua im lặng (đúng hành vi hiện tại của mọi channel wscompat
// dùng struct đích tường minh — field JSON không khai trong struct không gây lỗi, chỉ bị drop) nên
// gửi thêm không phá hành vi cũ trên backend-go; trên Node, `task.execute`'s Zod schema (nếu
// `.strict()`) CÓ THỂ reject — cần xác nhận trước khi bật ở Node target (không chặn ở
// backend-go target, nơi CR-004 Pha 0 đã đóng băng hướng đi).
await callRuntimeRpc(target, 'task.execute', {
  taskId: task.id,
  projectId: project!.id,
  worktreePath: currentWorktree!.path,
  traceId: span.id,
  prompt: prompt.trim() || undefined, // no-op cho tới khi ExecuteRequest có field này ở backend
})
```

Xoá state `disabled={... || !prompt.trim()}` khỏi Button (đã sửa ở trên) là thay đổi hành vi UI thấy
được ngay (nút không còn bị khoá bởi textarea trống) — cần 1 dòng trong PR description giải thích vì
sao (test cũ `TaskPromptEditor.test.tsx` khả năng có case assert `disabled` theo `prompt`, cần sửa
theo, xem Test Plan).

## Files cần sửa

| File | Action |
|------|--------|
| `frontend/src/shared/task-types.ts` | MODIFY — thêm `OrcaTask.workflowTemplateId?: string` |
| `frontend/src/renderer/src/components/task/ExecutionEngineBadge.tsx` | NEW — badge + `useInferredExecutionEngine()` |
| `frontend/src/renderer/src/components/task/AttachWorkflowTemplateAction.tsx` | NEW — dropdown `workflow.template.list` |
| `frontend/src/renderer/src/components/task/TaskDetail.tsx` | MODIFY — gắn `ExecutionEngineBadge` + `AttachWorkflowTemplateAction` cạnh nút Run (dòng 100-105), dùng `useTaskActivity` thay theo dõi im lặng sau `handleRunAgent` |
| `frontend/src/renderer/src/hooks/useTaskActivity.ts` | NEW — polling fallback (interim, chờ CR-003 + `RuntimeClientEvent` variant) |
| `frontend/src/renderer/src/hooks/useWorkflow.ts` | MODIFY — `runWorkflow()` (dòng 75-99) + `saveTemplate()`'s nhánh update (dòng 46-73) đúng shape `backend-go` thật |
| `frontend/src/renderer/src/components/task/TaskPromptEditor.tsx` | MODIFY — bỏ `disabled={!prompt.trim()}`, thêm note tĩnh, gửi `prompt` optimistically |
| `frontend/src/renderer/src/components/task/__tests__/TaskDetail.test.tsx` | MODIFY — mock `templates`/`tasks` cho `ExecutionEngineBadge`, mock `workflow.template.list` cho dropdown |
| `frontend/src/renderer/src/components/task/__tests__/TaskPromptEditor.test.tsx` | MODIFY — case cũ assert `disabled` theo `prompt.trim()` phải xoá/sửa; thêm case note tĩnh render, `prompt` có mặt trong payload gửi |
| `frontend/src/renderer/src/hooks/__tests__/useWorkflow.test.ts` | MODIFY — cập nhật mọi assertion `toHaveBeenCalledWith(..., 'workflow.execute'/'workflow.template.update', ...)` theo field mới |
| `frontend/src/renderer/src/hooks/__tests__/useTaskActivity.test.ts` | NEW |
| `frontend/src/renderer/src/components/task/__tests__/ExecutionEngineBadge.test.tsx` | NEW |
| `frontend/src/renderer/src/components/task/__tests__/AttachWorkflowTemplateAction.test.tsx` | NEW |

## Test Plan

```
ExecutionEngineBadge.test.tsx
├── no subtasks, no workflowTemplateId → renders "Direct Agent"
├── has subtasks (store.tasks có t.parentId === task.id) → renders "Orchestration"
├── workflowTemplateId set + template tìm thấy trong store.templates → renders "Workflow: <name>"
└── workflowTemplateId set nhưng ưu tiên workflow dù CŨNG có subtasks (đúng thứ tự ưu tiên CR-001)

AttachWorkflowTemplateAction.test.tsx
├── mount → gọi workflow.template.list, populate dropdown từ res.templates map (id/name)
├── chọn 1 item → gọi task.update với patch { workflowTemplateId } + optimistic store update ngay
├── workflow.template.list lỗi → toast.error, dropdown vẫn render rỗng không crash
└── task.update lỗi (backend field chưa hỗ trợ) → không throw ra ngoài, optimistic state vẫn giữ

useTaskActivity.test.ts (dùng vi.useFakeTimers, theo pattern useWorkflowExecution.test.ts)
├── mount với taskId → gọi task.get ngay lần đầu (không đợi hết interval)
├── advance 4000ms → gọi task.get lần 2, state.task cập nhật theo response mới
├── unmount → clearInterval, không còn RPC nào sau đó
└── taskId null → không effect nào chạy, không RPC nào

useWorkflow.test.ts (sửa case cũ + thêm case mới)
├── runWorkflow gọi workflow.execute với đúng { templateId, projectId, rootTraceId, requestId } — KHÔNG còn `inputs`/`traceId`
├── saveTemplate (update) gọi workflow.template.update với { id, name, dagJson, scope, parentTemplateId, expectedVersion } — KHÔNG còn `templateId`/`definition`/`traceId`
└── saveTemplate (create) — không đổi, giữ case cũ

TaskPromptEditor.test.tsx (sửa case cũ + thêm case mới)
├── Button KHÔNG disabled khi prompt rỗng (đảo ngược case cũ "disabled khi prompt rỗng")
├── note tĩnh `data-testid="prompt-override-note"` luôn render
└── runWithAgent gửi payload có field `prompt` (giá trị textarea, hoặc undefined nếu rỗng)

TaskDetail.test.tsx (thêm case mới, giữ case cũ)
├── renders ExecutionEngineBadge cạnh nút Run
├── renders AttachWorkflowTemplateAction cạnh nút Run
└── useTaskActivity's polled task status hiển thị lại trong UI (không cần user F5)
```

**Target:** ≥ 20 test case mới/sửa trên 6 file test.

## Verification

```bash
cd frontend && npx vitest run \
  src/renderer/src/components/task/__tests__/TaskDetail.test.tsx \
  src/renderer/src/components/task/__tests__/TaskPromptEditor.test.tsx \
  src/renderer/src/components/task/__tests__/ExecutionEngineBadge.test.tsx \
  src/renderer/src/components/task/__tests__/AttachWorkflowTemplateAction.test.tsx \
  src/renderer/src/hooks/__tests__/useWorkflow.test.ts \
  src/renderer/src/hooks/__tests__/useTaskActivity.test.ts
cd frontend && npx tsc --noEmit -p .
```

Trước khi commit, theo CLAUDE.md's quy tắc bắt buộc:
```
detect_changes({scope: "compare", base_ref: "main"})
```
kỳ vọng: chỉ symbol trong bảng "Files cần sửa" ở trên bị ảnh hưởng; nếu `WorkflowBuilder.tsx`
(caller của `runWorkflow`) xuất hiện trong danh sách "cần cập nhật theo signature mới" — đúng dự
kiến (đổi chữ ký `runWorkflow`, bỏ tham số `inputs`), không phải regression ngoài ý muốn.

## Không làm ở solution này

- **Không đổi `TaskDAGView.tsx`/access-control/share-link UI** — gap riêng, theo dõi ở
  BUG-FE-TASKV1-002/003, không thuộc "liên kết 3 engine" của CR-005.
- **Không xây dashboard Engine 2 thật** (BUG-FE-TASKV1-006's `OrchestrationPage.tsx` storyboard) —
  CR-005 không yêu cầu; đây là 1 CR/feature riêng.
- **Không thêm field `prompt` vào `task.proto`'s `ExecuteRequest`** — việc backend, theo dõi ở
  `specs/backend-go/bugs/task-v1` (đúng CR-005 mục 3's ghi chú).
- **Không tự implement CR-FLOW-TASK-001's `execution_links` bảng hay `selectEngine()` phía backend** —
  `ExecutionEngineBadge` ở đây chỉ là suy luận tạm thời phía client, sẽ đọc field backend thật một khi
  CR-001/002 triển khai (cần 1 solution follow-up đổi `useInferredExecutionEngine` sang đọc trực tiếp
  `task.engine`/`task.workflowTemplateId` từ response `task.get` thay vì suy luận).
- **Không thêm variant `taskActivity` vào `RuntimeClientEvent` hay bridge IPC cho `target.kind ===
  'local'`** — đây là thay đổi ở `shared/runtime-client-events.ts` + `main process`/`preload`, ngoài
  "Tác động" CR-005 khai báo (`components/task/*`, `hooks/*`, `components/workflow/*`); `useTaskActivity`
  ở đây CHỈ polling, đúng fallback CR-005 tự cho phép.
- **Không sửa `workflow.template.create`'s payload** dù phát hiện cùng loại lệch shape — ngoài 2 RPC
  CR-005 mục 3 chốt sửa (`runWorkflow`/`updateTemplate`); ghi nhận làm gap riêng ở "Phần 4" trên.
- **Không sửa `WorkflowBuilder.tsx`/`StepEditor.tsx`/`DAGPreview.tsx`** — CR-005's "Tác động" liệt kê
  `components/workflow/*` nhưng mục 3 chỉ mô tả thay đổi ở `useWorkflow.ts`; caller `WorkflowBuilder.tsx`
  cần cập nhật theo chữ ký `runWorkflow` mới nhưng đó là 1 sửa nhỏ, tách theo dõi task riêng (xem
  "gitnexus impact" ở CR Reference — người implement PHẢI tự chạy impact rồi cập nhật call site, không
  bỏ qua chỉ vì solution này không viết diff sẵn).

## Tham khảo

- [CR-FLOW-TASK-001](../../../../../docs/crs/v3/flow-task/CR-FLOW-TASK-001-three-engine-execution-architecture.md), [CR-FLOW-TASK-003](../../../../../docs/crs/v3/flow-task/CR-FLOW-TASK-003-unified-task-activity-event-catalog.md), [CR-FLOW-TASK-004](../../../../../docs/crs/v3/flow-task/CR-FLOW-TASK-004-backend-go-cutover-and-node-sqlite-retirement.md)
- [BUG-FE-TASKV1-004](../../../../bugs/task-v1/BUG-FE-TASKV1-004-run-agent-ux-gaps.md), [BUG-FE-TASKV1-005](../../../../bugs/task-v1/BUG-FE-TASKV1-005-missing-realtime-event-subscriptions.md), [BUG-FE-TASKV1-007](../../../../bugs/task-v1/BUG-FE-TASKV1-007-workflow-builder-rpc-shape-mismatch.md), [BUG-FE-TASKV1-008](../../../../bugs/task-v1/BUG-FE-TASKV1-008-dual-backend-rpc-contract-drift.md)
- [specs/frontend/tdd/v5/03-runtime-client-layer.md](../../../../tdd/v5/03-runtime-client-layer.md) — tầng `callRuntimeRpc`/`RuntimeClientTarget`
- [specs/frontend/tdd/v5/07-hooks-and-ipc.md](../../../../tdd/v5/07-hooks-and-ipc.md) — pattern hook subscribe event (lưu ý: `window.api.onRuntimeEvent` mô tả ở đây **không tồn tại thật trong code** — grep xác nhận 0 kết quả; TDD doc này aspirational cho phần đó)
- [specs/frontend/tdd/v5/14-workflow-ui.md](../../../../tdd/v5/14-workflow-ui.md), [specs/frontend/tdd/v5/15-task-graph-ui.md](../../../../tdd/v5/15-task-graph-ui.md)
- `backend-go/services/api-gateway/internal/adapter/wscompat/channels_workflow.go`, `channels_automation_task.go` — nguồn sự thật cho mọi shape RPC dùng trong solution này
- `backend-go/proto/orca/task/v1/task.proto`, `backend-go/proto/orca/workflow/v1/workflow.proto` — proto thật xác nhận field còn thiếu (`prompt`, `workflow_template_id`, `inputs`)
