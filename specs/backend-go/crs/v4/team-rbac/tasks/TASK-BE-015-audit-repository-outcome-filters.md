# TASK-BE-015: `audit_repository.go` — persist `Outcome`/`IPAddress`, add query filters

> **Status: ✅ DONE — 2026-09-09**

**Solution:** BE-SOL-005 | **CR:** CR-RBAC-005
**Depends on:** TASK-BE-014 (`domain.AuditEntry.Outcome`/`IPAddress` must exist first).

---

## Goal

`postgres.Repository.Append`/`Query` (`audit_repository.go`) only handle the pre-existing 6 fields. Wire
the 2 new columns through, and give `Query` the `actor_id`/`action`/`outcome` filters it's missing today
(currently only `tenant_id`+`since`+pagination).

## What to do

In `backend-go/services/auth-service/internal/adapter/postgres/audit_repository.go`:

1. `Append`: include `outcome`, `ip_address` in the INSERT.
2. `Query`: SELECT the 2 new columns into the returned `AuditEntry` values; add optional
   `actor_id`/`action`/`outcome` filter parameters — empty string / zero value = no filter, matching this
   codebase's established "empty = no filter" convention (see `ListDevServersForUserInput.Kind` for the
   existing pattern to mirror).

## Acceptance Criteria

- [x] `Append` persists `Outcome`/`IPAddress`.
- [x] `Query` returns `Outcome`/`IPAddress` on every row.
- [x] `Query` accepts optional `actor_id`/`action`/`outcome` filters; omitting all three preserves today's
      exact behavior (no filter).
- [x] `postgres/audit_repository_test.go` (testcontainers, per this repo's standard `adapter/postgres/`
      test tier): round-trip `Outcome`/`IPAddress`; filter by each of `actor_id`/`action`/`outcome`
      individually and in combination.
- [x] `go build ./...` / `go test ./...` clean for `auth-service`.

## gitnexus

**Premise correction:** by the time this task ran, `Append` already persisted `Outcome`/`IPAddress` and
`Query` already SELECTed them into the returned `AuditEntry` — Wave 1's TASK-BE-014 pass had gone slightly
further than its own task file described and wired both columns end-to-end already. The only actually-
missing piece was the `actor_id`/`action`/`outcome` filter parameters on `Query`, confirmed via
`codegraph_explore("audit_repository.go Append Query")` before editing, per this task's own instruction to
verify current shape first.

`impact({target:"AuditRepository", direction:"upstream", repo:"orca"})` (2 candidates; disambiguated to
`backend-go/services/auth-service/internal/usecase/ports.go:AuditRepository` via `target_uid`): **MEDIUM
risk, 13 impacted** (11 direct — every file in `auth-service` that imports the `usecase` package, since
`AuditRepository` lives on `ports.go`; the two depth-2 hits are `credential-broker-service`'s unrelated
same-named interface's own callers, a false-positive from name collision, not a real dependency). Adding 3
new parameters to `Query` is a breaking signature change, so every implementer/caller needed updating in
lockstep: `postgres.Repository.Query` (the interface's sole implementation),
`usecase.QueryAuditLog.Execute`'s call site (passes all three empty — preserves exact prior behavior, real
filter wiring is TASK-BE-016's job), `fakeAuditRepository.Query` (usecase package's test fake, now filters
for real so future usecase-level tests can exercise it), and the pre-existing
`TestRepository_AuditLog_AppendAndQueryFiltersByTenant` integration test's call site.

## Kết quả thực tế

Changed `AuditRepository.Query`'s signature (`ports.go`) and its one implementation
(`adapter/postgres/audit_repository.go`) to accept `actorID, action string, outcome domain.Outcome` between
`since` and `pageToken`, with the established empty-means-no-filter convention (`($n = '' OR col = $n)`
per parameter). Updated every call site the signature change broke:
`usecase/query_audit_log.go` (passes all three empty, no behavior change),
`usecase/fakes_test.go`'s `fakeAuditRepository.Query` (now filters in-memory for real), and
`adapter/postgres/repository_test.go`'s existing integration test call.

**Found and fixed a real pre-existing bug while writing the round-trip test**: `Query`'s SELECT read
`ip_address` back via `COALESCE(ip_address::text, '')` — for Postgres's `inet` column type this returns the
CIDR form (`"203.0.113.7/32"`), not the bare address that was written (`"203.0.113.7"`), so any real
non-empty IP silently gained a `/32` suffix on every read. Fixed by switching to `COALESCE(host(ip_address),
'')`, which returns just the address per Postgres's `host()` function semantics. Caught by
`TestRepository_AuditLog_RoundTripsOutcomeAndIPAddress` (new), which failed with
`expected IPAddress "203.0.113.7", got "203.0.113.7/32"` before the fix.

New file `backend-go/services/auth-service/internal/adapter/postgres/audit_repository_test.go`
(`//go:build integration`, testcontainers, mirrors `repository_test.go`'s `setupRepository` helper):
- `TestRepository_AuditLog_RoundTripsOutcomeAndIPAddress` — round-trips a denied entry with a real IP.
- `TestRepository_AuditLog_QueryFiltersByActorActionOutcome` — 5 subtests: filter by `actor_id` alone,
  `action` alone, `outcome` alone, all three combined, and no filters (confirms the prior no-filter
  behavior is unchanged, still returns all 4 seeded entries).

Results:
- `go build ./...` (auth-service module): clean.
- `go test ./...` (auth-service module, unit tests): **PASS**, no regressions.
- `go test -tags=integration -count=1 ./internal/adapter/postgres/... -run TestRepository_AuditLog -v`:
  all **3 tests PASS** (round-trip, the new 5-subtest filter test, and the pre-existing tenant-filter test)
  against a real dockerized Postgres 16 via testcontainers-go.
- `gofmt -l` on every changed file: no output (clean).

## Blocking

Blocked on TASK-BE-014 — DONE in the working tree (`domain.AuditEntry.Outcome`/`IPAddress` exist). Blocks
TASK-BE-016 (left untouched, next wave).
