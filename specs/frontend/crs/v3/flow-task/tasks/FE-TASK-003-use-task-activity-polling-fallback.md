# FE-TASK-003: `useTaskActivity` — polling fallback thay theo dõi im lặng sau Run

**Domain:** flow-task
**Solution Ref:** FE-SOL-001 Phần 3
**Priority:** 🟠 P1
**Estimated:** 40 phút
**Status:** [ ] TODO

---

## Mục tiêu

Không nơi nào trong `components/task/` subscribe sự kiện đẩy nào sau khi bấm Run — xác nhận
`grep -rn "subscribeRuntimeEvent\|subscribeRuntimeClientEvents" frontend/src/renderer/src/components/task/`
→ 0 kết quả (BUG-FE-TASKV1-005). `TaskDetail.tsx`'s `handleRunAgent` (dòng 64-87) chỉ `await` 1
lần rồi `toast`, không theo dõi trạng thái task về sau — người dùng phải tự F5/chuyển tab để thấy
`status` đổi. Thêm `useTaskActivity` polling `task.get` theo interval, dùng trong `TaskDetail.tsx`.

## ⚠️ Hard blocker đã biết — ĐÂY LÀ GIỚI HẠN CỐ Ý, KHÔNG PHẢI BUG CỦA TASK NÀY

CR-FLOW-TASK-005 mục 2's pseudocode gốc gọi
`subscribeRuntimeEvent(target, 'task.activity:${taskId}', cb)`. Hàm `subscribeRuntimeEvent` với
chữ ký `(target, channel: string, cb)` **không tồn tại ở bất kỳ đâu trong codebase** — xác nhận
`grep -rn "subscribeRuntimeEvent" frontend/src` → 0 kết quả. Cơ chế push-event thật duy nhất hiện
có là `subscribeRuntimeClientEvents(environmentId, onEvent, onError, onReplayed)`
(`frontend/src/renderer/src/runtime/runtime-client-events.ts:12-36`), với 2 giới hạn xác nhận
được bằng đọc code thật:

1. Chỉ nhận `environmentId: string` — **không có target `'local'`**; Desktop Electron
   (`target.kind === 'local'`) không đi qua đường này.
2. Event bị giới hạn bởi union đóng `isRuntimeClientEvent`
   (`runtime-client-events.ts:60-75`: `reposChanged`/`worktreesChanged`/`sshStateChanged`/
   `linearLinkedIssueUpdated`/`activateWorktree`/`worktreeBaseStatus`/
   `worktreeRemoteBranchConflict`/`worktreeCreateProgress`/`menuCommand`/`windowStateChanged`) —
   **không có variant nào cho task/workflow/orchestration activity.**

**Kết luận:** `useTaskActivity` **không thể** subscribe theo đúng nghĩa CR-FLOW-TASK-003 đặc tả
hôm nay — cả backend (kênh WS `task.activity:{taskId}`, CR-003 🔵 Proposed, chưa triển khai) lẫn
hạ tầng client (thêm 1 variant `RuntimeClientEvent` + bridge IPC cho `target.kind === 'local'`)
đều chưa tồn tại. Task này áp dụng **polling fallback** cho **cả 2** target kind — đúng fallback
CR-005 tự lường trước ở mục "Rủi ro". Không cố gắng vá `subscribeRuntimeEvent`/thêm variant event ở
task này — 2 việc đó đụng `shared/runtime-client-events.ts` + main process/preload, ngoài phạm vi
"Tác động" CR-005 khai báo (`components/task/*`, `hooks/*`).

## Files cần sửa

| File | Action |
|------|--------|
| `frontend/src/renderer/src/hooks/useTaskActivity.ts` | NEW — polling fallback |
| `frontend/src/renderer/src/components/task/TaskDetail.tsx` | MODIFY — dùng `useTaskActivity(task.id)` thay theo dõi im lặng sau `handleRunAgent` |
| `frontend/src/renderer/src/hooks/__tests__/useTaskActivity.test.ts` | NEW |
| `frontend/src/renderer/src/components/task/__tests__/TaskDetail.test.tsx` | MODIFY — case polled task status hiển thị lại |

