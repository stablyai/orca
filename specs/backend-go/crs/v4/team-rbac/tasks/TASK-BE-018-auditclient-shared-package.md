# TASK-BE-018: `common/auditclient` — shared best-effort audit-append client

> **Status: ✅ DONE — 2026-09-09**

**Solution:** BE-SOL-005 | **CR:** CR-RBAC-005
**Depends on:** TASK-BE-017 (`AppendAuditEntry` RPC must exist).

---

## Goal

Give `project-service`/`task-service`/`annotation-service`/`infra-fleet-service` a single, consistent,
thin client for appending audit entries to auth-service — following the same "cross-service shared code
policy" as `common/grpcmw`/`common/tenant`.

## What to do

New package `backend-go/common/auditclient/client.go`:

```go
// Package auditclient is the thin gRPC client every non-auth-service uses to
// append an audit entry to auth-service's audit_log — audit_log is
// auth-service's own schema (auth-service.md §2), so no other service talks
// to its Postgres directly.
package auditclient

type Client struct {
	auth authv1.AuthServiceClient
}

func New(auth authv1.AuthServiceClient) *Client { return &Client{auth: auth} }

// Append is best-effort: an audit-append failure is logged, never returned
// to the caller as an error — a permission-check RPC's own success/failure
// must never depend on the audit system being reachable (matches
// auth-service's own audit calls, which never roll back the primary
// operation on an audit-write failure — see update_access_policy.go's doc
// comment on PublishPolicyChange's identical non-blocking posture).
func (c *Client) Append(ctx context.Context, tenantID, actorID, action, target, outcome, ipAddress string) {
	_, err := c.auth.AppendAuditEntry(ctx, &authv1.AppendAuditEntryRequest{
		TenantId: tenantID, ActorId: actorID, Action: action, Target: target, Outcome: outcome, IpAddress: ipAddress,
	})
	if err != nil {
		slog.WarnContext(ctx, "auditclient: failed to append audit entry", "action", action, "error", err)
	}
}
```

**Critical invariant**: `Append` must never return an error to its caller — the whole point is that a
permission check's success/failure never depends on the audit system being reachable. Enforce this with a
test that a failing `AppendAuditEntry` RPC call does not propagate as an error from `Append`.

## Acceptance Criteria

- [x] `common/auditclient.New`/`Client.Append` implemented exactly as above (best-effort, logs on
      failure, never returns an error).
- [x] Unit test: a fake `AuthServiceClient` that errors on `AppendAuditEntry` — `Append` still returns
      (no panic, no error value) and the failure is logged.
- [x] `go build ./...` / `go test ./...` clean for `common/auditclient`.

## gitnexus

New package — no existing symbol modified. Run `codegraph_explore("common/grpcmw common/tenant shared
package pattern")` if unsure how `common/` packages are structured/tested in this repo before writing the
package, since this task explicitly follows that established convention.

## Kết quả thực tế

1. New `backend-go/common/auditclient/client.go`: `Client`/`New`/`Append` implemented exactly as the task
   sketch — `Append(ctx, tenantID, actorID, action, target, outcome, ipAddress string)` has no error return
   at all (the "never returns an error" invariant is enforced at the type level, not just by convention); a
   failed `AppendAuditEntry` RPC is logged via `slog.WarnContext` and swallowed.
2. New `backend-go/common/auditclient/client_test.go`: `fakeAuthServiceClient` embeds
   `authv1.AuthServiceClient` (nil) and overrides only `AppendAuditEntry` — matches this codebase's
   established partial-fake convention (`services/api-gateway/internal/adapter/authclient/jwks_client_test.go`),
   which also sidesteps having to keep this fake in sync with the `AuthServiceClient` interface every time
   an unrelated concurrent task adds another RPC to it (confirmed necessary: a second, concurrent in-flight
   session was adding `IsServiceTokenRevoked`/`ListCliTokens`/`RevokeCliToken` to that interface during this
   task). 3 tests: `TestAppend_NeverReturnsErrorOnRPCFailure` (asserts no panic and exactly 1 call when the
   fake errors), `TestAppend_ForwardsAllFields`, `TestAppend_SucceedsOnHappyPath`.
3. `backend-go/common/go.mod`: added `require github.com/stablyai/orca-go/proto v0.0.0` +
   `replace github.com/stablyai/orca-go/proto => ../proto`, mirroring every service module's own
   proto-dependency wiring (e.g. `services/api-gateway/go.mod`) — `common` had never imported generated
   proto code before this task.

gitnexus: confirmed via `grep -rl "auditclient"` that no file outside this new package references it yet
(TASK-BE-019..022 are next-wave, still untouched) — zero blast radius beyond the new package itself, matching
the task file's own "no existing symbol modified" note.

Results:
- `go build ./...` (common module): clean.
- `go test ./...` (common module, all packages including the pre-existing ones): **PASS**.
- `gofmt -l` on both new files: no output (clean).

## Blocking

Blocked on TASK-BE-017. Blocks TASK-BE-019, TASK-BE-020, TASK-BE-021, TASK-BE-022 (all 4 services'
wiring tasks depend on this client existing).
