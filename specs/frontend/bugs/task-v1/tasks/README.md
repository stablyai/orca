# Tasks — Frontend vs 3 hệ Task (task-v1)

**Nguồn:** [solutions/](../solutions/)
**Mục tiêu:** Chia nhỏ mỗi solution (8 bug) thành các task cụ thể, tự chứa đủ ngữ cảnh để 1 AI/dev
thực thi độc lập (mục tiêu, file cần đọc trước, thay đổi chính xác, cách verify, Definition of Done).
**Trạng thái tất cả:** `[ ] TODO` — chưa triển khai.

---

## SOL-FE-TASKV1-005, 007, 008 — KHÔNG tạo task ở đây

3 solution này (+ 1 phần của SOL-FE-TASKV1-004, xem bên dưới) là pointer tới
`FE-SOL-001-unified-task-execution-ui.md` (`specs/frontend/crs/v3/flow-task/solutions/`), do 1 agent
khác viết song song. **Task breakdown cho phần này nằm ở
[`../../../crs/v3/flow-task/tasks/`](../../../crs/v3/flow-task/tasks/) (implement `FE-SOL-001`),
không tạo lại ở đây.**

(Cập nhật tại thời điểm viết README này: thư mục đó đã tồn tại với `README.md` mục lục đầy đủ —
`FE-TASK-001` đến `FE-TASK-006`, cùng bảng "Hard blocker cần backend/runtime layer thay đổi trước".)

