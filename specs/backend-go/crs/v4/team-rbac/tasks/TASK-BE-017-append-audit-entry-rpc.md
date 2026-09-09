# TASK-BE-017: `AppendAuditEntry` RPC (auth-service, cross-service audit ingress)

> **Status: ✅ DONE — 2026-09-09**

**Solution:** BE-SOL-005 | **CR:** CR-RBAC-005
**Depends on:** TASK-BE-014 (`domain.AuditEntry`/`NewAuditEntry` must exist with the new fields first).

---

## Goal

`audit.audit_log` lives in `auth-service`'s own Postgres schema (bounded-context rule — no other service
gets a direct DB connection to it). `project-service`/`task-service`/`annotation-service`/
`infra-fleet-service` need a way to append an entry from their own OPA-gated decisions
(TASK-BE-019..022). This task adds the one small cross-service RPC that makes that possible.

## What to do

1. `backend-go/proto/orca/auth/v1/auth.proto`:

```protobuf
rpc AppendAuditEntry(AppendAuditEntryRequest) returns (google.protobuf.Empty);

message AppendAuditEntryRequest {
  string tenant_id = 1;   // from the caller's own validated context, not client input
  string actor_id = 2;
  string action = 3;      // e.g. "project.update", "repo.remove_member", "ssh.connect"
  string target = 4;      // resource type + id, e.g. "project:proj-123"
  string outcome = 5;     // "allowed" | "denied"
  string ip_address = 6;
}
```

2. New usecase `backend-go/services/auth-service/internal/usecase/append_audit_entry.go` — thin wrapper
   around `AuditRepository.Append`. **No `requireAdminActor` gate** — this is a service-to-service call,
   not an admin-console action; every other service authenticates to auth-service via mTLS + NetworkPolicy
   (per `07-security-architecture.md`), not per-call user authorization. Validates `tenant_id`/`action`
   non-empty, constructs `domain.NewAuditEntry`, appends.

3. `backend-go/services/auth-service/internal/adapter/grpc/server.go`: wire the handler.

## Acceptance Criteria

- [x] `AppendAuditEntry` RPC added to `auth.proto`, no admin gate.
- [x] `append_audit_entry.go` rejects empty `tenant_id`/`action` (usecase-level validation, before
      touching the repository).
- [x] `usecase/append_audit_entry_test.go`: no admin gate required (a non-admin/service caller succeeds);
      rejects empty `tenant_id`/`action`.
- [x] `go build ./...` / `go test ./...` clean for `auth-service`.

## gitnexus

`impact({target:"AuditRepository", direction:"upstream", repo:"orca", target_uid:"Interface:backend-go/services/auth-service/internal/usecase/ports.go:AuditRepository"})`
(same interface TASK-BE-015 just changed the `Query` signature on, run again here since this task adds a
NEW caller of `Append`): **MEDIUM risk, 13 impacted** (11 direct — see TASK-BE-015's note on the 2 depth-2
hits being an unrelated same-named interface in `credential-broker-service`, a name-collision false
positive). `AppendAuditEntry.Execute` only calls the already-stable `Append` method (unchanged signature),
so this task adds a caller rather than changing a contract — no transaction-semantics conflict with
`Append`'s existing callers (`Login`, `ForceRevokeAllSessionsForUser`, etc.), each of which calls `Append`
independently and best-effort (`_ = uc.audit.Append(...)` in most call sites), matching this task's own
non-transactional shape.

## Kết quả thực tế

1. `backend-go/proto/orca/auth/v1/auth.proto`: added `rpc AppendAuditEntry(AppendAuditEntryRequest) returns
   (google.protobuf.Empty)` and `message AppendAuditEntryRequest` exactly as sketched (tenant_id/actor_id/
   action/target/outcome/ip_address). Regenerated via `buf generate` — scoped the resulting diff to just
   `auth.pb.go`/`auth_grpc.pb.go`: `buf generate` also picked up an unrelated, already-pending source change
   to `infrafleet.proto` (CR-EVM-008/TASK-BE-EVM-020, a different in-flight task, not part of Wave 2) and
   would have regenerated `infrafleet.pb.go` too — reverted that incidental regeneration
   (`git checkout -- proto/gen/go/orca/infrafleet/v1/infrafleet.pb.go`) to keep this task's diff scoped to
   auth-service only, per this session's "no files outside the 5 tasks" constraint.
2. New `backend-go/services/auth-service/internal/usecase/append_audit_entry.go`:
   `AppendAuditEntry`/`AppendAuditEntryInput`, thin wrapper around `AuditRepository.Append` — no
   `requireAdminActor` call anywhere in it, validates `tenant_id`/`action` non-empty before constructing
   `domain.NewAuditEntry`.
3. `backend-go/services/auth-service/internal/adapter/grpc/server.go`: added `appendAuditEntry
   *usecase.AppendAuditEntry` field, threaded through `New(...)`, and the `AppendAuditEntry` handler
   method (mirrors `QueryAuditLog`'s shape, returns `*emptypb.Empty`).
4. `backend-go/services/auth-service/cmd/server/main.go`: wired `usecase.NewAppendAuditEntry(repo, clock)`
   and passed it into `authgrpc.New(...)` — required for the module to build once `server.New`'s signature
   grew a parameter; kept minimal (no other main.go changes).
5. New `backend-go/services/auth-service/internal/usecase/append_audit_entry_test.go`: 3 tests —
   `TestAppendAuditEntry_NoAdminGateRequired` (a plain, non-admin caller succeeds and the entry round-trips
   into the fake repository), `TestAppendAuditEntry_RejectsEmptyTenantID`,
   `TestAppendAuditEntry_RejectsEmptyAction` (both assert zero entries appended on rejection).

Verified no other service implements `authv1.AuthServiceServer` (only `auth-service/internal/adapter/grpc`
does, via `UnimplementedAuthServiceServer` embedding — the new interface method can't break any other
service's build), and confirmed `project-service`/`task-service`/`annotation-service`/`api-gateway` all
still build clean after the proto regen.

Results:
- `go build ./...` (auth-service module): clean.
- `go test ./...` (auth-service module): **PASS**, including the 3 new tests.
- `go build ./...` for `project-service`, `task-service`, `annotation-service`, `api-gateway`: clean
  (sanity check — none of them implement `AuthServiceServer`, so this was expected, but confirmed).
- `gofmt -l` on every changed file: no output (clean).

## Blocking

Blocked on TASK-BE-014 — DONE in the working tree. Blocks TASK-BE-018 (the shared client needs this RPC to
exist) — left untouched, next wave.
