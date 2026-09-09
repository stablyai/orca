# BE-AUTO-SOL-002: `actions[]` — action chain nhiều bước

> **🔲 Designed — chưa implement.** Phụ thuộc cứng BE-AUTO-SOL-001 (chốt
> backend-go là canonical cho pairing-path automation).

**CR:** [CR-AUTO-002](../../../../../../docs/crs/v4/automations/CR-AUTO-002-multi-action-chain-data-model.md)
**Frontend counterpart:** [FE-AUTO-SOL-002](../../../../frontend/crs/v4/automation/solutions/FE-AUTO-SOL-002-actions-type-plumbing.md)
**Service:** `automation-service`
**TDD tham chiếu:** [`automation-service.md`](../../../../tdd/services/automation-service.md), [`workflow-service.md`](../../../../tdd/services/workflow-service.md) §step model

---

## 1. Trạng thái hiện tại

`Automation` message (`automation.proto:32-48`) có đúng 1
`step_type`+`step_config_json`. `run_now.go` dispatch thẳng 1 lần tới
`workflow-service.ExecuteAdHocStep`. Không có khái niệm "nhiều action có
thứ tự" ở bất kỳ đâu trong service này.

## 2. Giải pháp

### Proto — thêm, không đổi field cũ

```proto
message AutomationAction {
  string id = 1;
  AutomationActionType type = 2; // enum mới: ACTION_TYPE_CREATE_WORKTREE, RUN_AGENT, COMMIT_PUSH, CREATE_PR, SEND_NOTIFICATION, RUN_SCRIPT
  string config_json = 3;
  bool continue_on_failure = 4;
}

message Automation {
  // ... field hiện có (step_type/step_config_json) giữ nguyên ...
  repeated AutomationAction actions = 10;
}

message AutomationRun {
  // ... field hiện có (id/automation_id/status) giữ nguyên ...
  repeated ActionResult action_results = 4;
}
message ActionResult {
  string action_id = 1;
  string status = 2; // running|completed|failed|skipped
  string output_json = 3;
  string error = 4;
}
```

### Đọc automation cũ như chain 1-action (lazy, không backfill Postgres)

Ở usecase layer (không phải DB migration): nếu `actions` rỗng nhưng
`step_type`/`step_config_json` có giá trị, coi như
`actions = [{id: automation.id + ":legacy", type: mapFromStepType(step_type), config_json: step_config_json}]`.
`mapFromStepType`: `STEP_TYPE_AGENT → RUN_AGENT`, `STEP_TYPE_SHELL → RUN_SCRIPT`,
`STEP_TYPE_NOTIFICATION → SEND_NOTIFICATION`, `STEP_TYPE_WEBHOOK` → chưa
có action type tương ứng (giữ nguyên chạy qua đường cũ nếu gặp, không
crash — log 1 warning, đây là trường hợp hiếm vì UI hiện tại không tạo
được automation `webhook` step).

### Usecase mới: `execute_automation_chain.go`

```go
// internal/usecase/execute_automation_chain.go
func (uc *ExecuteAutomationChain) Run(ctx context.Context, automation domain.Automation, runID string) error {
    actions := resolveActions(automation) // mục "đọc automation cũ" ở trên
    for _, action := range actions {
        result, err := uc.dispatch(ctx, action) // switch theo action.Type, xem BE-AUTO-SOL-003/004
        uc.repo.AppendActionResult(ctx, runID, result)
        if err != nil && !action.ContinueOnFailure {
            return err // dừng chain
        }
    }
    return nil
}
```

`run_now.go`'s logic dispatch hiện tại (gọi thẳng
`workflow-service.ExecuteAdHocStep`) trở thành **1 nhánh trong
`dispatch()`** (case `RUN_AGENT`/`RUN_SCRIPT`/`SEND_NOTIFICATION`,
gọi `ExecuteAdHocStep` với `step_type` tương ứng) — không viết lại, chỉ
gọi từ vị trí mới.

### Postgres

Thêm cột `actions_json` (JSONB) vào `automations` table
(`migrations/0003_action_chain.up.sql`), cột `action_results_json`
(JSONB) vào `automation_runs` table — dùng JSONB thay vì bảng con riêng
cho v1 (đơn giản hơn, khớp cách `step_config_json` hiện tại đã lưu JSON
blob, nhất quán style đã có trong service này).

## 3. Rủi ro / Phụ thuộc

| Hạng mục | Rủi ro | Ghi chú |
|---|---|---|
| Phụ thuộc cứng BE-AUTO-SOL-001 | Cao | Không bắt đầu trước khi 001 chốt |
| `AppendActionResult` ghi liên tục vào JSONB column (không phải bảng con) có thể race nếu 2 automation run cùng automation song song | Trung bình | Xem [BE-AUTO-SOL-006](./BE-AUTO-SOL-006-retention-scheduler-hardening.md)'s concurrency guard — nên merge cùng lúc, không để 2 solution độc lập tạo race |
| Tương thích ngược automation cũ (đọc `step_type` như 1-action chain) | Trung bình | Cần test round-trip: tạo automation trước migration này, đọc lại qua `ListAutomations` sau migration, xác nhận `actions` tự động có 1 phần tử đúng |

## Không thuộc phạm vi solution này

- Executor thật cho từng action type — xem BE-AUTO-SOL-003/004.
- UI tạo/sửa action chain — xem FE-AUTO-SOL-002/003/004.

## Liên quan

- `backend-go/proto/orca/automation/v1/automation.proto:32-48`
- `backend-go/services/automation-service/internal/usecase/run_now.go`
- `backend-go/services/automation-service/migrations/0001_init.up.sql`, `0002_scheduler_columns.up.sql`
- [BE-AUTO-SOL-001](./BE-AUTO-SOL-001-confirm-routing-close-gaps.md) (phụ thuộc cứng)
