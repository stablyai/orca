# TASK-FE-TASKV1-02 — Progress hiển thị client-side (`computeClientProgress`)

**Solution:** [SOL-FE-TASKV1-001](../solutions/SOL-FE-TASKV1-001-orcatask-crud-va-tree-navigation.md)
**Bug:** [BUG-FE-TASKV1-001](../BUG-FE-TASKV1-001-orcatask-crud-va-tree-navigation.md)
**File:** `frontend/src/renderer/src/hooks/useTasks.ts`, `frontend/src/renderer/src/components/task/TaskCard.tsx`
**Estimated:** 30 phút
**Status:** [ ] TODO
**Phụ thuộc:** Không — độc lập với TASK-FE-TASKV1-01, không cần RPC nào (thuần client-side)

---

## Mục tiêu

Task cha có con (subtask) hiện đang hiển thị `task.progressPercent` **tĩnh** — không có gì tự động
cập nhật số này khi subtask đổi status. `task.recalculateProgress` **không tồn tại ở backend-go**
(0 dòng code tính progress cascade — xác nhận bởi BUG-TASKV1-001), nên fix là ước lượng phía client,
chỉ để hiển thị, không ghi ngược lại store/backend.

---

## Context

Đọc trước:
- `frontend/src/renderer/src/components/task/TaskCard.tsx:17,33-35` — `hasChildren` đã có sẵn qua `useAppStore(s => s.tasks.some(t => t.parentId === task.id))`; dòng 33 hiện đọc thẳng `task.progressPercent`.
- `frontend/src/renderer/src/hooks/useTasks.ts` — nơi thêm hàm export mới (không phải method của hook, có thể export đứng riêng trong cùng file).

## Thay đổi cần thực hiện

**File:** `frontend/src/renderer/src/hooks/useTasks.ts` — thêm export đứng riêng (không nằm trong `useTasks()`):

```typescript
// Progress hiển thị = tỉ lệ subtask trực tiếp có status 'done' — chỉ là ước lượng
// client-side cho tới khi backend-go có calculateProgress() thật (BUG-TASKV1-001).
// KHÔNG ghi đè lên task.progressPercent trong store — trả ra 1 giá trị riêng để
// TaskCard tự quyết định hiển thị cái nào.
export function computeClientProgress(tasks: OrcaTask[], taskId: string): number | null {
  const children = tasks.filter(t => t.parentId === taskId)
  if (children.length === 0) return null // leaf task: dùng progressPercent thật của chính nó
  const done = children.filter(c => c.status === 'done').length
  return Math.round((done / children.length) * 100)
}
```

**File:** `frontend/src/renderer/src/components/task/TaskCard.tsx` — dòng 17, 33-35, dùng
`computeClientProgress` khi `hasChildren === true`:

```tsx
// Before
const hasChildren = useAppStore(s => s.tasks.some(t => t.parentId === task.id))
...
{task.progressPercent > 0 && (
  <span className="text-xs text-muted-foreground">{task.progressPercent}%</span>
)}

// After
const allTasks = useAppStore(s => s.tasks)
const hasChildren = allTasks.some(t => t.parentId === task.id)
const clientProgress = hasChildren ? computeClientProgress(allTasks, task.id) : null
const displayProgress = clientProgress ?? task.progressPercent
{(hasChildren || task.progressPercent > 0) && (
  <span
    className="text-xs text-muted-foreground"
    title={hasChildren ? 'Ước lượng client-side theo subtask done — xem BUG-TASKV1-001' : undefined}
  >
    {displayProgress}%
  </span>
)}
```

> [!IMPORTANT]
> Đổi `useAppStore(s => s.tasks.some(...))` thành đọc `s.tasks` rồi `.some()` ở ngoài selector —
> giữ đúng lý do đã ghi ở `useTasks.ts:8-14` (tránh snapshot đổi mỗi render gây lỗi React #185) —
> `computeClientProgress` cũng cần cùng mảng `allTasks` này, nên đọc 1 lần dùng cho cả 2 việc thay
> vì gọi `useAppStore` hai lần với hai selector khác nhau.

## Verify

```bash
pnpm --filter frontend tsc --noEmit
pnpm --filter frontend test -- TaskCard useTasks
```

Thêm test mới cho `computeClientProgress`: task không con → `null`; task 4 con, 2 done → `50`.

## Definition of Done

- [ ] `computeClientProgress()` export từ `useTasks.ts`, không đổi field `progressPercent` trong store
- [ ] `TaskCard.tsx` hiển thị `clientProgress ?? task.progressPercent`, kèm tooltip giải thích khi là ước lượng
- [ ] Test mới cho `computeClientProgress` (0 con, có con một phần done, toàn bộ done)
- [ ] `pnpm tsc --noEmit` sạch
