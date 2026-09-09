# TASK-BE-022: Audit `infra-fleet-service`'s dev-server connect (`ssh.connect`) decisions

> **Status: ✅ DONE — 2026-09-09**

**Solution:** BE-SOL-005 | **CR:** CR-RBAC-005
**Depends on:** TASK-BE-018 (`common/auditclient`).

---

## Goal

F32's own canonical audit example is "who connected to which server" — `"ssh.connect"`. Auditing
`ListDevServersForUser` itself would be noisy (it's a list operation, not a single allow/deny decision);
the real target is whichever usecase gates an actual SSH/PTY **connect** attempt.

## What to do

**Verify-before-implementing step is mandatory here** — BE-SOL-005 did not trace which usecase actually
gates a connection attempt (candidates named in the solution: `EstablishConnection`,
`SpawnTerminalSession` — neither confirmed). Run `codegraph_explore("infra-fleet-service ssh connect
EstablishConnection SpawnTerminalSession")` first to find the real gating usecase, then:

1. Identify the usecase that authorizes an SSH/PTY connection to a specific dev server.
2. Add the same pattern as TASK-BE-019/020/021: after the authorization decision resolves (both allow and
   deny branches), call `auditClient.Append(ctx, tenantID, actorID, "ssh.connect", "devserver:"+serverID,
   outcome, ip)`.

## Acceptance Criteria

- [x] The exact usecase that gates an SSH/PTY connect attempt is identified and documented (in the
      commit/PR description).
- [x] Both allow and deny branches call `auditClient.Append` with `action = "ssh.connect"`.
- [x] Integration-style test: a denied connect attempt results in exactly one `Append(..., outcome:
      "denied", ...)` call (fake `auditclient`).
- [x] Audit-append confirmed non-blocking — a connect decision's own return value is unaffected by the
      audit client's behavior.
- [x] `go build ./...` / `go test ./...` clean for `infra-fleet-service`.

## gitnexus

Not traced in BE-SOL-005's pass — the candidate usecase names (`EstablishConnection`,
`SpawnTerminalSession`) are unconfirmed guesses from the solution author, not verified symbols. Run
`codegraph_explore` as the mandatory first step; do not assume either name is correct without confirming.
Run `impact()` on whichever usecase is found before editing it.

## Blocking

Blocked on TASK-BE-018.

## Kết quả thực tế (2026-09-09)

`codegraph_explore("infra-fleet-service ssh connect EstablishConnection SpawnTerminalSession")` xác nhận
candidate name đúng: **`EstablishConnection.Execute`**
(`backend-go/services/infra-fleet-service/internal/usecase/establish_connection.go:31`) — usecase thực hiện
handshake SSH + Dev Server Agent đồng bộ (`uc.agent.Health(ctx, devServer)`), là điểm gate connect thật sự.
`SpawnTerminalSession` chỉ spawn PTY trên một connection ĐÃ established — không phải điểm gate connect.

**Lưu ý quan trọng phát hiện khi đọc code:** service này KHÔNG có OPA/policy-based allow/deny decision cho
SSH connect (`internal/usecase/authorization.go` chỉ có `requireAdmin` cho các RPC approve/reject dev
server khác, không dùng bởi `EstablishConnection`). "Quyết định" audit-worthy ở đây là kết quả của
`agent.Health()` (reachable hay không) sau khi tenant-scoped ssh-target lookup đã thành công — đây là điểm
gần nhất với một "allow/deny" cho hành động connect, đúng tinh thần "F32's canonical audit example". Đã
KHÔNG mở rộng phạm vi để tự thêm một cơ chế OPA-based authorization mới (ngoài phạm vi task này).

`impact({target:"NewEstablishConnection", direction:"upstream"})`: **LOW risk, 2 impacted** (1 direct
caller — `run` trong `cmd/server/main.go`).

Single-caller → constructor injection:
- `EstablishConnection` struct thêm field `auditClient *auditclient.Client` (nil-safe); constructor nhận
  thêm tham số.
- Sau `uc.agent.Health(...)`, tính `allowed := healthErr == nil && reachable`, gọi
  `Append(ctx, tenantID, actorID, "ssh.connect", "devserver:"+devServer.ID, outcome, ip)` với
  `actorID, _ := tenant.UserID(ctx)` (optional — `EstablishConnectionInput` không có UserID field, giữ
  nguyên hành vi cũ là không bắt buộc user context) và `ip, _ := tenant.ClientIP(ctx)`. `devServer.ID` đã
  resolve được tại điểm này (find-or-create đã chạy trước Health check) nên target luôn có giá trị hợp lệ
  kể cả nhánh deny (unreachable).
- Lỗi tenant-scoped lookup ban đầu (`uc.sshTargets.Get` thất bại — sai tenant/không tồn tại) KHÔNG được
  audit — nhất quán với project-service/annotation-service/task-service (chỉ audit quyết định cốt lõi, không
  audit các lỗi validate/context sớm hơn).
- `main.go`: dial `auth-service` mới (config field `AuthServiceAddr`), wrap `auditclient.New(...)`.
- Cập nhật 4 call site test hiện có trong `establish_connection_test.go` để truyền `nil`.
- Test mới: `TestEstablishConnection_UnreachableAgentAppendsExactlyOneDeniedAuditEntry`,
  `TestEstablishConnection_HealthyAgentAppendsExactlyOneAllowedAuditEntry`,
  `TestEstablishConnection_NilAuditClientIsANoOp` — dùng fake `authv1.AuthServiceClient`.

Build: `go build ./services/infra-fleet-service/...` sạch. Test: `go test
./services/infra-fleet-service/...` — toàn bộ pass (bao gồm các package khác trong service, không có
regression). `gofmt -l` sạch trên các file đã sửa.

File đã sửa: `internal/usecase/establish_connection.go`, `establish_connection_test.go`,
`internal/config/config.go`, `cmd/server/main.go`.
