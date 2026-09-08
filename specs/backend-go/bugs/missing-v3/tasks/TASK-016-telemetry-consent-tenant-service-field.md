# TASK-016: Telemetry consent state — `tenant-service` field + `GetTelemetryConsent`/`SetTelemetryConsent` RPCs

**From Solution:** SOL-014
**Priority:** P1 — blocked, not ready to start (see Depends on)
**Service:** `tenant-service`
**File:** `backend-go/proto/orca/tenant/v1/tenant.proto`, `backend-go/services/tenant-service/migrations/0006_telemetry_consent.up.sql` (new), `backend-go/services/tenant-service/migrations/0006_telemetry_consent.down.sql` (new), `backend-go/services/tenant-service/internal/domain/user_profile.go`, `backend-go/services/tenant-service/internal/usecase/ports.go`, `backend-go/services/tenant-service/internal/usecase/telemetry_consent.go` (new), `backend-go/services/tenant-service/internal/adapter/postgres/user_profile_repository.go`, `backend-go/services/tenant-service/internal/adapter/grpc/server.go`
**Depends on:** **TASK-015 — BLOCKED.** Do not start until `../decisions/DECISION-telemetry-consent-identity-model.md`'s Questions 1 and 2 (identity shape, consent scope: per-user/per-tenant/both) are marked `✅ DECIDED`. This task's design below assumes SOL-014's own placeholder default (Option A on both: per-user opt-in stored on `UserProfile`, per-`(tenant_id,user_id)` pseudonymous identity) — **re-check both answers against the actual decision recorded before implementing**; if the decision differs (e.g. a per-tenant admin toggle, or both with a precedence rule), this task's schema/RPC shape must change accordingly, not be implemented as literally written below.
**Status:** `[ ]` TODO — blocked, not ready to start

---

## Context

SOL-014 §1 sketches telemetry consent as one more small per-user
preference, reusing the exact "tiny per-user state, no natural owning
service, closest fit is `tenant-service`" reasoning SOL-005 already
establishes for `star_nag_state`. This task is real, buildable engineering
—but only once TASK-015's product decision fixes the consent *scope*
(per-user vs. per-tenant vs. both) and identity shape, both of which change
this task's schema. Written now so the implementation is ready to execute
the moment that decision lands, not before.

## Changes to make (assumes TASK-015 decided: per-user opt-in, `UserProfile`-hosted)

### Step 1 — migration

Following `0003_add_onboarding_state.up.sql`'s exact "new column on
`tenant.user_profiles`" shape (telemetry consent is a single small
preference blob, same category as onboarding progress, not a
multi-column table like `star_nag_state`):

```sql
-- Telemetry consent state — BUG-014/SOL-014, gated on the product decision
-- recorded in specs/backend-go/bugs/missing-v3/decisions/
-- DECISION-telemetry-consent-identity-model.md (Questions 1-2). NULL
-- opted_in means "existed before telemetry release, pending banner"
-- (mirrors the old TS backend's existedBeforeTelemetryRelease +
-- optedIn===null combination, client.ts).
ALTER TABLE tenant.user_profiles ADD COLUMN telemetry_consent_json JSONB;
```

```sql
ALTER TABLE tenant.user_profiles DROP COLUMN telemetry_consent_json;
```

### Step 2 — domain

Add to `internal/domain/user_profile.go` (a sibling type, not a
`UserProfile` field — same "own column, own accessor methods, not folded
into `Settings`'s deep-merge blob" treatment `OnboardingState` already
gets):

```go
// TelemetryConsent is the per-user telemetry opt-in/out state — see
// specs/backend-go/bugs/missing-v3/decisions/
// DECISION-telemetry-consent-identity-model.md for why this is per-user
// (Question 2) rather than per-tenant. OptedIn == nil means "existed
// before telemetry release, pending banner" — distinct from
// OptedIn == false (explicit opt-out).
type TelemetryConsent struct {
	OptedIn *bool
	Via     string // "first_launch_banner" | "settings" — last mutation's source
}
```

### Step 3 — `ports.go` + repository

Add two methods to `UserProfileRepository` (same dedicated-partial-update
shape as `GetOnboardingState`/`SetOnboardingState`, for the same reason:
routing through `Upsert` would clobber `department_id`/`settings_json` for
a caller that only wants to touch consent):

```go
	// GetTelemetryConsent/SetTelemetryConsent persist per-user telemetry
	// opt-in state — see domain.TelemetryConsent's doc comment. found=false
	// means no consent has ever been recorded (row missing OR column NULL),
	// which the usecase surfaces as OptedIn=nil ("pending banner"), not an
	// error.
	GetTelemetryConsent(ctx context.Context, companyID, userID string) (domain.TelemetryConsent, bool, error)
	SetTelemetryConsent(ctx context.Context, companyID, userID string, consent domain.TelemetryConsent) error
```

Implement in `user_profile_repository.go` following
`GetOnboardingState`/`SetOnboardingState`'s exact SQL shape (same file,
same `SELECT ... FROM tenant.user_profiles WHERE user_id = $1 AND
company_id = $2` / `INSERT ... ON CONFLICT (user_id) DO UPDATE SET
telemetry_consent_json = EXCLUDED.telemetry_consent_json, updated_at =
now()` pattern), marshaling/unmarshaling `domain.TelemetryConsent` to/from
the new `telemetry_consent_json` column exactly as `star_nag_state`'s
`active_prompt` column does (TASK-010).

### Step 4 — proto + usecase + grpc

```protobuf
  // ── telemetry consent (BUG-014/SOL-014) ───────────────────────────────
  // Gated on specs/backend-go/bugs/missing-v3/decisions/
  // DECISION-telemetry-consent-identity-model.md — do not call these from
  // any wscompat channel until TASK-018 lands (that's the consumer).
  rpc GetTelemetryConsent(GetTelemetryConsentRequest) returns (TelemetryConsent);
  rpc SetTelemetryConsent(SetTelemetryConsentRequest) returns (google.protobuf.Empty);

message GetTelemetryConsentRequest {
  string user_id = 1;
}

message TelemetryConsent {
  // opted_in has no proto3 "null" — use has_opted_in to distinguish "never
  // set" (has_opted_in=false) from an explicit false opt-out
  // (has_opted_in=true, opted_in=false).
  bool has_opted_in = 1;
  bool opted_in = 2;
  string via = 3;
}

message SetTelemetryConsentRequest {
  string user_id = 1;
  bool opted_in = 2;
  string via = 3;
}
```

Add `usecase.GetTelemetryConsent`/`usecase.SetTelemetryConsent` (same
`tenant.RequireTenantID(ctx)` + `apperrors.New` shape as every other
usecase in this file's siblings), and wire both into
`internal/adapter/grpc/server.go` + `cmd/server/main.go`, following
`GetOnboardingState`/`SetOnboardingState`'s exact wiring precedent
(`server.go:151-167`, `main.go:142-143,150`).

## Verify

```bash
cd backend-go/proto && buf generate && cd ..
go build ./services/tenant-service/...
go vet ./services/tenant-service/...
go test ./services/tenant-service/internal/usecase/... -run TestGetTelemetryConsent -run TestSetTelemetryConsent -count=1 -v
go test ./services/tenant-service/internal/adapter/postgres/... -run TestUserProfileRepository_TelemetryConsent -count=1 -v
```
