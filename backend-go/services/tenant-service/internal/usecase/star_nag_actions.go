package usecase

import (
	"context"
	"time"

	"github.com/stablyai/orca-go/common/apperrors"
	"github.com/stablyai/orca-go/common/tenant"
	"github.com/stablyai/orca-go/services/tenant-service/internal/domain"
)

// DeferStarNag backs both starNag.dismiss ("dismissed" outcome) and
// starNag.later ("later" outcome) — the old TS backend's dismiss() is
// itself defer('dismissed') (service.ts:307-309); telemetry emission for
// the outcome distinction is BUG-014/SOL-014's concern, not this usecase's
// (see SOL-005's own note on MAIN_OWNED_TELEMETRY_EVENTS excluding
// star_nag_outcome from the telemetry.track RPC path).
type DeferStarNag struct {
	repo          StarNagStateRepository
	visibilityPub StarNagVisibilityPublisher
}

func NewDeferStarNag(repo StarNagStateRepository, visibilityPub StarNagVisibilityPublisher) *DeferStarNag {
	return &DeferStarNag{repo: repo, visibilityPub: visibilityPub}
}

func (uc *DeferStarNag) Execute(ctx context.Context, userID string) error {
	companyID, err := tenant.RequireTenantID(ctx)
	if err != nil {
		return apperrors.New(apperrors.KindUnauthenticated, "TENANT_NO_TENANT", "no tenant in request context", err)
	}
	state, err := uc.repo.GetOrCreate(ctx, companyID, userID)
	if err != nil {
		return apperrors.New(apperrors.KindInternal, "TENANT_STAR_NAG_LOAD_FAILED", "failed to load star nag state", err)
	}
	if state.ActivePrompt == nil {
		// Mirrors service.ts:313-316: no active session, nothing to defer.
		return nil
	}
	state.NextThreshold *= 2
	state.BaselineAgents = nil // recomputed on next threshold check — see SOL-005's "Explicitly out of scope" section
	deferredUntil := time.Now().Add(domain.StarNagCooldown)
	state.DeferredUntil = &deferredUntil
	state.ActivePrompt = nil
	if err := uc.repo.Save(ctx, state); err != nil {
		return apperrors.New(apperrors.KindInternal, "TENANT_STAR_NAG_SAVE_FAILED", "failed to save star nag state", err)
	}
	// Best-effort — a missed push is not a lost domain fact (see
	// StarNagVisibilityPublisher's doc comment), same posture
	// PublishProfileInvalidated's own callers already accept.
	if uc.visibilityPub != nil {
		_ = uc.visibilityPub.PublishStarNagVisibilityChanged(ctx, companyID, userID, "hide", "", "")
	}
	return nil
}

// CompleteStarNag backs starNag.complete — permanent suppression
// (service.ts:384-391): starred or opted out for good.
type CompleteStarNag struct {
	repo          StarNagStateRepository
	visibilityPub StarNagVisibilityPublisher
}

func NewCompleteStarNag(repo StarNagStateRepository, visibilityPub StarNagVisibilityPublisher) *CompleteStarNag {
	return &CompleteStarNag{repo: repo, visibilityPub: visibilityPub}
}

func (uc *CompleteStarNag) Execute(ctx context.Context, userID string) error {
	companyID, err := tenant.RequireTenantID(ctx)
	if err != nil {
		return apperrors.New(apperrors.KindUnauthenticated, "TENANT_NO_TENANT", "no tenant in request context", err)
	}
	state, err := uc.repo.GetOrCreate(ctx, companyID, userID)
	if err != nil {
		return apperrors.New(apperrors.KindInternal, "TENANT_STAR_NAG_LOAD_FAILED", "failed to load star nag state", err)
	}
	state.Completed = true
	state.DeferredUntil = nil
	state.ActivePrompt = nil
	if err := uc.repo.Save(ctx, state); err != nil {
		return apperrors.New(apperrors.KindInternal, "TENANT_STAR_NAG_SAVE_FAILED", "failed to save star nag state", err)
	}
	if uc.visibilityPub != nil {
		_ = uc.visibilityPub.PublishStarNagVisibilityChanged(ctx, companyID, userID, "hide", "", "")
	}
	return nil
}

