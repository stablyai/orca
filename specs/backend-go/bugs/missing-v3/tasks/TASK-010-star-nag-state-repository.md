# TASK-010: `StarNagStateRepository` port + postgres adapter (`GetOrCreate`/`Save`)

**From Solution:** SOL-005
**Priority:** P0 — every usecase task (TASK-011/012/013) needs this port to exist
**Service:** `tenant-service`
**File:** `backend-go/services/tenant-service/internal/usecase/ports.go` (add interface), `backend-go/services/tenant-service/internal/adapter/postgres/star_nag_state_repository.go` (new), `backend-go/services/tenant-service/internal/adapter/postgres/star_nag_state_repository_test.go` (new)
**Depends on:** TASK-009
**Status:** `[x]` DONE — implemented as specified. The repo's actual convention is one shared `repository_test.go` gated behind `//go:build integration` using testcontainers-go (not a `dockertest`/live-manual-DB pattern) — new tests were added in a separate `star_nag_state_repository_test.go` file in the same package, reusing the existing `setupPool` helper rather than inventing a new one. All 4 integration tests pass for real (`go test -tags=integration ... -run TestStarNagStateRepository`), plus `go build`/`go vet` clean.

---

## Context

SOL-005 designs `StarNagState` as lazily-created on first access
(`GetOrCreate`, mirroring the old TS backend's `ensureStarNagBaseline`
auto-initializing on first read), not provisioned at signup. This task adds
the usecase-layer port (`ports.go`, following `UserProfileRepository`'s exact
shape/doc-comment convention) and its Postgres implementation, ready for the
usecases TASK-011/012/013 to depend on.

## Changes to make

### Step 1 — `ports.go`: add `StarNagStateRepository`

Current `ports.go` already documents `UserProfileRepository` at
`ports.go:82-109` as the precedent for "per-user, 1:1, logical FK to
auth-service" repositories. Add a new interface, same file, same style:

```go
// StarNagStateRepository persists the per-user "star Orca on GitHub" nag
// preference/state row (tenant.star_nag_state) — 1:1 with a user, same
// logical-FK-to-auth-service shape as UserProfileRepository. See
// domain.StarNagState's doc comment and
// specs/backend-go/bugs/missing-v3/solutions/SOL-005-starnag-channels.md.
type StarNagStateRepository interface {
	// GetOrCreate returns userID's existing row, or lazily inserts and
	// returns domain.NewDefaultStarNagState(userID, companyID) if none
	// exists yet — mirrors the old TS backend's ensureStarNagBaseline
	// auto-initializing on first read (threshold-trigger.ts:15-27); a row
	// is never provisioned at signup.
	GetOrCreate(ctx context.Context, companyID, userID string) (domain.StarNagState, error)
	// Save fully replaces state's mutable columns, keyed on
	// (company_id, user_id) — every SOL-005 usecase calls GetOrCreate then
	// Save, never a partial-field update, so there is no separate Upsert
	// vs. partial-update split like UserProfileRepository's
	// Upsert/SetOnboardingState pair.
	Save(ctx context.Context, state domain.StarNagState) error
}
```

### Step 2 — postgres adapter

Create `backend-go/services/tenant-service/internal/adapter/postgres/star_nag_state_repository.go`,
following `user_profile_repository.go`'s exact style (same package, same
`nullableString`-style helpers, same isolation posture — a row from another
company resolves as not-found):

