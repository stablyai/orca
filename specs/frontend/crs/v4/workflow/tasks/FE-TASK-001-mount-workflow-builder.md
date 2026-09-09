# FE-TASK-001: Mount `WorkflowBuilder` vào `WorkspaceLayout`

**Domain:** workflow
**Solution Ref:** FE-SOL-001 Phần 1
**Priority:** 🟠 P1
**Estimated:** 50 phút
**Status:** ✅ DONE — 2026-09-09

### Kết quả thực tế

Làm đúng như task đã đặc tả, không có sai lệch đáng kể:

- `useWorkflow.ts`'s `runWorkflow(inputs?)` đổi chữ ký thành `runWorkflow(projectId: string)`,
  gửi `{templateId, projectId, rootTraceId, requestId}` cho `workflow.execute` — đúng shape thật
  backend đã sẵn sàng nhận (`channels_workflow.go:36-52`).
- `WorkflowBuilder.tsx` nhận thêm prop `projectId` (bắt buộc) + `onSave` (optional), nút Run gọi
  `runWorkflow(projectId)`, nút Save gọi `saveTemplate()` rồi `onSave?.()`.
- `WorkflowMonitor.tsx` thêm nút "+ New Workflow" (`data-testid="new-workflow-btn"`) + prop
  `onNewWorkflow`.
- `WorkspaceLayout.tsx` thêm state `workflowView: 'monitor' | 'builder'`, lazy-load
  `WorkflowBuilder`, toggle đúng theo bước 4 của task.
- `impact()` xác nhận risk LOW cho cả `runWorkflow` (0 upstream, đúng dự đoán "chỉ 1 caller") và
  `WorkspaceLayout` (0 upstream) trước khi sửa — không có HIGH/CRITICAL.
- Test: cập nhật `useWorkflow.test.ts`, `WorkflowBuilder.test.tsx` (+ case Run mới), thêm case mới
  vào `WorkflowMonitor.test.tsx`, thêm 3 case mới + nút `tab-workflows` vào mock
  `WorkspaceTabBar` trong `WorkspaceLayout.test.tsx`. 36/36 test pass.
- `npx tsc --noEmit -p .` scoped tới các file đã sửa: không có lỗi mới. Có 1 lỗi tsc **tiền tồn
  tại, không liên quan** (`Cannot find module '@shared/workflow-types'`) — do
  `frontend/tsconfig.json` thiếu path mapping `@shared/*` (chỉ có `@renderer`/`@`); mọi file dùng
  `@shared/workflow-types` đều bị lỗi này kể cả trước khi tôi sửa gì (xác nhận bằng `git stash` +
  chạy lại tsc trên code base gốc: 123 lỗi tiền tồn tại). Vitest/Vite không thấy lỗi vì các import
  đó đều là `import type` — bị strip lúc build, chỉ `tsc --noEmit` mới phát hiện. Đây là gap cấu
  hình tsconfig toàn repo, ngoài phạm vi "Files cần sửa" của task này — không tự ý sửa
  `tsconfig.json`.
- `detect_changes()`: touched đúng `useWorkflow`, `WorkflowBuilder`, `WorkflowMonitor`,
  `WorkspaceLayout` — không có execution flow nào trong nhóm Workflow bị ảnh hưởng xấu.

Không có gap thật nào phát sinh ngoài dự đoán của task.

---

## Mục tiêu

`grep -rn "WorkflowBuilder" frontend/src/renderer/src --include="*.tsx"` (loại trừ định nghĩa
component) = 0 kết quả — `WorkflowBuilder` build sẵn từ lâu nhưng **chưa mount ở bất kỳ đâu trong
app thật**. `WorkspaceLayout.tsx`'s tab `'workflows'` (dòng 31, 93) chỉ render `WorkflowMonitor`
(xem executions), không có action nào dẫn tới màn hình tạo/sửa workflow. Thêm nút "+ New Workflow"
trong `WorkflowMonitor`, toggle sang `WorkflowBuilder` trong cùng tab.

## Xác nhận đã đọc code thật trước khi viết task (2026-09-09)

- `WorkspaceLayout.tsx` (đọc trực tiếp) — `WorkspaceTab = 'git' | 'tasks' | 'workflows' | 'agent'`
  (dòng 31), tab `'workflows'` (dòng 93) chỉ có `<WorkflowMonitor projectId={project.id} />`, không
  có state nào để toggle Builder.
- `WorkflowMonitor.tsx` (đọc trực tiếp) — không có nút "+ New Workflow" nào; component chỉ list
  execution + click vào 1 row để xem `ExecutionMonitor`. Cần thêm 1 nút mới ở phần đầu render (dòng
  63-64, trước khối `isLoading`).
