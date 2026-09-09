# FE-TASK-004: Sửa `WorkflowStepType` vocabulary khớp backend `StepType`

**Domain:** workflow
**Solution Ref:** FE-SOL-001 Phần 4
**Priority:** 🟠 P1
**Estimated:** 40 phút
**Status:** ✅ DONE — 2026-09-09 (phần rename an toàn; phần xoá `'approval'` vẫn giữ nguyên, chờ
xác nhận sản phẩm — đúng thiết kế 2 giai đoạn của chính task này, không phải gap bỏ sót)

### Kết quả thực tế

- Grep xác nhận trước khi sửa: đúng 3 chỗ có literal `'notify'` — `shared/workflow-types.ts`,
  `renderer/src/types/workflow-types.ts`, `StepEditor.tsx`'s mảng hardcode dòng 18. Không có call
  site nào khác ngoài 3 chỗ này (khớp phát hiện của task).
- Cả 2 file `workflow-types.ts` (`shared/` và `renderer/src/types/`, file sau sẽ bị xoá ở
  FE-TASK-006 — vẫn sửa đồng bộ ở đây theo đúng "Files cần sửa" của task, tránh lệch tạm thời giữa
  lúc 004 xong và lúc 006 chạy) đổi `WorkflowStepType` thành
  `'agent' | 'shell' | 'notification' | 'webhook' | 'condition' | 'approval'` — `'approval'` GIỮ
  LẠI đúng yêu cầu chờ xác nhận sản phẩm (Hướng A/B trong task chưa có quyết định). Đổi
  `NotifyStepConfig.type` từ `'notify'` sang `'notification'`.
- `StepEditor.tsx`'s dropdown array đổi thành
  `['agent','shell','notification','webhook','condition','approval']`.
- `WorkflowStepType` không resolve được qua `impact()`/`gitnexus` (type alias, không nằm trong call
  graph) — dùng fallback grep task đã tự đề xuất: `grep -rn "'notify'" frontend/src` trước và sau
  edit, xác nhận 0 literal `'notify'` còn sót (chỉ còn trong comment giải thích rename).
- Tạo mới `StepEditor.test.tsx` (chưa tồn tại trước đây dù task ghi "MODIFY") — theo đúng convention
  mock `ui/select` đã dùng ở `ModelSelector.test.tsx` (radix Select không test được đáng tin cậy
  qua interaction thật trong happy-dom). 3 case: dropdown đúng 6 giá trị không còn `notify`,
  `step.type='notification'` → Select nhận đúng `value`, Delete button.
- `npx tsc --noEmit -p .`: không lỗi mới ngoài lỗi `@shared/workflow-types` tiền tồn tại.
- `detect_changes()`: không có execution flow Workflow nào bị ảnh hưởng xấu.

**Chưa làm, đúng chủ đích**: xoá `'approval'` khỏi union + dropdown — chờ xác nhận sản phẩm theo
Hướng A/B trong task doc. Không thêm `action`/`parallel`.

---

## ⚠️ Cần xác nhận sản phẩm trước khi xoá `'approval'` — KHÔNG tự quyết ở task này

FE-SOL-001 §4 tự flag: *"'approval' → BỎ, không có backend tương đương — cần xác nhận với team
trước khi xoá (có thể có kỳ vọng người dùng dù chưa hoạt động thật)."* Task này **giữ nguyên yêu cầu
đó** — phần xoá `'approval'` phải chờ product confirm, không code trước. Xem bước 2 để biết chính
xác cần làm gì trong lúc chờ.

## Mục tiêu

`WorkflowStepType` hiện tại (`'agent'|'shell'|'notify'|'approval'`) lệch với backend `StepType` thật
(`agent|shell|notification|webhook|condition`). `notify` cần đổi tên thành `notification` (rename an
toàn, có ý nghĩa 1-1), còn `approval` cần xác nhận sản phẩm trước khi xử lý.

## Xác nhận đã đọc code thật trước khi viết task (2026-09-09)

