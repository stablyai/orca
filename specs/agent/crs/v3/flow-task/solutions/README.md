# Agent Solutions — Flow Task

**CR series:** [docs/crs/v3/flow-task/](../../../../../../docs/crs/v3/flow-task/README.md) (CR-FLOW-TASK-001..005)

## Vì sao chỉ có 1 solution ở đây, không phải 5

Đọc toàn văn cả 5 CR + `README.md` của series `flow-task` cho thấy **không
CR nào liệt kê `agent/` trong field "Tác động"**:

| CR | Tác động khai báo | Có chạm `agent/` không |
|---|---|---|
| CR-FLOW-TASK-001 | `task-service` (usecase/domain), `task.proto` | Không |
| CR-FLOW-TASK-002 | `task.proto`, `workflow.proto`, `task-service`, `workflow-service` | Không |
| CR-FLOW-TASK-003 | `orchestration-service`, `api-gateway`, `task-service` | Không (khai báo) — nhưng mục "Rủi ro/Không thuộc phạm vi" của chính CR-003 **tự flag** 1 khoảng trống chạm `agent/` (xem dưới) |
| CR-FLOW-TASK-004 | `deploy/prod/`, `desktop/src/main/task|workflow/*`, `backend/src/main/task|workflow/*` | Không |
| CR-FLOW-TASK-005 | `frontend/src/renderer/**` | Không |

4/5 CR (001, 002, 004, 005) hoàn toàn không có việc để làm ở `agent/` — mọi
thay đổi của chúng nằm ở `backend-go` (task-service/workflow-service/
orchestration-service), `desktop`/`backend` (Node, đang bị retire theo
CR-004), hoặc `frontend`. Viết "solution" cho `agent/` ở các CR này sẽ là
tài liệu rỗng, không phản ánh CR thật.

CR-FLOW-TASK-003 là ngoại lệ duy nhất: mục "Rủi ro / Không thuộc phạm vi"
ghi rõ *"Không giải quyết streaming stdout liên tục (PTY output real-time)
— đã bị SOL-TG-04 flag là cần đổi `agent/` + `infra-fleet-service`, ngoài
phạm vi CR này."* Đây là khoảng trống duy nhất trong cả series mà `agent/`
thực sự cần thêm capability — và CR-003 tự nhận nó chưa giải quyết.

## Solutions

| Solution | CR | Status |
|---|---|---|
| [SOL-AG-FLOWTASK-001](./SOL-AG-FLOWTASK-001-execution-activity-streaming-design.md) | CR-FLOW-TASK-003 (phần bị flag "ngoài phạm vi") | 📐 Design-only |

SOL-AG-FLOWTASK-001 thiết kế "Phase D" bổ trợ cho CR-FLOW-TASK-003: làm
`agent.execPrompt` (Engine 1's RPC thật, xác nhận bởi
[BUG-AGENT-TASKV1-001](../../../../bugs/task-v1/BUG-AGENT-TASKV1-001-orcatask-run-agent-execprompt-verification.md))
phát được tiến độ giữa chừng thay vì chỉ 1 response cuối, và nối dây qua
`infra-fleet-service` (hiện âm thầm drop mọi notification agent-side ngoài
`pty.*`/`browser.screencast*`) tới kênh `task.activity` mà CR-003 đã thiết
kế. Nó **không phải** 1 CR mới, không đổi acceptance criteria của CR-003, và
**không chặn** phần event rời rạc (status/dispatch/step-completed) mà
CR-003 đã cam kết — chỉ chặn phần "stdout liên tục" mà CR-003 tự loại khỏi
phạm vi.

Giữ ở trạng thái design-only vì lý do y hệt tiền lệ
[SOL-AG-PW-001](../../project-workspace/solutions/SOL-AG-PW-001-execution-progress-reporting-design.md)
(CR-PW-006 Phase D): cross-repo (agent + infra-fleet-service + task-service
+ api-gateway), đụng vào connection đang mang PTY traffic thật, và phụ
thuộc CR-FLOW-TASK-001/003 (`execution_links`, kênh `task.activity`) phải
tồn tại trước khi có chỗ để chunk đổ vào.
