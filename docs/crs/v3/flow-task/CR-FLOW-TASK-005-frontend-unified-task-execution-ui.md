# CR-FLOW-TASK-005 — Frontend: UI "Run" hợp nhất theo 3-engine + 1 Activity Feed

| Trường | Giá trị |
|--------|---------|
| **CR ID** | CR-FLOW-TASK-005 |
| **Tên** | Frontend chạy Task qua đúng 1 trong 3 engine (chọn tự động hoặc thủ công), subscribe 1 kênh Activity Feed hợp nhất, gọi RPC đúng shape `backend-go` |
| **Loại** | Feature / Bugfix |
| **Priority** | 🟠 P1 |
| **Phiên bản** | v1.0 |
| **Ngày tạo** | 2026-09-08 |
| **Trạng thái** | 🔵 Proposed — chưa triển khai |
| **Phụ thuộc** | [CR-FLOW-TASK-001](./CR-FLOW-TASK-001-three-engine-execution-architecture.md) (vocabulary), [CR-FLOW-TASK-003](./CR-FLOW-TASK-003-unified-task-activity-event-catalog.md) (kênh WS), [CR-FLOW-TASK-004](./CR-FLOW-TASK-004-backend-go-cutover-and-node-sqlite-retirement.md) (biết gọi backend nào) |
| **Tác động** | `frontend/src/renderer/src/components/task/*`, `hooks/useTask.ts`, `hooks/useWorkflow.ts`, `hooks/useWorkflowExecution.ts`, `components/workflow/*` |

---

## Bối cảnh & Vấn đề

Audit frontend (`specs/frontend/bugs/task-v1`) xác nhận:

- UI "Run" (`TaskDetail.tsx`) chỉ biết gọi `task.execute` — không hiển thị
  đang chạy Engine nào, không có lựa chọn Engine 3 (workflow) dù
  [CR-FLOW-TASK-002](./CR-FLOW-TASK-002-workflow-as-task-execution-engine.md)
  thêm khả năng này ở backend.
- Không có Activity Feed thật — `TaskDetail` không subscribe bất kỳ event
  nào (`task.created`/`agent_output`/`agent_completed`/`status_changed`:
  0 listener).
- `useWorkflow.ts` gọi `workflow.execute`/`workflow.template.update` với
  shape **không khớp** backend Node đang chạy production (thiếu `definition`,
  thừa `templateId`) — chỉ khớp shape `backend-go`. Đây là hệ quả trực tiếp
  của việc không có Pha 0 (CR-FLOW-TASK-004) trước đó: code được viết theo
  1 backend trong khi production chạy backend còn lại.
- `OrchestrationPage.tsx` (Engine 2's UI) là **marketing storyboard**, không
  gọi RPC nào — không phải UI điều phối thật.

## Giải pháp đề xuất

### 1. `TaskDetail` — hiển thị Engine + chọn Engine 3 tường minh

```tsx
// Đọc task.workflowTemplateId (CR-002) — nếu set, hiển thị badge "Workflow: <template name>"
// thay vì "Run" mặc định; nếu task có subtask, hiển thị "Orchestration"; ngược lại "Direct Agent"
// — 3 nhãn tương ứng CR-001's ExecutionEngine, không cần UI mới học khái niệm nào ngoài đọc field.
<ExecutionEngineBadge engine={task.activeEngine} />
<Button onClick={() => runTask(task.id)}>Run</Button>
```

Thêm 1 action "Attach Workflow Template" (dropdown chọn từ
`workflow.template.list` — RPC này **đã tồn tại và đã đúng** ở cả 2 backend,
chỉ chưa được frontend gọi bao giờ cho mục đích này) để set
`workflow_template_id` trước khi Run.

### 2. Activity Feed — subscribe kênh hợp nhất

```tsx
// hooks/useTaskActivity.ts (mới)
useEffect(() => {
  const unsub = subscribeRuntimeEvent(target, `task.activity:${taskId}`, (frame: TaskActivityFrame) => {
    // 1 reducer duy nhất xử lý cả 3 engine's event type — UI không cần biết
    // orchestration.messages hay workflow.step_executions tồn tại.
    dispatch({ type: 'activity', frame })
  })
  return unsub
}, [taskId])
```

Thay thế hoàn toàn kiểu polling hiện tại của `useWorkflowExecution.ts` (poll
`workflow.getExecution` mỗi 4s) khi Task được chạy qua Engine 3 — polling chỉ
còn là fallback nếu kênh WS (CR-003) chưa sẵn sàng ở 1 số deploy target.

### 3. Sửa RPC call theo đúng shape `backend-go` (Pha 0 của CR-004)

- `useWorkflow.ts`'s `runWorkflow()`: gửi `{templateId, inputs, projectId,
  traceId, originTaskId}` — **bỏ** kỳ vọng field `definition` (chỉ Node cần,
  và Node đang bị retire theo CR-004).
- `useWorkflow.ts`'s `updateTemplate()`: giữ nguyên `workflow.template.update`
  — method này **đã đúng** theo backend-go, vấn đề chỉ là Node thiếu nó (sẽ
  hết vấn đề sau CR-004 Pha 3).
- `TaskPromptEditor.tsx`: `task.execute` cần nhận field `prompt` tùy chọn
  (ghi đè `promptTemplate` cho lần chạy này) — hiện input người dùng gõ bị
  bỏ qua hoàn toàn; cần bổ sung field này ở `task.proto`'s `ExecuteRequest`
  trước (theo dõi ở `specs/backend-go/bugs/task-v1`, không phải phạm vi sửa
  của CR frontend này).

## Rủi ro / Không thuộc phạm vi

- Không tự làm UI mới cho `TaskDAGView`/access-control/share-link — đó là
  gap chức năng đơn lẻ, theo dõi ở `specs/frontend/bugs/task-v1`, không phải
  1 phần của "liên kết 3 engine".
- CR này giả định CR-003's kênh WS đã tồn tại — nếu triển khai trước khi
  CR-003 xong, `useTaskActivity` phải fallback về polling `task.get` theo
  interval, không được để Activity Feed trống hoàn toàn.

## Acceptance Criteria

- [ ] `TaskDetail` hiển thị đúng Engine hiện tại của Task (đọc field có sẵn, không cần RPC mới).
- [ ] Chọn Workflow Template cho 1 Task rồi bấm Run → gọi đúng Engine 3, không rơi về Engine 1/2.
- [ ] `useTaskActivity` nhận được ít nhất 1 frame test cho mỗi engine (giả lập ở integration test, không cần chạy thật cả 3 backend service).
- [ ] `useWorkflow.ts`'s `runWorkflow()`/`updateTemplate()` gọi đúng shape `backend-go` — test giả lập response backend-go pass; ghi rõ trong PR rằng lời gọi này **sẽ lỗi trên Node cho tới khi CR-FLOW-TASK-004 Pha 3 hoàn tất** (chấp nhận được, vì Pha 0 đã đóng băng theo hướng backend-go).
