# FE-TASK-002: `AttachWorkflowTemplateAction` — dropdown gọi `workflow.template.list`

**Domain:** flow-task
**Solution Ref:** FE-SOL-001 Phần 2
**Priority:** 🟠 P1
**Estimated:** 60 phút
**Status:** [ ] TODO

---

## Mục tiêu

`workflow.template.list` **có thật** ở `backend-go`
(`backend-go/services/api-gateway/internal/adapter/wscompat/channels_workflow.go:179-203` đăng ký
channel này, gọi `WorkflowServiceClient.ListTemplates`) nhưng **0 nơi nào trong `frontend/src` gọi
nó** (xác nhận `grep -rn "workflow.template.list" frontend/src` → 0 kết quả). Thêm dropdown
"Attach Workflow Template" trong `TaskDetail.tsx` để chọn 1 template có sẵn cho task.

## ⚠️ Hard blocker đã biết — đọc trước khi implement

`UpdateTaskRequest` proto (`backend-go/proto/orca/task/v1/task.proto:156-160`) xác nhận:

```protobuf
message UpdateTaskRequest {
  string id = 1;
  google.protobuf.StringValue title = 2;
  google.protobuf.StringValue status = 3;
}
```

**Backend-go hiện KHÔNG có cách nào persist `workflow_template_id` lên 1 task** — chỉ nhận
`title`/`status`. Task này do đó **chỉ set được optimistic client-side state** (đủ để badge ở
FE-TASK-001 hiển thị đúng trong phiên hiện tại), **KHÔNG bền qua reload trang** — lựa chọn mất khi
task được load lại từ backend. Đây là giới hạn CHẤP NHẬN ĐƯỢC theo đúng phạm vi CR-FLOW-TASK-005
(không tự mở rộng backend), nhưng **PHẢI ghi rõ trong PR description** để reviewer/QA không tưởng
nhầm đây là tính năng lưu vĩnh viễn. Việc thêm cột `workflow_template_id` bền vào backend thuộc
CR-FLOW-TASK-002 (chưa triển khai) — theo dõi riêng, không làm ở đây.

## ⚠️ Response `workflow.template.list` mix camelCase/snake_case — đọc kỹ trước khi map

Response serialize **trực tiếp struct Go bằng `encoding/json`**, không qua `protojson`
(`channels_workflow.go:34-45`'s comment tự flag việc này). Field bọc ngoài (`templates`,
`nextPageToken`) là camelCase (build thủ công qua `map[string]any`,
`channels_workflow.go:202`), nhưng field **bên trong mỗi `WorkflowTemplate`** là **snake_case**
(`id`, `tenant_id`, `name`, `dag_json`, `scope`, `parent_template_id`, `version` —
protoc-gen-go's struct tag mặc định). Đây là 1 response mix 2 convention trong **cùng 1 object**
— PHẢI map tường minh field-by-field, không được ép kiểu thẳng (`as WorkflowTemplate[]`).

## Files cần sửa

| File | Action |
|------|--------|
| `frontend/src/renderer/src/components/task/AttachWorkflowTemplateAction.tsx` | NEW |
| `frontend/src/renderer/src/components/task/TaskDetail.tsx` | MODIFY — gắn `<AttachWorkflowTemplateAction task={task} />` vào Action Buttons row (cạnh badge/nút Run, dòng 100-105) |
| `frontend/src/renderer/src/components/task/__tests__/AttachWorkflowTemplateAction.test.tsx` | NEW |
| `frontend/src/renderer/src/components/task/__tests__/TaskDetail.test.tsx` | MODIFY — mock `workflow.template.list` cho dropdown |

## Các bước thực thi

Copy gần như nguyên văn code mẫu ở FE-SOL-001 Phần 2 (`AttachWorkflowTemplateAction.tsx` đầy đủ).
Điểm mấu chốt cần giữ đúng khi implement:

1. **Type map tường minh** — không tái dùng `WorkflowDefinition` (shape hoàn toàn khác:
   `dag_json` string vs `steps[]` object):
   ```typescript
   type RawWorkflowTemplateListItem = { id: string; name: string }
   function toTemplateOption(raw: unknown): { id: string; name: string } | null {
     const r = raw as Partial<RawWorkflowTemplateListItem>
     if (!r.id || !r.name) return null
     return { id: r.id, name: r.name }
   }
   ```
   Chỉ map `id`/`name` (2 field không đổi tên giữa camelCase/snake_case) — đủ cho dropdown, không
   cố map toàn bộ struct.

2. **Attach = optimistic-only** (xem "Hard blocker" ở trên):
   ```typescript
   const attach = async (templateId: string) => {
     useAppStore.getState().updateTask(task.id, { workflowTemplateId: templateId }) // optimistic ngay
     try {
       await updateTask({ workflowTemplateId: templateId } as Partial<OrcaTask>)
     } catch {
       // Best-effort — RPC hiện tại (task.update → UpdateTaskRequest) không có field này để lưu.
     }
   }
   ```

3. Dùng `Select`/`SelectTrigger`/`SelectContent`/`SelectItem` đã có ở `components/ui/select` —
   không tự viết dropdown mới.

## Test cases cần cover

```
AttachWorkflowTemplateAction.test.tsx
├── mount → gọi workflow.template.list, populate dropdown từ res.templates map (id/name)
├── chọn 1 item → gọi task.update với patch { workflowTemplateId } + optimistic store update ngay
├── workflow.template.list lỗi → toast.error, dropdown vẫn render rỗng không crash
└── task.update lỗi (backend field chưa hỗ trợ) → không throw ra ngoài, optimistic state vẫn giữ

TaskDetail.test.tsx (case mới)
└── renders AttachWorkflowTemplateAction cạnh nút Run — mock `workflow.template.list` trả về
    `{ templates: [...] }` trong `mockRpc` hiện có
```

## Verify

```bash
cd frontend && npx vitest run \
  src/renderer/src/components/task/__tests__/AttachWorkflowTemplateAction.test.tsx \
  src/renderer/src/components/task/__tests__/TaskDetail.test.tsx
cd frontend && npx tsc --noEmit -p .
```

## gitnexus

Chạy trước khi sửa (bắt buộc theo CLAUDE.md):
```
impact({target: "TaskDetail", direction: "upstream"})
```
Task này sửa cùng vùng `TaskDetail.tsx` với FE-TASK-001/FE-TASK-003 — chạy lại impact sau khi cả
3 task merge để xác nhận không có regression chồng lấn (`detect_changes`).

## Depends on
FE-TASK-001 (field `OrcaTask.workflowTemplateId` + vùng Action Buttons đã có badge)

## Blocking
Không có
