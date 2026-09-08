# FE-TASK-005: Sửa `useWorkflow.ts`'s `saveTemplate()` nhánh update đúng shape `workflow.template.update` thật

**Domain:** flow-task
**Solution Ref:** FE-SOL-001 Phần 4 (nửa sau — `saveTemplate`'s update branch)
**Priority:** 🟠 P1
**Estimated:** 30 phút
**Status:** [ ] TODO

---

## Mục tiêu

CR-FLOW-TASK-005 mục 3 viết "giữ nguyên `workflow.template.update` — method này đã đúng theo
backend-go". Đọc thật `channels_workflow.go:107-129`'s `updateArgs` cho thấy **shape khác hẳn**
field hiện tại `useWorkflow.ts`'s `saveTemplate()` (dòng 56-62) đang gửi:

```go
// channels_workflow.go:108-115 — shape THẬT
type updateArgs struct {
    ID               string `json:"id"`                // KHÔNG PHẢI `templateId`
    Name             string `json:"name"`
    DAGJSON          string `json:"dagJson"`            // string JSON, KHÔNG PHẢI `definition: {steps}`
    Scope            string `json:"scope"`
    ParentTemplateID string `json:"parentTemplateId"`   // hiện không gửi field này
    ExpectedVersion  int32  `json:"expectedVersion"`    // optimistic concurrency — hiện không gửi
}
```

## Files cần sửa

| File | Action |
|------|--------|
| `frontend/src/renderer/src/hooks/useWorkflow.ts` | MODIFY — `saveTemplate()`'s nhánh update, dòng 56-62 |
| `frontend/src/renderer/src/hooks/__tests__/useWorkflow.test.ts` | MODIFY — case dòng 65-79, 81-102 |

## Các bước thực thi

### Sửa nhánh update (`useWorkflow.ts:56-62`)

```typescript
// Trước:
await callRuntimeRpc(target, 'workflow.template.update', {
  templateId,
  name: local.name,
  definition: { steps: local.steps ?? [] },
  scope: local.scope,
  traceId: span.id,
})

// Sau — đúng field name + serialize `steps` thành `dagJson` (string) theo shape backend-go
// thật. `expectedVersion`: WorkflowDefinition (shared/workflow-types.ts) hiện KHÔNG có field
// `version` (xác nhận đọc type — chỉ có id/name/templateId/scope/scopeRefId/steps) — gửi
// `(local as { version?: number }).version ?? 0` tạm thời, chấp nhận luôn ghi đè (mất tính
// năng optimistic-concurrency backend cung cấp) cho tới khi field `version` được thêm vào
// WorkflowDefinition + BE trả về nó. Bỏ `traceId` khỏi payload (không có field này ở
// updateArgs) — span vẫn dùng nội bộ để đo latency qua span.ok()/span.fail().
await callRuntimeRpc(target, 'workflow.template.update', {
  id: templateId,
  name: local.name,
  dagJson: JSON.stringify({ steps: local.steps ?? [] }),
  scope: local.scope,
  parentTemplateId: local.templateId ?? '',
  expectedVersion: (local as { version?: number }).version ?? 0,
})
```

### Cập nhật `useWorkflow.test.ts`

Case dòng 65-79 (`saveTemplate with templateId → calls workflow.template.update`):
```typescript
// Trước: expect.objectContaining({ templateId: 't1' })
// Sau:
expect(mockRpc).toHaveBeenCalledWith('mock-target', 'workflow.template.update', expect.objectContaining({ id: 't1' }))
```

Case dòng 81-102 (assert shape đầy đủ `{ templateId, name, definition, scope, traceId }`) đổi
toàn bộ assertion theo shape mới:
```typescript
expect(params).toMatchObject({
  id: 't1',
  name: 'Existing',
  scope: 'personal',
  dagJson: JSON.stringify({ steps: [{ id: 's1' }] }),
  parentTemplateId: '',
  expectedVersion: 0,
})
expect(params.templateId).toBeUndefined()
expect(params.definition).toBeUndefined()
expect(params.traceId).toBeUndefined()
```

## Giới hạn đã biết — ghi rõ trong PR

- **`expectedVersion` luôn gửi `0`** cho tới khi `WorkflowDefinition` (shared/workflow-types.ts)
  có field `version` thật + backend trả về nó ở `workflow.template.create`/`.resolve`. Nghĩa là
  optimistic-concurrency mà backend cung cấp qua `ExpectedVersion` **không có tác dụng bảo vệ**
  hôm nay — 2 client cùng sửa 1 template vẫn có thể ghi đè lẫn nhau âm thầm (last-write-wins).
  KHÔNG tự mở rộng `WorkflowDefinition`'s type ở task này — `steps[]`/`DAGPreview`/`StepEditor`
  cũng đọc type này, thay đổi ngoài phạm vi CR-FLOW-TASK-005 (chỉ chốt sửa `useWorkflow.ts`).
- **`workflow.template.create`'s payload cùng loại lệch shape KHÔNG được sửa ở task này** —
  `createArgs` (`channels_workflow.go:86-91`: `name`/`dagJson`/`scope`/`parentTemplateId`) cũng
  khác `{...local, traceId}` hiện tại (thiếu `dagJson`, thừa `id`/`traceId`/`steps` sai tên) —
  CR-FLOW-TASK-005 mục 3 chỉ nhắc `runWorkflow`/`updateTemplate`, không nhắc `template.create`.
  Khuyến nghị mở 1 bug/CR riêng cho gap này, không tự sửa ở đây.

## Verify

```bash
cd frontend && npx vitest run src/renderer/src/hooks/__tests__/useWorkflow.test.ts
cd frontend && npx tsc --noEmit -p .
```

## gitnexus

Chạy trước khi sửa (bắt buộc theo CLAUDE.md):
```
impact({target: "useWorkflow", direction: "upstream"})
```
Dán kết quả risk level vào PR — kỳ vọng LOW/tương tự FE-TASK-004 vì cùng file, cùng caller
(`WorkflowBuilder.tsx` gọi `saveTemplate` qua `onClick={saveTemplate}`, dòng 34).

## Depends on
Không có (khuyến nghị làm nối tiếp FE-TASK-004 — cùng file `useWorkflow.ts`, tránh conflict merge)

## Blocking
Không có
