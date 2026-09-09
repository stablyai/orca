# FE-TASK-002: `WorkflowLibrary` — Template Library/Sharing UI mới

**Domain:** workflow
**Solution Ref:** FE-SOL-001 Phần 2
**Priority:** 🔴 P0 — gap chính ma trận hoàn thành nêu
**Estimated:** 75 phút
**Status:** ✅ DONE — 2026-09-09

### Kết quả thực tế

Làm sau FE-TASK-001, đúng thứ tự phụ thuộc, không có sai lệch đáng kể:

- Tạo mới `useWorkflowLibrary.ts` (hook + `LibraryScope` type riêng, KHÔNG tái dùng
  `WorkflowScope` — đúng phát hiện quan trọng của task về giá trị `'team'` vs `'project'` lệch
  nhau), `WorkflowTemplateCard.tsx`, `WorkflowLibrary.tsx` — cả 3 file mới, không caller cũ nào.
- `WorkspaceLayout.tsx`: mở rộng `workflowView` từ `'monitor'|'builder'` (FE-TASK-001) sang
  `'monitor'|'builder'|'library'`, thêm state `selectedTemplateId`, lazy-load `WorkflowLibrary`,
  nối `WorkflowMonitor`'s `onOpenLibrary` mới → `WorkflowLibrary`'s `onUseTemplate` → set
  `selectedTemplateId` + chuyển sang `'builder'`.
- `WorkflowMonitor.tsx`: thêm nút "Browse Library" (`data-testid="open-library-btn"`, chỉ hiện khi
  có `onOpenLibrary`) cạnh "+ New Workflow"; bấm "+ New Workflow" giờ cũng reset
  `selectedTemplateId` về `undefined` (polish nhỏ ngoài code mẫu gốc — tránh Builder mở nhầm
  template cũ còn sót lại từ lần chọn Library trước).
- Browse/Use hoạt động thật qua `workflow.template.list` (không có search/sort/share thật — đúng
  giới hạn đã biết trước, chờ BE-SOL-005). `onPreview`/`onClone` là no-op đúng như task chỉ định.
- `impact()` xác nhận `WorkspaceLayout` risk LOW (0 upstream) trước khi sửa tiếp.
- Test: 2 file test mới (`useWorkflowLibrary.test.ts` 4 case, `WorkflowLibrary.test.tsx` 6 case) —
  10/10 pass. Test FE-TASK-001 (36 case) chạy lại vẫn pass sau khi mở rộng `workflowView`.
- `npx tsc --noEmit -p .`: không có lỗi mới trong các file đã sửa/tạo — chỉ còn lỗi
  `@shared/workflow-types` tiền tồn tại đã ghi chú ở FE-TASK-001 (ngoài phạm vi task này).
- `detect_changes()`: không có execution flow nào trong nhóm Workflow bị ảnh hưởng xấu.

Gap thật đã biết trước (không phải lỗi phát sinh): search full-text, sort trending/recent,
Share/Clone thật đều chờ BE-SOL-005's `SearchTemplates`/sharing RPC — đúng như task đã flag từ
đầu, không tự chế RPC giả.

---

## Mục tiêu

Xác nhận còn thiếu hoàn toàn: `ls frontend/src/renderer/src/components/workflow/` chỉ có
`DAGPreview.tsx, ExecutionMonitor.tsx, StepEditor.tsx, StepList.tsx, StepStatusBadge.tsx,
WorkflowBuilder.tsx, WorkflowMonitor.tsx` — không có library/browse/share component nào. Đây là
**gap ưu tiên cao nhất** theo ma trận hoàn thành CR-WF-006.

## Xác nhận đã đọc code thật trước khi viết task (2026-09-09)

- `workflow.template.list` **đã tồn tại thật**
  (`backend-go/services/api-gateway/internal/adapter/wscompat/channels_workflow.go:179-200`), args
  `{scope, pageToken, pageSize}`, trả `{templates: WorkflowTemplate[], nextPageToken}` — **không có
  tham số search/text filter nào**. `SearchTemplates` (text + tag filter, sort trending/recent) là
  RPC **mới**, 📋 Proposed ở
  [BE-SOL-005](../../../../../backend-go/crs/v4/workflow/solutions/BE-SOL-005-template-sharing-library-and-list-executions.md)
  — xác nhận `grep -n "SearchTemplates" backend-go/services/api-gateway/internal/adapter/wscompat/channels_workflow.go`
  = 0 kết quả. Sharing RPC (`share`/`clone` tracking) cũng chưa có wire channel nào.
