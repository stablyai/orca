// Package usecase holds tenant-service's application services and the
// ports they need — defined here, implemented in internal/adapter/*, per
// the Dependency Inversion convention in
// specs/backend-go/architecture/03-clean-architecture-guidelines.md.
package usecase

import (
	"context"
	"time"

	"github.com/stablyai/orca-go/services/tenant-service/internal/domain"
)

// CompanyRepository persists Company aggregates — tenant-service's own
// database, per specs/backend-go/architecture/05-data-architecture.md.
// tenant.companies has no tenant_id column to filter by: this table IS the
// tenant root (tenant-service.md §5), so its methods take only the
// company's own id.
type CompanyRepository interface {
	Create(ctx context.Context, company domain.Company) (domain.Company, error)
	Get(ctx context.Context, id string) (domain.Company, bool, error)
	// Exists backs ValidateTenant — the logical-FK check every other
	// service calls to confirm a tenant_id it received is real
	// (tenant-service.md §3).
	Exists(ctx context.Context, id string) (bool, error)
	// Update applies patch's non-empty fields only. Returns found=false if
	// no company matches id.
	Update(ctx context.Context, id string, patch domain.CompanySettingsPatch) (domain.Company, bool, error)
	// List returns every company row — genuinely cross-tenant (this table
	// IS the tenant root, see this interface's own doc comment), so callers
	// MUST admin-gate before exposing it. Added because a created company
	// was otherwise unreachable after the creating session ended (nothing
	// else lists tenant.companies) — see wscompat's profile.listCompanies.
	List(ctx context.Context) ([]domain.Company, error)
}

// CompanyEmailDomainRepository persists the email-domain -> company mapping
// (tenant.company_email_domains) — the multi-tenant SSO follow-up to
// CR-LOGIN-001. Every method takes/returns an already-normalized domain
// (domain.NormalizeEmailDomain) — normalization is the usecase layer's job,
// not this port's.
type CompanyEmailDomainRepository interface {
	// Add registers emailDomain as belonging to companyID. Re-adding the
	// same (companyID, emailDomain) pair is a no-op, not an error — the
	// usecase layer is responsible for rejecting an attempt to register a
	// domain already claimed by a DIFFERENT company (see
	// AddCompanyEmailDomain's doc comment); this method itself doesn't
	// enforce that, it just persists.
	Add(ctx context.Context, companyID, emailDomain string) error
	// Remove deletes one domain's mapping. Removing a domain that isn't
	// registered is a no-op, not an error.
	Remove(ctx context.Context, emailDomain string) error
	// ListForCompany returns every domain currently registered to
	// companyID, for the admin-facing "what domains does this company
	// own" view.
	ListForCompany(ctx context.Context, companyID string) ([]string, error)
	// ResolveCompanyID returns found=false (not an error) when no company
	// has registered emailDomain — the "this domain isn't set up for SSO
	// yet" case, which the caller (auth-service, via gRPC) surfaces as a
	// clear error rather than guessing a tenant.
	ResolveCompanyID(ctx context.Context, emailDomain string) (companyID string, found bool, err error)
}

// DepartmentRepository persists Department aggregates, always scoped by
// companyID — see tenant-service.md §9: "never inferred from a nested
// resource ID"; a department_id from another company must resolve as
// not-found, not "wrong company".
type DepartmentRepository interface {
	Create(ctx context.Context, department domain.Department) (domain.Department, error)
	Get(ctx context.Context, companyID, id string) (domain.Department, bool, error)
	// List returns every department scoped to companyID — flat, no
	// hierarchy (tenant-service.md's departments.parent_department_id
	// column is not surfaced by any RPC yet, see domain.Department's doc
	// comment).
	List(ctx context.Context, companyID string) ([]domain.Department, error)
	// Update applies patch's non-empty fields only, scoped by (companyID,
	// id) — a department_id from another company resolves as not-found,
	// same isolation rule as Get. Returns found=false if no match.
	Update(ctx context.Context, companyID, id string, patch domain.DepartmentSettingsPatch) (domain.Department, bool, error)
}

