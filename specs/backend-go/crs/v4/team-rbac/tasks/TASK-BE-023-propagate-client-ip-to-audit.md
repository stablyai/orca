# TASK-BE-023: Propagate the real client IP from api-gateway to audit call sites

> **Status: ✅ DONE — 2026-09-09**
> **Files modified:** `backend-go/common/tenant/tenant.go`, `backend-go/common/tenant/tenant_test.go`,
> `backend-go/common/grpcmw/grpcmw.go`, `backend-go/common/grpcmw/grpcmw_test.go`,
> `backend-go/services/api-gateway/internal/adapter/grpc/dial.go`,
> `backend-go/services/api-gateway/internal/adapter/httpgateway/middleware.go`
>
> **Kết quả thực tế:** Implemented per the sketch, with one design decision made explicit since the task
> left it open: instead of adding an `IPAddress` field to `usecase.Identity` OR touching every
> `AttachIdentity`/`attachAdminIdentity` call site individually, `httpgateway.authMiddleware` stashes the
> resolved client IP onto the request's own `ctx` via the new `tenant.WithClientIP`, and
> `gatewaygrpc.AttachIdentity` (the single function that already stamps `x-orca-role` on every outbound
> call) reads it back via `tenant.ClientIP(ctx)` and stamps `x-orca-role`'s sibling `x-orca-client-ip`
> alongside it — zero changes needed at any of the ~15 existing `AttachIdentity`/`attachAdminIdentity` call
> sites in `httpgateway`/`wscompat`. Deliberately r.RemoteAddr only, NOT `X-Forwarded-For`/`X-Real-IP`:
> confirmed via grep that this codebase has no existing trusted-proxy convention/allowlist anywhere, so
> trusting a client-supplied header would let a caller forge its own audit-trail IP — documented as a
> deliberate choice in `clientIPFromRemoteAddr`'s doc comment, not a TODO. The WS bridge
> (`internal/adapter/wsbridge`) was deliberately NOT touched — out of this task's stated scope
> (`authMiddleware`/`withIdentity` in `middleware.go` only); a WS-originated call's `ClientIP(ctx)` is
> simply absent (fail-safe, not an error), same as the task's own acceptance criterion for "no client IP
> context." `grpcmw_test.go`/`tenant_test.go` extended with round-trip + interceptor-extraction tests
> mirroring the existing Role coverage exactly. `go build ./...` clean for the whole repo; `go test ./...`
> clean for `api-gateway`, `common/grpcmw`, `common/tenant`. `gofmt -l` clean.

**Solution:** BE-SOL-005 | **CR:** CR-RBAC-005
**Depends on:** none structurally (independent of TASK-BE-014 through TASK-BE-018 — this is purely
api-gateway + metadata propagation). Should land before or alongside TASK-BE-019..022 so the
`ip_address` those tasks write is not permanently empty, but is not a hard compile-time blocker for any
of them (an empty IP is documented as valid, just less useful).

---

## Goal

`api-gateway`'s `authMiddleware`/wscompat bridge is the one place with a real client IP
(`r.RemoteAddr`) — internal services only see the gateway's own IP if they tried to read it themselves.
Resolve the IP once at the edge and pass it explicitly, the same way `TenantID`/`UserID`/`Role` already
travel.

## What to do

1. In `httpgateway`'s `authMiddleware`/`withIdentity` call sites (`backend-go/services/api-gateway/internal/adapter/httpgateway/middleware.go`),
   extract `r.RemoteAddr` (handling `X-Forwarded-For`/`X-Real-IP` if this deployment sits behind a proxy —
   verify existing conventions for trusted-proxy handling before adding header-based IP resolution, don't
   trust a client-supplied header blindly).
2. Forward it the same way `Role` travels (BE-SOL-002 / TASK-BE-003): as a new `grpcmw` metadata key
   (`x-orca-client-ip`), added alongside the existing `MetadataRole` key in
   `backend-go/common/grpcmw/grpcmw.go` — prefer this over adding an `IPAddress` field to
   `usecase.Identity`, for consistency with the existing `Role` propagation pattern.
3. `grpcmw.TenantExtractionInterceptor`: extract the new metadata key into context, mirroring how
   `MetadataRole` is extracted into `tenant.WithRole`. Add a `tenant.WithClientIP`/`tenant.ClientIP`
   accessor pair (or the closest existing naming convention in `common/tenant/tenant.go`) so downstream
   audit call sites (TASK-BE-019..022) can read it with `tenant.ClientIP(ctx)`.

## Acceptance Criteria

- [x] `api-gateway` resolves the real client IP once, at the edge, and attaches it as `x-orca-client-ip`
      gRPC metadata alongside `x-orca-role`.
- [x] `grpcmw.TenantExtractionInterceptor` extracts the new metadata key into context via a new
      `tenant.WithClientIP`/`tenant.ClientIP` pair.
- [x] A request through a path with no client IP context (e.g. a background job) yields an empty
      `ClientIP(ctx)`, not an error — same fail-safe posture as `tenant.Role`.
- [x] `grpcmw_test.go`/`tenant_test.go` extended with round-trip and interceptor-extraction tests, mirroring
      the existing `TestTenantExtractionInterceptor_AttachesRoleWhenPresent`/`TestRole_RoundTrips` coverage.
- [x] `go build ./...` / `go test ./...` clean for `api-gateway` and `common/grpcmw`/`common/tenant`.

## gitnexus

Run in this session (2026-09-09) before editing: `impact({target:"TenantExtractionInterceptor",
direction:"upstream", repo:"orca", summaryOnly:true})` → **risk CRITICAL**, impactedCount 33 (1 direct, 9
processes affected — every service's `run` in `cmd/server/main.go`, since every service's gRPC server
wires this interceptor). Confirmed the actual risk here is fan-out, not this change's blast radius: the
edit only adds one more `md.Get(...)`-into-`tenant.WithClientIP` branch to the interceptor's body, no
signature change, strictly additive (an absent `x-orca-client-ip` key is a no-op, matching every existing
metadata key's handling). `detect_changes({scope:"compare", base_ref:"main"})` after landing (run jointly
for all 7 Wave-1 tasks) confirms **risk low**, 0 affected processes — no other service's existing behavior
changed.

## Blocking

None (independent). TASK-BE-019 through TASK-BE-022 can proceed without this task having landed (using an
empty IP), but should be revisited to pick up a real IP once this lands.
