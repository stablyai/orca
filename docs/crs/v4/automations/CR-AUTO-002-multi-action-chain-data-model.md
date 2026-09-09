# CR-AUTO-002 — Data model action chain nhiều bước cho automation

| Trường | Giá trị |
|--------|---------|
| **CR ID** | CR-AUTO-002 |
| **Tên** | Thêm `actions[]` có thứ tự vào automation, thay cho model 1-step hiện tại |
| **Loại** | Feature (nền tảng dữ liệu) |
| **Priority** | **P0** |
| **Phiên bản** | v1.0 |
| **Ngày tạo** | 2026-09-09 |
| **Trạng thái** | 🔲 Proposed — chưa triển khai |
| **Tác giả** | Audit trực tiếp mã nguồn theo yêu cầu "rà soát F14 ở frontend và backend-go" |
| **Tác động HLD** | Automation domain data model |
| **Tác động Features** | F14 (Automations) — bắt buộc để CR-AUTO-003/004 có chỗ gắn action executor |

---

## Bối cảnh & Vấn đề gốc

F14's spec ([`docs/features/F14-automations.md:50-66`](../../../features/F14-automations.md))
mô tả automation là 1 chuỗi **nhiều action có thứ tự**:

```yaml
actions:
  - type: create_worktree
    base: main
  - type: run_agent
    agent: claude
    prompt: "Review all TODOs and suggest fixes"
  - type: commit
    message: "chore: automated TODO review"
  - type: create_pr
    title: "Weekly TODO cleanup"
```

Nhưng cả 2 model dữ liệu hiện có (audit 2026-09-09) đều chỉ có **1
step**, không phải chain:

- **TS (`frontend/src/shared/automations-types.ts`)**: `Automation` có
  `prompt: string` + `agentId: string` + `workspaceMode` (bao gồm
  `'new_per_run'` — tạo worktree mới, nhưng đây là 1 cờ cấu hình của
  "run agent", không phải 1 action riêng biệt trong chain). Không field
  nào tên `actions`/`steps`. `AutomationRunTrigger = 'scheduled' | 'manual'`
  (dòng 18) — cũng không có action nào ngoài "chạy 1 agent prompt".
- **Go (`backend-go/proto/orca/automation/v1/automation.proto:32-48`)**:
  `Automation` message có đúng 1 `step_type` (enum tái dùng từ
  `orca.workflow.v1.StepType`) + 1 `step_config_json` — không repeated
  field nào cho nhiều step.

Điều này khớp với phát hiện độc lập trước đó ở
`specs/backend-go/bugs/logic-v1/BUG-AT-01-cau-hinh-automation-partial.md`
— audit hiện tại xác nhận lại đúng gap này ở cả 2 tầng, không chỉ
backend-go.

## Giải pháp đề xuất

**Phụ thuộc cứng vào [CR-AUTO-001](./CR-AUTO-001-consolidate-execution-backend.md)**
— CR này viết trên nền backend canonical đã chọn (khuyến nghị: backend-go).
Giả định dưới đây viết cho backend-go; nếu CR-AUTO-001 chọn khác, áp dụng
tương tự cho backend đó.

### Schema mới: `AutomationAction`

```proto
// backend-go/proto/orca/automation/v1/automation.proto
message AutomationAction {
  string id = 1;              // ổn định qua các lần update, dùng cho run-history mapping
  AutomationActionType type = 2;  // enum: CREATE_WORKTREE, RUN_AGENT, COMMIT_PUSH, CREATE_PR, SEND_NOTIFICATION, RUN_SCRIPT
  string config_json = 3;     // opaque theo action type, giống step_config_json hiện tại
  bool continue_on_failure = 4; // false = dừng chain nếu action này lỗi (default)
}

message Automation {
  // ... field hiện có giữ nguyên cho tương thích ngược ...
  repeated AutomationAction actions = 10; // mới; automation cũ (chỉ có step_type/step_config_json) migrate thành actions=[{type: mapped từ step_type, config: step_config_json}]
}
```

Giữ `step_type`/`step_config_json` cũ **không xoá** — automation hiện có
trong Postgres đọc ra vẫn hợp lệ, được đọc như `actions = [1 action duy
nhất]` ở tầng usecase (không cần backfill migration Postgres ngay, có thể
làm lazy ở read path).

### Run history theo action

