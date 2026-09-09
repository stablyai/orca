# TASK-BE-016: `QueryAuditLogInput` — extend with `ActorID`/`Action`/`Outcome` filters

> **Status: ✅ DONE — 2026-09-09**

**Solution:** BE-SOL-005 | **CR:** CR-RBAC-005
**Depends on:** TASK-BE-015 (repository-level filters must exist to pass through).

---

## Goal

Surface the new repository-level filters (TASK-BE-015) through the usecase and RPC layer so
`QueryAuditLog` — and eventually the Admin Audit tab (CR-RBAC-001) — can actually filter by
actor/action/outcome, not just tenant+time range.

## What to do

1. `backend-go/services/auth-service/internal/usecase/query_audit_log.go`: `QueryAuditLogInput` gains
   `ActorID`/`Action`/`Outcome` optional fields, forwarded to the repository's new filter parameters
   (TASK-BE-015).
2. `backend-go/proto/orca/auth/v1/auth.proto`: `QueryAuditLogRequest` gains the corresponding optional
   fields; `AuditEntry` (proto message) gains `outcome`/`ip_address`.
3. `backend-go/services/auth-service/internal/adapter/grpc/server.go`: `toProtoAuditEntry` includes
   `Outcome`/`IpAddress`; the RPC handler forwards the new request fields into `QueryAuditLogInput`.

## Acceptance Criteria

- [x] `QueryAuditLogInput` has `ActorID`/`Action`/`Outcome` fields; zero-value/empty means "no filter."
- [x] `QueryAuditLogRequest`/`AuditEntry` proto messages carry the new fields; codegen run.
- [x] `toProtoAuditEntry` serializes `Outcome`/`IpAddress`.
- [x] `usecase/query_audit_log_test.go` extended with filter-combination cases (each filter alone, and
      combined).
- [x] Existing callers (e.g. any existing api-gateway admin route) compile unchanged with zero-value
      filters meaning "no filter" — confirmed backward compatible.
- [x] `go build ./...` / `go test ./...` clean for `auth-service`.

## gitnexus

Already run in BE-SOL-005's pass:

| Symbol | Direction | Risk | Impacted | Note |
|---|---|---|---|---|
| `QueryAuditLog` | upstream | LOW | 3 (1 direct, 1 process `run`) | New optional filter fields are additive — existing callers compile unchanged with zero-value filters meaning "no filter." |

## Kết quả thực tế

1. `backend-go/services/auth-service/internal/usecase/query_audit_log.go`: `QueryAuditLogInput` gained
   `ActorID string` / `Action string` / `Outcome domain.Outcome` fields, forwarded straight into
   `AuditRepository.Query`'s existing filter parameters (TASK-BE-015 had already added those to the
   repository signature and the postgres/fake implementations — this task only had to stop passing `"",
   "", ""` and thread the real input fields through instead).
2. `backend-go/proto/orca/auth/v1/auth.proto`: `QueryAuditLogRequest` gained `actor_id`/`action`/`outcome`
   (fields 5-7); `AuditEntry` gained `outcome`/`ip_address` (fields 7-8). Ran `buf generate` from
   `backend-go/proto` — a concurrent, unrelated in-flight session was actively editing this same
   `auth.proto` file adding CLI-token RPCs (`IsServiceTokenRevoked`/`ListCliTokens`/`RevokeCliToken`); the
   regen picked up their fields too (unavoidable — same file), but this task's own diff to `auth.pb.go`/
   `auth_grpc.pb.go` is additive only, confirmed by re-grepping for `QueryAuditLogRequest.GetActorId`/
   `GetAction`/`GetOutcome` and `AuditEntry.GetOutcome`/`GetIpAddress` after each regen. Also confirmed (as
   TASK-BE-017 did before) that `infrafleet.pb.go`/`infrafleet_grpc.pb.go` come out byte-identical to their
   pre-regen state (diffed against a saved copy), so this `buf generate` run didn't leak an unrelated
   service's pending proto changes into this diff.
3. `backend-go/services/auth-service/internal/adapter/grpc/server.go`: `QueryAuditLog` handler forwards
   `req.GetActorId()`/`GetAction()`/`domain.Outcome(req.GetOutcome())` into `QueryAuditLogInput`;
   `toProtoAuditEntry` now sets `Outcome: string(e.Outcome)` / `IpAddress: e.IPAddress`.
4. `backend-go/services/auth-service/internal/usecase/query_audit_log_test.go`: added
   `TestQueryAuditLog_FiltersByActorActionOutcome` — a table-driven test over 3 seeded entries covering
   "no filters", each of `ActorID`/`Action`/`Outcome` alone, two filters combined, and all three combined
   with no match (asserts an empty result, not an error).

`impact({target:"QueryAuditLog"})` (usecase struct) confirmed the task file's own LOW-risk/3-impacted note
— no other call site outside this package's own test file and the gRPC handler.

Results:
- `go build ./...` (auth-service module): clean.
- `go test ./...` (auth-service module): **PASS**, including the new filter-combination test.
- `gofmt -l` on every changed `.go` file: no output (clean).
- Confirmed `services/api-gateway` still builds clean after the proto regen (its `QueryAuditLogRequest`
  construction sites don't set the new fields, which is exactly the "zero-value means no filter" backward
  compatibility this task's acceptance criteria required).

## Blocking

Blocked on TASK-BE-015.
