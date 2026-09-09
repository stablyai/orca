# FE-TASK-006: Dọn dẹp 2 file `workflow-types.ts` trùng lặp — retire file chết

**Domain:** workflow
**Solution Ref:** không trực tiếp — phát hiện khi làm [FE-TASK-003](./FE-TASK-003-pause-resume-execution-status-type.md), không phải gap của FE-SOL-001/002
**Priority:** 🟡 P2 — technical debt, không chặn chức năng nào, nhưng rủi ro cao cho người sửa sau (sửa nhầm file im lặng không lỗi)
**Estimated:** 30 phút
**Status:** ✅ DONE — 2026-09-09

### Kết quả thực tế

Làm sau FE-TASK-003 (và sau FE-TASK-004, vì cả 2 đều sửa `renderer/src/types/workflow-types.ts`
trước khi nó bị xoá ở đây) đúng thứ tự khuyến nghị:

- `impact({target:"DAGPreview"})` xác nhận risk LOW trước khi sửa.
- Grep xác nhận `renderer/src/types/workflow-types.ts` chỉ có đúng 1 nơi import
  (`DAGPreview.tsx`, dùng `WorkflowStep`) — khớp phát hiện của task.
- Đổi import trong `DAGPreview.tsx` từ `'../../types/workflow-types'` sang
  `@shared/workflow-types`.
- Xoá `frontend/src/renderer/src/types/workflow-types.ts`.
- Grep lại xác nhận 0 tham chiếu còn sót tới file đã xoá.
- `DAGPreview.test.tsx` không cần sửa gì (test dùng `as any` cho `steps`, không import type nào
  trực tiếp từ file đã xoá) — 5/5 test pass không đổi.
- Task doc ghi verify bằng `pnpm typecheck`/`pnpm test -- DAGPreview` — cả 2 script **không tồn
  tại** trong `frontend/package.json` (chỉ có `build`/`dev`/`test`/`test:watch`, và `test` chạy
  toàn bộ suite qua `vitest run --config config/vitest.config.ts`, không nhận filter dạng
  `-- DAGPreview` theo cách `pnpm test -- DAGPreview` kỳ vọng). Dùng tương đương đúng với các task
  khác trong series này: `npx vitest run src/renderer/src/components/workflow/__tests__/
  DAGPreview.test.tsx` + `npx tsc --noEmit -p .` — không lỗi mới ngoài lỗi `@shared/workflow-types`
  tiền tồn tại (xem FE-TASK-001).
- `detect_changes()`: không có execution flow nào bị ảnh hưởng xấu.

Không có gap còn sót — 2 file `workflow-types.ts` giờ chỉ còn 1 (`shared/`), mọi import đã trỏ
đúng.

---

## Mục tiêu

Có **2 file `workflow-types.ts` độc lập** trong frontend, nội dung gần
giống nhau nhưng đã lệch (`diff` xác nhận: khác comment style, khác field
`timeout`, và `frontend/src/shared/workflow-types.ts` có thêm
`WorkflowExecution.rootTraceId?` mà file kia không có):

- `frontend/src/shared/workflow-types.ts` — file **thật sự đang dùng**,
  xác nhận `grep -rln "@shared/workflow-types\|shared/workflow-types'"
  frontend/src` → 7 file (mọi component/hook Workflow thật:
  `useWorkflowExecution.ts`, `useWorkflow.ts`, `ExecutionMonitor.tsx`,
  `WorkflowMonitor.tsx`, `StepStatusBadge.tsx`, `StepList.tsx`,
  `store/slices/workflow.ts`).
- `frontend/src/renderer/src/types/workflow-types.ts` — chỉ **1 nơi**
  import: `DAGPreview.tsx` (chỉ dùng `WorkflowStep`, không dùng
  `WorkflowExecutionStatus`).

Đây chính là bug-magnet đã gây sai lệch thật: [FE-TASK-003](./FE-TASK-003-pause-resume-execution-status-type.md)
phải ghi chú rõ "sửa đúng file `shared/`, không phải file `renderer/src/
types/`" vì FE-SOL-001 chỉ ghi "workflow-types.ts" không phân biệt — nếu
không dọn dẹp, mỗi task sau này chạm vào workflow types đều phải tự re-
verify lại từ đầu.

## Files cần sửa

| File | Action |
|------|--------|
| `frontend/src/renderer/src/types/workflow-types.ts` | XOÁ |
| `frontend/src/renderer/src/components/workflow/DAGPreview.tsx` | MODIFY — đổi import sang `@shared/workflow-types` |
| `frontend/src/renderer/src/components/workflow/__tests__/DAGPreview.test.tsx` | MODIFY — cập nhật import nếu test tự import type trực tiếp |

## Các bước thực thi

### 1. Xác nhận `shared/workflow-types.ts` có đủ mọi export `DAGPreview.tsx` cần

```bash
grep -n "^import.*workflow-types" frontend/src/renderer/src/components/workflow/DAGPreview.tsx
# Xác nhận DAGPreview chỉ dùng WorkflowStep (và có thể WorkflowDefinition) — cả 2 đã có ở shared/workflow-types.ts
```

### 2. Đổi import trong `DAGPreview.tsx`

```diff
- import type { WorkflowStep } from '../../types/workflow-types'
+ import type { WorkflowStep } from '@shared/workflow-types'
```

### 3. Xoá file cũ

```bash
rm frontend/src/renderer/src/types/workflow-types.ts
```

### 4. Build lại để xác nhận không còn import nào trỏ tới file đã xoá

```bash
cd /opt/repos/orca/frontend
grep -rn "renderer/src/types/workflow-types\|'\.\./\.\./types/workflow-types'\|'\.\./types/workflow-types'" src/
# Kỳ vọng: 0 kết quả
pnpm typecheck
```

## Test cases cần cover

- `DAGPreview.tsx` render đúng như trước sau khi đổi import (snapshot/existing test không đổi behavior).
- `pnpm typecheck` sạch, không còn reference nào tới file đã xoá.

## Verify

```bash
cd /opt/repos/orca/frontend
pnpm typecheck
pnpm test -- DAGPreview
```