```go
package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/stablyai/orca-go/services/tenant-service/internal/domain"
)

// StarNagStateRepository implements usecase.StarNagStateRepository against
// tenant.star_nag_state — 1:1 with a user, logical FK to auth-service, same
// isolation rule as UserProfileRepository (a row from another company
// resolves as not-found, tenant-service.md §9).
type StarNagStateRepository struct {
	pool *pgxpool.Pool
}

func NewStarNagStateRepository(pool *pgxpool.Pool) *StarNagStateRepository {
	return &StarNagStateRepository{pool: pool}
}

func (r *StarNagStateRepository) GetOrCreate(ctx context.Context, companyID, userID string) (domain.StarNagState, error) {
	state, found, err := r.get(ctx, companyID, userID)
	if err != nil {
		return domain.StarNagState{}, err
	}
	if found {
		return state, nil
	}
	def := domain.NewDefaultStarNagState(userID, companyID)
	if err := r.Save(ctx, def); err != nil {
		return domain.StarNagState{}, err
	}
	return def, nil
}

func (r *StarNagStateRepository) get(ctx context.Context, companyID, userID string) (domain.StarNagState, bool, error) {
	row := r.pool.QueryRow(ctx, `
		SELECT user_id, company_id, baseline_agents, app_version, next_threshold,
		       completed, deferred_until, agent_value_moment_app_version,
		       active_prompt, updated_at
		FROM tenant.star_nag_state
		WHERE user_id = $1 AND company_id = $2
	`, userID, companyID)

	var s domain.StarNagState
	var activePromptJSON []byte
	if err := row.Scan(&s.UserID, &s.CompanyID, &s.BaselineAgents, &s.AppVersion, &s.NextThreshold,
		&s.Completed, &s.DeferredUntil, &s.AgentValueMomentAppVersion, &activePromptJSON, &s.UpdatedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return domain.StarNagState{}, false, nil
		}
		return domain.StarNagState{}, false, fmt.Errorf("postgres: query star nag state: %w", err)
	}
	if len(activePromptJSON) > 0 {
		var p domain.ActiveStarNagPrompt
		if err := json.Unmarshal(activePromptJSON, &p); err != nil {
			return domain.StarNagState{}, false, fmt.Errorf("postgres: unmarshal active_prompt: %w", err)
		}
		s.ActivePrompt = &p
	}
	return s, true, nil
}

// Save upserts every mutable column, keyed on (user_id, company_id).
func (r *StarNagStateRepository) Save(ctx context.Context, s domain.StarNagState) error {
	var activePromptJSON []byte
	if s.ActivePrompt != nil {
		b, err := json.Marshal(s.ActivePrompt)
		if err != nil {
			return fmt.Errorf("postgres: marshal active_prompt: %w", err)
		}
		activePromptJSON = b
	}

	_, err := r.pool.Exec(ctx, `
		INSERT INTO tenant.star_nag_state
			(user_id, company_id, baseline_agents, app_version, next_threshold,
			 completed, deferred_until, agent_value_moment_app_version, active_prompt, updated_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
		ON CONFLICT (user_id) DO UPDATE SET
			company_id                     = EXCLUDED.company_id,
			baseline_agents                = EXCLUDED.baseline_agents,
			app_version                    = EXCLUDED.app_version,
			next_threshold                 = EXCLUDED.next_threshold,
			completed                      = EXCLUDED.completed,
			deferred_until                 = EXCLUDED.deferred_until,
			agent_value_moment_app_version = EXCLUDED.agent_value_moment_app_version,
			active_prompt                  = EXCLUDED.active_prompt,
			updated_at                     = now()
	`, s.UserID, s.CompanyID, s.BaselineAgents, s.AppVersion, s.NextThreshold,
		s.Completed, s.DeferredUntil, s.AgentValueMomentAppVersion, activePromptJSON)
	if err != nil {
		return fmt.Errorf("postgres: upsert star nag state: %w", err)
	}
	return nil
}
```

`s.DeferredUntil`/`s.UpdatedAt` are `*time.Time`/`time.Time` fields on
`domain.StarNagState`, but this file only ever passes them through as pgx
query parameters — it never constructs a `time.Time` literal itself, so it
needs no `"time"` import of its own (unlike `star_nag_actions.go`'s usecases
in TASK-011, which do call `time.Now()`).

### Step 3 — repository test

Create `star_nag_state_repository_test.go` following
`user_profile_repository.go`'s sibling test file's structure (check
`internal/adapter/postgres/*_test.go` for whichever existing test uses a
real or dockertest Postgres connection in this package — mirror its
connection-setup helper exactly, don't invent a new one). Cover:

- `GetOrCreate` on a brand-new `(companyID, userID)` lazily inserts a
  default row (`NextThreshold == domain.StarNagInitialThreshold`, everything
  else zero-valued) and returns it.
- `GetOrCreate` on an existing row returns the persisted values unchanged
  (no re-insert/overwrite).
- `Save` round-trips every field, including a non-nil `ActivePrompt` (JSONB
  marshal/unmarshal fidelity) and a nil `ActivePrompt` (clearing it back to
  SQL `NULL`).
- A row belonging to a different `company_id` is not returned by
  `GetOrCreate`/`get` scoped to the caller's own `companyID` — same
  adversarial-isolation case `user_profile_repository_test.go` (or whichever
  sibling test covers this pattern) already asserts for `UserProfileRepository`.

## Verify

```bash
cd backend-go
go build ./services/tenant-service/...
go vet ./services/tenant-service/...
go test ./services/tenant-service/internal/adapter/postgres/... -run TestStarNagStateRepository -count=1 -v
```
