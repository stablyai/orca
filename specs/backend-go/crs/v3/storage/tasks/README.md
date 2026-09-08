# backend-go Tasks — Frontend Storage Consolidation

**Solutions:** [../solutions/](../solutions/README.md)

## Track 1 — `tenant-service` (BE-SOL-STORAGE-001)

| Task | Depends on | Status |
|---|---|---|
| [TASK-BE-STORAGE-001](./TASK-BE-STORAGE-001-user-profiles-migration.md) — migration (6 cột + bảng mới) | Không | ✅ DONE |
| [TASK-BE-STORAGE-002](./TASK-BE-STORAGE-002-user-profile-repository-methods.md) — repository methods | TASK-BE-STORAGE-001 | ✅ DONE |
| [TASK-BE-STORAGE-003](./TASK-BE-STORAGE-003-grpc-proto-and-usecases.md) — proto + gRPC + usecases | TASK-BE-STORAGE-002 | ✅ DONE |
| [TASK-BE-STORAGE-004](./TASK-BE-STORAGE-004-wscompat-client-state-channels.md) — wscompat channels | TASK-BE-STORAGE-003 | ✅ DONE — unblock qua `buf generate` + 1 fake test double được vá; re-verified 2026-09-08 với `go test` thật (10/10 pass, package `api-gateway` giờ build sạch) |

## Track 2 — `infra-fleet-service`/`orchestration-service` (BE-SOL-STORAGE-002, BE-SOL-STORAGE-003)

| Task | Depends on | Status |
|---|---|---|
| [TASK-BE-STORAGE-005](./TASK-BE-STORAGE-005-audit-infra-fleet-read-handlers.md) — audit handler thật vs stub | Không | ✅ DONE |
| [TASK-BE-STORAGE-006](./TASK-BE-STORAGE-006-fleet-connectivity-summary-rpc.md) — RPC `GetFleetConnectivitySummary` | Không | ✅ DONE |
| [TASK-BE-STORAGE-007](./TASK-BE-STORAGE-007-list-active-dispatch-contexts-rpc.md) — RPC `ListActiveDispatchContextsForUser` | Không | ✅ DONE (2026-09-08) — unblocked qua `user_id` trực tiếp trên `dispatch_contexts` (không qua `coordinator_runs`/`StartCoordinatorRun`, việc đó thuộc epic riêng — xem BACKLOG-006); cộng 1 bug thật đã fix (`NULLIF`/`uuid` type mismatch) |
| [TASK-BE-STORAGE-008](./TASK-BE-STORAGE-008-wscompat-connectivity-and-agent-session-channels.md) — wscompat wiring | 005, 006, 007 | ✅ DONE (2026-09-08) — cả 2 phần xong, `agentSession.listActive` đã nối dây + 3 test PASS |
| [TASK-BE-STORAGE-009](./TASK-BE-STORAGE-009-connections-degraded-state-machine.md) — `connections` state machine | Không | ✅ DONE |
| [TASK-BE-STORAGE-010](./TASK-BE-STORAGE-010-terminal-sessions-close-rule.md) — `terminal_sessions` close rule | 009 | ✅ DONE — `MarkDegraded` xác nhận chưa từng đóng session (không phải bug); thêm `CloseTerminalSessionsForConnection`, wired vào `CloseAfterGracePeriodExpiry`. Gap riêng: `CloseExplicitly` chưa có caller (không có RPC `TeardownConnection`) — thuộc phạm vi 012 |
| [TASK-BE-STORAGE-011](./TASK-BE-STORAGE-011-dispatch-failure-classification.md) — phân loại lỗi transport/dispatch | 009 | 🟡 PARTIAL — `ClassifyDispatchFailure` xong (gRPC code signal), caller thật của `FailDispatch` KHÔNG sửa được vì `FailDispatch` chưa tồn tại trong code |
| [TASK-BE-STORAGE-012](./TASK-BE-STORAGE-012-explicit-teardown-and-integration-tests.md) — teardown + test suite tích hợp | 009, 010, 011 | ✅ DONE (2026-09-08) — Part A/B như ban đầu (RPC `TeardownConnection` + 2 test reframed, `FailDispatch`-test 🔲 N/A vì `FailDispatch` chưa tồn tại — xem 011/BACKLOG-009); **Part C mới**: `connection.teardown` wscompat channel (`channels_infra_fleet.go`, 4 test, real `go test` PASS); **Part D mới**: `TeardownConnection` giờ best-effort notify agent qua `DevServerAgentClient.Exec` (1 test mới, `TestTeardownConnection_NotifiesAgentBestEffort`) — unblocks `FE-TASK-STORAGE-016`/`TASK-AG-STORAGE-007`/`009`, cả 3 đã đóng theo |

## Thứ tự thực thi

```
Track 1: 001 → 002 → 003 → 004                    (tuyến tính, mỗi task phụ thuộc task trước)
Track 2: 005 ┐
         006 ├→ 008
         007 ┘
         009 → 010 ┐
              → 011 ├→ 012
```

2 track độc lập nhau, có thể chạy song song. Trong Track 2, 005/006/007 có
thể làm song song với nhau (khác file/service), rồi 008 gộp lại; 009 phải
xong trước 010/011, cả hai xong mới tới 012.

## Nguyên tắc chung cho AI thực thi các task này

- **Luôn chạy `impact()`/`codegraph explore` trước khi sửa symbol** — mỗi
  task đã ghi rõ symbol cần kiểm tra ở mục "gitnexus", nhưng đây là yêu cầu
  bắt buộc chung theo `CLAUDE.md`/`AGENTS.md`, không chỉ khi task nhắc tới.
- **Không tự ý mở rộng phạm vi** — mỗi task chỉ sửa đúng file đã liệt kê;
  nếu phát hiện gap khác trong lúc làm (như TASK-BE-STORAGE-010's mục 3),
  ghi nhận lại, không sửa luôn nếu ngoài phạm vi task.
- **`buf generate` sau bất kỳ thay đổi `.proto` nào** — kiểm tra không phá
  `proto/gen/go` dùng chung với service khác trước khi commit.
- **Test trước, không giả định pass** — mọi lệnh `go test` trong mục
  "Verify" phải thực sự chạy và thấy kết quả, không suy đoán.
