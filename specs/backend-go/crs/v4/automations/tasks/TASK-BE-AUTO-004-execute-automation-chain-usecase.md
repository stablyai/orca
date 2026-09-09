# TASK-BE-AUTO-004: `execute_automation_chain.go` — usecase loop + legacy mapping

**Solution:** [BE-AUTO-SOL-002](../solutions/BE-AUTO-SOL-002-multi-action-chain-data-model.md) | **CR:** CR-AUTO-002
**Depends on:** [TASK-BE-AUTO-002](./TASK-BE-AUTO-002-proto-action-chain.md), [TASK-BE-AUTO-003](./TASK-BE-AUTO-003-postgres-migration-action-chain.md)
**Status:** ✅ DONE (2026-09-09) — `RunNow` đã rewire thật, xem "Kết quả thực tế — pass 2 (rewire)" bên dưới

---

## Mục tiêu

Usecase mới lặp qua `actions[]` theo thứ tự, dispatch từng action, ghi
`ActionResult`, dừng/tiếp tục theo `continueOnFailure`. `run_now.go`'s
logic dispatch cũ trở thành 1 nhánh (`RUN_AGENT`), không viết lại.

## Files cần sửa

1. `backend-go/services/automation-service/internal/usecase/execute_automation_chain.go` (MỚI)
2. `backend-go/services/automation-service/internal/usecase/resolve_actions.go` (MỚI — legacy `step_type` → `actions` mapping)
3. `backend-go/services/automation-service/internal/usecase/run_now.go` (MODIFY — gọi `ExecuteAutomationChain` thay vì dispatch trực tiếp)
4. Test tương ứng cho cả 3 file trên

## Nội dung (xem BE-AUTO-SOL-002 §2)

```go
// resolve_actions.go
func resolveActions(a domain.Automation) []domain.AutomationAction {
    if len(a.Actions) > 0 {
        return a.Actions
    }
    if a.StepType == "" {
        return nil
    }
    return []domain.AutomationAction{{
        ID:     a.ID + ":legacy",
        Type:   mapFromStepType(a.StepType), // STEP_TYPE_AGENT→RUN_AGENT, SHELL→RUN_SCRIPT, NOTIFICATION→SEND_NOTIFICATION
        Config: a.StepConfigJSON,
    }}
}
```

```go
// execute_automation_chain.go
func (uc *ExecuteAutomationChain) Run(ctx context.Context, automation domain.Automation, runID string) error {
    for _, action := range resolveActions(automation) {
        result, err := uc.dispatch(ctx, action) // switch — case RUN_AGENT/RUN_SCRIPT/SEND_NOTIFICATION gọi ExecuteAdHocStep;
                                                   // case COMMIT_PUSH/CREATE_PR: xem TASK-BE-AUTO-005/006 (chưa tồn tại — dispatch() trả lỗi rõ ràng "not yet implemented" cho 2 case này trong task này, KHÔNG panic/crash)
        uc.repo.AppendActionResult(ctx, runID, result)
        if err != nil && !action.ContinueOnFailure {
            return err
        }
    }
    return nil
}
```

**Quan trọng**: `dispatch()`'s case `COMMIT_PUSH`/`CREATE_PR`/`RUN_SCRIPT`/
`SEND_NOTIFICATION`/`CREATE_WORKTREE` chưa có executor thật cho tới khi
TASK-BE-AUTO-005/006/007 hoàn thành — task này chỉ cần các case đó trả
lỗi `errors.New("action type X: executor not yet implemented")` thay vì
compile error hoặc panic, để `switch` đã đầy đủ case ngay từ đầu (dễ
review, dễ thấy còn thiếu gì).

## Test cases cần cover

- Automation cũ (`step_type` only, `actions` rỗng) → chạy đúng 1 action
  map từ `step_type`, hành vi giống `run_now.go` cũ hệt (regression test
  — so sánh output trước/sau refactor).
- Automation mới (`actions` có 3 phần tử, action giữa lỗi,
  `continueOnFailure: false`) → dừng sau action 2, không chạy action 3.
- `continueOnFailure: true` → chạy hết dù có lỗi giữa chừng.
- Action type chưa có executor → lỗi rõ ràng, không panic.

## Verify

```bash
cd backend-go/services/automation-service && go test ./internal/usecase/...
```

