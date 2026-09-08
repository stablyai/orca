# BUG-FE-TASKV1-007 — `useWorkflow.ts`'s `runWorkflow()` gửi thiếu field `definition` bắt buộc → `workflow.execute` chắc chắn lỗi trên production hôm nay

**Mức độ:** 🔴 Critical
**Status:** 🔴 Open
**Module:** `frontend/src/renderer/src/hooks/useWorkflow.ts`
**Phát hiện:** 2026-09-08 (audit frontend vs 3 hệ Task: OrcaTask/Task Execute/Workflow Orchestration)

---

## Mô tả

### 1. `runWorkflow()` — thiếu field `definition` bắt buộc (Critical, xảy ra hôm nay)

`useWorkflow.ts`'s `runWorkflow()` (dòng 75-99) gọi:

```ts
const result = await callRuntimeRpc<{ id: string }>(target, 'workflow.execute', { templateId, inputs, traceId: span.id })
```

— chỉ gửi `templateId`, `inputs`, `traceId`. Nhưng **cả 2 bản backend Node**
đang chạy thật (`desktop/src/main/workflow/workflow-rpc-handler.ts` cho
Electron desktop, VÀ `backend/src/main/workflow/workflow-rpc-handler.ts` cho
server/web mode — bản mà `deploy/prod/docker-compose.yml` build thành image
`orca-server` theo `CR-FLOW-TASK-004`) đều định nghĩa:

```ts
const ExecuteParam = z.object({
  definition: WorkflowDefinitionSchema,   // BẮT BUỘC — không .optional()
  inputs: z.record(z.unknown()).optional(),
  projectId: z.string().optional(),
  traceId: z.string().optional(),
})
```

(`backend/src/main/workflow/workflow-rpc-handler.ts:58-63`, giống hệt ở
`desktop/src/main/workflow/workflow-rpc-handler.ts:46-51`). `definition` là
field **bắt buộc** (không `.optional()`) và **không có field `templateId`
nào trong schema cả 2 backend** — Zod `.parse()` sẽ throw ngay khi thiếu
`definition`, bất kể `templateId` có được gửi kèm hay không. Điều này nghĩa
là: **mọi lần bấm nút "Run" trên `WorkflowBuilder.tsx`** (dòng 34:
`<Button onClick={() => runWorkflow()} data-testid="run-workflow-btn">Run</Button>`)
**đều lỗi runtime** trên cả desktop Electron lẫn server/web mode hiện đang
chạy production — không phải rủi ro tiềm ẩn, mà là bug đang xảy ra thật mỗi
lần dùng tính năng.

`backend-go`'s `ExecuteRequest` (`workflow.proto:84-89`) lại dùng
`template_id` (không có `definition`, và cũng **không có field `inputs`**) —
xác nhận code frontend hiện tại được viết theo shape `backend-go` trong khi
2 backend Node đang phục vụ traffic thật đều yêu cầu shape ngược lại
(`definition`, không `templateId`). Đây là hệ quả trực tiếp của việc chưa có
"Pha 0" (đóng băng theo 1 shape duy nhất) như `CR-FLOW-TASK-004` đề xuất.

### 2. `workflow.template.update` — brief gốc đã LỖI THỜI, method này ĐÃ tồn tại (đính chính)

Task brief ban đầu cho rằng `workflow.template.update` "KHÔNG TỒN TẠI trên
backend Node — chỉ tồn tại ở backend-go". Đọc code thật xác nhận claim này
**đã lỗi thời/không chính xác** với hiện trạng: `backend/src/main/workflow/workflow-rpc-handler.ts:103-110,
268-271` (server/web mode) **CÓ** `workflow.template.update` — đã được sửa
đúng shape từ trước (comment tại `useWorkflow.ts:52-55` tham chiếu
`BUG-FE-RPC-006`, xác nhận bởi `backend/src/main/workflow/__tests__/TemplateResolver.test.ts:100`
và `specs/frontend/api/rpc-catalog.md:521`). Tuy nhiên method này **VẪN KHÔNG
TỒN TẠI** ở `desktop/src/main/workflow/workflow-rpc-handler.ts` (chỉ có 7
method: execute/getExecution/listExecutions/cancel/template.create/list/resolve
— xác nhận đọc toàn bộ danh sách factory function, dòng 5-8 + dòng 90). Vậy
hiện trạng chính xác là:

| Deploy target | `workflow.template.update` |
|---|---|
| Server/Web mode (`backend/src/main`) | ✅ Tồn tại, đúng shape (đã fix BUG-FE-RPC-006) |
| Desktop Electron (`desktop/src/main`) | ❌ Không tồn tại — chỉ 7/10 method |
| `backend-go` | ✅ Tồn tại (`UpdateTemplate` tương đương, chưa audit chi tiết ở đây) |