- ⚠️ **Phát hiện quan trọng, KHÔNG có trong FE-SOL-001**: backend's `WorkflowTemplate.scope` field
  (`task.proto`... à nhầm, đúng là `workflow.proto:67`) có comment giá trị hợp lệ
  **`"company" | "team" | "personal"`** — nhưng frontend's `WorkflowScope` type
  (`frontend/src/shared/workflow-types.ts:4`, dùng cho `WorkflowDefinition.scope` cục bộ) lại là
  **`'personal' | 'project' | 'company'`** — dùng `'project'` thay vì `'team'`. Đây là 2 khái niệm
  khác nhau (scope của 1 `WorkflowDefinition` cục bộ vs. scope filter của RPC list/search phía
  server) tình cờ gần giống tên nhưng lệch giá trị — **KHÔNG tái dùng `WorkflowScope` type cho tham
  số scope của `WorkflowLibrary`/`useWorkflowLibrary`**, dùng thẳng union string riêng khớp giá trị
  RPC thật (`'company' | 'team' | 'personal'`) để tránh gán nhầm `'project'` vào 1 chỗ backend đọc
  là `'team'`.
- `components/ui/` đã có sẵn `card.tsx`, `badge.tsx`, `tabs.tsx`, `input.tsx` — dùng nguyên, không tự
  vẽ component cơ bản mới, đúng AGENTS.md's Design System.
- Store's `templates: WorkflowDefinition[]` (`store/slices/workflow.ts:11`) là danh sách cục bộ của
  template người dùng đang mở trong Builder — **không phải** cùng khái niệm với danh sách Library
  (Library liệt kê template từ server theo scope, có thể nhiều hơn/khác những gì đã load vào store).
  `useWorkflowLibrary` giữ state riêng, không ghi đè `s.templates`.

## Files cần sửa

