# TASK-BE-AUTO-011: `running_run_id` — concurrency guard

**Solution:** [BE-AUTO-SOL-006](../solutions/BE-AUTO-SOL-006-retention-scheduler-hardening.md) | **CR:** CR-AUTO-007
**Depends on:** [TASK-BE-AUTO-003](./TASK-BE-AUTO-003-postgres-migration-action-chain.md), [TASK-BE-AUTO-010](./TASK-BE-AUTO-010-retention-and-timeout.md)
**Status:** ✅ DONE (2026-09-09)

---

## Mục tiêu

Ngăn manual run (`RunNow`) chạy chồng với scheduled run đang chạy cùng
automation.

## Files cần sửa

1. Migration (gộp với TASK-BE-AUTO-003/010 nếu gần nhau) — thêm cột `running_run_id` (nullable) trên `automations`
2. `backend-go/services/automation-service/internal/usecase/execute_automation_chain.go` (MODIFY — acquire/release lock)
3. Test tương ứng

## Nội dung

```sql
ALTER TABLE automations ADD COLUMN running_run_id TEXT;
ALTER TABLE automations ADD COLUMN running_since TIMESTAMPTZ;
```

```go
func acquireRunLock(ctx context.Context, db *sql.DB, automationID, runID string, ttl time.Duration) (bool, error) {
    res, err := db.ExecContext(ctx, `
      UPDATE automations SET running_run_id = $1, running_since = now()
      WHERE id = $2 AND (running_run_id IS NULL OR running_since < now() - $3::interval)
    `, runID, automationID, ttl)
    if err != nil { return false, err }
    n, _ := res.RowsAffected()
    return n > 0, nil
}
// ttl = run_timeout_seconds (TASK-BE-AUTO-010) + buffer (vd. 15 phút) — không hardcode độc lập với timeout config
func releaseRunLock(ctx context.Context, db *sql.DB, automationID, runID string) error {
    _, err := db.ExecContext(ctx, `UPDATE automations SET running_run_id = NULL WHERE id = $1 AND running_run_id = $2`, automationID, runID)
    return err
}
```

`ExecuteAutomationChain.Run` gọi `acquireRunLock` đầu hàm (nếu `false`,
trả lỗi `"automation is already running, run <id> in progress"`),
`defer releaseRunLock`.

## Test cases cần cover

- 2 lời gọi `Run` đồng thời cho cùng automation → chỉ 1 acquire thành công.
- Lock cũ hơn TTL (giả lập crash không release) → acquire mới thành công (tự giải phóng).
- Release đúng sau khi run kết thúc (thành công/lỗi/timeout) — dùng `defer`, không sót nhánh nào.

## Verify

```bash
cd backend-go/services/automation-service && go test -race ./internal/usecase/...
```

## gitnexus

`impact({target: "ExecuteAutomationChain", direction: "upstream"})` —
xác nhận `RunNow` usecase và scheduler ticker đều đi qua đúng hàm có
lock này, không có đường tắt nào bỏ qua.

---

## ✅ Kết quả thực tế (2026-09-09)

**Lệch so với sketch gốc**:
1. Cột `running_run_id` migration 0003 (từ TASK-BE-AUTO-003) tạo kiểu
   **`UUID`**, không phải `TEXT` như sketch — phát hiện thật khi chạy
   integration test đầu tiên với run ID dạng chuỗi tuỳ ý
   (`"run-first"`): Postgres báo `invalid input syntax for type uuid`.
   Sửa test dùng UUID literal thay vì tự do đặt chuỗi — không đổi migration
   (domain.AutomationRun.ID luôn là UUID thật trong production nên không
   phải vấn đề runtime, chỉ là test ban đầu viết sai giả định).