Nghĩa là: nếu người dùng Desktop Electron cố "Save" 1 template đã tồn tại
(`saveTemplate()`, `useWorkflow.ts:46-73`, nhánh `if (templateId)`), RPC
dispatcher sẽ trả lỗi "method not found" — bug thật nhưng khác bản chất so
với brief gốc mô tả (không phải "chưa tồn tại ở bất kỳ Node backend nào", mà
là "tồn tại không đồng nhất giữa 2 bản Node").

### 3. Step type mismatch giữa FE và cả 2 backend (phát hiện thêm, không có trong brief gốc)

`shared/workflow-types.ts:3` định nghĩa
`WorkflowStepType = 'agent' | 'shell' | 'notify' | 'approval'`, và
`StepEditor.tsx:18` cho user chọn đúng 4 giá trị này trong dropdown "Type".
Nhưng `WorkflowStepConfigSchema` ở **cả 2 backend Node**
(`backend/src/main/workflow/workflow-rpc-handler.ts:38-41`) chỉ chấp nhận
`'agent' | 'shell' | 'webhook' | 'notification' | 'condition'` — không có
`'approval'` (thiếu hoàn toàn ở backend), và tên gọi `'notify'` (FE) lệch với
`'notification'` (backend). `backend-go`'s `StepType` enum (`workflow.proto:53-59`)
cũng dùng `STEP_TYPE_NOTIFICATION`/`STEP_TYPE_WEBHOOK`/`STEP_TYPE_CONDITION`,
không có tương đương `approval`. Vậy nếu user chọn "notify" hoặc "approval"
trong `StepEditor.tsx` rồi Save/Run, cả 2 backend sẽ reject giá trị `type`
không hợp lệ ở `config.type` (do `WorkflowStepConfigSchema.type` là
`z.enum(...)`, không khớp `'notify'`/`'approval'`).

### Nhận xét về BUG-FE-WF-001 (yêu cầu xác nhận theo brief)

