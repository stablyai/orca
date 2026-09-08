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