2. Sketch dùng `db.ExecContext` trực tiếp trên `*sql.DB` — không khớp
   kiến trúc port-based (giống TASK-BE-AUTO-010's phát hiện). Thay bằng 2
   method mới trên `AutomationRepository` port: `AcquireRunLock(ctx,
   tenantID, automationID, runID string, ttl time.Duration) (bool,
   error)` và `ReleaseRunLock(ctx, tenantID, automationID, runID string)
   error` — implement bằng 1 câu `UPDATE ... WHERE (running_run_id IS
   NULL OR running_since < now() - make_interval(secs => $4))` (dùng
   `make_interval` thay vì nối chuỗi interval — tránh cast lỗi và rõ ràng
   hơn), atomic dưới race nhờ Postgres serialize UPDATE cùng row.
3. **`ExecuteAutomationChain`'s constructor đổi signature** (`runs,
   executor, pullRequests` → `automations, runs, executor,
   pullRequests`) — ảnh hưởng tất cả 13 call site có sẵn trong
   `execute_automation_chain_test.go` + 3 fake `AutomationRepository`
   khác (`run_now_test.go`, `scheduler/ticker_test.go`,
   `grpc/server_test.go`) cần thêm `AcquireRunLock`/`ReleaseRunLock` để
   compile — không có trong sketch gốc's phạm vi "chỉ sửa
   execute_automation_chain.go".
4. **Phát hiện risk timing thật**: lock ACQUIRE dùng `ctx` gốc (trước khi
   bọc `context.WithTimeout` cho cả chain), còn RELEASE (trong `defer`)
   dùng `context.WithoutCancel(ctx)` + timeout riêng 10s — cùng lý do với
   `finalCtx` ở TASK-BE-AUTO-010: nếu dùng chung `ctx` đã hết hạn cho cả
   release, 1 chain timeout ra sẽ KHÔNG BAO GIỜ nhả lock, khoá luôn mọi
   lần chạy sau của automation đó cho tới khi lock TTL riêng (dài hơn
   nhiều — `RunTimeoutSeconds + 15 phút`) tự hết hạn.
5. **Quyết định thiết kế khi lock bị chiếm** (`acquired=false`): trả
   `apperrors.New(KindFailedPrecondition, "AUTOMATION_ALREADY_RUNNING",
   ...)` ngay, KHÔNG tự chuyển `run` sang trạng thái Failed — vì `run`
   được tạo/đánh dấu Running bởi caller TRƯỚC khi gọi `Execute` (theo
   đúng precondition đã ghi trong doc comment gốc của
   `ExecuteAutomationChain`), nên việc dọn dẹp row này là trách nhiệm của
   caller. Ghi rõ trong code comment: 1 lần tích hợp `RunNow` thật trong
   tương lai NÊN acquire lock TRƯỚC KHI tạo run row, để tránh hoàn toàn
   tình huống "run row mồ côi" này — nằm ngoài phạm vi task này (chỉ xây
   `ExecuteAutomationChain`'s cơ chế lock, chưa nối vào `RunNow`, đúng
   design "không rewiring RunNow" đã ghi từ TASK-BE-AUTO-004).

**Test cases đã cover** (unit, `execute_automation_chain_test.go`, khớp
đúng 3 mục sketch's "Test cases cần cover"):
- `TestExecuteAutomationChain_ConcurrentRuns_OnlyOneAcquiresTheLock` — 2
  run cho cùng automation, chỉ 1 acquire thành công (run2 pre-empted bằng
  cách acquire trước qua fake, xác nhận đúng nội dung + kind lỗi
  `AppError{KindFailedPrecondition, AUTOMATION_ALREADY_RUNNING}`, và
  executor KHÔNG được gọi lần nào).
- `TestExecuteAutomationChain_StaleLockPastTTL_SelfHeals` — lock cũ hơn
  TTL (giả lập crash, backdate `lockSince`) → acquire mới thành công, run
  chạy trọn tới Succeeded.
- `TestExecuteAutomationChain_ReleasesLockOnSuccess` /
  `_ReleasesLockOnActionFailure` — xác nhận `defer` release chạy đúng ở cả
  2 nhánh kết thúc (Succeeded/Failed), không sót nhánh nào (đúng ý sketch
  "dùng `defer`, không sót nhánh nào").

**Test cases đã cover** (integration thật qua Postgres/testcontainers-go,
`postgres/repository_test.go`, **chạy thật trong sandbox này**):
- `TestAutomationRepository_AcquireRunLock_OnlyOneCallerWinsWhenUnlocked` —
  acquire thứ 2 trên automation đã khoá (còn tươi) → `false`,
  `running_run_id` DB vẫn giữ đúng caller đầu tiên.
- `TestAutomationRepository_AcquireRunLock_StaleLockPastTTLSelfHeals` —
  TTL 1s, chờ thật 1.2s (không mock thời gian) → acquire mới thành công,
  xác nhận đúng biểu thức `now() - make_interval(...)` chạy đúng trên
  Postgres thật.
- `TestAutomationRepository_ReleaseRunLock_OnlyReleasesOwnLock` — release
  bởi ID không phải chủ sở hữu → no-op (`running_run_id` không đổi);
  release bởi đúng chủ sở hữu → `running_run_id`/`running_since` về NULL.

**Verify (chạy thật trong sandbox này)**:
```
gofmt -l ...                         # sạch
go build ./services/automation-service/...        # sạch
go vet ./services/automation-service/...           # sạch
go test -race ./services/automation-service/...    # PASS, không data race
go test -tags=integration ./services/automation-service/internal/adapter/postgres/... -run RunLock -v
  # PASS 3/3 (Postgres thật) — 1 lần retry do cùng race khởi động
  # container đã thấy độc lập ở TASK-BE-AUTO-010, không liên quan code
```

**Files đã sửa:**
- `backend-go/services/automation-service/internal/usecase/ports.go` (MODIFY — thêm `AcquireRunLock`/`ReleaseRunLock` vào `AutomationRepository`)
- `backend-go/services/automation-service/internal/usecase/execute_automation_chain.go` (MODIFY — constructor đổi signature, acquire/release lock, `runLockTTLBuffer`)
- `backend-go/services/automation-service/internal/usecase/execute_automation_chain_test.go` (MODIFY — 13 call site cập nhật + 4 test mới)
- `backend-go/services/automation-service/internal/usecase/run_now_test.go` (MODIFY — `fakeAutomationRepository.AcquireRunLock`/`ReleaseRunLock` thật, có TTL/self-heal logic)
- `backend-go/services/automation-service/internal/adapter/scheduler/ticker_test.go` (MODIFY — fake no-op, để compile)
- `backend-go/services/automation-service/internal/adapter/grpc/server_test.go` (MODIFY — fake no-op, để compile)
- `backend-go/services/automation-service/internal/adapter/postgres/repository.go` (MODIFY — `AutomationRepository.AcquireRunLock`/`ReleaseRunLock` thật)
- `backend-go/services/automation-service/internal/adapter/postgres/repository_test.go` (MODIFY — 3 integration test mới)