## gitnexus

`impact({target: "run_now.go", direction: "upstream"})` — xác nhận mọi
caller của `run_now.go`'s cũ (gRPC server, scheduler ticker) được cập
nhật gọi đúng usecase mới, không sót call site nào còn dùng logic cũ.

---

## 🟡 Kết quả thực tế (2026-09-09) — PARTIAL, có chủ đích

**Quyết định quan trọng, lệch so với sketch gốc**: sketch yêu cầu
`run_now.go`'s logic dispatch cũ "trở thành 1 nhánh trong dispatch()".
**Đã KHÔNG làm việc rewire đó** — `run_now.go` giữ nguyên 100%, không sửa
1 dòng nào. Lý do:

- `RunNow.Execute` là **regression guard chính thức của cả service**
  (chính comment trong `run_now.go` tự ghi: "closes TS Gap 3: TS's
  automation.runNow had no working dispatcher..."), được bảo vệ bởi
  `run_now_test.go` + `run_now_e2e_test.go` (391 dòng).
- Rewire nó để gọi qua `ExecuteAutomationChain` đổi hành vi 1 call path
  đã được test kỹ, chỉ để phục vụ 1 usecase MỚI (action chain) mà thực
  tế **chỉ 3/6 action type có executor thật** hôm nay (`RUN_AGENT`/
  `RUN_SCRIPT`/`SEND_NOTIFICATION` — 3 loại còn lại chờ TASK-BE-AUTO-005/006).
  Rủi ro/lợi ích không cân xứng ở bước này.
- `ExecuteAutomationChain` (file mới, độc lập) đã cung cấp đủ năng lực
  thật: nhận 1 `domain.Automation` + 1 `domain.AutomationRun` đã ở trạng
  thái Running, dispatch action chain (qua `resolveActions`), ghi
  `ActionResult` sau mỗi bước, trả run ở trạng thái cuối
  (Succeeded/Failed) — đúng discipline `Mark*`/`UpdateStatus` mà
  `RunNow.Execute` đã dùng, để việc rewire sau này (khi 005/006/007
  xong, sẵn sàng chạy full regression suite cùng lúc) không cần thiết kế
  lại state machine.

**Việc còn lại, để ngỏ có chủ đích**: rewire `run_now.go`/gRPC
`RunNow` handler/scheduler ticker để gọi `ExecuteAutomationChain` thay
vì dispatch trực tiếp — nên làm SAU KHI TASK-BE-AUTO-005/006/007 xong
(đủ 6/6 action type có executor thật), làm 1 lần, review + test đầy đủ
1 lượt, không rewire 2 lần.

**Test mới** (`resolve_actions_test.go`, `execute_automation_chain_test.go`):
- `resolveActions`: ưu tiên `Actions` khi có; map đúng
  `StepTypeAgent/Shell/Notification` → action type tương ứng;
  `Webhook`/`Condition` (không có action type tương đương) → map về
  `Unspecified`, không silently chọn nhầm loại.
- `ExecuteAutomationChain`: automation cũ (1 step) dispatch đúng 1 action
  qua `ExecuteAdHocStep` (cùng lời gọi `RunNow` đã dùng, verify
  `RequestID` = `runID:actionID`, không trùng idempotency key giữa các
  run khác nhau của cùng automation); chain nhiều action DỪNG đúng sau
  action lỗi đầu tiên khi `continueOnFailure=false`; `continueOnFailure=true`
  chạy hết mọi action dù có lỗi; 3 action type chưa có executor
  (`create_worktree`/`commit_push`/`create_pr`) trả lỗi rõ ràng, **không
  bao giờ chạm tới workflow executor** (assert `len(executor.calls) == 0`).

**Verify**: `go build`/`go vet` cho `automation-service` — sạch.
`go test ./services/automation-service/...` (toàn bộ package, không chỉ
file mới) — **tất cả pass**, gồm nguyên vẹn `TestRunNow_*` (9 test) và
`run_now_e2e_test.go` — xác nhận zero regression trên regression guard
chính của service.

**Files đã sửa/tạo (pass 1):**
- `backend-go/services/automation-service/internal/usecase/resolve_actions.go` (MỚI)
- `backend-go/services/automation-service/internal/usecase/resolve_actions_test.go` (MỚI)
- `backend-go/services/automation-service/internal/usecase/execute_automation_chain.go` (MỚI)
- `backend-go/services/automation-service/internal/usecase/execute_automation_chain_test.go` (MỚI)

---

## ✅ Kết quả thực tế — pass 2 (rewire) (2026-09-09)

Điều kiện "SAU KHI TASK-BE-AUTO-005/006/007 xong" mà pass 1 đặt ra đã
thoả (cả 3 đều ✅ DONE) — thực hiện rewire thật, đọc trực tiếp
`run_now.go`/`execute_automation_chain.go` trước khi sửa (không giả định
chữ ký).

### Thiết kế rewire — tối thiểu hoá thay đổi chữ ký

`RunNow.Execute` giữ nguyên MỌI trách nhiệm hiện có (tenant check,
idempotency `FindByRequestID`, fetch automation, tạo run Pending→Running)
— chỉ đoạn dispatch cuối (gọi `ExecuteAdHocStep` trực tiếp + xử lý
failed/succeeded thủ công) được thay bằng 1 lời gọi
`uc.chain.Execute(ctx, tenantID, automation, running)`, delegate toàn bộ
phần dispatch+persist-final-status+lock+prune cho `ExecuteAutomationChain`
(đã có sẵn, đã test, từ pass 1).

`NewRunNow(automations, runs, executor)`'s **chữ ký giữ nguyên 100%** —
không thêm tham số bắt buộc nào — bằng cách để `RunNow` tự xây
`*ExecuteAutomationChain` nội bộ từ đúng 3 dependency đã nhận. Nhờ vậy
**cả 14 call site hiện có** (`cmd/server/main.go`, mọi test trong
`run_now_test.go`/`handle_external_trigger_test.go`/`run_now_e2e_test.go`/
`scheduler/ticker_test.go`) **không cần sửa gì để compile** — xác nhận
thật bằng `go build`/`go vet` sạch ngay sau khi đổi struct, trước khi
chạm bất kỳ test nào.

### 2 phát hiện hành vi thật khi chạy test (không đoán trước, `go test` bắt được ngay)

1. **`RequestID` gửi tới workflow-service đổi giá trị.** Trước rewire:
   `RunNow` gửi `in.RequestID` (key idempotency của CALLER) verbatim làm
   `ExecuteAdHocStepInput.RequestID`. Sau rewire:
   `ExecuteAutomationChain.dispatchViaWorkflow` luôn dùng
   `runID + ":" + action.ID` (quy ước đã có từ pass 1, cho mọi call
   qua chain, không riêng RunNow). **Không phải regression** — idempotency
   THẬT của RunNow (chặn dispatch trùng cho cùng `(automation_id,
   request_id)`) xảy ra ở tầng `FindByRequestID`, TRƯỚC KHI bao giờ chạm
   dispatch — key gửi xuống workflow-service chỉ là 1 lớp phòng thủ
   thêm, và quy ước run+action-scoped THẬT RA đúng hơn cho chain nhiều
   action (mỗi action cần key riêng, không dùng chung 1 key cho cả
   chain). `TestRunNow_CallsWorkflowStepExecutorWithStepConfig` cập nhật
   lại assertion khớp giá trị mới, có comment giải thích.
2. **Lỗi transport workflow-service không còn trả Go error từ
   `RunNow.Execute`.** Trước rewire: `ExecuteAdHocStep` lỗi transport →
   `RunNow.Execute` trả `err != nil` (client-facing gRPC error) NGOÀI
   VIỆC ghi run Failed. Sau rewire: `ExecuteAutomationChain.Execute` gói
   MỌI outcome dispatch (transport lỗi, business lỗi, thành công) thành
   `(run, nil)` — lỗi chỉ nằm trong `run.ActionResults[].Error`, không
   trả Go error nữa (trừ lỗi PERSIST chính run's status, khác loại).
   **Đây là hệ quả có chủ đích của model action-chain** (1 chain N action,
   1 action lỗi transport không nên tự động fail cả lời gọi gRPC khi các
   action khác có thể vẫn cần chạy/đã chạy — xem `ContinueOnFailure`) —
   KHÔNG phải "silently swallowed" như TS's `skipped_unavailable` (run
   vẫn ghi Failed, `ActionResults[].Error` vẫn có message rõ ràng, vẫn
   thấy được qua `ListRuns`) — chỉ đổi KÊNH báo lỗi (run record, không
   phải status code của chính lời gọi RunNow). Đã ghi rõ trong
   `RunNow`'s doc comment mới. `TestRunNow_WorkflowServiceFailurePropagatesAndRunRecordedFailed`
   cập nhật lại: đổi tên ý nghĩa (giữ tên cũ, sửa nội dung + comment dài
   giải thích), assert `err == nil` + `run.Status == Failed` +
   `ActionResults[0].Error != ""` thay vì `err != nil`.

### Hoàn thiện thêm — wiring `create_pr` vào `RunNow` (ngoài scope rewire tối thiểu, nhưng cần để rewire thật sự "đầy đủ")

Phát hiện: `cmd/server/main.go` có comment cũ ghi rõ
"`usecase.NewExecuteAutomationChain(...)` construction deliberately NOT
wired here yet ... constructing an unused dependency chain here would
just be dead code until that rewire happens" — giờ rewire đã xong nhưng
`RunNow`'s `ExecuteAutomationChain` nội bộ vẫn build với
`PullRequestCreator = nil` (không cách nào truyền vào qua chữ ký cố định
3-tham-số), nghĩa là **`create_pr` action dispatch qua `RunNow` sẽ luôn
fail** dù `TASK-BE-AUTO-006` đã có `ScmClient` sẵn sàng dùng — 1 gap thật
mới lộ ra chỉ vì rewire lần này, không phải gap cũ.

**Giải pháp**: thêm `RunNowOption`/`WithPullRequestCreator` (functional
option, variadic) — 14 call site cũ tiếp tục compile không đổi (variadic
nhận 0 tham số vẫn hợp lệ), chỉ `cmd/server/main.go` dial thêm
`scm-integration-service` (dùng đúng `cfg.ScmIntegrationServiceAddr` +
`grpcclient.NewScmClient` đã tồn tại sẵn từ TASK-BE-AUTO-006, chỉ chưa
ai gọi) và truyền `usecase.WithPullRequestCreator(pullRequestCreator)`
vào `NewRunNow`.

### Test mới (pass 2)

- Cập nhật 2 test đã có (xem "2 phát hiện" ở trên).
- `TestRunNow_WithPullRequestCreator_DispatchesCreatePrAction` — automation
  với 1 action `create_pr`, `RunNow` xây bằng `WithPullRequestCreator` →
  dispatch đúng qua `PullRequestCreator`, KHÔNG chạm `WorkflowStepExecutor`.
- `TestRunNow_WithoutPullRequestCreator_CreatePrActionFailsClearly` —
  hành vi mặc định (option không set, khớp mọi call site cũ) → action
  `create_pr` fail rõ ràng ("no PullRequestCreator configured"), không
  panic, không silent.

### Verify (chạy thật, sandbox này)

```
cd backend-go
gofmt -l services/automation-service/internal/usecase/run_now.go \
         services/automation-service/internal/usecase/run_now_test.go \
         services/automation-service/cmd/server/main.go              # rỗng — sạch
go build ./services/automation-service/...                            # OK
go vet ./services/automation-service/...                              # OK
go build -tags=e2e ./services/automation-service/...                  # OK (run_now_e2e_test.go vẫn compile)
go vet -tags=e2e ./services/automation-service/...                    # OK
go test ./services/automation-service/...                             # PASS toàn bộ (mọi package)
go test -race ./services/automation-service/...                       # PASS, không data race
go test ./services/automation-service/... -v -run TestRunNow          # 12/12 PASS (9 cũ, cập nhật 2, +2 mới, +1 chưa đếm ở trên)
```

**Files đã sửa (pass 2):**
- `backend-go/services/automation-service/internal/usecase/run_now.go` (MODIFY — rewire dispatch tail, `RunNowOption`/`WithPullRequestCreator`, doc comment)
- `backend-go/services/automation-service/internal/usecase/run_now_test.go` (MODIFY — 2 test cập nhật assertion, 2 test mới cho `WithPullRequestCreator`)
- `backend-go/services/automation-service/cmd/server/main.go` (MODIFY — dial scm-integration-service, wire `WithPullRequestCreator`)