- ⚠️ **Phát hiện quan trọng, KHÔNG có trong FE-SOL-001**: `WorkflowBuilder.tsx`'s nút Run
  (dòng 35: `onClick={() => runWorkflow()}`) gọi `useWorkflow.ts`'s `runWorkflow(inputs?)` — đọc
  trực tiếp `useWorkflow.ts` (dòng 98-140) xác nhận hàm này **đã được vá đúng shape RPC thật**
  (BACKLOG-020 — gửi `{templateId, rootTraceId, requestId}`, không còn field `inputs` sai) **nhưng
  KHÔNG gửi `projectId`**, dù chính comment trong file (dòng 109-110) ghi rõ *"workflow.execute's
  real shape is {templateId, projectId, rootTraceId, requestId}"*. Xác nhận `workflow.execute`'s
  wscompat handler thật (`channels_workflow.go:36-52`) **đã decode + forward `ProjectID` đầy đủ**
  vào `ExecuteRequest.ProjectId` — nghĩa là backend sẵn sàng nhận `projectId`, chỉ có
  `useWorkflow.ts` phía frontend đang thiếu gửi field này. Mount `WorkflowBuilder` mà không vá lỗ
  hổng này thì mọi execution chạy từ Builder sẽ có `ProjectId` rỗng ở backend — task này phải vá
  luôn (không tách task riêng, vì "mount cho dùng được" đòi hỏi đúng `projectId` end-to-end).
- `WorkflowBuilder({ templateId }: { templateId?: string })` (dòng 10) — hiện chỉ nhận `templateId`,
  không có prop `projectId` nào.

## Files cần sửa

| File | Action |
|------|--------|
| `frontend/src/renderer/src/hooks/useWorkflow.ts` | MODIFY — `runWorkflow()` nhận thêm `projectId` param, gửi trong payload RPC (dòng 98-118) |
| `frontend/src/renderer/src/components/workflow/WorkflowBuilder.tsx` | MODIFY — thêm prop `projectId`, truyền vào `runWorkflow(projectId)` |
| `frontend/src/renderer/src/components/workflow/WorkflowMonitor.tsx` | MODIFY — thêm nút "+ New Workflow" + prop `onNewWorkflow` |
| `frontend/src/renderer/src/components/workspace/WorkspaceLayout.tsx` | MODIFY — thêm state `workflowView`, lazy-load `WorkflowBuilder`, toggle Monitor/Builder trong tab `'workflows'` (dòng 21-23, 93) |
| `frontend/src/renderer/src/hooks/__tests__/useWorkflow.test.ts` | MODIFY — case `runWorkflow` cập nhật assertion gửi `projectId` |
| `frontend/src/renderer/src/components/workflow/__tests__/WorkflowBuilder.test.tsx` | MODIFY — case Run truyền đúng `projectId` |
| `frontend/src/renderer/src/components/workflow/__tests__/WorkflowMonitor.test.tsx` | MODIFY — case nút "+ New Workflow" gọi `onNewWorkflow` |
| `frontend/src/renderer/src/components/workspace/__tests__/WorkspaceLayout.test.tsx` | MODIFY — case toggle sang Builder |

## Các bước thực thi

### 1. Vá `useWorkflow.ts`'s `runWorkflow()` thêm `projectId`

```typescript
// useWorkflow.ts — dòng 98-118
const runWorkflow = useCallback(
  async (projectId: string) => {
    if (!templateId) {
      toast.error('Save workflow first')
      return null
    }
    const target = getActiveRuntimeTarget(useAppStore.getState().settings)
    const span = Tracers.uiWorkflowExecuteFlow.start({ templateId })
    try {
      // channels_workflow.go:36-52 đã decode + forward projectId đầy đủ — chỉ thiếu
      // gửi từ phía client, vá ở đây (comment cũ trong file đã ghi đúng shape 4 field
      // từ lâu, code chỉ chưa theo kịp).
      const result = await callRuntimeRpc<{ id: string }>(target, 'workflow.execute', {
        templateId,
        projectId,
        rootTraceId: span.id,
        requestId: span.id
      })
      useAppStore.getState().addExecution({
        id: result.id, templateId, status: 'running', startedAt: Date.now(),
        triggeredBy: 'me', definition: local as WorkflowDefinition, rootTraceId: span.id
      })
      span.ok({ executionId: result.id })
      toast.success('Workflow started')
      return result.id
    } catch (err) {
      span.fail(err, { templateId })
      toast.error('Failed to start workflow')
      return null
    }
  },
  [templateId, local]
)
```

### 2. Thêm prop `projectId` vào `WorkflowBuilder.tsx`

```tsx
// WorkflowBuilder.tsx — dòng 10, 35
export function WorkflowBuilder({ templateId, projectId, onSave }: { templateId?: string; projectId: string; onSave?: () => void }) {
  const { template, addStep, removeStep, updateStep, updateTemplate, saveTemplate, runWorkflow } = useWorkflow(templateId)
  // ...
  <Button size="sm" variant="outline" onClick={async () => { await saveTemplate(); onSave?.() }} data-testid="save-workflow-btn">Save</Button>
  <Button size="sm" onClick={() => runWorkflow(projectId)} data-testid="run-workflow-btn">Run</Button>
```

`projectId` bắt buộc (không optional) — khác với v3 flow-task series's FE-TASK-004 từng đề xuất
optional để không phá test cũ khi component còn là orphan; giờ component được mount thật (bước 4),
`projectId` luôn có giá trị thật từ `WorkspaceContext`, không cần fallback rỗng nữa.

