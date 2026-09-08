# Bug Reports — Frontend vs 3 hệ Task (task-v1)

**Module:** `frontend/src/renderer/src/components/task/`, `components/workflow/`, `components/feature-wall/agents-orchestration/`, `hooks/useTask*.ts`, `hooks/useWorkflow*.ts`
**Phát hiện:** 2026-09-08
**Bối cảnh:** Audit đối chiếu code frontend thật với 3 hệ Task theo mô hình
"3 execution engine" của [`docs/crs/v3/flow-task/`](../../../../docs/crs/v3/flow-task/README.md):
**OrcaTask** (Engine 1 — task tree/CRUD), **Task Execute/Orchestration**
(Engine 2 — coordinator/dispatch qua orchestration-service), **Workflow
Orchestration** (Engine 3 — template/step/execution qua workflow-service).
Đối chiếu cả backend Node (2 bản: `desktop/src/main`, `backend/src/main`) lẫn
`backend-go` vì cả 2 hiện đang cùng tồn tại (xem
[CR-FLOW-TASK-004](../../../../docs/crs/v3/flow-task/CR-FLOW-TASK-004-backend-go-cutover-and-node-sqlite-retirement.md)).

---

## Danh sách Bugs

| ID | Mức độ | Tiêu đề | Module | Status |
|----|--------|---------|--------|--------|
| [BUG-FE-TASKV1-001](./BUG-FE-TASKV1-001-orcatask-crud-va-tree-navigation.md) | 🟠 High | OrcaTask: không có UI tạo task thủ công, cây task tự build phía client | `TaskGraph.tsx`, `TaskTreeView.tsx`, `useTask.ts` | 🔴 Open |
| [BUG-FE-TASKV1-002](./BUG-FE-TASKV1-002-orcatask-dependency-graph-gia.md) | 🟠 High | `TaskDAGView` vẽ dependency graph giả (luôn rỗng), không UI thêm/xoá edge | `TaskDAGView.tsx` | 🔴 Open |
| [BUG-FE-TASKV1-003](./BUG-FE-TASKV1-003-access-control-va-share-link-khong-dung.md) | 🟡 Medium | `task.grant`/`task.resolvePermission` mồ côi ở UI; chưa có khái niệm share-link cho Task | `components/task/` | 🔴 Open |
| [BUG-FE-TASKV1-004](./BUG-FE-TASKV1-004-run-agent-ux-gaps.md) | 🟠 High | "Run with Agent": input người dùng bị bỏ qua, không Activity Feed, không batch, không comment UI | `TaskPromptEditor.tsx`, `TaskDetail.tsx` | 🔴 Open |
| [BUG-FE-TASKV1-005](./BUG-FE-TASKV1-005-missing-realtime-event-subscriptions.md) | 🟠 High | Không có real-time event subscription nào cho Task/Agent/Workflow — mọi nơi polling/refetch thủ công | `useWorkflowExecution.ts`, `useTasks.ts` | 🔴 Open |
| [BUG-FE-TASKV1-006](./BUG-FE-TASKV1-006-task-execute-orchestration-ui-khong-ton-tai.md) | 🔴 Critical | Task Execute/Orchestration (Engine 2): không có UI điều phối thật, `OrchestrationPage.tsx` chỉ là storyboard marketing | `feature-wall/agents-orchestration/`, `terminal-orchestration-task-links.ts` | 🔴 Open |
| [BUG-FE-TASKV1-007](./BUG-FE-TASKV1-007-workflow-builder-rpc-shape-mismatch.md) | 🔴 Critical | `useWorkflow.ts`'s `runWorkflow()` thiếu field `definition` bắt buộc → `workflow.execute` lỗi mỗi lần bấm Run trên production | `useWorkflow.ts` | 🔴 Open |
| [BUG-FE-TASKV1-008](./BUG-FE-TASKV1-008-dual-backend-rpc-contract-drift.md) | 🔴 Critical | Root cause tổng hợp: frontend viết pha trộn theo 2 shape backend khác nhau, lỗi tuỳ deploy target | `useWorkflow.ts`, `useTask.ts` | 🔴 Open |

---

## Phân loại theo Priority

### 🔴 Critical — Xử lý ngay
- **BUG-FE-TASKV1-007**: `workflow.execute` lỗi chắc chắn mỗi lần bấm "Run" trên production hôm nay — không phải rủi ro, là bug đang xảy ra.
- **BUG-FE-TASKV1-008**: root cause của 007 — không có quy tắc "viết RPC theo shape nào" khiến lỗi tương tự tiếp tục phát sinh nếu không chặn ở quy trình review.
- **BUG-FE-TASKV1-006**: Engine 2 (Task Execute/Orchestration) không có UI vận hành thật nào — gap chức năng toàn bộ 1 trong 3 engine.

