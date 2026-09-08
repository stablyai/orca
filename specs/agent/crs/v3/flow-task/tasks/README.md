# Agent Tasks — Flow Task

**Solutions:** [../solutions/](../solutions/README.md)

## Vì sao có task ở đây dù solution còn "📐 Design-only"

Trước khi cắt task, đã kiểm tra tiền lệ trực tiếp
[SOL-AG-PW-001](../../project-workspace/solutions/SOL-AG-PW-001-execution-progress-reporting-design.md)
(CR-PW-006 Phase D — cùng loại gap: agent-side unary exec cần streaming,
cùng lý do design-only là cross-repo + connection đang mang traffic thật).
Tiền lệ đó **có** 1 task tương ứng đã được cắt:
[TASK-AG-PW-001](../../project-workspace/tasks/TASK-AG-PW-001-execution-progress-reporting-investigation.md)
— nên áp dụng đúng tiền lệ này: cắt task cho SOL-AG-FLOWTASK-001, không chỉ
dừng ở ghi chú README.

Khác biệt với TASK-AG-PW-001: task đó là 1 task "investigation" đã đóng (ghi
lại việc đọc code xác nhận thiết kế, không có việc implement nào còn mở).
SOL-AG-FLOWTASK-001 đã tự làm phần "investigation" đó trong chính solution
doc (mục 1 + Checklist đã tick). Vì vậy 3 task dưới đây là task **implement**
ở dạng sẵn sàng cầm lên làm (theo mẫu
`specs/agent/bugs/agent-orchestration/tasks/TASK-ORCH-*.md`) — nhưng **không
phải TODO ngay**: mỗi task đánh dấu rõ `Status: [ ] TODO (chờ quyết định
triển khai — không phải TODO ngay)` vì solution vẫn ở trạng thái
"chưa lên lịch triển khai" và còn phụ thuộc CR-FLOW-TASK-001/003 chưa
triển khai xong (xem từng task's phần "Depends on").

## Tasks

| Task | Solution ref | Repo | Status |
|---|---|---|---|
| [TASK-AG-FLOWTASK-001](./TASK-AG-FLOWTASK-001-agent-execoutput-notification.md) | SOL-AG-FLOWTASK-001 §2.1 | `agent/` | [ ] TODO (chờ quyết định triển khai) |
| [TASK-AG-FLOWTASK-002](./TASK-AG-FLOWTASK-002-infra-fleet-execoutput-demux.md) | SOL-AG-FLOWTASK-001 §2.2, §3 | `backend-go/services/infra-fleet-service` | [ ] TODO (chờ quyết định triển khai) |
| [TASK-AG-FLOWTASK-003](./TASK-AG-FLOWTASK-003-task-service-activity-republish.md) | SOL-AG-FLOWTASK-001 §2.3 | `backend-go/services/task-service` | [ ] TODO (chờ quyết định triển khai) |

Thứ tự phụ thuộc: 001 → 002 → 003, và 003 còn phụ thuộc thêm CR-FLOW-TASK-001
+ CR-FLOW-TASK-003 phải triển khai xong trước (xem chi tiết trong từng file).
Không task nào trong 3 task này được bắt đầu code cho tới khi có quyết định
lên lịch triển khai phần streaming của CR-FLOW-TASK-003 — xem
[SOL-AG-FLOWTASK-001](../solutions/SOL-AG-FLOWTASK-001-execution-activity-streaming-design.md)
§4 "Vì sao dừng ở design-only" và §5 "Câu hỏi mở phải trả lời trước khi
implement".
