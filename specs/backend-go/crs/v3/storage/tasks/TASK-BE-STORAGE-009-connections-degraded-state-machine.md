# TASK-BE-STORAGE-009: `connections` — cột `degraded_since`/`grace_period_seconds` + state machine

**Solution:** BE-SOL-STORAGE-003 | **CR:** CR-STORAGE-008(b)
**Service:** `infra-fleet-service`
**Depends on:** Không
**Status:** ✅ DONE — 2026-09-07

---

**Kết quả thực tế:**

- `migrations/0014_connections_grace_period.{up,down}.sql` (MỚI): thêm
  `degraded_since TIMESTAMPTZ NULL`, `grace_period_seconds INTEGER NOT NULL
  DEFAULT 300` vào `infra.connections`. **Đã test thật** bằng cách apply
  `up.sql` rồi `down.sql` rồi `up.sql` lại trực tiếp qua `psql` lên container
  `orca-go-postgres` thật (`\d infra.connections` xác nhận cột xuất hiện/biến
  mất đúng cả 2 chiều) — không qua CLI `golang-migrate` vì
  `schema_migrations.version` của DB này đang ở 6 dù có 13 file migration
  (drift lịch sử đã ghi chú trong migration 0007's header comment); chạy
  `migrate up` từ version 6 có rủi ro va vào schema đã áp dụng trước đó.
  SQL được xác nhận đúng bằng thực thi thật, không chỉ đọc bằng mắt.
- `internal/domain/connection.go` (MODIFY): thêm `DegradedSince *time.Time`,
  `GracePeriodSeconds int` vào `Connection`; 4 hằng số trạng thái
  (`ConnectionStatusEstablishing/Established/Degraded/Closed`); 2 sentinel
  error mới (`ErrGracePeriodExpired`, `ErrGracePeriodNotYetExpired`); 4
  method thuần domain đúng chữ ký task yêu cầu: `MarkDegraded(now)`,
  `Reestablish(now)`, `CloseAfterGracePeriodExpiry(now)`, `CloseExplicitly()`
  — không I/O, không phụ thuộc usecase/adapter.
- `internal/domain/connection_test.go` (MỚI): đúng cả 4 test tên yêu cầu —
  `TestConnection_MarkDegraded_OnlyFromEstablished`,
  `TestConnection_Reestablish_WithinGracePeriod_ReturnsToEstablished`,
  `TestConnection_Reestablish_AfterGracePeriodExpiry_ReturnsError`,
  `TestConnection_CloseExplicitly_BypassesGracePeriodFromAnyNonClosedStatus`
  — cả 4 pass (`go test ./internal/domain/... -run TestConnection -v`).
- `internal/usecase/poll_fleet_health.go` (MODIFY — usecase health-poll/
  heartbeat-loss thật của service này, không phải `resolve_connection.go`:
  `ResolveConnection` là read-path thuần túy, không có logic health-poll
  nào; `PollFleetHealth` mới là nơi phát hiện heartbeat-loss qua
  `agent.Health()` + so sánh mẫu trước/sau). Thêm nhánh: khi phát hiện
  dev server chuyển reachable→unreachable, tìm active connection qua
  `ConnectionRepository.GetActiveByDevServer` rồi gọi `conn.MarkDegraded(now)`
  + persist qua `UpdateStatus` (port mới, MODIFY `ports.go` +
  `repository.go`); khi unreachable→reachable, gọi `conn.Reestablish(now)`
  hoặc `conn.CloseAfterGracePeriodExpiry(now)` nếu hết hạn. Toàn bộ logic
  transition nằm trong domain, usecase chỉ gọi — đúng yêu cầu "không tự viết
  logic transition trực tiếp trong usecase".
- `cmd/server/main.go` (MODIFY — ngoài 4 file được liệt kê ban đầu, nhưng
  cần thiết để wiring thật hoạt động): `NewPollFleetHealth` nhận thêm
  `ConnectionRepository` param, truyền `repo`.
- Test usecase-level mới (`poll_fleet_health_test.go`):
  `TestPollFleetHealth_ReachableToUnreachableTransition_MarksActiveConnectionDegraded`,
  `TestPollFleetHealth_UnreachableToReachable_ReestablishesActiveConnection`
  — xác nhận domain method thật sự được gọi từ usecase, không phải logic
  inline. `TestDegradedConnectionDoesNotTripCircuitBreaker` **không**
  implement — đúng như task doc tự cho phép ("có thể viết trước dạng
  pending/skip nếu làm task này trước"): khái niệm circuit breaker/
  `failure_count` thuộc `orchestration-service.DispatchContext`, chưa tồn
  tại, phụ thuộc TASK-BE-STORAGE-011.

**Verify thật đã chạy:**
```
cd backend-go/services/infra-fleet-service && go build ./...                    # sạch
go test ./internal/domain/... -run TestConnection -v                             # 4/4 pass
go test ./...                                                                     # tất cả pass
gofmt -l .                                                                        # sạch
```

**Lưu ý môi trường (trung thực, không thuộc chất lượng code):** trong lúc
làm task này, workspace dùng chung `/opt/repos/orca` bị 1 tiến trình khác
(agent khác đang hoạt động song song) chạy `git stash`/checkout sang branch
`feature/project-delete-ui`, xoá mất các thay đổi chưa commit của session
này nhiều lần giữa chừng — đã khôi phục lại đầy đủ từ `git stash` (vẫn còn
giữ, chưa drop) + viết lại thủ công phần bị mất, xác nhận lại bằng build/test
thật sau mỗi lần khôi phục. Không có thay đổi nào của agent khác bị xoá bởi
việc khôi phục này (chỉ checkout đúng các file thuộc `infra-fleet-service`
+ proto `infrafleet` từ stash, không đụng các service khác).

## ⚠️ Lưu ý phạm vi (nhắc lại từ solution)

Task này **không** giải quyết session affinity/connection handoff hạ tầng
khi service chạy nhiều pod (`infra-fleet-service.md` §8's câu hỏi mở) —
giả định transport-level đã reconnect đúng chỗ; chỉ định nghĩa state
machine ứng dụng phía trên giả định đó.

## Files cần sửa

1. `backend-go/services/infra-fleet-service/migrations/XXXX_connections_grace_period.up.sql` (MỚI)
2. `backend-go/services/infra-fleet-service/migrations/XXXX_connections_grace_period.down.sql` (MỚI)
3. `backend-go/services/infra-fleet-service/internal/usecase/resolve_connection.go` (MODIFY — hoặc file usecase health-poll tương đương, §7 TDD)
4. `backend-go/services/infra-fleet-service/internal/domain/connection.go` (MODIFY — thêm field + hàm transition thuần domain)

## Migration

```sql
ALTER TABLE connections
  ADD COLUMN degraded_since       TIMESTAMPTZ NULL,
  ADD COLUMN grace_period_seconds INTEGER NOT NULL DEFAULT 300;
```

## State machine (xem BE-SOL-STORAGE-003 §2 cho sơ đồ đầy đủ)

Thêm vào `domain/connection.go`, dạng hàm thuần (không I/O, dễ unit test):

```go
func (c *Connection) MarkDegraded(now time.Time) error {
	if c.Status != StatusEstablished {
		return fmt.Errorf("cannot mark degraded from status %s", c.Status)
	}
	c.Status = StatusDegraded
	c.DegradedSince = &now
	return nil
}

func (c *Connection) Reestablish(now time.Time) error {
	if c.Status != StatusDegraded {
		return fmt.Errorf("cannot reestablish from status %s", c.Status)
	}
	if now.Sub(*c.DegradedSince) > time.Duration(c.GracePeriodSeconds)*time.Second {
		return ErrGracePeriodExpired   // caller phải gọi CloseAfterGracePeriodExpiry thay vì reestablish
	}
	c.Status = StatusEstablished
	c.DegradedSince = nil
	return nil
}

func (c *Connection) CloseAfterGracePeriodExpiry(now time.Time) error { /* status=closed, chỉ khi đã hết grace period */ }
func (c *Connection) CloseExplicitly() { /* status=closed ngay, dùng bởi TeardownConnection, bỏ qua grace period */ }
```

Usecase gọi các hàm domain này khi health-poll phát hiện mất heartbeat
hoặc khi agent reconnect — **không** tự viết logic transition trực tiếp
trong usecase (giữ domain layer thuần theo
`03-clean-architecture-guidelines.md`).

## Test cases cần cover

- `TestConnection_MarkDegraded_OnlyFromEstablished`
- `TestConnection_Reestablish_WithinGracePeriod_ReturnsToEstablished`
- `TestConnection_Reestablish_AfterGracePeriodExpiry_ReturnsError`
- `TestConnection_CloseExplicitly_BypassesGracePeriodFromAnyNonClosedStatus`
- `TestDegradedConnectionDoesNotTripCircuitBreaker` (usecase-level, cần
  TASK-BE-STORAGE-011 tồn tại để test đầy đủ — có thể viết trước dạng
  pending/skip nếu làm task này trước)

## Verify

```bash
cd backend-go/services/infra-fleet-service && go build ./...
go test ./internal/domain/... -run TestConnection -v
```

## gitnexus

`impact({target: "Connection", direction: "upstream"})` trước khi thêm
field/method — domain type này khả năng được nhiều usecase khác tham
chiếu, xác nhận rủi ro trước khi đổi struct.

## Blocking

TASK-BE-STORAGE-010 (terminal_sessions rule) và TASK-BE-STORAGE-011
(dispatch classification) phụ thuộc state machine này tồn tại để biết khi
nào KHÔNG đóng/fail.