### 🟠 High — Xử lý trong 1-2 sprint tới
- **BUG-FE-TASKV1-001, 002**: CRUD/tree/dependency graph của OrcaTask thiếu nhiều thao tác cơ bản (tạo task thủ công, quản lý dependency qua UI).
- **BUG-FE-TASKV1-004, 005**: UX "Run with Agent" có nhiều lỗ hổng (input bị bỏ qua, không feedback real-time) — cùng root cause thiếu event channel.

### 🟡 Medium — Dọn dần
- **BUG-FE-TASKV1-003**: access-control per-task mồ côi ở UI — ảnh hưởng thật nhưng chưa chặn luồng chính (task vẫn dùng được qua quyền project).

---

## Tác động tổng hợp

- **Chạy được ngay hôm nay hay không:** BUG-FE-TASKV1-007 là bug nghiêm trọng nhất — Workflow (Engine 3) UI đã tồn tại thật (đính chính BUG-FE-WF-001 lỗi thời, xem chi tiết trong 007) nhưng **không dùng được** vì RPC shape sai. Đây là ưu tiên #1 của bộ bug này.
- **Thiếu UI hoàn toàn:** Engine 2 (Task Execute/Orchestration) không có bất kỳ dashboard vận hành thật nào (BUG-FE-TASKV1-006) — chỉ có 1 tiện ích điều hướng nhỏ (click link trong terminal).
- **Thiếu thao tác cơ bản:** Engine 1 (OrcaTask) thiếu tạo task thủ công, quản lý dependency, access-control qua UI (001, 002, 003) — vẫn dùng được cho luồng chính (AI decompose → execute) nhưng thiếu nhiều control thủ công.
- **UX/real-time:** cả 3 engine đều thiếu Activity Feed thật (004, 005) — nguyên nhân gốc là chưa có kênh event hợp nhất ở backend (theo dõi ở CR-FLOW-TASK-003).
- **Root cause chung:** BUG-FE-TASKV1-008 giải thích vì sao các lỗi shape (007) xảy ra và tiếp tục có nguy cơ xảy ra — codebase đang ở giữa 1 cuộc migration 2 backend chưa có quy tắc ràng buộc.

## Đính chính bug cũ (không tự sửa file, chỉ ghi nhận)

- `specs/frontend/bugs/workflow-orchestration/BUG-FE-WF-001-workflow-builder-ui-not-implemented.md` — **dường như đã lỗi thời**. UI Workflow Builder thật đã tồn tại (`WorkflowBuilder.tsx`, `StepEditor.tsx`, `DAGPreview.tsx`, `WorkflowMonitor.tsx`), vấn đề hiện tại là RPC shape mismatch (xem BUG-FE-TASKV1-007), không phải "UI không tồn tại". Khuyến nghị người sở hữu thư mục `workflow-orchestration/` xác minh và đóng/cập nhật BUG-FE-WF-001.

## Không nhầm lẫn với

- `specs/frontend/bugs/agent-orchestration/BUG-FE-ORCH-001-no-ipc-bridge-agent-start-stop-resume.md` — về **Agent Orchestration** (vòng đời `agent.start/stop/resume` của 1 agent session), khác với **Task Execute/Orchestration** (coordinator/dispatch/message của orchestration-service) mà BUG-FE-TASKV1-006 mô tả.

## Tham khảo

- [docs/crs/v3/flow-task/README.md](../../../../docs/crs/v3/flow-task/README.md) — bối cảnh series CR
- [docs/crs/v3/flow-task/CR-FLOW-TASK-004](../../../../docs/crs/v3/flow-task/CR-FLOW-TASK-004-backend-go-cutover-and-node-sqlite-retirement.md) — kế hoạch cutover backend-go
- [docs/crs/v3/flow-task/CR-FLOW-TASK-005](../../../../docs/crs/v3/flow-task/CR-FLOW-TASK-005-frontend-unified-task-execution-ui.md) — thiết kế UI hợp nhất frontend
- [`specs/backend-go/bugs/task-v1/`](../../../backend-go/bugs/task-v1/README.md) — bộ bug tương ứng phía backend-go (đã hoàn tất, các cross-reference ở trên đã trỏ đúng ID)