## Các bước thực thi

Copy gần như nguyên văn code mẫu ở FE-SOL-001 Phần 3 (`useTaskActivity.ts` đầy đủ) — theo đúng
pattern polling đã có ở `useWorkflowExecution.ts:31-57` (cùng interval constant style, cùng
cleanup-on-unmount, cùng comment "why polling"). Điểm cần giữ đúng:

- `TASK_ACTIVITY_POLL_INTERVAL_MS = 4_000` — cùng hằng số `useWorkflowExecution.ts:8` dùng, không
  bịa hằng số mới.
- `isLive: false` cố định trong state — UI dùng field này để phân biệt "đang poll" / "đang nhận
  real-time" một khi kênh WS thật tồn tại. Không xoá field này dù luôn `false` hôm nay.
- RPC dùng: `task.get` — **RPC đã tồn tại** (dùng chung với refetch thủ công hiện có), không phải
  RPC mới; chỉ đổi cách gọi từ "theo action người dùng" sang interval.
- Poll ngay khi mount (không đợi hết interval đầu tiên) — cùng pattern
  `useWorkflowExecution`/`useTaskActivity` mẫu.

Trong `TaskDetail.tsx`, dùng state polled để hiển thị lại status không cần F5 (đóng
BUG-FE-TASKV1-005's phần Task):

```tsx
const { task: polledTask } = useTaskActivity(task.id)
// polledTask?.status đổi ('in_progress' → 'done') tự phản ánh qua polling — cần quyết định khi
// implement: hiển thị polledTask.status thay task.status ở đâu trong UI hiện tại (ví dụ badge
// TaskStatusBadge nếu có, hoặc field Status ở tab Details dòng ~118-131).
```

## Không làm ở task này (task follow-up riêng khi CR-003 xong)

Khi CR-FLOW-TASK-003 (kênh WS backend) **và** `RuntimeClientEvent` có thêm variant `taskActivity`
đều xong, thay thân effect của `useTaskActivity` bằng `subscribeRuntimeClientEvents(...)` cho
target `'environment'` + 1 bridge IPC tương đương cho `'local'` (theo pattern
`window.api.onAutomationEvent` ở `useAutomationDispatchEvents.ts`). Việc này đụng
`preload`/`main process`, cần 1 task riêng, không làm ở đây.

## Test cases cần cover

```
useTaskActivity.test.ts (dùng vi.useFakeTimers, theo pattern useWorkflowExecution.test.ts)
├── mount với taskId → gọi task.get ngay lần đầu (không đợi hết interval)
├── advance 4000ms → gọi task.get lần 2, state.task cập nhật theo response mới
├── unmount → clearInterval, không còn RPC nào sau đó
└── taskId null → không effect nào chạy, không RPC nào

TaskDetail.test.tsx (case mới)
└── useTaskActivity's polled task status hiển thị lại trong UI (không cần user F5)
```

## Verify

```bash
cd frontend && npx vitest run \
  src/renderer/src/hooks/__tests__/useTaskActivity.test.ts \
  src/renderer/src/components/task/__tests__/TaskDetail.test.tsx
cd frontend && npx tsc --noEmit -p .
```

## gitnexus

Chạy trước khi sửa (bắt buộc theo CLAUDE.md):
```
impact({target: "TaskDetail", direction: "upstream"})
```
Task này sửa cùng vùng `TaskDetail.tsx` với FE-TASK-001/FE-TASK-002 — khuyến nghị làm **sau cùng**
trong 3 task để giảm xung đột merge (không phải hard dependency, chỉ là thứ tự thực thi hợp lý vì
cả 3 cùng chỉnh gần `handleRunAgent`/Action Buttons).

## Depends on
Không có (khuyến nghị làm sau FE-TASK-001/FE-TASK-002 để tránh conflict merge trên `TaskDetail.tsx`,
không phải phụ thuộc chức năng)

## Blocking
Không có