| File | Action |
|------|--------|
| `frontend/src/renderer/src/hooks/useWorkflowLibrary.ts` | NEW |
| `frontend/src/renderer/src/components/workflow/WorkflowLibrary.tsx` | NEW |
| `frontend/src/renderer/src/components/workflow/WorkflowTemplateCard.tsx` | NEW |
| `frontend/src/renderer/src/components/workspace/WorkspaceLayout.tsx` | MODIFY — thêm `workflowView: 'monitor' \| 'builder' \| 'library'`, nút truy cập Library (nối tiếp FE-TASK-001's toggle) |
| `frontend/src/renderer/src/hooks/__tests__/useWorkflowLibrary.test.ts` | NEW |
| `frontend/src/renderer/src/components/workflow/__tests__/WorkflowLibrary.test.tsx` | NEW |

## Các bước thực thi

### 1. Tạo `useWorkflowLibrary.ts` — dùng `workflow.template.list` thật hôm nay (không chờ SearchTemplates)

```typescript
import { useState, useEffect, useCallback } from 'react'
import { useAppStore } from '../store'
import { callRuntimeRpc, getActiveRuntimeTarget } from '../runtime/runtime-rpc-client'
import type { WorkflowDefinition } from '@shared/workflow-types'

// Giá trị THẬT khớp workflow.proto:67/162 — KHÔNG dùng WorkflowScope (đó là khái niệm khác,
// scope cục bộ của 1 WorkflowDefinition, có 'project' thay vì 'team').
export type LibraryScope = 'company' | 'team' | 'personal'

export function useWorkflowLibrary(scope: LibraryScope, search: string) {
  const [templates, setTemplates] = useState<WorkflowDefinition[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(false)
    try {
      const target = getActiveRuntimeTarget(useAppStore.getState().settings)
      const result = await callRuntimeRpc<{ templates: WorkflowDefinition[] }>(
        target, 'workflow.template.list', { scope }
      )
      // workflow.template.list KHÔNG hỗ trợ search server-side (chưa có SearchTemplates) —
      // lọc client-side tạm thời trên tập đã load; nâng cấp sang server-side search khi
      // BE-SOL-005's SearchTemplates merge (không đổi chữ ký hook, chỉ đổi thân hàm này).
      const filtered = search.trim()
        ? result.templates.filter((t) => t.name.toLowerCase().includes(search.trim().toLowerCase()))
        : result.templates
      setTemplates(filtered)
    } catch {
      setLoadError(true)
    } finally {
      setLoading(false)
    }
  }, [scope, search])

  useEffect(() => {
    void load()
  }, [load])

  return { templates, loading, loadError, reload: load }
}
```

### 2. Tạo `WorkflowTemplateCard.tsx`

```tsx
import { Card, CardHeader, CardTitle, CardContent } from '../ui/card'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import type { WorkflowDefinition } from '@shared/workflow-types'

export function WorkflowTemplateCard({
  template, onUse, onPreview, onClone
}: {
  template: WorkflowDefinition
  onUse: () => void
  onPreview: () => void
  onClone: () => void
}) {
  return (
    <Card data-testid={`template-card-${template.id}`}>
      <CardHeader>
        <CardTitle className="text-sm flex items-center justify-between">
          {template.name}
          <Badge variant="outline">{template.steps.length} steps</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex gap-2">
        <Button size="sm" onClick={onUse} data-testid="template-use">Use</Button>
        <Button size="sm" variant="outline" onClick={onPreview} data-testid="template-preview">Preview</Button>
        <Button size="sm" variant="outline" onClick={onClone} data-testid="template-clone">Clone</Button>
      </CardContent>
    </Card>
  )
}
```

`onShare`/`ShareDialog` từ code mẫu gốc FE-SOL-001 §2 **không đưa vào task này** — xem mục "Không
làm ở task này".

### 3. Tạo `WorkflowLibrary.tsx`

```tsx
import { useState } from 'react'
import { useWorkflowLibrary, type LibraryScope } from '../../hooks/useWorkflowLibrary'
import { WorkflowTemplateCard } from './WorkflowTemplateCard'
import { Input } from '../ui/input'
import { Tabs, TabsList, TabsTrigger } from '../ui/tabs'

export function WorkflowLibrary({
  onUseTemplate
}: {
  onUseTemplate: (templateId: string) => void
}) {
  const [scope, setScope] = useState<LibraryScope>('company')
  const [search, setSearch] = useState('')
  const { templates, loading, loadError } = useWorkflowLibrary(scope, search)

  return (
    <div className="workflow-library space-y-3 p-2" data-testid="workflow-library">
      <Input
        placeholder="Search templates..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        data-testid="library-search"
      />
      <Tabs value={scope} onValueChange={(v) => setScope(v as LibraryScope)}>
        <TabsList>
          <TabsTrigger value="company">Company Standards</TabsTrigger>
          <TabsTrigger value="team">Team Templates</TabsTrigger>
          <TabsTrigger value="personal">My Workflows</TabsTrigger>
        </TabsList>
      </Tabs>
      {loading ? (
        <div className="text-xs text-muted-foreground" data-testid="library-loading">Loading...</div>
      ) : loadError ? (
        <div className="text-xs text-destructive" data-testid="library-error">Failed to load templates.</div>
      ) : templates.length === 0 ? (
        <div className="text-xs text-muted-foreground" data-testid="library-empty">No templates in this scope yet.</div>
      ) : (
        <div className="grid grid-cols-3 gap-3">
          {templates.map((t) => (
            <WorkflowTemplateCard
              key={t.id}
              template={t}
              onUse={() => onUseTemplate(t.id)}
              onPreview={() => {}}
              onClone={() => {}}
            />
          ))}
        </div>
      )}
    </div>
  )
}
```

`onPreview`/`onClone` để no-op ở task này (xem mục "Không làm ở task này") — chỉ `onUse` (mở
template đã chọn trong Builder) hoạt động thật, đúng cách duy nhất template thật sự dùng được hôm
nay là mở trong Builder rồi Save/Run (không có RPC clone thật).

### 4. Gắn vào `WorkspaceLayout.tsx` (nối tiếp FE-TASK-001's toggle)

```tsx
// WorkspaceLayout.tsx — mở rộng workflowView từ FE-TASK-001
const [workflowView, setWorkflowView] = useState<'monitor' | 'builder' | 'library'>('monitor')
const WorkflowLibrary = lazy(() => import('../workflow/WorkflowLibrary').then(m => ({ default: m.WorkflowLibrary })))

{activeTab === 'workflows' && (
  workflowView === 'library' ? (
    <WorkflowLibrary onUseTemplate={(id) => { setSelectedTemplateId(id); setWorkflowView('builder') }} />
  ) : workflowView === 'builder' ? (
    <WorkflowBuilder templateId={selectedTemplateId} projectId={project.id} onSave={() => setWorkflowView('monitor')} />
  ) : (
    <WorkflowMonitor projectId={project.id} onNewWorkflow={() => setWorkflowView('builder')} onOpenLibrary={() => setWorkflowView('library')} />
  )
)}
```

Cần thêm state `selectedTemplateId` (khởi tạo `undefined`) và prop `onOpenLibrary` mới cho
`WorkflowMonitor` (nút "Browse Library" cạnh "+ New Workflow" từ FE-TASK-001) — chi tiết UI nút này
là polish nhỏ, không lặp lại toàn bộ code `WorkflowMonitor.tsx` ở đây vì FE-TASK-001 đã sửa file này
trước.

## Không làm ở task này

- **Không implement Share/Clone thật** — không có RPC `share`/`clone` nào tồn tại hôm nay (chỉ có
  trong đề xuất BE-SOL-005). `onClone`/`onPreview` để no-op, không tự chế RPC giả hoặc optimistic
  clone (khác với Board view's optimistic update ở task-graph series — ở đây không có cách nào để
  "clone" đúng nghĩa nếu không tạo template mới qua `workflow.template.create` với nội dung copy,
  việc đó nên là 1 task follow-up rõ ràng khi cần, không lẫn vào task Library ban đầu).
- **Không implement search server-side** — filter client-side tạm thời trên kết quả `scope` đã load,
  nâng cấp lên `SearchTemplates` là việc của 1 task follow-up khi BE-SOL-005 merge.
- Không đổi `WorkflowBuilder.tsx`'s cách nhận `templateId` — Library chỉ set state cha rồi truyền
  xuống, không đổi API của Builder.

## Test cases cần cover

```
useWorkflowLibrary.test.ts
├── mount với scope='company' → gọi workflow.template.list({scope:'company'})
├── đổi scope → gọi lại RPC với scope mới
├── search không rỗng → lọc client-side đúng theo tên (case-insensitive)
└── RPC lỗi → loadError=true, templates=[]

WorkflowLibrary.test.tsx
├── render 3 tab company/team/personal, mặc định company
├── templates rỗng → hiện "No templates in this scope yet."
├── click "Use" trên 1 card → gọi onUseTemplate(templateId)
└── gõ vào search input → useWorkflowLibrary nhận đúng search value mới
```

## Verify

```bash
cd frontend && npx vitest run \
  src/renderer/src/hooks/__tests__/useWorkflowLibrary.test.ts \
  src/renderer/src/components/workflow/__tests__/WorkflowLibrary.test.tsx
cd frontend && npx tsc --noEmit -p .
```

## gitnexus

Chạy trước khi sửa (bắt buộc theo CLAUDE.md):
```
impact({target: "WorkspaceLayout", direction: "upstream"})
```
Task này nối tiếp thay đổi của FE-TASK-001 trên cùng file — làm SAU FE-TASK-001 trong cùng PR hoặc
PR liền kề để tránh conflict merge trên `workflowView` state. Risk dự kiến LOW cho các file mới
(`WorkflowLibrary.tsx`/`WorkflowTemplateCard.tsx`/`useWorkflowLibrary.ts` là file mới, không caller
nào cũ). Dán kết quả thật vào PR.

## Depends on

FE-TASK-001 (cần `workflowView` state + lazy-load pattern đã thêm ở `WorkspaceLayout.tsx`). Về mặt
backend: `workflow.template.list` đã tồn tại thật, đủ để scaffold + demo Library hôm nay; **để có
search full-text + sort trending/recent + Share/Clone thật**, cần
[BE-SOL-005](../../../../../backend-go/crs/v4/workflow/solutions/BE-SOL-005-template-sharing-library-and-list-executions.md)'s
`SearchTemplates`/sharing RPC (📋 Proposed) — không phải hard blocker cho việc ship phần Browse/Use
trước.

## Blocking

Không có
