# TASK-BE-014: `AuditEntry` gains `Outcome`/`IPAddress` — migration + domain type

> **Status: ✅ DONE — 2026-09-09**
> **Files modified:** `backend-go/services/auth-service/migrations/0004_audit_outcome_and_ip.up.sql` (new),
> `backend-go/services/auth-service/migrations/0004_audit_outcome_and_ip.down.sql` (new),
> `backend-go/services/auth-service/internal/domain/audit.go`,
> `backend-go/services/auth-service/internal/domain/audit_test.go`,
> `backend-go/services/auth-service/internal/adapter/postgres/audit_repository.go`,
> `backend-go/services/auth-service/internal/adapter/postgres/repository_test.go`,
> `backend-go/services/auth-service/internal/usecase/{bootstrap,create_user,deactivate_user,
> force_revoke_all_sessions,issue_service_token... }.go` — see full list below.
>
> **Kết quả thực tế:** `0004` was free (confirmed via `ls migrations/` — TASK-BE-009's own migration is out
> of this Wave-1 scope and hasn't landed, so no numbering collision). Migration, `domain.Outcome`/
> `AuditEntry.Outcome`/`AuditEntry.IPAddress`, and `NewAuditEntry`'s new signature all implemented exactly
> per the sketch. All 10 in-repo call sites of `domain.NewAuditEntry` updated to pass
> `domain.OutcomeAllowed, ""` (the two new params): `bootstrap.go`, `deactivate_user.go`, `logout.go`,
> `create_user.go`, `revoke_session.go`, `login.go`, `reactivate_user.go`, `update_user_role.go`,
> `force_revoke_all_sessions.go`, `login_or_provision_sso_user.go` — plus the two test-only call sites
> (`domain/audit_test.go`, `adapter/postgres/repository_test.go`, the latter gated behind the
> `integration` build tag). `audit_repository.go`'s `Append`/`Query` extended to persist/read the two new
> columns (outcome defaults to `allowed` if somehow empty on write, matching the DB `DEFAULT`; `ip_address`
> read back via `COALESCE(...,'')` so an unset `INET` never breaks the scan). `domain/audit_test.go` gained
> 3 new tests (`TestNewAuditEntry_DefaultsEmptyOutcomeToAllowed`, `TestNewAuditEntry_RejectsInvalidOutcome`,
> `TestNewAuditEntry_PersistsOutcomeAndIPAddress`) alongside the updated existing ones. `go build ./...`
> clean for the whole repo; `go test ./...` clean for `auth-service` (the `integration`-tagged postgres test
> was updated for compile-correctness but not run — no Docker/testcontainers in this environment; scope
> note per the task's own instructions). `gofmt -l` clean. Proto/gRPC surface (`authv1.AuditEntry`,
> `toProtoAuditEntry`) deliberately NOT touched — out of this task's stated scope (schema/domain only);
> it simply doesn't yet expose the two new fields over the wire, tracked implicitly by TASK-BE-015..023's
> own scope.

**Solution:** BE-SOL-005 | **CR:** CR-RBAC-005
**Depends on:** none — foundation task for the rest of BE-SOL-005 (TASK-BE-015 through TASK-BE-023 all
build on this schema/domain change).

---

## Goal

`domain.AuditEntry` is exactly `{ID, TenantID, ActorID, Action, Target, OccurredAt}` — no `outcome`, no
`ip_address`, so audit entries can't distinguish "denied" from "allowed," and there's no client IP on
record. Add both.

## What to do

1. New migration
   `backend-go/services/auth-service/migrations/0004_audit_outcome_and_ip.up.sql` (confirm this number is
   still free — coordinate with TASK-BE-009's `sso_group_role_mapping` migration, which may also want
   `0004`; whichever lands first takes it, the other becomes `0005`):

```sql
ALTER TABLE auth.audit_log
    ADD COLUMN outcome     TEXT NOT NULL DEFAULT 'allowed' CHECK (outcome IN ('allowed', 'denied')),
    ADD COLUMN ip_address  INET;

CREATE INDEX idx_audit_log_outcome ON auth.audit_log (tenant_id, outcome);
```

`0004_audit_outcome_and_ip.down.sql`:

```sql
DROP INDEX IF EXISTS auth.idx_audit_log_outcome;
ALTER TABLE auth.audit_log DROP COLUMN IF EXISTS outcome, DROP COLUMN IF EXISTS ip_address;
```

2. `backend-go/services/auth-service/internal/domain/audit.go`:

```go
type Outcome string

const (
	OutcomeAllowed Outcome = "allowed"
	OutcomeDenied  Outcome = "denied"
)

func (o Outcome) Valid() bool {
	switch o {
	case OutcomeAllowed, OutcomeDenied:
		return true
	default:
		return false
	}
}

type AuditEntry struct {
	ID         string
	TenantID   string
	ActorID    string
	Action     string
	Target     string
	Outcome    Outcome // defaults to OutcomeAllowed for pre-existing call sites, see NewAuditEntry
	IPAddress  string  // empty for entries appended by a service with no HTTP-request context (e.g. a background job)
	OccurredAt time.Time
}

// NewAuditEntry's signature grows an Outcome parameter. Every existing call
// site (auth-service's own success-path audit calls) passes OutcomeAllowed —
// see "Files to change" for the mechanical update.
func NewAuditEntry(id, tenantID, actorID, action, target string, outcome Outcome, ipAddress string, occurredAt time.Time) (AuditEntry, error) {
	// ... existing checks ...
	if outcome == "" {
		outcome = OutcomeAllowed // backward-compatible default, not an error — see domain.AuditEntry's doc comment
	}
	if !outcome.Valid() {
		return AuditEntry{}, ErrInvalidOutcome
	}
	return AuditEntry{ID: id, TenantID: tenantID, ActorID: actorID, Action: action, Target: target, Outcome: outcome, IPAddress: ipAddress, OccurredAt: occurredAt}, nil
}
```

3. Update every existing call site that constructs `AuditEntry` directly (confirmed to be only
   `auth-service`'s own usecases, e.g. `update_user_role.go`) to pass `OutcomeAllowed` and an empty/known
   IP.

## Acceptance Criteria

- [x] Migration adds `outcome` (NOT NULL, default `'allowed'`, checked) and `ip_address` (`INET`,
      nullable) columns + an index on `(tenant_id, outcome)`.
- [x] `domain.AuditEntry` has `Outcome`/`IPAddress` fields; `Outcome` type with `Valid()`.
- [x] `NewAuditEntry`'s new signature defaults empty `Outcome` to `OutcomeAllowed` (backward compatible),
      rejects any other invalid value with `ErrInvalidOutcome`.
- [x] Every existing in-repo call site updated to compile against the new signature.
- [x] `domain/audit_test.go`: `NewAuditEntry` validates `Outcome`, defaults empty outcome to `allowed`.
- [x] `go build ./...` / `go test ./...` clean for `auth-service`.

## gitnexus

Re-run in this session (2026-09-09) via `impact({target:"AuditEntry", direction:"upstream", repo:"orca",
file_path:"backend-go/services/auth-service/internal/domain/audit.go", summaryOnly:true})` (disambiguated
from the unrelated `authv1.AuditEntry` proto message, a separate candidate) → **risk LOW**, impactedCount
14 (1 direct, 1 process `run`) — matches BE-SOL-005's original numbers exactly:

| Symbol | Direction | Risk | Impacted | Note |
|---|---|---|---|---|
| `AuditEntry` | upstream | LOW | 14 (1 direct, 1 process `run`) | The `NewAuditEntry` signature change touches all direct callers — grep-confirmed only `auth-service`'s own usecases construct `AuditEntry` directly today, all in-repo, all updated in this same change. |

## Blocking

Blocks TASK-BE-015 (repository layer), and transitively every other BE-SOL-005 task.
