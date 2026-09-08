# TASK-BE-STORAGE-012: `TeardownConnection` bỏ qua grace-period + test suite tích hợp reconnect-resume

**Solution:** BE-SOL-STORAGE-003 | **CR:** CR-STORAGE-008(b)
**Service:** `infra-fleet-service`
**Depends on:** TASK-BE-STORAGE-009, TASK-BE-STORAGE-010, TASK-BE-STORAGE-011
**Status:** ✅ DONE (2026-09-08) — Part A (`TeardownConnection` RPC + its 2
tests), Part B (2 reframed tests, reusing TASK-BE-STORAGE-009/010's
existing coverage rather than duplicating it), Part C (`connection.teardown`
wscompat channel), and Part D (best-effort agent notify) all complete. The
original "`FailDispatch` not double-fired" test is 🔲 NOT APPLICABLE, not
missing — `FailDispatch` does not exist in this codebase (confirmed by
TASK-BE-STORAGE-011; tracked separately at `specs/backlog/BACKLOG-009-orchestration-service-fail-dispatch-missing.md`).

> **Kết quả thực tế / adjusted scope:** như TASK-BE-STORAGE-010/011 đã phát
> hiện, KHÔNG có RPC `TeardownConnection` thật trong `infrafleet.proto`
> trước task này (trái với BE-SOL-STORAGE-003 §5's khẳng định), và
> `FailDispatch` không tồn tại ở bất kỳ đâu trong `orchestration-service`
> (README's known gap, xem TASK-BE-STORAGE-011). Phạm vi gốc của task này
> (test `TeardownConnection` bỏ qua grace-period + test `FailDispatch`
> không double-fail) không thể implement literally. Scope điều chỉnh:
>
> **Part A — `TeardownConnection` RPC (thêm mới, additive, thin wiring):**
> - `backend-go/proto/orca/infrafleet/v1/infrafleet.proto` — thêm
>   `rpc TeardownConnection(TeardownConnectionRequest) returns
>   (google.protobuf.Empty)`, request chỉ có `connection_id` (tenant từ
>   metadata, cùng convention với mọi RPC khác trong service này).
>   `buf generate` chạy sạch — chỉ `infrafleet.pb.go`/`infrafleet_grpc.pb.go`
>   thay đổi do task này (2 file khác — `gitgateway`/`scmintegration` — bị
>   `buf generate` chạy repo-wide vô tình đụng tới do session khác đã sửa
>   proto của họ nhưng chưa regen; đã revert về HEAD ngay sau đó vì chúng
>   sạch trước khi task này chạy. `tenant.pb.go`/`tenant_grpc.pb.go` đã
>   dirty từ TRƯỚC khi task này bắt đầu — chỉ để nguyên, không đụng thêm,
>   không phải phần việc của task này).
> - `internal/usecase/teardown_connection.go` (MỚI) — `TeardownConnection`
>   usecase: `ConnectionResolver.ResolveConnection` để tra `connectionId`
>   (not-found nếu không thuộc tenant), gọi
>   `domain.Connection.CloseExplicitly()` (TASK-BE-STORAGE-009 — LẦN ĐẦU
>   TIÊN có caller thật), `ConnectionRepository.UpdateStatus` để lưu, rồi
>   `CloseTerminalSessionsForConnection.Execute` (TASK-BE-STORAGE-010) —
>   composition thuần của 2 piece đã test kỹ, không có logic nghiệp vụ mới.
> - `internal/adapter/grpc/server.go` (1 handler mới) +
>   `cmd/server/main.go` (wire usecase, `repo` đóng vai trò cả
>   `ConnectionResolver` lẫn `ConnectionRepository`, cùng convention với
>   chỗ khác trong file).
> - Test (`internal/usecase/teardown_connection_test.go`, MỚI):
>   `TestExplicitTeardownBypassesGracePeriod` (degraded, grace period còn
>   xa hạn, vẫn đóng ngay), `TestTeardownConnection_ClosesTerminalSessions`
>   (đóng đúng session của connection này, session của connection khác
>   không đụng), cộng 3 test phụ (`RequiresTenantContext`,
>   `UnknownConnection_ReturnsNotFound`, `AlreadyClosed_IsIdempotent`).
>   Tất cả PASS thật.
>
> **Part B — 2 test còn lại, dùng piece đã có (KHÔNG viết trùng):**
> - `TestDegradedConnectionDoesNotTripCircuitBreaker` — reframe theo đúng
>   hướng dẫn: TASK-BE-STORAGE-010's
>   `poll_fleet_health_test.go::TestMarkDegraded_DoesNotCloseTerminalSessions`
>   ĐÃ chứng minh đúng ý định khả thi của test này ở usecase-level (chuyển
>   `established -> degraded` không đụng tới bất kỳ state nào khác ngoài
>   connection status — không có "failure counter" nào để tăng, vì khái
>   niệm đó sống ở `orchestration-service`, không import được, xem
>   BE-SOL-STORAGE-003 §4 investigation note). File đó đã có sẵn 1 đoạn
>   comment (`TestDegradedConnectionDoesNotTripCircuitBreaker`'s doc
>   comment ngay phía trên) giải thích chính xác lý do này — không viết
>   test trùng lặp ở đây.
> - `TestGracePeriodExpiryClosesConnectionAndFailsDispatch` → reframe
>   thành `TestGracePeriodExpiryClosesConnectionAndTerminalSessions` (bỏ
>   nửa "AndFailsDispatch" — không có cơ chế fail-dispatch nào để test).
>   TASK-BE-STORAGE-010's
>   `poll_fleet_health_test.go::TestCloseAfterGracePeriodExpiry_ClosesAllTerminalSessionsForConnection`
>   ĐÃ implement đúng test này (grace period hết hạn → `connections.status
>   = closed` VÀ `terminal_sessions` liên quan đóng theo, session của
>   connection khác không đụng) — không viết trùng, chỉ tham chiếu lại ở
>   đây.
>
> **KHÔNG làm (ngoài khả năng thật):**
> - Không tự tạo `FailDispatch` RPC/usecase/wiring mới — xác nhận lại kết
>   luận của TASK-BE-STORAGE-011, không mở rộng phạm vi.
> - `TestResolveConnectionCacheInvalidatedOnStatusChange` (rủi ro cache
>   race nêu ở mục "Rủi ro cần review") — không viết, vì Provider
>   Registry/in-process cache riêng biệt với DB không tồn tại trong service
>   này hôm nay (`ResolveConnection` luôn đọc thẳng Postgres, không có
>   cache layer nào ở giữa) — rủi ro này không áp dụng được cho kiến trúc
>   thật.
>
> **Verify thật đã chạy:**
> ```
> $ cd backend-go/services/infra-fleet-service && go build ./...
> (sạch)
> $ go test ./internal/usecase/... -run "TestExplicitTeardown|TestTeardownConnection|TestDegradedConnection|TestGracePeriodExpiry|TestMarkDegraded_DoesNotCloseTerminalSessions|TestCloseAfterGracePeriodExpiry" -v
> ... tất cả PASS (xem log đầy đủ trong báo cáo phiên làm việc)
> $ go test ./...
> ok cho mọi package có test
> $ gofmt -l .
> (không có output — sạch)
> ```

---

## Mục tiêu

Đóng chủ động (logout đã xác nhận, gọi từ FE-TASK-STORAGE-016's
`closeAllActiveSessions()`) phải bỏ qua toàn bộ `grace_period_seconds` —
chuyển thẳng `established|degraded -> closed`, đóng ngay `terminal_sessions`
liên quan.

## Files cần sửa

1. `backend-go/services/infra-fleet-service/internal/usecase/teardown_connection.go` (MODIFY — xác nhận đã gọi `Connection.CloseExplicitly()` từ TASK-BE-STORAGE-009, không phải tự viết logic đóng riêng)
2. `backend-go/services/infra-fleet-service/internal/usecase/reconnect_resume_integration_test.go` (MỚI — test suite tích hợp, không phải unit test đơn lẻ)

## Việc cần làm

1. Xác nhận `TeardownConnection` usecase hiện có (đã generate trong
   `infrafleet_grpc.pb.go` theo BE-SOL-STORAGE-003 §5) gọi đúng
   `Connection.CloseExplicitly()` (TASK-BE-STORAGE-009) thay vì
   `CloseAfterGracePeriodExpiry()` hoặc tự set status trực tiếp.
2. Viết test suite tích hợp (dùng fake repository, không cần Postgres
   thật) mô phỏng đầy đủ 3 kịch bản chính đã nêu ở BE-SOL-STORAGE-003 §6.

## Test cases bắt buộc (tên đã chốt ở BE-SOL-STORAGE-003 §6)

- `TestDegradedConnectionDoesNotTripCircuitBreaker` — mô phỏng `degraded`
  rồi `established` lại trong grace-period; xác nhận
  `dispatch_contexts.failure_count` không tăng (dùng
  `ClassifyDispatchFailure` từ TASK-BE-STORAGE-011).
- `TestGracePeriodExpiryClosesConnectionAndFailsDispatch` — mô phỏng hết
  grace-period; xác nhận `connections.status=closed`, `terminal_sessions`
  đóng (TASK-BE-STORAGE-010), VÀ `FailDispatch` được gọi **đúng 1 lần**
  (không double-fail nếu health-poll chạy nhiều lần trên cùng 1 connection
  đã hết hạn).
- `TestExplicitTeardownBypassesGracePeriod` — `TeardownConnection` đóng
  ngay dù `grace_period_seconds` chưa hết.

## Rủi ro cần review khi implement (nhắc lại từ solution, không bỏ qua)

- Race giữa health-poll (chuyển `degraded`) và 1 request đang xử lý dở
  trên `connectionId` đó — xác nhận `ResolveConnection`/in-process cache
  (Provider Registry, §7 TDD) không trả kết quả stale ngay sau khi status
  đổi; có thể cần invalidate cache đồng thời với đổi status trong cùng 1
  transaction/lock. Viết `TestResolveConnectionCacheInvalidatedOnStatusChange`
  nếu Provider Registry có cache riêng biệt với DB.
- `grace_period_seconds` mặc định 300s — ghi rõ trong PR/commit message là
  "điểm khởi đầu, cần review sản phẩm riêng", không phải quyết định cuối.

## Verify

```bash
cd backend-go/services/infra-fleet-service && go build ./...
go test ./internal/usecase/... -run "TestDegradedConnection|TestGracePeriodExpiry|TestExplicitTeardown" -v
go test ./...
```

## gitnexus

`detect_changes({scope: "compare", base_ref: "main"})` sau khi hoàn tất
TASK-BE-STORAGE-009..012 (toàn bộ BE-SOL-STORAGE-003) — xác nhận execution
flow "connection health monitoring" và "dispatch failure handling" đều
được liệt kê trong scope thay đổi, không có flow nào khác bị ảnh hưởng
ngoài dự kiến.

## Blocking

Không — đây là task cuối của BE-SOL-STORAGE-003. Sau khi xong,
FE-TASK-STORAGE-016 (phần resume UX) có backend thật để kiểm chứng.


---

## ✅ Part C — `connection.teardown` wscompat channel (2026-09-08, added — closes the gap FE-TASK-STORAGE-016/TASK-AG-STORAGE-007/009 were blocked on)

Part A above built `TeardownConnection` as a real gRPC RPC on
`infra-fleet-service`, but never exposed it through `api-gateway`'s
wscompat layer — so no browser/agent caller could actually reach it. That
gap was flagged in `specs/backlog/README.md` and in
`FE-TASK-STORAGE-016`'s own status note. Closed now:

- `backend-go/services/api-gateway/internal/adapter/wscompat/channels_infra_fleet.go`
  (MODIFY) — new `connection.teardown` channel on `registerInfraFleetChannels`
  (already wired into `RegisterRealChannels` for this file, no `main.go`
  change needed). Takes `{connectionId}`, calls
  `client.TeardownConnection(rpcCtx, &infrafleetv1.TeardownConnectionRequest{ConnectionId: ...})`
  after `AttachIdentity` — tenant/user scoping from `Identity`, never from
  args, same convention as every other channel in this file/CR.
- `channels_test.go` (MODIFY) — `fakeInfraFleetClient.TeardownConnection`
  fake + capture fields.
- `channels_infra_fleet_test.go` (MODIFY) — 4 new tests:
  `TestConnectionTeardownChannel_UserIDComesFromIdentityNotArgs`,
  `TestConnectionTeardownChannel_ForwardsConnectionId`,
  `TestConnectionTeardownChannel_MissingConnectionIdReturnsError`,
  `TestConnectionTeardownChannel_PropagatesUpstreamError`.

**Verification** (same environment constraint as TASK-BE-STORAGE-004 —
recorded honestly, not glossed over): `gofmt -l` on all 3 touched files —
clean, zero output. `go build ./...` for `api-gateway` still fails
package-wide, but **not because of this change** — confirmed by
`go build -gcflags="-e" ./...` (uncapped error list, bypassing Go's
default 10-error cutoff that could otherwise hide errors in files sorting
alphabetically after the broken ones): every remaining error is in
`channels_ephemeral_vm.go`, `channels_git.go`, or `channels_scm.go` —
pre-existing, unrelated proto-drift breakage from other in-progress work
(`git-gateway-service`/`scm-integration-service` protos not regenerated).
**None of the 3 files this addition touched appear anywhere in that
list.** Manually cross-checked `TeardownConnection`/`TeardownConnectionRequest`/
`emptypb.Empty` signatures directly against the real generated
`infrafleet_grpc.pb.go`/`infrafleet.pb.go` (§ confirmed in this session)
before writing the handler — not guessed.

Real `go test` run for this specific addition is blocked by the same
whole-package compile failure, same as TASK-BE-STORAGE-004 — re-run
`go test ./internal/adapter/wscompat/... -run TestConnectionTeardown -v`
once `channels_ephemeral_vm.go`/`channels_git.go`/`channels_scm.go` are
fixed by whoever owns that in-progress proto work.

**Unblocks**: `FE-TASK-STORAGE-016` (frontend `closeAllActiveSessions()`
now has a real channel to call), `TASK-AG-STORAGE-007`/`009` (the agent
now has a concrete wscompat channel name — `connection.teardown` — to
build its inbound-RPC-name coordination against, closing the
"coordinate rather than invent independently" blocker those tasks flagged).

---

## ✅ Part D — Best-effort agent notify on explicit teardown (2026-09-08, added)

`TeardownConnection.Execute` (Part A) only updated Postgres — the live
agent (if reachable) never learned the connection was torn down, so its
own PTYs (including AI-agent CLI ones from `agent.spawn`) would sit
unaware. Closed using infrastructure that already exists — no new
transport:

- `internal/usecase/teardown_connection.go` (MODIFY) — `TeardownConnection`
  now takes a 4th constructor dependency, `agent DevServerAgentClient`
  (the same generic `Exec(ctx, devServer, method, params)` port
  `KillWorkspacePort`/`ScanWorkspacePorts` already use). After the DB
  writes succeed, calls `agent.Exec(ctx, devServer, "connection.teardown",
  map[string]any{"connectionId": conn.ID})` — the exact method name
  `channels_infra_fleet.go`'s new `connection.teardown` wscompat channel
  and `TASK-AG-STORAGE-007`'s agent-side handler now share.
- **Deliberately best-effort** — the call's error is discarded, not
  propagated. Documented inline why this differs from
  `KillWorkspacePort`'s pattern of failing on an agent error: an explicit
  teardown's whole point is that server-side state must end up closed even
  when the dev server is unreachable right now (laptop closed, agent
  crashed, network down) — exactly the case a confirmed logout most needs
  to succeed in.
- `cmd/server/main.go` (MODIFY) — wires the already-constructed
  `agentClient` into `NewTeardownConnection`'s new 4th argument.
- `internal/usecase/teardown_connection_test.go` (MODIFY) — all 5 existing
  `NewTeardownConnection(...)` call sites updated with `&fakeDevServerAgentClient{}`
  (already defined package-wide in `scan_workspace_ports_test.go`, reused,
  not duplicated); 1 new test,
  `TestTeardownConnection_NotifiesAgentBestEffort` (agent.Exec returns an
  error → teardown still succeeds; asserts `connection.teardown` was the
  method called).

**Verification — real, run in this session:**
```
$ cd backend-go/services/infra-fleet-service && go build ./...
(clean)
$ go test ./internal/usecase/... -run "TestTeardownConnection|TestExplicitTeardown" -v
--- PASS x6 (all TeardownConnection tests, including the new one)
$ go test ./...
ok for every package with tests
$ gofmt -l internal/usecase/teardown_connection.go internal/usecase/teardown_connection_test.go cmd/server/main.go
(no output — clean)
```

This closes the last piece `FE-TASK-STORAGE-016`/`TASK-AG-STORAGE-007`/`009`
needed from the backend-go side: `connection.teardown` now exists as a
real wscompat channel (Part C) AND actually reaches the live agent (Part
D), not just the database.
