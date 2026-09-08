# TASK-009: Add `star_nag_state` table (migration) + `StarNagState` domain model on tenant-service

**From Solution:** SOL-005
**Priority:** P0 — every other SOL-005 task depends on this table/type existing
**Service:** `tenant-service`
**File:** `backend-go/services/tenant-service/migrations/0005_star_nag_state.up.sql` (new), `backend-go/services/tenant-service/migrations/0005_star_nag_state.down.sql` (new), `backend-go/services/tenant-service/internal/domain/star_nag_state.go` (new)
**Depends on:** none
**Status:** `[x]` DONE — implemented as specified. `go build`/`go vet` clean on tenant-service; migration verified LIVE against the shared `orca-go-postgres` dev container (`migrate up` to version 5, `down 1` back to 4, `up` again to restore 5 — all clean). No deviation from the sketch.

---

## Context

BUG-005 found zero `StarNag`/`ValueMoment` concept anywhere in `backend-go`.
SOL-005's verdict is a new `star_nag_state` table folded into `tenant-service`
(same "small per-user preference state, no natural owning service" shape as
`tenant.user_profiles`), not a new microservice. This task lays the
foundation everything else in this solution builds on: the migration and the
`domain.StarNagState`/`domain.ActiveStarNagPrompt` types.

## Changes to make

### Step 1 — migration

The existing migration numbering in
`backend-go/services/tenant-service/migrations/` runs `0001`–`0004`
(`0004_company_email_domains.up.sql` is the latest), each a plain `.up.sql`/
`.down.sql` pair with no framework migration-tool boilerplate — see
`0003_add_onboarding_state.up.sql`:

```sql
-- Live bug: the onboarding wizard's completion/progress state was never
-- persisted anywhere in backend-go (channels_onboarding.go always echoed
-- the caller's update back without storing it) — every page refresh reset
-- to "wizard not started", re-showing onboarding forever. tenant.user_profiles
-- is already the per-user (one row per user_id) state table this service
-- owns; onboarding progress is genuinely per-user, not a cascading
-- company/department/team default like settings_json, so it gets its own
-- column rather than being folded into that deep-merge blob.
ALTER TABLE tenant.user_profiles ADD COLUMN onboarding_state_json JSONB;
```

Unlike onboarding state, `star_nag_state` is NOT folded into
`user_profiles` as another column — it's a genuinely separate 8-column
concern with its own `updated_at`/index, so it gets its own table (per
SOL-005's own domain-model section), still in the `tenant` schema tenant-service
owns exclusively.

Create `backend-go/services/tenant-service/migrations/0005_star_nag_state.up.sql`:

```sql
-- New table, not another tenant.user_profiles column (unlike onboarding
-- state) — star-nag state is 8 columns of its own concern (dismissal/
-- cooldown/threshold/completion/active-prompt), not a single JSON blob
-- fitting the "one more per-user setting" shape onboarding_state_json used.
-- See specs/backend-go/bugs/missing-v3/solutions/SOL-005-starnag-channels.md
-- for the full design (STAR_NAG_INITIAL_THRESHOLD=35 ported from the old
-- TS backend's backend/src/shared/constants.ts:124).
CREATE TABLE tenant.star_nag_state (
  user_id                          UUID PRIMARY KEY,          -- logical FK -> auth.users, 1:1 like user_profiles.user_id
  company_id                       UUID NOT NULL REFERENCES tenant.companies(id),
  baseline_agents                  BIGINT,
  app_version                      TEXT,
  next_threshold                   BIGINT NOT NULL DEFAULT 35,
  completed                        BOOLEAN NOT NULL DEFAULT false,
  deferred_until                   TIMESTAMPTZ,
  agent_value_moment_app_version   TEXT,
  -- ActiveStarNagPrompt (domain/star_nag_state.go) as JSON, or NULL when no
  -- prompt is currently displayed — replaces the old TS backend's
  -- in-memory-only promptSession (service.ts:66) since a dismiss/later/
  -- openWeb/starOrca call may land on a different tenant-service replica
  -- than the one that served the show.
  active_prompt                    JSONB,
  updated_at                       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_star_nag_state_company ON tenant.star_nag_state(company_id);
```

Confirmed against `0001_init.up.sql`: `tenant.companies.id` is `UUID PRIMARY
KEY`, so the `REFERENCES tenant.companies(id)` clause above is correct as
written.

Create `backend-go/services/tenant-service/migrations/0005_star_nag_state.down.sql`:

```sql
DROP TABLE tenant.star_nag_state;
```

### Step 2 — domain model

Create `backend-go/services/tenant-service/internal/domain/star_nag_state.go`,
following `domain/user_profile.go`'s style (plain struct, a `New*` constructor
enforcing invariants, doc comments citing the design doc):

