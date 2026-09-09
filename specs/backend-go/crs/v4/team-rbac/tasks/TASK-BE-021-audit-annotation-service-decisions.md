# TASK-BE-021: Audit `annotation-service`'s author-or-admin decisions

> **Status: ✅ DONE — 2026-09-09**

**Solution:** BE-SOL-005 | **CR:** CR-RBAC-005
**Depends on:** TASK-BE-018 (`common/auditclient`).

---

## Goal

`annotation-service`'s `OPAClient.Decision` (`annotation-service/internal/adapter/opaclient/client.go:36`)
has zero audit-append calls today, same gap as `project-service`/`task-service`.

## What to do

**Verify-before-implementing step is mandatory here**, same as TASK-BE-020 — the exact usecase caller
wasn't traced in BE-SOL-005's pass. Run `codegraph_explore("annotation-service Decision opaclient")`
first, then:

1. Identify the usecase(s) that call `Decision` for the author-or-admin authorization check.
2. Add the same pattern as TASK-BE-019/020: after `Decision` resolves (both allow and deny branches), call
   `auditClient.Append(ctx, tenantID, actorID, action, target, outcome, ip)`.
3. Follow the established `Target` naming convention (e.g. `"annotation:"+id`) — verify if one already
   exists for this service, establish one consistent with `project-service`'s shape if not.

## Acceptance Criteria

- [x] The exact usecase call site invoking `OPAClient.Decision` is identified and documented (in the
      commit/PR description).
- [x] Both allow and deny branches call `auditClient.Append`.
- [x] Integration-style test: a denied decision results in exactly one `Append(..., outcome: "denied",
      ...)` call (fake `auditclient`).
- [x] Audit-append confirmed non-blocking.
- [x] `go build ./...` / `go test ./...` clean for `annotation-service`.

## gitnexus

Not traced in BE-SOL-005's pass beyond the `OPAClient.Decision` client itself — run
`codegraph_explore("annotation-service Decision opaclient")` as the mandatory first step, per the
solution's own explicit note. Run `impact()` on whichever usecase function is found before editing it.

## Blocking

Blocked on TASK-BE-018.

## Kết quả thực tế (2026-09-09)

`codegraph_explore("annotation-service Decision opaclient")` xác nhận **hai** call site (không phải một
như task file gợi ý ban đầu): `UpdateAnnotation.Execute` (`update_annotation.go:59`) và
`DeleteAnnotation.Execute` (`delete_annotation.go:52`), cả hai gọi `uc.opa.Decision(ctx, actorID,
existing.AuthorID, "")`.

`impact({target:"NewUpdateAnnotation"/"NewDeleteAnnotation", direction:"upstream"})`: cả hai **LOW risk, 2
impacted** (1 direct caller mỗi hàm — `run` trong `cmd/server/main.go`).

Single-caller mỗi usecase → dùng constructor injection (đúng convention `opa`/`repo` hiện có):
- Cả hai struct thêm field `auditClient *auditclient.Client` (nil-safe); constructor nhận thêm tham số.
- Sau khi `Decision` resolve thành công (tách nhánh lỗi policy-eval riêng, không audit khi evaluator lỗi),
  gọi `Append(ctx, tenantID, actorID, "annotation.update"/"annotation.delete", "annotation:"+in.ID,
  outcome, ip)` — action theo convention `<resource>.<verb>`, Target `"annotation:"+id` như task mô tả.
- `main.go`: dial `auth-service` mới (config field `AuthServiceAddr`), wrap `auditclient.New(...)`, truyền
  cùng một `auditClient` instance vào cả `NewUpdateAnnotation` và `NewDeleteAnnotation`.
- Cập nhật toàn bộ call site test hiện có (`delete_annotation_test.go`, `update_annotation_test.go`) để
  truyền `nil` cho tham số mới.
- Test mới cho cả hai usecase: `Test{Update,Delete}Annotation_DeniedCallAppendsExactlyOneDeniedAuditEntry`,
  `Test{Update,Delete}Annotation_AllowedCallAppendsExactlyOneAllowedAuditEntry`, và
  `TestDeleteAnnotation_AuditAppendFailureDoesNotAffectDecision` — dùng fake `authv1.AuthServiceClient`
  (định nghĩa trong `delete_annotation_test.go`, tái dùng ở `update_annotation_test.go` vì cùng package).

Build: `go build ./services/annotation-service/...` sạch. Test: `go test
./services/annotation-service/...` — toàn bộ pass. `gofmt -l` sạch.

File đã sửa: `internal/usecase/delete_annotation.go`, `delete_annotation_test.go`,
`internal/usecase/update_annotation.go`, `update_annotation_test.go`, `internal/config/config.go`,
`cmd/server/main.go`.