`specs/frontend/bugs/workflow-orchestration/BUG-FE-WF-001-workflow-builder-ui-not-implemented.md`
khẳng định "Workflow Builder UI không tồn tại", liệt kê
`workflow-builder.tsx`/`workflow-template-library.tsx`/`workflow-execution-monitor.tsx`
là "Files không tồn tại". Đọc code thật xác nhận claim này **đã lỗi thời**:
`components/workflow/WorkflowBuilder.tsx` (75 dòng), `StepEditor.tsx` (52
dòng), `DAGPreview.tsx` (137 dòng), `WorkflowMonitor.tsx` (96 dòng) đều **tồn
tại thật, có UI thật** (drag-reorder step qua `@dnd-kit/sortable`, DAG preview
qua `@xyflow/react`, danh sách execution + drill-down qua
`ExecutionMonitor` — `WorkflowMonitor.tsx:1-3` ghi rõ đây là "CR-PW-003 fix;
was a static stub"). Vấn đề thật của Workflow UI hiện nay **không phải "chưa
tồn tại"** mà là **RPC shape mismatch** như mô tả ở mục 1-3 phía trên.
Khuyến nghị người sở hữu thư mục `workflow-orchestration/` xác minh lại và
đóng/cập nhật `BUG-FE-WF-001` — bug hiện tại **không** tự ý sửa/xoá file đó.

## Hậu quả

- **Mọi lần bấm "Run"** trên `WorkflowBuilder.tsx` lỗi ngay lập tức trên
  production — tính năng chạy workflow từ UI **hoàn toàn không dùng được**,
  mức độ Critical vì ảnh hưởng 100% user cố dùng tính năng, không phải edge
  case.
- Desktop Electron: "Save" 1 template đã tồn tại (update, không phải create)
  lỗi "method not found" — chỉ nhánh create (`workflow.template.create`, vẫn
  tồn tại ở cả 2 Node backend) hoạt động.
- Step type "notify"/"approval" chọn được trong UI nhưng backend chắc chắn
  reject khi save/run — silent trap khác cho user.

## Bằng chứng

```
frontend/src/renderer/src/hooks/useWorkflow.ts:82                              → runWorkflow() gửi { templateId, inputs, traceId } — thiếu `definition`
backend/src/main/workflow/workflow-rpc-handler.ts:58-63                        → ExecuteParam.definition bắt buộc (không .optional()), không có field templateId
desktop/src/main/workflow/workflow-rpc-handler.ts:46-51                        → schema Desktop giống hệt bản server — cùng lỗi
backend-go/proto/orca/workflow/v1/workflow.proto:84-89                         → ExecuteRequest dùng template_id, không có definition/inputs — xác nhận FE viết theo shape backend-go
frontend/src/renderer/src/hooks/useWorkflow.ts:46-73                           → saveTemplate(), nhánh update gọi workflow.template.update
backend/src/main/workflow/workflow-rpc-handler.ts:103-110,268-271              → workflow.template.update TỒN TẠI ở server/web mode (đã fix BUG-FE-RPC-006)
desktop/src/main/workflow/workflow-rpc-handler.ts:1-9,85-90                    → chỉ 7 method, KHÔNG có workflow.template.update ở Desktop Electron
frontend/src/shared/workflow-types.ts:3                                       → WorkflowStepType = 'agent'|'shell'|'notify'|'approval'
frontend/src/renderer/src/components/workflow/StepEditor.tsx:18               → dropdown cho chọn đúng 4 giá trị trên
backend/src/main/workflow/workflow-rpc-handler.ts:38-41                       → WorkflowStepConfigSchema chỉ nhận 'agent'|'shell'|'webhook'|'notification'|'condition' — lệch tên & thiếu 'approval'
```

## Đề xuất fix

1. **Ưu tiên khẩn cấp:** sửa `runWorkflow()` gửi đúng shape 2 backend Node đang chạy thật — build `definition` từ `local.steps` (tương tự cách `saveTemplate()` đã làm ở nhánh update, dòng 59) thay vì gửi `templateId` trần. Theo `CR-FLOW-TASK-005` mục 3, hướng dài hạn là chuyển hẳn sang shape `backend-go` (`templateId`, bỏ `definition`) — nhưng chỉ làm vậy AN TOÀN sau khi `CR-FLOW-TASK-004` Pha 3 (flip production sang backend-go) hoàn tất; cho tới lúc đó, phải sửa theo shape Node đang chạy thật để tính năng dùng được ngay.
2. Thêm 1 lớp thích ứng (adapter) chọn shape gửi đi theo `target`/deploy mode đang active — tránh lặp lại lỗi tương tự khi cutover từng phần (một số target đã sang backend-go, một số chưa) — xem thêm BUG-FE-TASKV1-008.
3. Với `workflow.template.update` trên Desktop Electron: hoặc thêm method này vào `desktop/src/main/workflow/workflow-rpc-handler.ts` (đồng bộ với bản server), hoặc ẩn nút "Save" cho template đã tồn tại khi chạy target Desktop cho tới khi đồng bộ xong.
4. Thống nhất step type giữa FE/backend: đổi `'notify'` → `'notification'`, quyết định giữ hay bỏ `'approval'` (nếu giữ, cần thêm vào backend trước; nếu bỏ, xoá khỏi `WorkflowStepType` và `StepEditor.tsx`).
5. Xác nhận với chủ sở hữu `workflow-orchestration/` để cập nhật/đóng `BUG-FE-WF-001` — không tự sửa file đó trong phạm vi bug này.

## Tham khảo

- Backend liên quan: [BUG-TASKV1-006](../../../backend-go/bugs/task-v1/BUG-TASKV1-006-workflow-target-resolution-and-step-types-gap.md) (thiếu step type action/parallel, thiếu target resolution) + [BUG-TASKV1-008](../../../backend-go/bugs/task-v1/BUG-TASKV1-008-dual-backend-routing-and-postgres-compliance.md) (đối chiếu ExecuteRequest/UpdateTemplate shape 2 backend)
- CR liên quan: docs/crs/v3/flow-task/CR-FLOW-TASK-004-backend-go-cutover-and-node-sqlite-retirement.md (Pha 0 — đóng băng phân kỳ RPC contract)
- CR liên quan: docs/crs/v3/flow-task/CR-FLOW-TASK-005-frontend-unified-task-execution-ui.md mục 3 (chính xác ghi nhận gap `definition`/`templateId`)
- Liên quan: specs/frontend/bugs/workflow-orchestration/BUG-FE-WF-001-workflow-builder-ui-not-implemented.md — **dường như đã lỗi thời**, UI thật đã tồn tại (`WorkflowBuilder.tsx`/`StepEditor.tsx`/`DAGPreview.tsx`/`WorkflowMonitor.tsx`), vấn đề hiện tại là RPC shape mismatch (bug này), khuyến nghị người sở hữu thư mục `workflow-orchestration/` xác minh và đóng/cập nhật BUG-FE-WF-001.
- Liên quan: BUG-FE-TASKV1-008 (root cause tổng hợp — dual backend RPC contract drift)
