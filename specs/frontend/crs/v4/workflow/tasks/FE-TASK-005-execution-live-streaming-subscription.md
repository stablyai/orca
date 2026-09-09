# FE-TASK-005: Consume live execution events (subscription, giữ polling làm fallback)

**Domain:** workflow
**Solution Ref:** [FE-SOL-002](../solutions/FE-SOL-002-execution-live-streaming.md) (toàn bộ solution)
**Priority:** 🔵 P3 — blocked, không lên lịch (chờ 2 lớp phụ thuộc backend)
**Estimated:** — (không ước lượng cho tới khi phụ thuộc backend xong; ước lượng thật sẽ tính lại lúc mở khoá)
**Status:** [ ] TODO (chờ quyết định triển khai — không phải TODO ngay)

> Note 2026-09-09: bỏ qua trong đợt thực thi FE-TASK-001/002/003/004/006 (session cùng ngày) — vẫn
> blocked đúng như ghi ở trên, chờ `CR-FLOW-TASK-003` → `BE-SOL-006` (cả 2 vẫn 📋 Proposed). Không
> code gì thêm ở đây.

> **⚠️ BLOCKED — KHÔNG bắt đầu code cho tới khi 2 lớp phụ thuộc backend dưới đây đều xong.** Task
> này chỉ ghi lại thiết kế đã có trong FE-SOL-002 ở dạng sẵn sàng cầm lên làm ngay khi được mở khoá,
> không phải một task đang chờ nhận việc.

---

## Vì sao vẫn có file task dù blocked (khác với cách xử lý các solution "chưa sẵn sàng" khác)

Series backend-go's `specs/backend-go/crs/v3/flow-task/tasks/README.md`'s mục "Why BE-SOL-004 has no
tasks" chọn **không tạo task nào** cho 1 solution mà nội dung chỉ là "đừng bắt đầu Phase 3 vội" (một
xác nhận gate, không phải thiết kế implement). FE-SOL-002 **khác về bản chất**: nó **là** 1 thiết kế
implement cụ thể (thay đổi 1 `useEffect` trong `useWorkflowExecution.ts`, giữ nguyên phần còn lại),
chỉ đang chờ hạ tầng backend tồn tại để chạy được — giống hệt tình huống
`specs/agent/crs/v3/flow-task/tasks/TASK-AG-FLOWTASK-001-agent-execoutput-notification.md` (task đó
cũng "P3, design-only, not scheduled", vẫn có file task với banner blocked rõ ràng ở đầu). Task này đi
theo đúng khuôn mẫu đó — ghi lại thiết kế đã sẵn sàng cầm lên làm ngay khi khoá mở, thay vì chỉ nhắc
tới trong README rồi phải viết lại từ đầu lúc BE-SOL-006 merge.

## Chuỗi phụ thuộc — 2 lớp, cả 2 đều 📋 Proposed hôm nay

```
CR-FLOW-TASK-003 (unified task-activity event catalog)  ← lớp 1, backend-go, 📋 Proposed
        │  chưa có: RuntimeClientEvent variant nào cho task/workflow activity,
        │  chưa có: subscribeRuntimeEvent (hàm này KHÔNG tồn tại ở bất kỳ đâu trong codebase)
        ▼
BE-SOL-006 (workflow execution live streaming)          ← lớp 2, backend-go, 📋 Proposed
        │  tự khai "Hard dependency: CR-FLOW-TASK-003 must land first —
        │  do not build an independent event schema"
        ▼
FE-SOL-002 (task này — frontend consumption)             ← blocked bởi CẢ 2 lớp trên
```

## Xác nhận đã đọc code thật trước khi viết task (2026-09-09) — tình trạng hạ tầng

- `grep -rn "subscribeRuntimeEvent" frontend/src` = 0 kết quả — hàm FE-SOL-002's design gọi
  (`subscribeRuntimeEvent(target, channel, cb)`) chưa từng tồn tại, y hệt phát hiện cũ ở flow-task
  series's FE-TASK-003 (`specs/frontend/crs/v3/flow-task/tasks/FE-TASK-003-use-task-activity-polling-fallback.md`).
  Không có gì thay đổi kể từ lúc đó.
- Cơ chế push-event thật duy nhất (`subscribeRuntimeClientEvents`,
  `frontend/src/renderer/src/runtime/runtime-client-events.ts:12-36,60-75`) vẫn giới hạn bởi union
  đóng không có variant `taskActivity`/`workflowActivity`, và không nhận target `'local'`.