`AutomationRun` cần field mới `action_results: repeated ActionResult`
(mỗi action trong chain có `actionId`, `status`, `output`, `error`) thay
vì 1 kết quả duy nhất — để CR-AUTO-003/004's executor có chỗ ghi lại
per-action outcome, và UI (`AutomationRunHistory.tsx`,
`AutomationDetail.tsx`) hiển thị được tiến trình từng bước.

### Semantics `continue_on_failure`

Mặc định `false` — action lỗi thì dừng chain, không chạy tiếp action sau
(khớp giả định an toàn: không tự động `create_pr` nếu `run_agent` lỗi
giữa chừng). `true` cho phép chain tiếp tục (vd. `send_notification` vẫn
nên chạy dù `commit_push` thất bại, để báo lỗi).

### Executor loop

Thêm 1 usecase mới `execute_automation_chain.go` (cạnh `run_now.go` hiện
có) — lặp `actions[]` theo thứ tự, dispatch từng action tới executor
tương ứng (CR-AUTO-003/004 định nghĩa), dừng/tiếp tục theo
`continue_on_failure`, ghi `action_results` sau mỗi bước. `run_now.go`'s
logic hiện tại (dispatch qua `workflow-service.ExecuteAdHocStep`) trở
thành **1 trong các executor** (`RUN_AGENT`/`RUN_SCRIPT` loại step), không
bị viết lại — chỉ được gọi từ trong loop thay vì trực tiếp.

### TS side (nếu automation cũ trên implementation #1/#2 cần đọc/hiển thị action chain)

`automations-types.ts`'s `Automation` cần optional `actions?: AutomationAction[]`
tương ứng, cho renderer hiển thị được automation mới (tạo trên
backend-go) dù chưa migrate hẳn UI form tạo automation sang multi-action
(UI form là scope của CR-AUTO-003/004, không phải CR này).

## Rủi ro / Phụ thuộc

| Hạng mục | Rủi ro | Ghi chú |
|---|---|---|
| Phụ thuộc cứng CR-AUTO-001 | Cao | Không bắt đầu code trước khi CR-AUTO-001's quyết định kiến trúc chốt |
| Tương thích ngược automation cũ (`step_type`/`step_config_json`) | Trung bình | Không xoá field cũ; đọc như chain 1-action — cần test round-trip cho automation tạo trước CR này |
| `AutomationRun`'s schema đổi (`action_results` mới) | Trung bình | Cần migration Postgres cho `automation_runs` table (thêm cột hoặc JSON field), cập nhật `ListRuns` response, và renderer's `AutomationRunHistory.tsx`/`AutomationDetail.tsx` phải xử lý cả run cũ (không có `action_results`) lẫn run mới |
| Chain dài chạy lâu, không timeout tổng | Thấp (theo dõi) | Liên quan CR-AUTO-007's run timeout — nên tính timeout theo tổng chain, không chỉ từng action |

## Không thuộc phạm vi CR này

- UI form tạo/sửa automation multi-action (chọn action type, sắp xếp thứ
  tự, cấu hình `continue_on_failure`) — xem CR-AUTO-003/004, phần UI của
  từng action loại.
- Action executor thật cho từng loại (`CREATE_WORKTREE`, `COMMIT_PUSH`,
  `CREATE_PR`, `SEND_NOTIFICATION`, `RUN_SCRIPT`) — xem CR-AUTO-003/004.
- Migration dữ liệu automation cũ từ implementation #1/#2 (Electron/Node)
  sang backend-go — xem CR-AUTO-001's "Không thuộc phạm vi".

## Liên quan

- `docs/features/F14-automations.md:50-66` (spec YAML gốc)
- `backend-go/proto/orca/automation/v1/automation.proto:32-48`
- `frontend/src/shared/automations-types.ts:18,136` (`AutomationRunTrigger`, `trigger` field)
- `backend-go/services/automation-service/internal/usecase/run_now.go` (executor hiện tại, trở thành 1 nhánh trong loop)
- `specs/backend-go/bugs/logic-v1/BUG-AT-01-cau-hinh-automation-partial.md` (audit gap này trước đây, độc lập)
- [CR-AUTO-001](./CR-AUTO-001-consolidate-execution-backend.md) (phụ thuộc cứng)
- [CR-AUTO-003](./CR-AUTO-003-action-executors-commit-pr.md), [CR-AUTO-004](./CR-AUTO-004-action-executors-script-notification.md) (phụ thuộc cứng vào CR này)