// UserProfileRepository persists the per-user profile-override row
// (tenant.user_profiles) — 1:1 with a user, logical FK to auth-service.
type UserProfileRepository interface {
	// Upsert creates or updates a user's profile row — used by
	// SetUserDepartment and (after this task) UpdateUserProfile.
	Upsert(ctx context.Context, profile domain.UserProfile) error
	Get(ctx context.Context, companyID, userID string) (domain.UserProfile, bool, error)
	// ListUserIDsByDepartment returns every user_id whose profile currently
	// has department_id = departmentID — UpdateDepartment's cache-
	// invalidation scope (tenant-service.md §8's per-mutation invalidation
	// table). Cheap indexed read against idx_user_profiles_department.
	ListUserIDsByDepartment(ctx context.Context, companyID, departmentID string) ([]string, error)
	// ListUserIDsByCompany returns every user_id in companyID —
	// UpdateCompany's (wider) cache-invalidation scope. Cheap indexed read
	// against idx_user_profiles_company.
	ListUserIDsByCompany(ctx context.Context, companyID string) ([]string, error)
	// GetOnboardingState/SetOnboardingState persist the onboarding wizard's
	// per-user progress (frontend/src/shared/types.ts's OnboardingState,
	// stored as an opaque JSON blob — see onboarding_state_json's migration
	// comment). found=false means "no state ever saved" (row missing OR
	// column NULL), the same "wizard not started" default the caller
	// already renders for a brand-new user. A dedicated partial-update
	// method rather than routing through Upsert: Upsert fully replaces
	// department_id/settings_json each call, which would silently clobber
	// them for a caller that only wants to touch onboarding state.
	GetOnboardingState(ctx context.Context, companyID, userID string) (stateJSON string, found bool, err error)
	SetOnboardingState(ctx context.Context, companyID, userID, stateJSON string) error
}

// ClientStateRepository persists the 5 opaque per-user JSON columns added by
// 0006_client_state_and_workspace_sessions.up.sql (CR-STORAGE-001/003/004b)
// — keybindings, UI local state, saved runtime environments, client
// settings, accounts->dev-server map. All 5 share one shape (get/set a
// whole blob, scoped by user_id), so this port is parameterized by column
// name rather than exposing 5 near-identical method pairs — see
// usecase.ClientStateKind for the kind->column mapping that is the only
// thing allowed to choose that name (never a client-supplied string).
// found=false has the same "row missing OR column NULL" meaning as
// UserProfileRepository.GetOnboardingState.
type ClientStateRepository interface {
	GetClientStateColumn(ctx context.Context, companyID, userID, column string) (valueJSON string, found bool, err error)
	SetClientStateColumn(ctx context.Context, companyID, userID, column, valueJSON string) error
}

// WorkspaceSessionRepository persists tenant.user_workspace_sessions
// (CR-STORAGE-004a) — unlike ClientStateRepository's columns, this is a
// dedicated table keyed by (user_id, host_id): a user can have N sessions,
// one per host/environment, not a 1:1 column on user_profiles (see
// BE-SOL-STORAGE-001 §3).
type WorkspaceSessionRepository interface {
	Get(ctx context.Context, companyID, userID, hostID string) (sessionJSON string, found bool, err error)
	// Set fully replaces the session for (userID, hostID).
	Set(ctx context.Context, companyID, userID, hostID, sessionJSON string) error
	// Patch shallow-merges patchJSON's top-level fields into the existing
	// session (creating one if none exists) — implementations must do this
	// under a lock/transaction so two near-simultaneous patches don't drop
	// each other's fields (BE-SOL-STORAGE-001 §4).
	Patch(ctx context.Context, companyID, userID, hostID, patchJSON string) error
}

// TeamRepository persists Team aggregates and TeamMember rows, always
// scoped by companyID.
type TeamRepository interface {
	Create(ctx context.Context, team domain.Team) (domain.Team, error)
	Get(ctx context.Context, companyID, id string) (domain.Team, bool, error)
	// ListByCompany backs ListTeams — every team row scoped to companyID,
	// same not-found-not-wrong-company posture as Get (tenant-service.md §9).
	ListByCompany(ctx context.Context, companyID string) ([]domain.Team, error)
	AddMember(ctx context.Context, member domain.TeamMember) error
	// RemoveMember deletes one (team_id, user_id) row — backs
	// RemoveTeamMember. Returns found=false (not an error) when no such row
	// existed, so the usecase can treat "already removed" as an idempotent
	// no-op, matching DELETE semantics elsewhere in this codebase.
	RemoveMember(ctx context.Context, teamID, userID string) (bool, error)
	ListMembers(ctx context.Context, teamID string) ([]domain.TeamMember, error)
	// ListUserTeamLayers returns, for one user within one company, every
	// team they belong to with that team's Settings and the membership's
	// Priority — exactly the pre-fetched input domain.ResolveProfile's team
	// layer needs (tenant-service.md §4/§6).
	ListUserTeamLayers(ctx context.Context, companyID, userID string) ([]domain.TeamSettingsLayer, error)
}

