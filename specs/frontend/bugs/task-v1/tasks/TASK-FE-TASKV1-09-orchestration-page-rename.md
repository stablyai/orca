# TASK-FE-TASKV1-09 — Đổi tên `OrchestrationPage.tsx` → `OrchestrationStoryboard.tsx`

**Solution:** [SOL-FE-TASKV1-006](../solutions/SOL-FE-TASKV1-006-task-execute-orchestration-ui-khong-ton-tai.md) (mục 1)
**Bug:** [BUG-FE-TASKV1-006](../BUG-FE-TASKV1-006-task-execute-orchestration-ui-khong-ton-tai.md)
**File:** `frontend/src/renderer/src/components/feature-wall/agents-orchestration/OrchestrationPage.tsx`
**Estimated:** 15 phút
**Status:** [ ] TODO
**Phụ thuộc:** Không — rename thuần, không đổi hành vi

---

## Mục tiêu

`OrchestrationPage.tsx` chỉ là 1 storyboard tĩnh minh hoạ ý tưởng UI (feature-wall), không phải
trang orchestration thật đang hoạt động — tên gọi hiện tại gây hiểu nhầm cao trong nội bộ team
(theo BUG-FE-TASKV1-006). Đổi tên phản ánh đúng bản chất.

## Context

Xác nhận toàn bộ nơi import bằng grep — chỉ có đúng 1 nơi:

```bash
grep -rln "OrchestrationPage" frontend/src --include="*.tsx" --include="*.ts"
# → agents-orchestration/OrchestrationPage.tsx (chính nó)
# → feature-wall/AgentsOrchestrationVisual.tsx:6,43 (nơi import + dùng)
```

## Thay đổi cần thực hiện

```bash
git mv frontend/src/renderer/src/components/feature-wall/agents-orchestration/OrchestrationPage.tsx \
       frontend/src/renderer/src/components/feature-wall/agents-orchestration/OrchestrationStoryboard.tsx
```

**File:** `OrchestrationStoryboard.tsx` — đổi tên export bên trong file (từ `OrchestrationPage` thành
`OrchestrationStoryboard`, giữ nguyên toàn bộ nội dung/JSX khác).

**File:** `frontend/src/renderer/src/components/feature-wall/AgentsOrchestrationVisual.tsx:6,43`

```tsx
// Before
import { OrchestrationPage } from './agents-orchestration/OrchestrationPage'
...
<OrchestrationPage

// After
import { OrchestrationStoryboard } from './agents-orchestration/OrchestrationStoryboard'
...
<OrchestrationStoryboard
```

## Verify

```bash
pnpm --filter frontend tsc --noEmit
grep -rn "OrchestrationPage" frontend/src
# Phải trả về 0 kết quả (kể cả test/snapshot nếu có)
pnpm --filter frontend test -- AgentsOrchestrationVisual
```

## Definition of Done

- [ ] File đổi tên qua `git mv` (giữ lịch sử), export đổi tên khớp file
- [ ] `AgentsOrchestrationVisual.tsx` cập nhật import + JSX usage
- [ ] `grep -rn "OrchestrationPage" frontend/src` → 0 kết quả
- [ ] `pnpm tsc --noEmit` sạch