- ⚠️ **Phát hiện quan trọng, KHÔNG có trong FE-SOL-001 (mở rộng từ phát hiện ở FE-TASK-003)**:
  `WorkflowStepType` bị định nghĩa **trùng lặp ở 2 file**, và vocabulary sai lệch cần sửa ở **cả 2**
  (khác với `WorkflowExecutionStatus` ở FE-TASK-003, vốn chỉ có ở 1 file):
  - `frontend/src/shared/workflow-types.ts:3` — `WorkflowStepType = 'agent' | 'shell' | 'notify' |
    'approval'`. Dùng bởi `useWorkflow.ts` (tạo step mới, dòng 21-30) + toàn bộ chain thật
    (`WorkflowBuilder.tsx` → `StepList.tsx`/`StepEditor.tsx`).
  - `frontend/src/renderer/src/types/workflow-types.ts:3` — **định nghĩa y hệt**
    `'agent' | 'shell' | 'notify' | 'approval'`. Chỉ `DAGPreview.tsx` import (`WorkflowStep`, không
    trực tiếp `WorkflowStepType`, nhưng `WorkflowStep.type: WorkflowStepType` nên gián tiếp dùng).
  - `StepEditor.tsx` (đọc trực tiếp, dòng 18) **không import type nào cả** — dropdown Type hardcode
    mảng literal `['agent','shell','notify','approval']` ngay trong JSX, tách rời hoàn toàn khỏi cả
    2 file type. **Sửa cả 3 chỗ** (2 file type + `StepEditor.tsx`'s mảng hardcode), thiếu 1 trong 3
    khiến dropdown hiện giá trị không khớp type hoặc ngược lại.
- Backend `StepType` thật xác nhận trực tiếp ở
  [BE-SOL-003 (workflow)](../../../../../backend-go/crs/v4/workflow/solutions/BE-SOL-003-variable-interpolation-and-step-types.md)'s
  citation `step.go:16-23`: `agent|shell|notification|webhook|condition`. `parseStepType` helper
  (`channels_automation_task.go:38-46`, dùng chung cho `workflow.*`/`task.aiDecompose`) parse chuỗi
  UPPERCASE có prefix `STEP_TYPE_` qua `workflowv1.StepType_value` — nghĩa là chuỗi gửi lên phải khớp
  đúng 1 trong 5 tên đó (case-insensitive, tự thêm prefix), sai tên → rơi về
  `STEP_TYPE_UNSPECIFIED`.
- `action`/`parallel` (2 giá trị FE-SOL-001 §4 đề xuất thêm "khi BE-SOL-003 merge") — xác nhận
  `grep -n "action\|parallel" backend-go/proto/orca/workflow/v1/workflow.proto`'s `StepType` enum
  hôm nay **không có** — đúng như solution đã ghi, chưa thêm ở task này.

## Files cần sửa

| File | Action |
|------|--------|
| `frontend/src/shared/workflow-types.ts` | MODIFY — `WorkflowStepType`, `NotifyStepConfig` (dòng 3, 20-25) |
| `frontend/src/renderer/src/types/workflow-types.ts` | MODIFY — `WorkflowStepType`, `NotifyStepConfig` (giữ đồng bộ với file trên) |
| `frontend/src/renderer/src/components/workflow/StepEditor.tsx` | MODIFY — mảng hardcode dòng 18 |
| `frontend/src/renderer/src/hooks/useWorkflow.ts` | KHÔNG cần sửa — `addStep()` (dòng 20-33) tạo step mặc định `type: 'agent'`, không bị ảnh hưởng bởi rename `notify`→`notification` |
| `frontend/src/renderer/src/components/workflow/__tests__/StepEditor.test.tsx` | MODIFY — case dropdown hiện đúng 5 giá trị mới |

## Các bước thực thi

### 1. Rename `notify` → `notification` ở cả 2 file type

```typescript
// frontend/src/shared/workflow-types.ts VÀ frontend/src/renderer/src/types/workflow-types.ts
// — sửa giống hệt nhau ở cả 2 file
export type WorkflowStepType = 'agent' | 'shell' | 'notification' | 'webhook' | 'condition'

export type NotifyStepConfig = {
  type:    'notification'   // đổi từ 'notify'
  message: string
  channel: 'slack' | 'email' | 'webhook'
  target:  string
}
```

`'approval'` **bị bỏ khỏi union** ở bước này theo đúng đề xuất solution — nhưng xem bước 2 ngay
dưới, đây là điểm cần dừng lại chờ xác nhận trước khi merge, không phải "cứ code rồi tính sau".

### 2. Xử lý `'approval'` — CHỜ XÁC NHẬN SẢN PHẨM, không tự quyết

Trước khi xoá `'approval'` khỏi union ở bước 1, **task này dừng lại** ở đây và cần 1 trong 2 hướng do
product/team quyết định, KHÔNG được tự chọn:

- **Hướng A (nếu xác nhận không ai đang dùng approval-gate thật)**: xoá hẳn `'approval'` như bước 1
  đã viết, không thêm gì thay thế. Kiểm tra trước: `grep -rn "type.*===.*'approval'\|'approval'"
  frontend/src/renderer/src/components/workflow/ frontend/src/renderer/src/hooks/` — nếu có bất kỳ
  logic nào rẽ nhánh theo `type === 'approval'` (không chỉ liệt kê trong dropdown), phải xử lý logic
  đó trước khi xoá type, không chỉ xoá type suông.
- **Hướng B (nếu sản phẩm cần approval-gate thật)**: KHÔNG tự chế lại `'approval'` như 1 step type
  workflow — map vào orchestration-service's `DecisionGate` (đã có ở CR-TG-004/
  [BE-SOL-004 (task-graph)](../../../../../backend-go/crs/v4/task-graph/solutions/) theo đúng chỉ
  dẫn của FE-SOL-001 §4). Việc này là 1 CR/task riêng, không mở rộng phạm vi task này.

