# TASK-BE-STORAGE-010: `terminal_sessions` — không đóng khi `connections.status = degraded`

**Solution:** BE-SOL-STORAGE-003 | **CR:** CR-STORAGE-008(b)
**Service:** `infra-fleet-service`
**Depends on:** TASK-BE-STORAGE-009
**Status:** ✅ DONE (2026-09-07)

> **Kết quả thực tế:** Audit xác nhận TASK-BE-STORAGE-009's
> `markConnectionDegraded` (`poll_fleet_health.go`) CHƯA BAO GIỜ đóng
> `terminal_sessions` — không phải bug cần sửa, chỉ cần thêm phần còn thiếu:
> đóng khi *thật sự* `closed`. Đã thêm:
> `internal/usecase/close_terminal_sessions_for_connection.go` (MỚI) —
> usecase `CloseTerminalSessionsForConnection` gọi
> `TerminalSessionRepository.CloseAllForConnection` (method MỚI trên
> interface `ports.go` + implementation thật trong
> `adapter/postgres/terminal_session_repository.go`, `UPDATE ... WHERE
> connection_id = $2 AND closed_at IS NULL`). Wired vào
> `poll_fleet_health.go`'s `reestablishConnection`: chỉ gọi khi nhánh
> `CloseAfterGracePeriodExpiry` thật sự thành công (`transitionedToClosed`
> flag), KHÔNG gọi từ `markConnectionDegraded`. `NewPollFleetHealth` thêm
> tham số `sessions TerminalSessionRepository` (nilable, cùng convention với
> `conns`) — cập nhật `cmd/server/main.go` (truyền `terminalSessionStore` đã
> có sẵn) và 11 call site test.
>
> 4 test bắt buộc đều PASS thật (`go test ./... -run
> 'TestMarkDegraded_DoesNotCloseTerminalSessions|TestCloseAfterGracePeriodExpiry_ClosesAllTerminalSessionsForConnection|TestCloseExplicitly_ClosesAllTerminalSessionsForConnection|TestKillTerminalSession_StillWorksIndependentlyOfConnectionStatus'
> -v`): tất cả PASS, kể cả 3 subtest của
> `TestKillTerminalSession_StillWorksIndependentlyOfConnectionStatus`
> (established/degraded/closed). `go build ./...` sạch, `go test ./...` toàn
> bộ service PASS, `gofmt -l .` sạch.
>
> **Gap riêng phát hiện được (KHÔNG lẫn vào task này, theo đúng chỉ dẫn của
> task):** `domain.Connection.CloseExplicitly` (path (b)'s "đóng chủ động")
> KHÔNG có caller nào trong toàn bộ backend-go — không có RPC
> `TeardownConnection` trong `infrafleet.proto` (`grep` xác nhận 0 kết quả),
> trái với BE-SOL-STORAGE-003 §5's khẳng định "RPC TeardownConnection đã có
> trong API surface". `TestCloseExplicitly_ClosesAllTerminalSessionsForConnection`
> vẫn PASS thật (gọi trực tiếp `domain.Connection.CloseExplicitly()` rồi
> `CloseTerminalSessionsForConnection.Execute` — chứng minh usecase đóng
> đúng), nhưng việc thêm RPC `TeardownConnection` thật + wire nó gọi
> `CloseExplicitly`/`CloseTerminalSessionsForConnection` là phạm vi của
> TASK-BE-STORAGE-012 (đã liệt kê "explicit teardown" trong tên task đó).

---

## Mục tiêu

Không có migration — chỉ sửa quy tắc ứng dụng: `terminal_sessions.closed_at`
chỉ được set khi (a) `KillTerminalSession` gọi tường minh, hoặc (b)
`connections.status` chuyển hẳn sang `closed` (kể cả do hết grace-period
hoặc đóng chủ động).

## Files cần sửa

1. File usecase xử lý khi connection chuyển trạng thái (usecase đã sửa ở
   TASK-BE-STORAGE-009 — audit lại xem nó có đang vô tình đóng
   `terminal_sessions` ngay khi mất heartbeat hay không).
2. `backend-go/services/infra-fleet-service/internal/usecase/close_terminal_sessions_for_connection.go` (MỚI hoặc MODIFY nếu đã có hàm tương tự) — chỉ gọi từ nhánh `CloseAfterGracePeriodExpiry`/`CloseExplicitly`, KHÔNG gọi từ `MarkDegraded`.

## Việc cần làm

1. Đọc lại toàn bộ code path hiện tại xử lý "mất heartbeat" — xác nhận
   XEM CÓ code nào đang đóng `terminal_sessions` ngay khi phát hiện mất
   kết nối hay không (đây có thể là hành vi HIỆN TẠI cần sửa, không phải
   thêm mới hoàn toàn — audit trước khi giả định).
2. Nếu có, sửa để chỉ gọi `close_terminal_sessions_for_connection` từ 2
   nhánh: `connections.status -> closed` (do hết grace-period) và
   `TeardownConnection` (đóng chủ động).
3. Nếu hiện tại CHƯA có hành vi tự đóng `terminal_sessions` khi mất kết
   nối (tức PTY session vẫn "sống" trong DB dù connection chết, không ai
   dọn) — đây là 1 gap khác, ghi nhận riêng, KHÔNG lẫn vào task này (task
   này chỉ đảm bảo "không đóng SỚM khi degraded", không phải "đảm bảo có
   đóng khi thật sự closed" — nếu thiếu, đó là 1 task bổ sung ngoài phạm
   vi hiện tại).

## Test cases cần cover

- `TestMarkDegraded_DoesNotCloseTerminalSessions` — connection chuyển
  `degraded`, xác nhận `terminal_sessions.closed_at` vẫn NULL cho mọi
  session thuộc connection đó.
- `TestCloseAfterGracePeriodExpiry_ClosesAllTerminalSessionsForConnection`
- `TestCloseExplicitly_ClosesAllTerminalSessionsForConnection`
- `TestKillTerminalSession_StillWorksIndependentlyOfConnectionStatus` —
  đảm bảo không phá hành vi `KillTerminalSession` tường minh hiện có.

## Verify

```bash
cd backend-go/services/infra-fleet-service && go build ./... && go test ./...
```

## gitnexus

`impact({target: "KillTerminalSession", direction: "upstream"})` và tương
đương cho usecase xử lý mất heartbeat — xác nhận đầy đủ caller trước khi
sửa, đặc biệt vì đây có thể là thay đổi hành vi hiện có (xem mục 1), không
chỉ thêm code mới.

## Blocking

TASK-BE-STORAGE-012 (test suite tổng hợp reconnect-resume) cần task này
xong để pass `TestGracePeriodExpiryClosesConnectionAndFailsDispatch`.