// DisableStarNag backs starNag.disable — same terminal shape as Complete
// (service.ts:384-391 covers both under one branch); kept as its own
// usecase (not an alias) because the two are semantically distinct actions
// even though today's persisted effect is identical, matching the old TS
// backend's own two-methods-one-effect shape.
type DisableStarNag struct {
	repo          StarNagStateRepository
	visibilityPub StarNagVisibilityPublisher
}

func NewDisableStarNag(repo StarNagStateRepository, visibilityPub StarNagVisibilityPublisher) *DisableStarNag {
	return &DisableStarNag{repo: repo, visibilityPub: visibilityPub}
}

func (uc *DisableStarNag) Execute(ctx context.Context, userID string) error {
	companyID, err := tenant.RequireTenantID(ctx)
	if err != nil {
		return apperrors.New(apperrors.KindUnauthenticated, "TENANT_NO_TENANT", "no tenant in request context", err)
	}
	state, err := uc.repo.GetOrCreate(ctx, companyID, userID)
	if err != nil {
		return apperrors.New(apperrors.KindInternal, "TENANT_STAR_NAG_LOAD_FAILED", "failed to load star nag state", err)
	}
	state.Completed = true
	state.DeferredUntil = nil
	state.ActivePrompt = nil
	if err := uc.repo.Save(ctx, state); err != nil {
		return apperrors.New(apperrors.KindInternal, "TENANT_STAR_NAG_SAVE_FAILED", "failed to save star nag state", err)
	}
	if uc.visibilityPub != nil {
		_ = uc.visibilityPub.PublishStarNagVisibilityChanged(ctx, companyID, userID, "hide", "", "")
	}
	return nil
}

// ForceShowStarNag backs starNag.forceShow — unconditional show, no
// GitHub check, no gating beyond "not already visible" (service.ts:397-407).
type ForceShowStarNag struct {
	repo          StarNagStateRepository
	visibilityPub StarNagVisibilityPublisher
}

func NewForceShowStarNag(repo StarNagStateRepository, visibilityPub StarNagVisibilityPublisher) *ForceShowStarNag {
	return &ForceShowStarNag{repo: repo, visibilityPub: visibilityPub}
}

func (uc *ForceShowStarNag) Execute(ctx context.Context, userID string) error {
	companyID, err := tenant.RequireTenantID(ctx)
	if err != nil {
		return apperrors.New(apperrors.KindUnauthenticated, "TENANT_NO_TENANT", "no tenant in request context", err)
	}
	state, err := uc.repo.GetOrCreate(ctx, companyID, userID)
	if err != nil {
		return apperrors.New(apperrors.KindInternal, "TENANT_STAR_NAG_LOAD_FAILED", "failed to load star nag state", err)
	}
	if state.ActivePrompt != nil {
		return nil // already visible — no-op, per service.ts:397-407
	}
	state.ActivePrompt = &domain.ActiveStarNagPrompt{Source: "force_show", Mode: "gh", Surface: "card", ShownAt: time.Now()}
	if err := uc.repo.Save(ctx, state); err != nil {
		return apperrors.New(apperrors.KindInternal, "TENANT_STAR_NAG_SAVE_FAILED", "failed to save star nag state", err)
	}
	if uc.visibilityPub != nil {
		_ = uc.visibilityPub.PublishStarNagVisibilityChanged(ctx, companyID, userID, "show", "gh", "card")
	}
	return nil
}

// NotifyStarNagOnboardingCompleted backs starNag.onboardingCompleted — the
// old TS backend's onboardingCompleted() (service.ts:275). Records the
// event by refreshing app_version so a later threshold/value-moment check
// can tell onboarding has happened; it does NOT itself show a prompt
// (showing on onboarding completion, if desired, is the frontend's own
// agent-value-moment flow calling starNag.agentValueMoment separately —
// see PrepareStarNagAgentValueMoment below).
type NotifyStarNagOnboardingCompleted struct {
	repo StarNagStateRepository
}

func NewNotifyStarNagOnboardingCompleted(repo StarNagStateRepository) *NotifyStarNagOnboardingCompleted {
	return &NotifyStarNagOnboardingCompleted{repo: repo}
}