**Cho tới khi có xác nhận**, giữ `'approval'` trong union (không xoá ở bước 1 thật sự), chỉ đổi
`notify`→`notification` trước — commit riêng phần rename an toàn này, để phần xoá `approval` chờ
quyết định là 1 PR/commit tách biệt, tránh block toàn bộ vocabulary fix vì 1 câu hỏi mở chưa có câu
trả lời:

```typescript
// Trạng thái tạm thời khuyến nghị cho tới khi có xác nhận sản phẩm:
export type WorkflowStepType = 'agent' | 'shell' | 'notification' | 'webhook' | 'condition' | 'approval'
// 'approval' giữ lại tạm thời — chờ xác nhận Hướng A/B ở trên trước khi xoá thật.
```

### 3. Cập nhật `StepEditor.tsx`'s dropdown

```tsx
// StepEditor.tsx — dòng 18
{['agent','shell','notification','webhook','condition','approval'].map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}
// Bỏ 'approval' khỏi mảng này CÙNG LÚC với khi bước 2 được xác nhận xoá khỏi type — không lệch
// giữa dropdown và type union.
```

## Không làm ở task này

- Không thêm `action`/`parallel` — chờ [BE-SOL-003 (workflow)](../../../../../backend-go/crs/v4/workflow/solutions/BE-SOL-003-variable-interpolation-and-step-types.md)
  merge trước, đúng ghi chú của FE-SOL-001 §4.
- Không tự quyết định xoá `'approval'` — bắt buộc chờ xác nhận sản phẩm (xem bước 2).
- Không đổi `ShellStepConfig`/`AgentStepConfig` — chỉ `NotifyStepConfig` bị ảnh hưởng bởi rename.

## Test cases cần cover

```
StepEditor.test.tsx (case cập nhật)
├── dropdown Type hiện đúng: agent, shell, notification, webhook, condition (+ approval nếu chưa
│   xác nhận xoá)
└── step.type='notification' → chọn đúng option tương ứng trong Select (không còn 'notify')

Kiểm tra bằng tsc (không phải vitest case riêng)
└── npx tsc --noEmit -p . xác nhận không còn literal 'notify' nào sót lại gây lỗi type ở bất kỳ
    call site nào khác 2 file type + StepEditor.tsx đã liệt kê
```

## Verify

```bash
cd frontend && npx vitest run src/renderer/src/components/workflow/__tests__/StepEditor.test.tsx
cd frontend && npx tsc --noEmit -p .
# Xác nhận không còn 'notify' cũ sót lại ngoài phạm vi đã sửa:
grep -rn "'notify'" frontend/src/renderer/src frontend/src/shared
```

## gitnexus

Chạy trước khi sửa (bắt buộc theo CLAUDE.md):
```
impact({target: "WorkflowStepType", direction: "upstream"})
```
Đây là 1 type union được dùng ở nhiều component (`StepEditor.tsx`, `StepList.tsx`, `DAGPreview.tsx`
qua `WorkflowStep`, `useWorkflow.ts`) — kỳ vọng risk MEDIUM do rename ảnh hưởng nhiều call site cùng
lúc (đổi tên 1 literal trong union, không phải thêm/bớt component). Dùng `rename` (theo CLAUDE.md's
"NEVER rename symbols with find-and-replace") nếu công cụ hỗ trợ rename literal union member; nếu
không, `grep -rn "'notify'"` trước/sau để xác nhận không sót call site nào. Dán risk level thật vào
PR — **nếu impact trả về HIGH/CRITICAL, dừng lại và báo cáo trước khi tiếp tục sửa**, đúng yêu cầu
CLAUDE.md.

## Depends on

Không có phụ thuộc backend/RPC nào (đây là type-only + 1 dropdown, không có RPC nào gửi step type
trực tiếp qua network theo dạng chuỗi tự do — `parseStepType` ở backend tự parse khi cần). Bước 2
(xoá `approval`) phụ thuộc xác nhận sản phẩm, không phải phụ thuộc kỹ thuật.

## Blocking

Không có
