# TASK-BE-020: Audit `task-service`'s grant/permission-resolution decisions

> **Status: ✅ DONE — 2026-09-09**

**Solution:** BE-SOL-005 | **CR:** CR-RBAC-005
**Depends on:** TASK-BE-018 (`common/auditclient`).

---

## Goal

`task-service`'s `OPAClient.Decision` (`task-service/internal/adapter/opaclient/client.go:53`, input
`level`/`action`/`tenantID`) has zero audit-append calls today, same as `project-service` before
TASK-BE-019.

## What to do

**Verify-before-implementing step is mandatory here** — BE-SOL-005 did not trace the exact usecase call
site that invokes `OPAClient.Decision` within its token budget. Run
`codegraph_explore("task-service Decision opaclient")` first to find the real caller(s), then:

1. Identify which usecase(s) call `Decision` for the grant-hierarchy permission check.
2. Add the same pattern as TASK-BE-019: after `Decision` resolves (both allow and deny branches), call
   `auditClient.Append(ctx, tenantID, actorID, action, target, outcome, ip)` with `task-service`'s own
   equivalent of `project`/`repo` target naming (verify the established `Target` convention for this
   service, or establish one consistent with `project-service`'s `"project:"+id` shape if none exists
   yet).
3. Follow the same dependency-injection convention already used for `opaclient.Client` in the calling
   usecase's constructor.

## Acceptance Criteria

- [x] The exact usecase call site invoking `OPAClient.Decision` is identified and documented (in the
      commit/PR description implementing this task).
- [x] Both allow and deny branches call `auditClient.Append`.
- [x] Integration-style test: a denied decision results in exactly one `Append(..., outcome: "denied",
      ...)` call (fake `auditclient`, not a real cross-service RPC in the unit-test tier).
- [x] Audit-append confirmed non-blocking — the permission decision's own return value is unaffected by
      the audit client's behavior.
- [x] `go build ./...` / `go test ./...` clean for `task-service`.

## gitnexus

Not traced in BE-SOL-005's pass beyond the `OPAClient.Decision` client itself — run
`codegraph_explore("task-service Decision opaclient")` as the mandatory first step of this task, per the
solution's own explicit note. Run `impact()` on whichever usecase function is found before editing it.

## Blocking

Blocked on TASK-BE-018.

## Kết quả thực tế (2026-09-09)

`codegraph_explore("task-service Decision opaclient")` xác nhận call site duy nhất: `ResolvePermission.Execute`
(`backend-go/services/task-service/internal/usecase/resolve_permission.go:86`, gọi `uc.opa.Decision(ctx,
level, in.Action, tenantID)`). Không có usecase nào khác gọi `OPAClient.Decision` trong service này.

`impact({target:"NewResolvePermission", direction:"upstream"})`: **LOW risk, 2 impacted** (1 direct caller —
`run` trong `cmd/server/main.go` — 1 execution flow ảnh hưởng, đúng như dự đoán vì đây là single-caller
usecase, không phải fan-out lớn như project-service).

Vì chỉ có DUY NHẤT một call site, dùng constructor injection (đúng convention hiện có của package cho
`opa`/`teams`/etc.), KHÔNG cần package-level wiring point như TASK-BE-019:
- `ResolvePermission` struct thêm field `auditClient *auditclient.Client` (nil-safe); `NewResolvePermission`
  nhận thêm tham số này.
- Trong `Execute`, sau khi `uc.opa.Decision` resolve thành công (tách riêng nhánh lỗi policy-eval — KHÔNG
  audit khi bản thân evaluator lỗi, giữ đúng ranh giới "OPA decision" như TASK-BE-019), gọi
  `uc.auditClient.Append(ctx, tenantID, in.UserID, in.Action, "task:"+in.TaskID, outcome, ip)` với
  `ip, _ := tenant.ClientIP(ctx)`. Target convention mới `"task:"+id`, nhất quán với `"project:"+id` của
  project-service (task-service trước đây chưa có convention Target nào).
- `main.go`: dial `auth-service` mới (config field `AuthServiceAddr`, env `AUTH_SERVICE_ADDR`), wrap
  `auditclient.New(authv1.NewAuthServiceClient(...))`, truyền vào `NewResolvePermission`.
- Cập nhật 8 call site test hiện có trong `resolve_permission_test.go` + 1 trong
  `internal/adapter/grpc/server_test.go` để truyền `nil` cho tham số mới (không audit trong các test không
  liên quan).
- Test mới: `TestResolvePermission_DeniedDecisionAppendsExactlyOneDeniedAuditEntry`,
  `TestResolvePermission_AllowedDecisionAppendsExactlyOneAllowedAuditEntry`,
  `TestResolvePermission_NilAuditClientIsANoOp` — dùng fake `authv1.AuthServiceClient` giống
  `common/auditclient/client_test.go`.

Build: `go build ./services/task-service/...` sạch. Test: `go test ./services/task-service/...` — toàn bộ
pass. `gofmt -l` sạch.

File đã sửa: `internal/usecase/resolve_permission.go`, `internal/usecase/resolve_permission_test.go`,
`internal/adapter/grpc/server_test.go`, `internal/config/config.go`, `cmd/server/main.go`.
