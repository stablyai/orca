# FE-TASK-005: `useTaskActivity` — polling fallback (áp dụng thiết kế có sẵn)

**Domain:** task-graph
**Solution Ref:** FE-SOL-001 Phần 5
**Priority:** 🟠 P1
**Estimated:** 35 phút
**Status:** ✅ DONE — 2026-09-09

### Kết quả thực tế

- `useTaskActivity.ts` (mới): polling `task.get` mỗi `TASK_ACTIVITY_POLL_INTERVAL_MS = 4_000`,
  poll ngay khi mount, `isLive: false` cố định, cleanup `clearInterval` khi unmount/taskId đổi —
  đúng nguyên văn thiết kế của flow-task's FE-TASK-003, không thiết kế lại.
- **Phát hiện + sửa 1 bug thật trong chính spec (cả task-graph's FE-TASK-005 lẫn flow-task's
  FE-TASK-003 gốc đều mắc)**: code mẫu gọi `callRuntimeRpc(target, 'task.get', { taskId })`, nhưng
  đọc code thật `channels.go:299-312` xác nhận handler decode `{ id: string }` (`json:"id"`), KHÔNG
  phải `{ taskId }`. Gửi `{ taskId }` sẽ khiến `ID` luôn rỗng ở backend → `GetTask` thất bại/sai task
  → toàn bộ cơ chế polling fallback không hoạt động thật dù test viết theo đúng mẫu vẫn "pass" (vì
  test tự mock RPC, không phát hiện được sai lệch với backend thật). Đã sửa thành
  `callRuntimeRpc(target, 'task.get', { id: taskId })` — khớp đúng contract backend thật. Ghi chú
  trực tiếp trong code + đề nghị người review đối chiếu lại flow-task's FE-TASK-003 gốc (namespace
  v3) vì bug này có khả năng cũng tồn tại ở đó nếu đã triển khai.
- `TaskDetail.tsx`: đặt `useTaskActivity(task?.id)` sau effect `resolvePermission` của FE-TASK-004
  (đã merge trước trong series này), hiển thị `<TaskStatusBadge status={polledTask?.status ??
  task.status}>` cạnh Status Select — đúng 2 điểm khác biệt task này nêu.
- `impact({target: "TaskDetail", direction: "upstream"})`: risk **LOW** (giống kết quả đã chạy ở
  FE-TASK-004, cùng symbol).
- Test mới: `useTaskActivity.test.ts` (5 case, dùng `vi.useFakeTimers` theo đúng pattern
  `useWorkflowExecution.test.ts`), `TaskDetail.test.tsx` (+1 case: polled status hiển thị qua badge
  thay vì text thô, xác nhận ưu tiên `polledTask.status` khi khác với `task.status` gốc). Kết quả
  `npx vitest run` cho cả 2 file: **16/16 pass**. `npx tsc --noEmit -p .`: 0 lỗi mới.
- Không có gap ngoài giới hạn cố ý đã ghi trong spec (polling, không phải push event thật — chờ
  CR-FLOW-TASK-003 + `RuntimeClientEvent` variant mới, ngoài phạm vi).

---

## Mục tiêu

FE-SOL-001 §5 tự nói rõ: *"áp dụng thiết kế có sẵn, không thiết kế lại"* — implement `useTaskActivity`
theo đúng `CR-FLOW-TASK-005` §2's thiết kế, với fallback polling `task.get` mỗi 4 giây khi kênh
`task.activity:{taskId}` (CR-FLOW-TASK-003) chưa sẵn sàng. Task này **là chính task đó**, đã được
đặc tả đầy đủ ở series flow-task trước — không granularize thêm, chỉ trỏ đúng bản đã có và xác nhận
lại tình trạng hạ tầng chưa đổi.

## Xác nhận đã đọc code thật trước khi viết task (2026-09-09) — tình trạng hạ tầng KHÔNG đổi từ lúc viết flow-task

- `grep -rn "subscribeRuntimeEvent" frontend/src` vẫn = 0 kết quả — hàm này chưa từng tồn tại, đúng
  như xác nhận cũ.
- Cơ chế push-event thật duy nhất vẫn là `subscribeRuntimeClientEvents(environmentId, onEvent,
  onError, onReplayed)` (`frontend/src/renderer/src/runtime/runtime-client-events.ts:12-36`), vẫn
  giới hạn bởi union đóng `isRuntimeClientEvent` (dòng 60-75) — không có variant nào cho
  task/workflow activity, và không nhận target `'local'`.
- `task.get` RPC (`channels.go:311-323`) vẫn tồn tại thật, dùng chung với refetch thủ công hiện có
  của `TaskDetail.tsx`/`useTask.ts` — RPC này không đổi.
- `useWorkflowExecution.ts:8` (`EXECUTION_POLL_INTERVAL_MS = 4_000`) vẫn là pattern polling mẫu duy
  nhất trong codebase để copy — không có pattern thứ 2 nào mới xuất hiện.

