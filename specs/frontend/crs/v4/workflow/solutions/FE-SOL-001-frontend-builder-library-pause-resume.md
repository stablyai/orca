# FE-SOL-001: Mount Workflow Builder, Template Library/Sharing UI, Pause/Resume, step-type vocabulary fix

> **📋 Proposed — chưa triển khai.** Đọc code frontend thật tại thời điểm
> viết (2026-09-09).

## CR Reference

- **CR:** [CR-WF-006](../../../../../../docs/crs/v4/workflow/CR-WF-006-frontend-builder-library-pause-resume.md) — P0 (Library UI) / P1 (còn lại)
- **Phụ thuộc:** [BE-SOL-005](../../../../../backend-go/crs/v4/workflow/solutions/BE-SOL-005-template-sharing-library-and-list-executions.md) (Library UI cần RPC sharing/search) — Pause/Resume + vocabulary fix không phụ thuộc gì, ship trước được

## ⚠️ Cập nhật sau khi viết task (2026-09-09)

Solution này viết chung "workflow-types.ts" không phân biệt — thực tế có
**2 file trùng tên, khác nội dung**: `frontend/src/shared/workflow-types.ts`
(file thật, 7 component/hook dùng) và
`frontend/src/renderer/src/types/workflow-types.ts` (chỉ 1 nơi dùng,
`DAGPreview.tsx`, không liên quan Pause/Resume). Mục 3 dưới đây (và
[FE-TASK-003](../tasks/FE-TASK-003-pause-resume-execution-status-type.md))
phải sửa đúng file `shared/`. Đã mở
[FE-TASK-006](../tasks/FE-TASK-006-consolidate-duplicate-workflow-types.md)
(task mới, không thuộc solution này) để dọn dẹp file trùng lặp, tránh lần
sau lại phải re-verify từ đầu.

## 1. Mount `WorkflowBuilder` (xác nhận còn thiếu)

`grep -rn "WorkflowBuilder" frontend/src/renderer/src --include="*.tsx"`
(loại trừ định nghĩa component) = 0 kết quả — vẫn chưa mount ở đâu.
`WorkspaceLayout.tsx:31,93` xác nhận `WorkspaceTab` chỉ có
`'git'|'tasks'|'workflows'|'agent'`, tab `'workflows'` chỉ render
`WorkflowMonitor`, không có action nào dẫn tới `WorkflowBuilder`.

```tsx
// WorkspaceLayout.tsx
const WorkflowBuilder = lazy(() => import('../workflow/WorkflowBuilder').then(m => ({ default: m.WorkflowBuilder })))
// thêm state cục bộ trong tab 'workflows' để toggle Monitor/Builder, hoặc thêm sub-route —
// đơn giản nhất: nút "+ New Workflow" trong WorkflowMonitor's toolbar mở Builder trong cùng tab
{activeTab === 'workflows' && (
  workflowView === 'builder'
    ? <WorkflowBuilder projectId={project.id} onSave={() => setWorkflowView('monitor')} />
    : <WorkflowMonitor projectId={project.id} onNewWorkflow={() => setWorkflowView('builder')} />
)}
```

## 2. **Workflow Template Library (mới)** — gap chính ma trận hoàn thành nêu

Xác nhận còn thiếu: `ls components/workflow/` chỉ có `DAGPreview.tsx,
ExecutionMonitor.tsx, StepEditor.tsx, StepList.tsx, StepStatusBadge.tsx,
WorkflowBuilder.tsx, WorkflowMonitor.tsx` — không có library/browse/share
component nào.

```tsx
// WorkflowLibrary.tsx (MỚI)
export function WorkflowLibrary({ projectId }: { projectId: string }) {
  const [tab, setTab] = useState<'company' | 'team' | 'personal'>('company')
  const [search, setSearch] = useState('')
  const { templates, loading } = useWorkflowLibrary(tab, search) // hook mới, gọi BE-SOL-005's SearchTemplates
  return (
    <div className="space-y-3 p-2">
      <Input placeholder="Search templates..." value={search} onChange={e => setSearch(e.target.value)} />
      <Tabs value={tab} onValueChange={v => setTab(v as any)}>
        <TabsList>
          <TabsTrigger value="company">Company Standards</TabsTrigger>
          <TabsTrigger value="team">Team Templates</TabsTrigger>
          <TabsTrigger value="personal">My Workflows</TabsTrigger>
        </TabsList>
      </Tabs>
      <div className="grid grid-cols-3 gap-3">
        {templates.map(t => (
          <WorkflowTemplateCard key={t.id} template={t} onUse={() => runFromTemplate(t.id)}
            onPreview={() => setPreview(t)} onClone={() => cloneTemplate(t.id)} onShare={() => setShareTarget(t)} />
        ))}
      </div>
      {shareTarget && <ShareDialog template={shareTarget} onClose={() => setShareTarget(null)} />}
    </div>
  )
}
```