- `useWorkflowExecution.ts` (đọc trực tiếp hôm nay, dòng 10-22's comment) vẫn tự nhận là "interim,
  pre-Phase-D stopgap", poll `workflow.getExecution` mỗi 4 giây — không đổi từ lúc FE-SOL-002 viết.
  `ExecutionMonitor.tsx`'s `streamingOutput` (dòng 7, 63-66) vẫn là dead-code path chờ nguồn dữ liệu
  chưa từng tồn tại — `streamingOutput[executionId]` luôn `[]` trong thực tế hôm nay.
- `BE-SOL-006` (`specs/backend-go/crs/v4/workflow/solutions/BE-SOL-006-execution-live-streaming.md`)
  tự ghi **Status: 📋 Proposed — not yet implemented, blocked on CR-FLOW-TASK-003** — xác nhận trực
  tiếp, không phải suy đoán.

## Thiết kế (nguyên văn từ FE-SOL-002, sẵn sàng cầm lên làm khi mở khoá — KHÔNG granularize thêm)

```tsx
// useWorkflowExecution.ts — thêm effect này CẠNH polling effect hiện có (dòng 31-57), KHÔNG xoá
// polling — giữ nguyên làm fallback, chỉ hạ ưu tiên khi subscription hoạt động.
useEffect(() => {
  const channel = execution?.originTaskId
    ? `task.activity:${execution.originTaskId}`
    : `workflow.activity:${executionId}` // BE-SOL-006's kênh fallback cho execution không qua Task
  const unsub = subscribeRuntimeEvent(target, channel, (frame) => {
    dispatch({ type: 'step-update', frame })
  })
  return unsub
}, [executionId, execution?.originTaskId])
```

`ExecutionMonitor.tsx` không cần đổi UI khi mở khoá — `streamingOutput` sẽ có nguồn dữ liệu thật thay
dead-code path hiện tại; chỉ cần xác nhận `groupStepsByWave` (component's helper, dòng 78-92) phản
ứng đúng với update từ subscription giống như update từ poll hiện tại (cùng 1 luồng state, khác
nguồn trigger).

## Files sẽ cần sửa (khi mở khoá — KHÔNG sửa bây giờ)

| File | Action |
|------|--------|
| `frontend/src/renderer/src/hooks/useWorkflowExecution.ts` | MODIFY — thêm effect subscribe, giữ nguyên polling effect làm fallback |
| `frontend/src/renderer/src/runtime/runtime-client-events.ts` | MODIFY (ngoài phạm vi `components/workflow/*`/`hooks/*` mà CR-WF-007 khai — cần xác nhận lại phạm vi CR khi mở khoá) — thêm `subscribeRuntimeEvent` hoặc mở rộng `isRuntimeClientEvent`'s union |
| `frontend/src/renderer/src/components/workflow/ExecutionMonitor.tsx` | Không đổi UI, chỉ xác nhận lại bằng test |

Dòng thứ 2 ở bảng trên chạm `preload`/main-process-adjacent code (`runtime-client-events.ts` là
shared client logic cho cả push-event) — **đây chính là lý do design này chưa thể chốt hoàn toàn**
cho tới khi CR-FLOW-TASK-003 tự quyết định hình dạng API (`subscribeRuntimeEvent`'s chữ ký thật, có
đúng như FE-SOL-002 giả định `(target, channel, cb)` hay không) — xem "Open Questions" dưới.

## Open Questions cần CR-FLOW-TASK-003 trả lời trước khi task này chuyển từ blocked sang TODO thật

1. `subscribeRuntimeEvent`'s chữ ký chính xác — FE-SOL-002 giả định `(target, channel: string, cb)`
   nhưng đây chỉ là tên hàm chưa tồn tại, chưa có PR/CR nào chốt chữ ký thật.
2. Channel naming — `task.activity:{taskId}` vs `workflow.activity:{executionId}` là 2 pattern khác
   nhau cho cùng 1 khái niệm "1 workflow execution phát sinh từ 1 task hay không" — CR-FLOW-TASK-003
   cần chốt convention đặt tên channel chung cho cả 2 domain (task-graph + workflow), không để mỗi
   consumer tự đặt tên khác nhau.
3. `target.kind === 'local'` (Desktop Electron) hiện không đi qua `subscribeRuntimeClientEvents` nào
   cả (chỉ nhận `environmentId: string`) — cần 1 bridge IPC tương đương cho Desktop trước khi
   `subscribeRuntimeEvent` hoạt động cross-platform, không chỉ Web mode.

## Test plan (khi mở khoá)

- Execution có `originTaskId` → nhận event qua `task.activity:{taskId}`; không có → qua
  `workflow.activity:{executionId}`.
- Tắt subscription giả lập (Web mode không có WS, hoặc Desktop chưa có bridge IPC) → polling 4s vẫn
  hoạt động bình thường, không throw.
- Không duplicate update khi cả subscription và poll cùng trả về cùng 1 step.

## Verification (khi mở khoá)

```bash
cd frontend && npx vitest run src/renderer/src/hooks/__tests__/useWorkflowExecution.test.ts
cd frontend && npx tsc --noEmit -p .
```

## gitnexus (chạy lại khi mở khoá, không chạy bây giờ vì chưa có code để impact)

```
impact({target: "useWorkflowExecution", direction: "upstream"})
```

## Depends on

**Hard blocker, 2 lớp** — [CR-FLOW-TASK-003](../../../../../../docs/crs/v3/flow-task/CR-FLOW-TASK-003-unified-task-activity-event-catalog.md)
(📋 Proposed) phải xong trước, sau đó
[BE-SOL-006](../../../../../backend-go/crs/v4/workflow/solutions/BE-SOL-006-execution-live-streaming.md)
(📋 Proposed, tự khai phụ thuộc CR-FLOW-TASK-003) phải xong. Không có cách nào rút ngắn chuỗi này từ
phía frontend — không tự chế 1 kênh event tạm thời khác đi (đúng "Not in scope" của FE-SOL-002:
*"Backend event schema — dùng nguyên của CR-FLOW-TASK-003/BE-SOL-006, không thiết kế lại"*).

## Blocking

Không có task nào khác trong `specs/frontend/crs/v4/workflow/tasks/` phụ thuộc task này — FE-TASK-001
đến 004 đều ship độc lập, không chờ streaming.
