# TASK-BE-019: Audit `project-service`'s `requireProjectAccess`/`requireRepoAccess` decisions

> **Status: ✅ DONE — 2026-09-09**

**Solution:** BE-SOL-005 | **CR:** CR-RBAC-005
**Depends on:** TASK-BE-018 (`common/auditclient`). Touches the same file as TASK-BE-003
(`callerGlobalRole` fix) — land TASK-BE-003 first to avoid a conflicting diff on
`authorization.go`; TASK-BE-023 (client-IP propagation) should ideally land before this task so the
`ip_address` field isn't empty, but is not a hard compile-time blocker.

---

## Goal

Neither `requireProjectAccess` nor `requireRepoAccess` appends any audit entry today — confirmed zero
audit-append calls in `project-service`. This is the CR's most concrete, most important call site: it's
the RBAC decision point CR-RBAC-002 (TASK-BE-003) also fixes in the same file.

## What to do

In `backend-go/services/project-service/internal/usecase/authorization.go`, after `opa.Decision`/
`opa.RepoDecision` resolves — **on both the `allowed` and `!allowed` branches** (F32 wants to see both,
not just denials) — call:

```go
auditClient.Append(ctx, tenantID, actorID, action, "project:"+projectID, outcome, ip)
```

Both `requireProjectAccess` and `requireRepoAccess` already have every value this needs in scope
(`tenantID`, `actorID`/caller identity, the `action` being checked, the project/repo id, and the decision
outcome). `ip` comes from context — see TASK-BE-023 for how it gets there; if that task hasn't landed yet,
pass an empty string rather than blocking on it (the field is documented as legitimately empty when no
HTTP-request context exists).

`requireProjectAccess`/`requireRepoAccess` will need an `auditClient *auditclient.Client` parameter or a
package-level wiring point — follow whatever dependency-injection convention this package already uses for
`opa`/`membership` (constructor injection, most likely).

## Acceptance Criteria

- [x] Both `requireProjectAccess` and `requireRepoAccess` call `auditClient.Append` on **both** the allow
      and deny branches.
- [x] Target format is `"project:"+projectID` (or the equivalent for repo-scoped checks — verify the
      established `Target` convention, e.g. `"repo:"+repoID`).
- [x] Integration-style test: a denied `requireProjectAccess` call results in exactly one
      `auditClient.Append(..., outcome: "denied", ...)` call (fake `auditclient` capturing the call, not a
      real cross-service RPC in the unit-test tier).
- [x] An allowed call similarly results in exactly one `Append(..., outcome: "allowed", ...)` call.
- [x] Audit-append is confirmed non-blocking: a fake `auditClient` that "fails" (if the interface allows
      simulating that) does not change `requireProjectAccess`'s own return value — the permission decision
      is authoritative, the audit call is a side effect.
- [x] `go build ./...` / `go test ./...` clean for `project-service`.

## gitnexus

Run `impact({target:"requireProjectAccess", direction:"upstream"})` and the same for `requireRepoAccess`
before editing — both already carry MEDIUM risk (30 impacted) from TASK-BE-003's fix to the same file;
confirm the combined diff (TASK-BE-003 + this task) doesn't change either function's risk classification
materially, since this task adds a call, not a behavior change to the decision itself. Run
`detect_changes({scope:"compare", base_ref:"main"})` after, checking `project-service`'s existing OPA-gated
processes still show 0 broken steps — audit calls must be additive and non-blocking, never a new failure
mode for the underlying permission check.

## Blocking

Blocked on TASK-BE-018. Should follow TASK-BE-003 to avoid merge conflicts on the same file.

## Kết quả thực tế (2026-09-09)

Đọc lại `authorization.go` trên đĩa trước khi sửa — xác nhận `callerGlobalRole` đã đọc `tenant.Role(ctx)`
(TASK-BE-003 đã land), không phải bản stub cũ mô tả trong task.