// StarNagStateRepository persists the per-user "star Orca on GitHub" nag
// preference/state row (tenant.star_nag_state) — 1:1 with a user, same
// logical-FK-to-auth-service shape as UserProfileRepository. See
// domain.StarNagState's doc comment and
// specs/backend-go/bugs/missing-v3/solutions/SOL-005-starnag-channels.md.
//
// NOTE (environment note, not a design decision of this task): this
// interface and StarNagVisibilityPublisher below were found missing from
// this file mid-session — internal/usecase/star_nag_actions.go (owned by a
// different, concurrently-running task) already references them, so they
// are restored here verbatim to keep this package compiling. Not part of
// TASK-BE-STORAGE-001..004's own scope.
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

// StarNagVisibilityPublisher broadcasts a star-nag prompt visibility
// transition (show/hide) so notification-service can relay it to the
// affected user's live starNag.subscribe stream, wherever it's connected —
// see specs/backend-go/bugs/missing-v3/solutions/SOL-005-starnag-channels.md
// §"Design — starNag.subscribe/unsubscribe". A nil
// StarNagVisibilityPublisher (same convention as a nil
// CacheInvalidationPublisher when NATS is unreachable at startup) means the
// mutating usecase still persists the state change correctly; only the live
// push is skipped — a client that reconnects/refetches still sees correct
// state, so this is best-effort UI responsiveness, not a durability
// requirement, same posture PublishProfileInvalidated already has.
type StarNagVisibilityPublisher interface {
	PublishStarNagVisibilityChanged(ctx context.Context, tenantID, userID, event, mode, surface string) error
}

// ScmStarCheckPort answers "has this user starred Orca on GitHub" and
// "star it on their behalf" — usecase-level port per
// architecture/03-clean-architecture-guidelines.md, because
// scm-integration-service has no RPC for either question today (BUG-012).
// ok=false means "unable to determine" (no such RPC yet, or the user has no
// linked GitHub OAuth account) — the same designed degrade-to-unknown
// answer github.checkOrcaStarred already gives (channels_scm.go:56-70), NOT
// an error.
//
// NOTE (environment note, same as StarNagStateRepository above): restored
// verbatim mid-session to keep this package compiling against
// star_nag_actions.go — not part of TASK-BE-STORAGE-001..004's own scope.
type ScmStarCheckPort interface {
	CheckStarred(ctx context.Context, userID string) (starred bool, ok bool)
	StarRepository(ctx context.Context, userID string) (starred bool, ok bool)
}

// ProfileCache is the in-process LRU-with-TTL cache port for
// GetResolvedProfile — a usecase-layer concern per tenant-service.md §6,
// implemented by internal/adapter/cache, deliberately NOT baked into
// internal/adapter/postgres. Every mutating usecase that touches a Settings
// layer (SetUserDepartment, AddTeamMember) calls Invalidate for the exact
// user(s) it affects before returning success (tenant-service.md §8).
type ProfileCache interface {
	Get(ctx context.Context, userID string) (domain.ResolvedProfile, bool)
	Set(ctx context.Context, userID string, profile domain.ResolvedProfile, ttl time.Duration)
	Invalidate(ctx context.Context, userID string)
}

// CacheInvalidationPublisher broadcasts a profile-cache invalidation to
// every tenant-service replica over NATS — closes the horizontal-scaling
// gap ProfileCache's own doc comment used to flag as an accepted, TTL-bound
// staleness window (docs/execution-plan.md Epic F). Every mutating usecase
// that calls ProfileCache.Invalidate locally also calls this, best-effort,
// right after; internal/adapter/eventbus.Consumer is what makes every OTHER
// replica invalidate the same entry. A nil CacheInvalidationPublisher
// (wired in cmd/server/main.go when NATS is unreachable at startup) is
// valid — callers must nil-check before use, same convention as an absent
// optional dependency elsewhere in this codebase; the cache simply falls
// back to today's TTL-bounded staleness.
type CacheInvalidationPublisher interface {
	PublishProfileInvalidated(ctx context.Context, tenantID, userID string) error
}