Dùng `Card`/`Badge`/`Tabs` primitives đã có ở `components/ui/`, token màu
theo [`docs/STYLEGUIDE.md`](../../../../../STYLEGUIDE.md) — không tự vẽ
component cơ bản mới.

## 3. Pause/Resume — thêm `'paused'` vào type union trước

Phát hiện khi đọc code thật: `WorkflowExecutionStatus` hiện tại
(`workflow-types.ts`) là `'pending'|'running'|'completed'|'failed'|
'cancelled'` — **thiếu `'paused'`** hoàn toàn, dù backend-go's
`domain.WorkflowExecution.Status` đã có giá trị này
(`workflow-service.md` §4: *"`pending|running|paused|completed|failed|cancelled`"*).
Đây là bước phải làm trước khi thêm nút Pause/Resume, không chỉ là thêm 2
nút vào `ExecutionMonitor.tsx`.

```ts
// workflow-types.ts
export type WorkflowExecutionStatus = 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'
```

```tsx
// ExecutionMonitor.tsx — cạnh nút Cancel hiện có (dòng ~37-42)
{execution.status === 'running' && (
  <Button size="sm" variant="outline" onClick={pauseExecution} data-testid="pause-btn">Pause</Button>
)}
{execution.status === 'paused' && (
  <Button size="sm" variant="outline" onClick={resumeExecution} data-testid="resume-btn">Resume</Button>
)}
```

```ts
// useWorkflowExecution.ts — 2 hàm mới, gọi RPC backend-go đã có thật (channels_workflow.go's workflow.pause/workflow.resume)
const pauseExecution = () => callRuntimeRpc(target, 'workflow.pause', { executionId })
const resumeExecution = () => callRuntimeRpc(target, 'workflow.resume', { executionId })
```

## 4. Sửa step-type vocabulary

Xác nhận: `workflow-types.ts:3` — `WorkflowStepType = 'agent'|'shell'|
'notify'|'approval'` — lệch với backend `StepType` thật
(`agent|shell|notification|webhook|condition`, xác nhận trực tiếp ở
[BE-SOL-003 (workflow)](../../../../../backend-go/crs/v4/workflow/solutions/BE-SOL-003-variable-interpolation-and-step-types.md)'s
citation của `step.go:16-23`).

```ts
// workflow-types.ts
export type WorkflowStepType = 'agent' | 'shell' | 'notification' | 'webhook' | 'condition' | 'action' | 'parallel'
// 'notify' → đổi tên 'notification' cho khớp backend
// 'approval' → BỎ, không có backend tương đương — cần xác nhận với team
//   trước khi xoá (có thể có kỳ vọng người dùng dù chưa hoạt động thật);
//   nếu sản phẩm cần approval-gate thật, map vào orchestration-service's
//   DecisionGate (đã có ở CR-TG-004/BE-SOL-004), không tự chế step type mới.
```

`StepEditor.tsx`'s dropdown cập nhật theo enum mới; thêm option `action`/
`parallel` khi [BE-SOL-003 (workflow)](../../../../../backend-go/crs/v4/workflow/solutions/BE-SOL-003-variable-interpolation-and-step-types.md) merge.

## Not in scope

- Real-time step output trong `ExecutionMonitor` — vẫn poll 4s hiện có cho
  tới [FE-SOL-002](./FE-SOL-002-execution-live-streaming.md).
- Quyết định xoá hẳn `'approval'` — cần xác nhận sản phẩm trước.

## Test plan

- `WorkflowBuilder` truy cập được từ UI thật qua "+ New Workflow".
- Library UI: search/filter/Use/Preview/Clone/Share hoạt động đúng RPC.
- Pause hiện khi `running`, Resume hiện khi `paused`, gọi đúng RPC, UI cập
  nhật ngay không chờ poll kế tiếp.
- `WorkflowStepType` khớp 1-1 backend `StepType` (không còn giá trị FE-only).

## References

- [CR-WF-006](../../../../../../docs/crs/v4/workflow/CR-WF-006-frontend-builder-library-pause-resume.md)
- `frontend/src/renderer/src/types/workflow-types.ts`, `components/workflow/ExecutionMonitor.tsx`, `WorkspaceLayout.tsx:21-31,93`
- `specs/backend-go/tdd/services/workflow-service.md` §4