**Kết luận: mọi phân tích + code mẫu của
[flow-task's FE-TASK-003](../../../v3/flow-task/tasks/FE-TASK-003-use-task-activity-polling-fallback.md)
vẫn đúng nguyên văn hôm nay.** Task này không viết lại nội dung đó (tránh trùng lặp/rời rạc 2 nguồn
sự thật) — implement theo file đó, chỉ khác 2 điểm nêu ở dưới do bối cảnh task-graph series đã có
thêm UI mới (FE-TASK-001..004 ở series này).

## Files cần sửa

Giống hệt bảng ở
[flow-task's FE-TASK-003](../../../v3/flow-task/tasks/FE-TASK-003-use-task-activity-polling-fallback.md#files-cần-sửa):

| File | Action |
|------|--------|
| `frontend/src/renderer/src/hooks/useTaskActivity.ts` | NEW — polling fallback |
| `frontend/src/renderer/src/components/task/TaskDetail.tsx` | MODIFY — dùng `useTaskActivity(task.id)` thay theo dõi im lặng sau `handleRunAgent` |
| `frontend/src/renderer/src/hooks/__tests__/useTaskActivity.test.ts` | NEW |
| `frontend/src/renderer/src/components/task/__tests__/TaskDetail.test.tsx` | MODIFY — case polled task status hiển thị lại |

## Các bước thực thi

Copy nguyên văn nội dung "Các bước thực thi" của
[flow-task's FE-TASK-003](../../../v3/flow-task/tasks/FE-TASK-003-use-task-activity-polling-fallback.md#các-bước-thực-thi)
— cùng `TASK_ACTIVITY_POLL_INTERVAL_MS = 4_000`, cùng `isLive: false` cố định, cùng RPC `task.get`,
cùng poll-ngay-khi-mount. **2 điểm khác biệt do task-graph series đã build thêm UI ở
`TaskDetail.tsx` (FE-TASK-004 ở series này thêm tab Access + permission badge):**

1. Đặt `useTaskActivity(task.id)` **sau** khối `useEffect` fetch `task.resolvePermission` của
   FE-TASK-004 (nếu FE-TASK-004 đã merge trước) — 2 effect độc lập, thứ tự khai báo không ảnh hưởng
   hành vi, chỉ giữ code dễ đọc theo nhóm chức năng (permission trước, activity sau).
2. `polledTask?.status` hiển thị lại nên đặt cạnh `TaskStatusBadge` nếu FE-TASK-003 (Board view, task
   này KHÔNG phải cùng số nhưng cùng series) đã thêm badge 7-status đầy đủ vào
   `TaskStatusBadge.tsx` — dùng `<TaskStatusBadge status={polledTask?.status ?? task.status} />`
   thay vì render text thô, tận dụng badge đã có màu/icon đúng cho cả 7 status thay vì tự vẽ lại.

```tsx
// TaskDetail.tsx — ví dụ cụ thể hoá điểm 2, đặt trong tab Details cạnh Status Select hiện có
const { task: polledTask } = useTaskActivity(task.id)
// ...
<TaskStatusBadge status={polledTask?.status ?? task.status} />
```

## Không làm ở task này

Giống hệt mục "Không làm ở task này" của
[flow-task's FE-TASK-003](../../../v3/flow-task/tasks/FE-TASK-003-use-task-activity-polling-fallback.md#không-làm-ở-task-này-task-follow-up-riêng-khi-cr-003-xong)
— không vá `subscribeRuntimeEvent`/thêm variant event, việc đó đụng `preload`/main process, ngoài
phạm vi "Tác động" CR-005.

## Test cases cần cover

Giống hệt
[flow-task's FE-TASK-003](../../../v3/flow-task/tasks/FE-TASK-003-use-task-activity-polling-fallback.md#test-cases-cần-cover),
cộng 1 case mới do điểm khác biệt 2 ở trên:

```
useTaskActivity.test.ts — copy nguyên 4 case gốc (mount gọi ngay, advance 4000ms gọi lại, unmount
clearInterval, taskId null không effect)

TaskDetail.test.tsx (case mới, thêm vào case gốc)
└── polledTask.status đổi → <TaskStatusBadge> hiển thị đúng icon/label mới (không phải text thô)
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
Task này sửa cùng vùng `TaskDetail.tsx` với FE-TASK-004 ở series này (Access tab + permission badge)
— khuyến nghị làm **sau** FE-TASK-004 để giảm xung đột merge (không phải hard dependency chức năng).
Risk dự kiến LOW — dán kết quả thật vào PR.

## Depends on

Không có phụ thuộc chức năng cứng. Khuyến nghị làm sau FE-TASK-004 (cùng file `TaskDetail.tsx`) để
tránh conflict merge.

## Blocking

Không có