```go
package domain

import "time"

// StarNagInitialThreshold is the number of agent runs before the first
// "star Orca" nag prompt — ported verbatim from the old TS backend's
// STAR_NAG_INITIAL_THRESHOLD (backend/src/shared/constants.ts:124).
const StarNagInitialThreshold = 35

// StarNagCooldown is how long a "later"/"open web" action defers the next
// prompt — ported from STAR_NAG_COOLDOWN_DAYS (service.ts:21-22).
const StarNagCooldown = 3 * 24 * time.Hour

// StarNagState is the per-(user, company) growth-nag preference/state row —
// tenant.star_nag_state, 1:1 with a user like UserProfile. See
// specs/backend-go/bugs/missing-v3/solutions/SOL-005-starnag-channels.md
// for the full design; this ports the 6 persisted fields from the old TS
// backend's GlobalSettings.ui.starNag* (backend/src/shared/types.ts:3497-3515)
// plus ActivePrompt, a persisted replacement for that backend's in-memory-only
// promptSession (service.ts:66).
type StarNagState struct {
	UserID                     string
	CompanyID                  string
	BaselineAgents             *int64
	AppVersion                 *string
	NextThreshold              int64
	Completed                  bool
	DeferredUntil              *time.Time
	AgentValueMomentAppVersion *string
	ActivePrompt               *ActiveStarNagPrompt
	UpdatedAt                  time.Time
}

// ActiveStarNagPrompt mirrors the old TS backend's in-memory
// StarNagPromptSession (service.ts:66, star-nag-telemetry.ts) — persisted
// here (not process-local) so a later dismiss/later/openWeb/starOrca call
// can act on it regardless of which tenant-service replica served the show.
type ActiveStarNagPrompt struct {
	// Source: "threshold" | "force_show" | "agent_value_moment" |
	// "onboarding_completed" — StarNagPromptSource.
	Source string
	// Mode: "gh" | "web" — StarNagPromptMode.
	Mode string
	// Surface: "card" | "toast".
	Surface           string
	OpenedRepoTracked bool
	ShownAt           time.Time
}

// NewDefaultStarNagState constructs the lazily-created default row for a
// user who has never had one before — mirrors the old TS backend's
// ensureStarNagBaseline auto-initializing on first read
// (threshold-trigger.ts:15-27): NextThreshold starts at
// StarNagInitialThreshold, everything else zero-valued/nil.
func NewDefaultStarNagState(userID, companyID string) StarNagState {
	return StarNagState{
		UserID:        userID,
		CompanyID:     companyID,
		NextThreshold: StarNagInitialThreshold,
	}
}
```

## Verify

```bash
cd backend-go
go build ./services/tenant-service/...
go vet ./services/tenant-service/...
```

No `go test` target yet — this task adds no test file of its own (TASK-010
adds the repository this domain type backs, with its own tests). To confirm
the migration itself applies and rolls back cleanly against a scratch DB
(per the `Makefile`'s `migrate-all` target, which just documents the
per-service invocation):

```bash
migrate -path services/tenant-service/migrations -database "$DATABASE_DSN_TENANT" up
migrate -path services/tenant-service/migrations -database "$DATABASE_DSN_TENANT" down 1
```