func (uc *NotifyStarNagOnboardingCompleted) Execute(ctx context.Context, userID string) error {
	companyID, err := tenant.RequireTenantID(ctx)
	if err != nil {
		return apperrors.New(apperrors.KindUnauthenticated, "TENANT_NO_TENANT", "no tenant in request context", err)
	}
	// GetOrCreate alone is enough to record "this user's row now exists" —
	// there is no dedicated onboarding-completed column on StarNagState
	// (see domain.StarNagState); this is intentionally a cheap no-op today,
	// flagged (not hidden) as a real design gap: BUG-005's own "Explicitly
	// out of scope" section notes the threshold auto-trigger has no
	// backend-go event source at all, and onboarding-completion firing a
	// prompt automatically would need that same missing event plumbing.
	if _, err := uc.repo.GetOrCreate(ctx, companyID, userID); err != nil {
		return apperrors.New(apperrors.KindInternal, "TENANT_STAR_NAG_LOAD_FAILED", "failed to load star nag state", err)
	}
	return nil
}

// OpenWebStarNag backs starNag.openWeb — opening GitHub is only a handoff,
// not verified star success (service.ts:342-354): sets a cooldown WITHOUT
// setting Completed, unlike Complete/Disable.
type OpenWebStarNag struct {
	repo          StarNagStateRepository
	visibilityPub StarNagVisibilityPublisher
}

func NewOpenWebStarNag(repo StarNagStateRepository, visibilityPub StarNagVisibilityPublisher) *OpenWebStarNag {
	return &OpenWebStarNag{repo: repo, visibilityPub: visibilityPub}
}

func (uc *OpenWebStarNag) Execute(ctx context.Context, userID string) error {
	companyID, err := tenant.RequireTenantID(ctx)
	if err != nil {
		return apperrors.New(apperrors.KindUnauthenticated, "TENANT_NO_TENANT", "no tenant in request context", err)
	}
	state, err := uc.repo.GetOrCreate(ctx, companyID, userID)
	if err != nil {
		return apperrors.New(apperrors.KindInternal, "TENANT_STAR_NAG_LOAD_FAILED", "failed to load star nag state", err)
	}
	deferredUntil := time.Now().Add(domain.StarNagCooldown)
	state.DeferredUntil = &deferredUntil
	state.ActivePrompt = nil
	if err := uc.repo.Save(ctx, state); err != nil {
		return apperrors.New(apperrors.KindInternal, "TENANT_STAR_NAG_SAVE_FAILED", "failed to save star nag state", err)
	}
	if uc.visibilityPub != nil {
		_ = uc.visibilityPub.PublishStarNagVisibilityChanged(ctx, companyID, userID, "hide", "", "")
	}
	return nil
}

// StarOrcaFromNag backs starNag.starOrca. See ScmStarCheckPort's doc
// comment: ok=false (today, always, via StubAdapter) degrades to
// starred=false — matches the frontend's existing "web fallback" UI path,
// no error surfaced.
type StarOrcaFromNag struct {
	repo          StarNagStateRepository
	starCheck     ScmStarCheckPort
	visibilityPub StarNagVisibilityPublisher
}

func NewStarOrcaFromNag(repo StarNagStateRepository, starCheck ScmStarCheckPort, visibilityPub StarNagVisibilityPublisher) *StarOrcaFromNag {
	return &StarOrcaFromNag{repo: repo, starCheck: starCheck, visibilityPub: visibilityPub}
}

func (uc *StarOrcaFromNag) Execute(ctx context.Context, userID string) (bool, error) {
	starred, ok := uc.starCheck.StarRepository(ctx, userID)
	if !ok {
		return false, nil
	}
	if starred {
		companyID, err := tenant.RequireTenantID(ctx)
		if err != nil {
			return false, apperrors.New(apperrors.KindUnauthenticated, "TENANT_NO_TENANT", "no tenant in request context", err)
		}
		state, err := uc.repo.GetOrCreate(ctx, companyID, userID)
		if err != nil {
			return false, apperrors.New(apperrors.KindInternal, "TENANT_STAR_NAG_LOAD_FAILED", "failed to load star nag state", err)
		}
		state.Completed = true
		state.DeferredUntil = nil
		state.ActivePrompt = nil
		if err := uc.repo.Save(ctx, state); err != nil {
			return false, apperrors.New(apperrors.KindInternal, "TENANT_STAR_NAG_SAVE_FAILED", "failed to save star nag state", err)
		}
		// Only published in this (state-changing) branch — the ok=false
		// degrade above never touched any state, so nothing to announce.
		if uc.visibilityPub != nil {
			_ = uc.visibilityPub.PublishStarNagVisibilityChanged(ctx, companyID, userID, "hide", "", "")
		}
	}
	return starred, nil
}

