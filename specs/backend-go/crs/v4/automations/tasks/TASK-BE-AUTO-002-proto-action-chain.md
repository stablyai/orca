# TASK-BE-AUTO-002: Proto — `AutomationAction`/`actions`/`ActionResult`

**Solution:** [BE-AUTO-SOL-002](../solutions/BE-AUTO-SOL-002-multi-action-chain-data-model.md) | **CR:** CR-AUTO-002
**Depends on:** [TASK-BE-AUTO-001](./TASK-BE-AUTO-001-confirm-routing-and-document.md) (khuyến nghị, không cứng)
**Status:** ✅ DONE (2026-09-09)

---

## Mục tiêu

Thêm message/field mới vào `automation.proto` cho action chain nhiều
bước, KHÔNG đổi field cũ (`step_type`/`step_config_json` giữ nguyên).

## Files cần sửa

1. `backend-go/proto/orca/automation/v1/automation.proto` (MODIFY)
2. Chạy proto codegen (Makefile target — tìm lệnh đúng trong
   `backend-go/Makefile`, không tự đoán) để regen
   `automation.pb.go`/`automation_grpc.pb.go`

## Nội dung (xem BE-AUTO-SOL-002 §2)

```proto
enum AutomationActionType {
  AUTOMATION_ACTION_TYPE_UNSPECIFIED = 0;
  AUTOMATION_ACTION_TYPE_CREATE_WORKTREE = 1;
  AUTOMATION_ACTION_TYPE_RUN_AGENT = 2;
  AUTOMATION_ACTION_TYPE_COMMIT_PUSH = 3;
  AUTOMATION_ACTION_TYPE_CREATE_PR = 4;
  AUTOMATION_ACTION_TYPE_SEND_NOTIFICATION = 5;
  AUTOMATION_ACTION_TYPE_RUN_SCRIPT = 6;
}

message AutomationAction {
  string id = 1;
  AutomationActionType type = 2;
  string config_json = 3;
  bool continue_on_failure = 4;
}

message ActionResult {
  string action_id = 1;
  string status = 2; // running|completed|failed|skipped
  string output_json = 3;
  string error = 4;
}

message Automation {
  // ... field 1-9 hiện có giữ nguyên, KHÔNG đổi số thứ tự ...
  repeated AutomationAction actions = 10;
}

message AutomationRun {
  // ... field 1-3 hiện có giữ nguyên ...
  repeated ActionResult action_results = 4;
}
```

Xác nhận số thứ tự field tiếp theo còn trống trên `Automation` (đọc
proto thật — solution ghi số 10 nhưng phải xác nhận không trùng field
nào khác đã thêm sau thời điểm viết solution).

## Test cases cần cover

- Round-trip: marshal/unmarshal 1 `Automation` có `actions` rỗng (automation
  cũ) → không lỗi, `actions` giải mã thành slice rỗng (không `nil` gây
  panic ở usecase layer nếu code giả định non-nil).
- Round-trip: `Automation` có `actions` 2 phần tử → giữ đúng thứ tự sau
  unmarshal.

## Verify

```bash
cd backend-go && make proto-gen  # xác nhận đúng target thật trong Makefile trước khi chạy
go build ./services/automation-service/...
go test ./services/automation-service/internal/domain/...
```

## gitnexus

`impact({target: "Automation", direction: "downstream"})` trước khi đổi
message — xác nhận danh sách usecase/adapter nào decode struct này, để
biết phạm vi ảnh hưởng thật trước khi Track 2 tiếp tục ở TASK-BE-AUTO-004.

---

## ✅ Kết quả thực tế (2026-09-09)

**Mở rộng phạm vi có chủ đích** so với sketch: gộp luôn field
`max_run_history`/`run_timeout_seconds` (đáng lẽ thuộc TASK-BE-AUTO-010)
vào cùng đợt đổi proto này — đúng khuyến nghị của chính README's "Lưu ý
migration": tránh 2 lần đổi message `Automation`/`CreateAutomationRequest`
gần nhau về thời gian. TASK-BE-AUTO-010 khi làm sẽ chỉ còn phần Postgres
migration + logic prune/timeout, không cần đổi proto nữa.

**Lệch khác so với sketch**: `UpdateAutomationRequest` cần 1 field mới
không có trong sketch — `AutomationActionList actions_set` (message
wrapper riêng) thay vì để `repeated AutomationAction actions` trần trên
`UpdateAutomationRequest`. Lý do: proto3 không phân biệt được "field
repeated rỗng vì client không gửi" với "field repeated rỗng vì client cố
tình xoá hết action" — nếu dùng `repeated` trần, 1 update chỉ đổi
`enabled` (như `TestHandleUpdateAutomation_PartialEditOnlySetsProvidedFields`
đã test ở TASK-BE-AUTO-012) sẽ không thể phân biệt với "xoá hết action
chain", vi phạm đúng nguyên tắc partial-edit mà `UpdateAutomationRequest`
đã có sẵn cho mọi field khác (wrapper type). Thêm 1 message rỗng
`AutomationActionList` làm "wrapper" cho `repeated` field — cách duy nhất
proto3 hỗ trợ presence-check cho repeated field.

**Verify**: `make proto-gen` (buf) sạch. `go build` cho `proto/`,
`automation-service`, `api-gateway` — sạch (trừ `cmd/server`'s lỗi biên
dịch không liên quan, đã ghi nhận ở TASK-BE-EVM-021). `go test
./services/automation-service/...` — toàn bộ package pass, không có
test nào phá (automation cũ chỉ đọc `step_type`/`step_config_json`,
field mới đều optional/có default 0-value hợp lệ).

**Files đã sửa:**
- `backend-go/proto/orca/automation/v1/automation.proto` (MODIFY)
- `backend-go/proto/gen/go/orca/automation/v1/automation.pb.go` (regenerated)
- `backend-go/proto/gen/go/orca/automation/v1/automation_grpc.pb.go` (regenerated)