`impact()` trước khi sửa (callgraph, upstream):
- `requireProjectAccess`: **HIGH risk, 19 impacted** (19 direct callers trong `internal/usecase/*.go`, 1
  module `Usecase`, 0 affected_processes theo GitNexus).
- `requireRepoAccess`: **MEDIUM risk, 9 impacted** (9 direct callers, 1 module `Usecase`).
- Đây là số liệu thật tại thời điểm sửa — cao hơn con số "MEDIUM, 30 impacted" mà task file dự đoán ban đầu
  (GitNexus tính risk/impacted riêng cho từng hàm, không gộp). Đã cảnh báo theo yêu cầu AGENTS.md/CLAUDE.md
  (risk HIGH cho `requireProjectAccess`) — nhưng thay đổi thực hiện chỉ CỘNG THÊM một lệnh gọi audit sau khi
  `opa.Decision`/`opa.RepoDecision` đã resolve, không đổi logic allow/deny hiện có, nên rủi ro hành vi thực
  tế là thấp dù risk score cao (do số lượng caller lớn).

**Thiết kế đã chọn — "package-level wiring point" (được task này cho phép làm alternative cho constructor
injection):** thay vì thêm tham số `auditClient` vào MỌI constructor của 19+9 call site (rất nhiều usecase
struct khác nhau trong package), thêm một biến package-level `auditClient *auditclient.Client` +
`SetAuditClient(c *auditclient.Client)` trong `authorization.go`, wire một lần ở `main.go`. Lý do: cả
`requireProjectAccess` và `requireRepoAccess` đã có mọi giá trị cần thiết trong scope (tenantID qua
`tenant.TenantID(ctx)`, actorID, action, project/repo id, outcome, ip qua `tenant.ClientIP(ctx)` — đã có từ
TASK-BE-023), nên xuyên tham số qua toàn bộ constructor chỉ để tới 2 hàm dùng chung sẽ là plumbing thuần,
không có consumer nào khác cần nó.

- `requireProjectAccess`/`requireRepoAccess`: gọi `auditDecision(ctx, actorID, action, target, allowed)`
  ngay sau khi `opa.Decision`/`opa.RepoDecision` resolve thành công (không audit khi bản thân
  policy-eval lỗi — giữ đúng ranh giới "OPA decision" như annotation-service/task-service).
  Target = `"project:"+projectID` / `"repo:"+repoID` đúng convention task mô tả.
- `auditClient` nil-safe: `auditDecision` no-op nếu chưa `SetAuditClient` (hầu hết unit test hiện có).
- `main.go`: dial `auth-service` (mới, project-service trước đây không gọi auth-service) qua
  `AUTH_SERVICE_ADDR` (config field mới), wrap `authv1.NewAuthServiceClient` bằng `auditclient.New`, gọi
  `usecase.SetAuditClient(...)`.
- Test mới trong `authorization_test.go`: `TestRequireProjectAccess_DeniedCallAppendsExactlyOneDeniedAuditEntry`,
  `TestRequireProjectAccess_AllowedCallAppendsExactlyOneAllowedAuditEntry`,
  `TestRequireProjectAccess_AuditAppendFailureDoesNotAffectDecision`,
  `TestRequireRepoAccess_DeniedCallAppendsExactlyOneDeniedAuditEntry`,
  `TestRequireRepoAccess_AllowedCallAppendsExactlyOneAllowedAuditEntry` — dùng fake
  `authv1.AuthServiceClient` (partial-fake convention, giống `common/auditclient/client_test.go`) wired qua
  `SetAuditClient`, reset về giá trị cũ sau mỗi test.

Build: `go build ./services/project-service/...` sạch. Test: `go test ./services/project-service/...` —
toàn bộ pass (bao gồm 5 test mới). `gofmt -l` sạch trên mọi file đã sửa.

File đã sửa: `internal/usecase/authorization.go`, `internal/usecase/authorization_test.go`,
`internal/config/config.go`, `cmd/server/main.go`.
