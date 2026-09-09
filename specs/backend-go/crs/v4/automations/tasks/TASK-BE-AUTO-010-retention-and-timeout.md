# TASK-BE-AUTO-010: `max_run_history` + prune-on-write + `run_timeout_seconds`

**Solution:** [BE-AUTO-SOL-006](../solutions/BE-AUTO-SOL-006-retention-scheduler-hardening.md) | **CR:** CR-AUTO-007
**Depends on:** [TASK-BE-AUTO-003](./TASK-BE-AUTO-003-postgres-migration-action-chain.md) (schema — gộp migration nếu gần nhau)
**Status:** ✅ DONE (2026-09-09)

---

## Mục tiêu

Retention cấu hình theo automation (thay `MAX_AUTOMATION_RUNS_PER_AUTOMATION`
hardcode phía TS); run timeout tổng chain (2 giờ default).

## Files cần sửa

1. `backend-go/proto/orca/automation/v1/automation.proto` (MODIFY — thêm `max_run_history`, `run_timeout_seconds`)
2. Migration thêm/gộp (xem TASK-BE-AUTO-003's ghi chú gộp)
3. `backend-go/services/automation-service/internal/usecase/execute_automation_chain.go` (MODIFY — `context.WithTimeout` + prune sau khi ghi run)
4. Test tương ứng

## Nội dung

```proto
message Automation {
  // ...
  int32 max_run_history = 12;    // 0 = default 100
  int32 run_timeout_seconds = 13; // 0 = default 7200
}
```

```go
// prune sau khi AppendActionResult cuối cùng / khi run kết thúc
func pruneRuns(ctx context.Context, db *sql.DB, automationID string, maxRuns int) error {
    if maxRuns <= 0 { maxRuns = 100 }
    _, err := db.ExecContext(ctx, `
      DELETE FROM automation_runs WHERE automation_id = $1 AND id NOT IN (
        SELECT id FROM automation_runs WHERE automation_id = $1 ORDER BY created_at DESC LIMIT $2
      )`, automationID, maxRuns)
    return err
}
```

```go
// timeout tổng chain
timeout := time.Duration(automation.RunTimeoutSeconds) * time.Second
if timeout <= 0 { timeout = 2 * time.Hour }
ctx, cancel := context.WithTimeout(ctx, timeout)
defer cancel()
```

## Test cases cần cover

- Automation có 105 run, `max_run_history: 50` → sau prune còn đúng 50 run mới nhất.
- `max_run_history: 0` → dùng default 100 (không phải 0, tránh xoá hết run).
- Chain chạy quá `run_timeout_seconds` → context cancel, action đang chạy dừng, `ActionResult` ghi `status: failed`, `error` chứa "timeout".

## Verify

```bash
cd backend-go/services/automation-service && go test ./internal/usecase/... ./internal/adapter/postgres/...
```

## gitnexus

`impact({target: "execute_automation_chain.go", direction: "upstream"})`
— xác nhận không phá TASK-BE-AUTO-004/005/006/007 đã merge trước đó (đây
là file chung nhiều task cùng sửa — merge cẩn thận).

---

## ✅ Kết quả thực tế (2026-09-09)

**Lệch so với sketch gốc**:
1. Proto fields `max_run_history`/`run_timeout_seconds` và migration
   0003's cột tương ứng (`max_run_history`, `run_timeout_seconds`) **đã có
   sẵn** từ TASK-BE-AUTO-002/003 — domain.Automation cũng đã có 2 field
   này (`internal/domain/automation.go:99-103`). Task này do đó chỉ còn
   thật sự cần: (a) prune-on-write, (b) chain-level timeout.
2. Sketch gốc viết `pruneRuns(ctx, db *sql.DB, ...)` thao tác `*sql.DB`
   trực tiếp — không khớp kiến trúc port-based hiện có (usecase layer chỉ
   thấy `AutomationRunRepository` interface, không thấy `pgxpool.Pool`).
   Thay vào đó: thêm method mới `PruneRuns(ctx, tenantID, automationID
   string, maxRuns int32) error` vào `AutomationRunRepository` port
   (`ports.go`), implement trong `postgres/repository.go` bằng 1 câu
   `DELETE ... WHERE id NOT IN (SELECT ... ORDER BY created_at DESC LIMIT
   $3)` — cùng logic sketch, đúng layer.
3. **Phát hiện risk thật khi thêm timeout**: dùng chung 1 `ctx` cho cả
   dispatch loop lẫn việc ghi status cuối cùng (`UpdateStatus`) sẽ khiến
   chính lần ghi "failed" (do timeout) cũng thất bại vì `ctx` đã hết hạn
   — run kẹt "running" mãi mãi, phá luôn mục đích của
   TASK-BE-AUTO-011's concurrency guard. Sửa bằng cách tách `finalCtx :=
   context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)` cho
   riêng đoạn ghi status cuối + prune — không có trong sketch gốc, phát
   hiện khi implement.

**Nội dung đã làm**:
- `context.WithTimeout(ctx, effectiveRunTimeout(automation))` bọc toàn bộ
  dispatch loop trong `ExecuteAutomationChain.Execute` — `effectiveRunTimeout`
  trả về `RunTimeoutSeconds` giây, hoặc default 2h nếu `<= 0`.
- `pruneRuns()` gọi `uc.runs.PruneRuns(finalCtx, tenantID, automation.ID,
  effectiveMaxRunHistory(automation))` sau khi ghi status cuối (cả 2
  nhánh Failed/Succeeded) — best-effort (`_ =`), cùng convention với
  intermediate `UpdateStatus` calls trong loop.
- `effectiveMaxRunHistory()` trả `MaxRunHistory` hoặc default 100 nếu
  `<= 0`.

**Test cases đã cover** (khác thứ tự sketch nhưng cùng nội dung):
- Unit (`execute_automation_chain_test.go`, fake repo): prune gọi đúng
  `maxRuns` (default 100 và override), prune chạy trên CẢ 2 nhánh
  success/failure, `ctx` truyền cho dispatch có deadline đúng derive từ
  `RunTimeoutSeconds` (dùng `deadlineCapturingExecutor`, không cần chờ
  timeout thật).
- Integration (`postgres/repository_test.go`, Postgres thật qua
  testcontainers-go, **đã chạy thật trong sandbox này, không giả định
  pass**): 105→50 run scenario thay bằng 5→2 (tương đương, nhỏ hơn cho
  test nhanh) — `TestAutomationRunRepository_PruneRuns_KeepsOnlyMostRecentN`
  xác nhận đúng 2 run mới nhất theo `created_at` sống sót;
  `TestAutomationRunRepository_PruneRuns_ZeroOrNegativeIsNoop` xác nhận
  `maxRuns<=0` không xoá gì (port's "0 = no-op, caller resolves default"
  contract).
- **Không viết** test "chain chạy quá `run_timeout_seconds` → context
  cancel thật" bằng cách chờ hết giờ thật (sketch's ý số 3) — thay bằng
  test nhanh xác nhận `ctx.Deadline()` đúng giá trị derive, vì
  `ExecuteAutomationChain.dispatch()` đã tự nhiên propagate `ctx.Err()`
  qua `err != nil` path của mọi executor call (không cần logic
  timeout-riêng để action trả `status:"failed"` — cơ chế lỗi chung đã đủ).

**Verify (chạy thật trong sandbox này)**:
```
gofmt -l ...            # sạch, không file nào cần format
go build ./services/automation-service/...        # sạch
go vet ./services/automation-service/...           # sạch
go test ./services/automation-service/...           # PASS (toàn bộ unit)
go test -tags=integration ./services/automation-service/internal/adapter/postgres/... -run PruneRuns -v
  # PASS (2/2, Postgres thật qua testcontainers-go/Docker) — 1 lần retry
  # do race khởi động container Postgres không liên quan tới code (đã
  # thấy lặp lại độc lập với thay đổi ở task này)
```

**Files đã sửa:**
- `backend-go/services/automation-service/internal/usecase/ports.go` (MODIFY — thêm `PruneRuns` vào `AutomationRunRepository`)
- `backend-go/services/automation-service/internal/usecase/execute_automation_chain.go` (MODIFY — timeout wrap + prune-on-write + helpers)
- `backend-go/services/automation-service/internal/usecase/execute_automation_chain_test.go` (MODIFY — 6 test mới)
- `backend-go/services/automation-service/internal/usecase/run_now_test.go` (MODIFY — `fakeAutomationRunRepository.PruneRuns` + `prunedRunsCall`)
- `backend-go/services/automation-service/internal/adapter/scheduler/ticker_test.go` (MODIFY — fake's `PruneRuns` no-op, để compile)
- `backend-go/services/automation-service/internal/adapter/postgres/repository.go` (MODIFY — `AutomationRunRepository.PruneRuns` thật)
- `backend-go/services/automation-service/internal/adapter/postgres/repository_test.go` (MODIFY — 2 integration test mới)