### 3. Thêm nút "+ New Workflow" vào `WorkflowMonitor.tsx`

```tsx
// WorkflowMonitor.tsx — dòng 22, 63-64
export function WorkflowMonitor({ projectId, onNewWorkflow }: { projectId: string; onNewWorkflow: () => void }) {
  // ...giữ nguyên load()/useEffect...
  return (
    <div className="workflow-monitor p-4 space-y-2" data-testid="workflow-monitor">
      <div className="flex justify-end">
        <Button size="sm" onClick={onNewWorkflow} data-testid="new-workflow-btn">+ New Workflow</Button>
      </div>
      {/* ...phần isLoading/loadError/executions.map giữ nguyên... */}
```

Cần import `Button` từ `'../ui/button'` (chưa có trong `WorkflowMonitor.tsx` hôm nay).

### 4. Toggle Monitor/Builder trong `WorkspaceLayout.tsx`

```tsx
// WorkspaceLayout.tsx
const WorkflowBuilder = lazy(() =>
  import('../workflow/WorkflowBuilder').then((m) => ({ default: m.WorkflowBuilder }))
)

// Trong component:
const [workflowView, setWorkflowView] = useState<'monitor' | 'builder'>('monitor')

// Dòng 93 — thay thế:
{activeTab === 'workflows' && (
  workflowView === 'builder' ? (
    <WorkflowBuilder projectId={project.id} onSave={() => setWorkflowView('monitor')} />
  ) : (
    <WorkflowMonitor projectId={project.id} onNewWorkflow={() => setWorkflowView('builder')} />
  )
)}
```

Đặt `workflowView` reset về `'monitor'` khi `activeTab` đổi khỏi `'workflows'` là optional polish —
không bắt buộc cho task này (không có bug thật nếu giữ nguyên state khi quay lại tab).

## Không làm ở task này

- Không thêm route/deep-link riêng cho Builder (ví dụ URL param) — chỉ toggle state cục bộ trong
  cùng tab, đúng cách đơn giản nhất FE-SOL-001 §1 đề xuất.
- Không đổi `DAGPreview.tsx`/`StepEditor.tsx`/`StepList.tsx` — ngoài phạm vi "mount", không đụng.
  (step-type vocabulary fix là [FE-TASK-004](./FE-TASK-004-step-type-vocabulary-fix.md) riêng.)
- Không thêm validation "template đã có ít nhất 1 step trước khi Run" — hành vi Run hiện tại (báo
  lỗi qua toast nếu thiếu `templateId`) giữ nguyên, không mở rộng.

## Test cases cần cover

```
useWorkflow.test.ts (case cập nhật)
└── runWorkflow('proj-1') → gọi workflow.execute({templateId, projectId:'proj-1', rootTraceId, requestId})

WorkflowBuilder.test.tsx (case cập nhật)
└── bấm Run → runWorkflow được gọi với đúng projectId prop truyền vào

WorkflowMonitor.test.tsx (case mới)
└── bấm "+ New Workflow" → onNewWorkflow được gọi

WorkspaceLayout.test.tsx (case mới)
├── tab 'workflows', mặc định → render WorkflowMonitor
├── WorkflowMonitor's onNewWorkflow → chuyển sang render WorkflowBuilder
└── WorkflowBuilder's onSave → chuyển lại về WorkflowMonitor
```

## Verify

```bash
cd frontend && npx vitest run \
  src/renderer/src/hooks/__tests__/useWorkflow.test.ts \
  src/renderer/src/components/workflow/__tests__/WorkflowBuilder.test.tsx \
  src/renderer/src/components/workflow/__tests__/WorkflowMonitor.test.tsx \
  src/renderer/src/components/workspace/__tests__/WorkspaceLayout.test.tsx
cd frontend && npx tsc --noEmit -p .
```

## gitnexus

Chạy trước khi sửa (bắt buộc theo CLAUDE.md):
```
impact({target: "useWorkflow", direction: "upstream"})
impact({target: "WorkspaceLayout", direction: "upstream"})
```
`runWorkflow`'s chữ ký đổi từ `(inputs?)` sang `(projectId: string)` bắt buộc — xác nhận không còn
call site nào khác ngoài `WorkflowBuilder.tsx` gọi `runWorkflow()` với 0 tham số trước khi sửa (kỳ
vọng risk LOW, chỉ 1 caller theo ghi nhận hiện tại, nhưng phải xác nhận thật bằng impact trước khi
đổi chữ ký breaking). `WorkspaceLayout` là component cấp cao — kỳ vọng nhiều test cấp app import nó,
xác nhận thêm `workflowView` state không phá bất kỳ snapshot/test cấu trúc nào trước khi kết luận an
toàn. Dán risk level thật vào PR.

## Depends on

Không có (mọi RPC dùng đã tồn tại thật, kể cả `projectId` mà `workflow.execute`'s wscompat handler
đã sẵn sàng nhận).

## Blocking

Không có