| Solution | Lý do không tạo task ở đây |
|----------|---------------------------|
| [SOL-FE-TASKV1-005](../solutions/SOL-FE-TASKV1-005-missing-realtime-event-subscriptions.md) | Pointer toàn bộ tới `FE-SOL-001` (`useTaskActivity`) — xem `FE-TASK-003` ở thư mục trên |
| [SOL-FE-TASKV1-007](../solutions/SOL-FE-TASKV1-007-workflow-builder-rpc-shape-mismatch.md) | Pointer toàn bộ tới `FE-SOL-001` (`useWorkflow.ts`'s `runWorkflow`) — xem `FE-TASK-004`/`FE-TASK-005` |
| [SOL-FE-TASKV1-008](../solutions/SOL-FE-TASKV1-008-dual-backend-rpc-contract-drift.md) | Biểu hiện cụ thể vá bởi `FE-SOL-001`; root cause hệ thống (quy tắc review/codegen dùng chung) là việc process, không có task code để tạo |
| SOL-FE-TASKV1-004 mục 1-2 (field `prompt`, Activity Feed) | Pointer tới `FE-SOL-001` — xem `FE-TASK-003` (Activity Feed) và `FE-TASK-006` (field `prompt`, optimistic, hard-blocked bởi thiếu field proto) |

---

## Mục lục Task (SOL-FE-TASKV1-001, 002, 003, 004 phần mới, 006)

| Task ID | Solution | Tiêu đề | File chính | Phụ thuộc | Blocked bởi backend-go? |
|---------|----------|---------|------------|-----------|--------------------------|
| [TASK-FE-TASKV1-01](./TASK-FE-TASKV1-01-new-task-dialog-and-create-hook.md) | SOL-001 | Dialog "New Task" + `createTask()` | `TaskCreateDialog.tsx` (mới), `useTasks.ts` | Không | ⚠️ Một phần — gap MỚI phát hiện: `task.create` wscompat không forward `projectId` (chưa track) |
| [TASK-FE-TASKV1-02](./TASK-FE-TASKV1-02-client-side-progress-display.md) | SOL-001 | Progress hiển thị client-side (`computeClientProgress`) | `useTasks.ts`, `TaskCard.tsx` | Không | Không |
| [TASK-FE-TASKV1-03](./TASK-FE-TASKV1-03-taskdagview-real-dependency-data.md) | SOL-002 (Phần A) | DAG vẽ dependency thật + sửa `TaskDetail.tsx` đọc sai shape RPC | `useTaskDependencyEdges.ts` (mới), `TaskDAGView.tsx`, `TaskDetail.tsx` | Không | Không |
| [TASK-FE-TASKV1-04](./TASK-FE-TASKV1-04-taskdagview-add-edge-ui.md) | SOL-002 (Phần B) | Thêm dependency edge qua kéo-nối | `TaskDAGView.tsx` | TASK-FE-TASKV1-03 | ✅ Có — `task.addEdge` chưa wire wscompat (chưa track) |
| [TASK-FE-TASKV1-05](./TASK-FE-TASKV1-05-task-grant-level-type-fix-and-permission-hook.md) | SOL-003 (mục 1-2) | Sửa type `TaskGrantLevel` + `useTaskPermission` | `task-types.ts`, `useTaskPermission.ts` (mới) | Không | Không (type/hook tự đứng được; RPC thật blocked ở TASK-06) |
| [TASK-FE-TASKV1-06](./TASK-FE-TASKV1-06-task-access-panel-and-execute-gate.md) | SOL-003 (mục 3-4) | Tab "Access" + gate nút Execute | `TaskAccessPanel.tsx` (mới), `TaskDetail.tsx` | TASK-FE-TASKV1-05 | ✅ Có — `task.grant`/`task.resolvePermission` chưa wire wscompat (chưa track) |
| [TASK-FE-TASKV1-07](./TASK-FE-TASKV1-07-task-batch-execute-ui.md) | SOL-004 (Phần 2) | Batch Execute UI (chọn nhiều task) | `useTaskBatchExecution.ts` (mới), `TaskGraph.tsx`, `TaskTreeView.tsx`, `TaskCard.tsx` | Không | Không (dùng `task.execute` đã hoạt động) |
| [TASK-FE-TASKV1-08](./TASK-FE-TASKV1-08-task-comments-ui.md) | SOL-004 (Phần 3) | Tab "Comments" | `useTaskComments.ts`/`TaskComments.tsx` (mới), `TaskDetail.tsx` | Không | ✅ Có — `AddComment`/`ListComments` không tồn tại ở bất kỳ tầng nào backend-go (chưa track) |
| [TASK-FE-TASKV1-09](./TASK-FE-TASKV1-09-orchestration-page-rename.md) | SOL-006 (mục 1) | Đổi tên `OrchestrationPage` → `OrchestrationStoryboard` | `OrchestrationPage.tsx` | Không | Không |
| [TASK-FE-TASKV1-10](./TASK-FE-TASKV1-10-task-dispatch-status-panel.md) | SOL-006 (mục 2-4) | `TaskDispatchStatusPanel` trong `TaskDetail` | `TaskDispatchStatusPanel.tsx` (mới), `TaskDetail.tsx` | TASK-FE-TASKV1-09 (khuyến nghị, không bắt buộc) | Không (dùng `orchestration.dispatchShow` đã wire) |

---

## Phát hiện xuyên suốt khi viết bộ task này (mới, không có trong solutions gốc)

Khi đọc code thật (`file:line`) để viết từng task, phát hiện thêm các gap **không có trong 8
solution gốc**:

1. **`task.create` (wscompat) không forward `projectId`** — dù `CreateTaskRequest` proto, usecase,
   domain đều hỗ trợ đầy đủ field này. Task tạo mới qua UI sẽ "biến mất" khỏi `TaskGraph` sau khi
   tạo (silent bug). Xem TASK-FE-TASKV1-01.
2. **`task.getDependencies` không có field `edgeType`** trong response thật (`Task[]` phẳng) — cả
   `TaskDetail.tsx` (code đang chạy) LẪN thiết kế gốc của SOL-FE-TASKV1-002 đều giả định sai shape
   `{task, edgeType}[]`. Bug run-time đang tồn tại: `TaskDetail`'s "Dependencies" section hiện luôn
   hiển thị rỗng. Xem TASK-FE-TASKV1-03.
3. **`TaskGrantLevel` đã tồn tại nhưng alias sai** (`= TaskPermission`, action scale) tại
   `shared/task-types.ts:137` — SOL-FE-TASKV1-003 đề xuất "thêm mới" trùng tên; phải sửa định nghĩa
   hiện có (an toàn: 0 consumer nào khác đang dùng type này). Xem TASK-FE-TASKV1-05.
4. **Store không có field `currentUserId`** — field thật là `currentUser: OrcaUser | null`
   (`.id`). Ảnh hưởng TASK-FE-TASKV1-05/06.
5. **`TaskComment` type đã tồn tại** (`userId`/`content`), khác field solution gốc dùng
   (`authorId`/`body`). Xem TASK-FE-TASKV1-08.
6. **`agentSession.listActive`** (gọi `ListActiveDispatchContextsForUser`) đã được wire vào
   wscompat sau khi SOL-FE-TASKV1-006 được viết — nằm dưới namespace `agentSession.*` chứ không
   phải `orchestration.*` nên solution gốc (grep theo tiền tố `orchestration.`) không thấy. Không
   mở rộng phạm vi TASK-FE-TASKV1-10 vì việc này, chỉ ghi nhận làm cơ hội cho 1 task tương lai
   ("My Active Agent Sessions" panel ở cấp project/sidebar).
7. **`TaskTreeView.tsx` cần sửa để batch-select hoạt động** — SOL-FE-TASKV1-004 chỉ liệt kê
   `TaskCard.tsx`/`TaskGraph.tsx`, bỏ sót tầng trung gian `TaskTreeView.tsx` (đệ quy `renderLevel()`)
   phải thread thêm 3 prop mới. Xem TASK-FE-TASKV1-07.

## Thứ tự thực hiện gợi ý

```
Độc lập hoàn toàn, làm song song bất kỳ lúc nào:
  TASK-FE-TASKV1-02   client-side progress
  TASK-FE-TASKV1-03   DAG real dependency data + sửa TaskDetail bug
  TASK-FE-TASKV1-07   batch execute UI
  TASK-FE-TASKV1-09   OrchestrationPage rename

Chuỗi phụ thuộc:
  TASK-FE-TASKV1-01 → (không có task nối tiếp, nhưng blocked 1 phần bởi backend-go)
  TASK-FE-TASKV1-03 → TASK-FE-TASKV1-04 (add-edge UI, blocked bởi backend-go)
  TASK-FE-TASKV1-05 → TASK-FE-TASKV1-06 (access panel, blocked bởi backend-go)
  TASK-FE-TASKV1-09 → TASK-FE-TASKV1-10 (khuyến nghị thứ tự, không bắt buộc)

Độc lập, nhưng luôn hiện "chưa khả dụng" cho tới khi backend-go làm xong phần track ở trên:
  TASK-FE-TASKV1-08   comments UI (blocked sâu nhất — chưa có RPC lẫn usecase ở backend-go)
```

## Tham khảo chung

- [`../README.md`](../README.md) — mục lục 8 solution gốc
- [`../../README.md`](../../README.md) — mục lục 8 bug gốc
- [`../../../crs/v3/flow-task/tasks/`](../../../crs/v3/flow-task/tasks/) — task breakdown của `FE-SOL-001` (005/007/008 + phần pointer của 004)
- `specs/backend-go/bugs/task-v1/` — bộ bug backend-go tương ứng, nơi các gap wscompat/proto mới phát hiện ở trên cần được mở task riêng