// PrepareStarNagAgentValueMoment backs starNag.agentValueMoment. With
// ok=false (today's stub), takes the exact branch the old TS backend takes
// for starred===null: {status:"ready", mode:"web"} (agent-value-moment.ts:48-50).
// Skips (status:"skipped") when already Completed or a cooldown is active
// or a prompt is already visible, or this app version already had a value
// moment attempt.
type PrepareStarNagAgentValueMoment struct {
	repo      StarNagStateRepository
	starCheck ScmStarCheckPort
}

func NewPrepareStarNagAgentValueMoment(repo StarNagStateRepository, starCheck ScmStarCheckPort) *PrepareStarNagAgentValueMoment {
	return &PrepareStarNagAgentValueMoment{repo: repo, starCheck: starCheck}
}

type StarNagAgentValueMomentPreparation struct {
	Status string // "ready" | "skipped"
	Mode   string // "gh" | "web", only when Status == "ready"
}

func (uc *PrepareStarNagAgentValueMoment) Execute(ctx context.Context, userID, appVersion string) (StarNagAgentValueMomentPreparation, error) {
	companyID, err := tenant.RequireTenantID(ctx)
	if err != nil {
		return StarNagAgentValueMomentPreparation{}, apperrors.New(apperrors.KindUnauthenticated, "TENANT_NO_TENANT", "no tenant in request context", err)
	}
	state, err := uc.repo.GetOrCreate(ctx, companyID, userID)
	if err != nil {
		return StarNagAgentValueMomentPreparation{}, apperrors.New(apperrors.KindInternal, "TENANT_STAR_NAG_LOAD_FAILED", "failed to load star nag state", err)
	}
	if state.Completed || state.ActivePrompt != nil ||
		(state.DeferredUntil != nil && state.DeferredUntil.After(time.Now())) ||
		(state.AgentValueMomentAppVersion != nil && *state.AgentValueMomentAppVersion == appVersion) {
		return StarNagAgentValueMomentPreparation{Status: "skipped"}, nil
	}
	mode := "web"
	if starred, ok := uc.starCheck.CheckStarred(ctx, userID); ok && !starred {
		mode = "gh"
	}
	state.AgentValueMomentAppVersion = &appVersion
	if err := uc.repo.Save(ctx, state); err != nil {
		return StarNagAgentValueMomentPreparation{}, apperrors.New(apperrors.KindInternal, "TENANT_STAR_NAG_SAVE_FAILED", "failed to save star nag state", err)
	}
	return StarNagAgentValueMomentPreparation{Status: "ready", Mode: mode}, nil
}

// ShowPreparedStarNagAgentValueMoment backs starNag.showAgentValueMoment —
// marks the prepared moment as now actively displayed.
type ShowPreparedStarNagAgentValueMoment struct {
	repo          StarNagStateRepository
	visibilityPub StarNagVisibilityPublisher
}

func NewShowPreparedStarNagAgentValueMoment(repo StarNagStateRepository, visibilityPub StarNagVisibilityPublisher) *ShowPreparedStarNagAgentValueMoment {
	return &ShowPreparedStarNagAgentValueMoment{repo: repo, visibilityPub: visibilityPub}
}

func (uc *ShowPreparedStarNagAgentValueMoment) Execute(ctx context.Context, userID string) error {
	companyID, err := tenant.RequireTenantID(ctx)
	if err != nil {
		return apperrors.New(apperrors.KindUnauthenticated, "TENANT_NO_TENANT", "no tenant in request context", err)
	}
	state, err := uc.repo.GetOrCreate(ctx, companyID, userID)
	if err != nil {
		return apperrors.New(apperrors.KindInternal, "TENANT_STAR_NAG_LOAD_FAILED", "failed to load star nag state", err)
	}
	state.ActivePrompt = &domain.ActiveStarNagPrompt{Source: "agent_value_moment", Mode: "web", Surface: "toast", ShownAt: time.Now()}
	if err := uc.repo.Save(ctx, state); err != nil {
		return apperrors.New(apperrors.KindInternal, "TENANT_STAR_NAG_SAVE_FAILED", "failed to save star nag state", err)
	}
	if uc.visibilityPub != nil {
		_ = uc.visibilityPub.PublishStarNagVisibilityChanged(ctx, companyID, userID, "show", "web", "toast")
	}
	return nil
}
