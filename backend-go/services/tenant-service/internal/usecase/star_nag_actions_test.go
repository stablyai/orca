package usecase

import (
	"context"
	"testing"
	"time"

	"github.com/stablyai/orca-go/services/tenant-service/internal/domain"
)

const testStarNagCompanyID = "11111111-1111-1111-1111-111111111111"
const testStarNagUserID = "22222222-2222-2222-2222-222222222222"

func TestDeferStarNag_WithActivePrompt(t *testing.T) {
	repo := newFakeStarNagStateRepository()
	ctx := withTenant(context.Background(), testStarNagCompanyID)
	state, err := repo.GetOrCreate(ctx, testStarNagCompanyID, testStarNagUserID)
	if err != nil {
		t.Fatalf("seed get or create: %v", err)
	}
	state.ActivePrompt = &domain.ActiveStarNagPrompt{Source: "threshold", Mode: "gh", Surface: "card"}
	baseline := int64(10)
	state.BaselineAgents = &baseline
	if err := repo.Save(ctx, state); err != nil {
		t.Fatalf("seed save: %v", err)
	}

	uc := NewDeferStarNag(repo, nil)
	if err := uc.Execute(ctx, testStarNagUserID); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	got := repo.byUserID[testStarNagUserID]
	if got.NextThreshold != domain.StarNagInitialThreshold*2 {
		t.Errorf("expected NextThreshold doubled to %d, got %d", domain.StarNagInitialThreshold*2, got.NextThreshold)
	}
	if got.BaselineAgents != nil {
		t.Error("expected BaselineAgents cleared to nil")
	}
	if got.ActivePrompt != nil {
		t.Error("expected ActivePrompt cleared to nil")
	}
	if got.DeferredUntil == nil {
		t.Fatal("expected DeferredUntil to be set")
	}
	wantAround := time.Now().Add(domain.StarNagCooldown)
	if diff := got.DeferredUntil.Sub(wantAround); diff > time.Minute || diff < -time.Minute {
		t.Errorf("expected DeferredUntil ~3 days out, got %v (diff %v)", got.DeferredUntil, diff)
	}
}

func TestDeferStarNag_NoActivePrompt_NoOp(t *testing.T) {
	repo := newFakeStarNagStateRepository()
	ctx := withTenant(context.Background(), testStarNagCompanyID)

	uc := NewDeferStarNag(repo, nil)
	if err := uc.Execute(ctx, testStarNagUserID); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if repo.saveCalls != 0 {
		t.Errorf("expected Save never called when ActivePrompt is nil, got %d calls", repo.saveCalls)
	}
}

func TestCompleteStarNag(t *testing.T) {
	repo := newFakeStarNagStateRepository()
	ctx := withTenant(context.Background(), testStarNagCompanyID)

	uc := NewCompleteStarNag(repo, nil)
	if err := uc.Execute(ctx, testStarNagUserID); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	got := repo.byUserID[testStarNagUserID]
	if !got.Completed || got.DeferredUntil != nil || got.ActivePrompt != nil {
		t.Errorf("unexpected state after CompleteStarNag: %+v", got)
	}
}

func TestDisableStarNag(t *testing.T) {
	repo := newFakeStarNagStateRepository()
	ctx := withTenant(context.Background(), testStarNagCompanyID)

	uc := NewDisableStarNag(repo, nil)
	if err := uc.Execute(ctx, testStarNagUserID); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	got := repo.byUserID[testStarNagUserID]
	if !got.Completed || got.DeferredUntil != nil || got.ActivePrompt != nil {
		t.Errorf("unexpected state after DisableStarNag: %+v", got)
	}
}

func TestForceShowStarNag_AlreadyVisible_NoOp(t *testing.T) {
	repo := newFakeStarNagStateRepository()
	ctx := withTenant(context.Background(), testStarNagCompanyID)
	state, err := repo.GetOrCreate(ctx, testStarNagCompanyID, testStarNagUserID)
	if err != nil {
		t.Fatalf("seed get or create: %v", err)
	}
	state.ActivePrompt = &domain.ActiveStarNagPrompt{Source: "threshold", Mode: "web", Surface: "toast"}
	if err := repo.Save(ctx, state); err != nil {
		t.Fatalf("seed save: %v", err)
	}
	repo.saveCalls = 0

	uc := NewForceShowStarNag(repo, nil)
	if err := uc.Execute(ctx, testStarNagUserID); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if repo.saveCalls != 0 {
		t.Errorf("expected Save never called when already visible, got %d calls", repo.saveCalls)
	}
}

func TestForceShowStarNag_SetsActivePrompt(t *testing.T) {
	repo := newFakeStarNagStateRepository()
	ctx := withTenant(context.Background(), testStarNagCompanyID)

	uc := NewForceShowStarNag(repo, nil)
	if err := uc.Execute(ctx, testStarNagUserID); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	got := repo.byUserID[testStarNagUserID]
	if got.ActivePrompt == nil {
		t.Fatal("expected ActivePrompt to be set")
	}
	if got.ActivePrompt.Source != "force_show" || got.ActivePrompt.Mode != "gh" || got.ActivePrompt.Surface != "card" {
		t.Errorf("unexpected ActivePrompt: %+v", got.ActivePrompt)
	}
}

func TestNotifyStarNagOnboardingCompleted(t *testing.T) {
	repo := newFakeStarNagStateRepository()
	ctx := withTenant(context.Background(), testStarNagCompanyID)

	uc := NewNotifyStarNagOnboardingCompleted(repo)
	if err := uc.Execute(ctx, testStarNagUserID); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if _, ok := repo.byUserID[testStarNagUserID]; !ok {
		t.Error("expected GetOrCreate to have provisioned a row")
	}
}

func TestOpenWebStarNag_SetsDeferredUntilWithoutCompleted(t *testing.T) {
	repo := newFakeStarNagStateRepository()
	ctx := withTenant(context.Background(), testStarNagCompanyID)

	uc := NewOpenWebStarNag(repo, nil)
	if err := uc.Execute(ctx, testStarNagUserID); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	got := repo.byUserID[testStarNagUserID]
	if got.Completed {
		t.Error("expected Completed to remain false")
	}
	if got.DeferredUntil == nil {
		t.Fatal("expected DeferredUntil to be set")
	}
	if got.ActivePrompt != nil {
		t.Error("expected ActivePrompt cleared")
	}
}

func TestStarOrcaFromNag_NotOK_DegradesToFalse(t *testing.T) {
	repo := newFakeStarNagStateRepository()
	starCheck := &fakeScmStarCheckPort{starRepositoryOK: false}
	ctx := withTenant(context.Background(), testStarNagCompanyID)

	uc := NewStarOrcaFromNag(repo, starCheck, nil)
	starred, err := uc.Execute(ctx, testStarNagUserID)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if starred {
		t.Error("expected starred=false when ok=false")
	}
	if _, ok := repo.byUserID[testStarNagUserID]; ok {
		t.Error("expected no state to be touched in the ok=false degrade branch")
	}
}

func TestStarOrcaFromNag_OKAndStarred_CompletesState(t *testing.T) {
	repo := newFakeStarNagStateRepository()
	starCheck := &fakeScmStarCheckPort{starRepositoryOK: true, starRepositoryResult: true}
	ctx := withTenant(context.Background(), testStarNagCompanyID)

	uc := NewStarOrcaFromNag(repo, starCheck, nil)
	starred, err := uc.Execute(ctx, testStarNagUserID)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !starred {
		t.Error("expected starred=true")
	}
	got := repo.byUserID[testStarNagUserID]
	if !got.Completed {
		t.Error("expected Completed=true when starred")
	}
}

func TestStarOrcaFromNag_OKButNotStarred_StateUntouched(t *testing.T) {
	repo := newFakeStarNagStateRepository()
	starCheck := &fakeScmStarCheckPort{starRepositoryOK: true, starRepositoryResult: false}
	ctx := withTenant(context.Background(), testStarNagCompanyID)

	uc := NewStarOrcaFromNag(repo, starCheck, nil)
	starred, err := uc.Execute(ctx, testStarNagUserID)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if starred {
		t.Error("expected starred=false")
	}
	if _, ok := repo.byUserID[testStarNagUserID]; ok {
		t.Error("expected no state to be touched when not starred")
	}
}

func TestPrepareStarNagAgentValueMoment_SkipsWhenCompleted(t *testing.T) {
	repo := newFakeStarNagStateRepository()
	ctx := withTenant(context.Background(), testStarNagCompanyID)
	state, _ := repo.GetOrCreate(ctx, testStarNagCompanyID, testStarNagUserID)
	state.Completed = true
	_ = repo.Save(ctx, state)

	uc := NewPrepareStarNagAgentValueMoment(repo, &fakeScmStarCheckPort{})
	result, err := uc.Execute(ctx, testStarNagUserID, "1.0.0")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Status != "skipped" {
		t.Errorf("expected status=skipped, got %+v", result)
	}
}

func TestPrepareStarNagAgentValueMoment_SkipsWhenCooldownActive(t *testing.T) {
	repo := newFakeStarNagStateRepository()
	ctx := withTenant(context.Background(), testStarNagCompanyID)
	state, _ := repo.GetOrCreate(ctx, testStarNagCompanyID, testStarNagUserID)
	future := time.Now().Add(time.Hour)
	state.DeferredUntil = &future
	_ = repo.Save(ctx, state)

	uc := NewPrepareStarNagAgentValueMoment(repo, &fakeScmStarCheckPort{})
	result, err := uc.Execute(ctx, testStarNagUserID, "1.0.0")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Status != "skipped" {
		t.Errorf("expected status=skipped, got %+v", result)
	}
}

func TestPrepareStarNagAgentValueMoment_SkipsWhenSameAppVersionAlreadyRecorded(t *testing.T) {
	repo := newFakeStarNagStateRepository()
	ctx := withTenant(context.Background(), testStarNagCompanyID)
	state, _ := repo.GetOrCreate(ctx, testStarNagCompanyID, testStarNagUserID)
	v := "1.0.0"
	state.AgentValueMomentAppVersion = &v
	_ = repo.Save(ctx, state)

	uc := NewPrepareStarNagAgentValueMoment(repo, &fakeScmStarCheckPort{})
	result, err := uc.Execute(ctx, testStarNagUserID, "1.0.0")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Status != "skipped" {
		t.Errorf("expected status=skipped, got %+v", result)
	}
}

func TestPrepareStarNagAgentValueMoment_ReadyWithWebModeWhenStarCheckUnknown(t *testing.T) {
	repo := newFakeStarNagStateRepository()
	ctx := withTenant(context.Background(), testStarNagCompanyID)

	uc := NewPrepareStarNagAgentValueMoment(repo, &fakeScmStarCheckPort{checkStarredOK: false})
	result, err := uc.Execute(ctx, testStarNagUserID, "1.0.0")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Status != "ready" || result.Mode != "web" {
		t.Errorf("expected {ready, web} for the shippable-today (stub) path, got %+v", result)
	}
}

func TestShowPreparedStarNagAgentValueMoment_SetsActivePrompt(t *testing.T) {
	repo := newFakeStarNagStateRepository()
	ctx := withTenant(context.Background(), testStarNagCompanyID)

	uc := NewShowPreparedStarNagAgentValueMoment(repo, nil)
	if err := uc.Execute(ctx, testStarNagUserID); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	got := repo.byUserID[testStarNagUserID]
	if got.ActivePrompt == nil {
		t.Fatal("expected ActivePrompt to be set")
	}
	if got.ActivePrompt.Source != "agent_value_moment" || got.ActivePrompt.Mode != "web" || got.ActivePrompt.Surface != "toast" {
		t.Errorf("unexpected ActivePrompt: %+v", got.ActivePrompt)
	}
}

// ── TASK-014: visibility_changed publish wiring ────────────────────────────

func TestDeferStarNag_PublishesHideOnlyWhenStateChanged(t *testing.T) {
	repo := newFakeStarNagStateRepository()
	ctx := withTenant(context.Background(), testStarNagCompanyID)
	state, _ := repo.GetOrCreate(ctx, testStarNagCompanyID, testStarNagUserID)
	state.ActivePrompt = &domain.ActiveStarNagPrompt{Source: "threshold", Mode: "gh", Surface: "card"}
	_ = repo.Save(ctx, state)

	pub := &fakeStarNagVisibilityPublisher{}
	uc := NewDeferStarNag(repo, pub)
	if err := uc.Execute(ctx, testStarNagUserID); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(pub.calls) != 1 || pub.calls[0].Event != "hide" {
		t.Fatalf("expected exactly one hide publish, got %+v", pub.calls)
	}
	if pub.calls[0].TenantID != testStarNagCompanyID || pub.calls[0].UserID != testStarNagUserID {
		t.Errorf("unexpected publish identity: %+v", pub.calls[0])
	}
}

func TestDeferStarNag_NoOp_DoesNotPublish(t *testing.T) {
	repo := newFakeStarNagStateRepository()
	ctx := withTenant(context.Background(), testStarNagCompanyID)
	pub := &fakeStarNagVisibilityPublisher{}
	uc := NewDeferStarNag(repo, pub)
	if err := uc.Execute(ctx, testStarNagUserID); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(pub.calls) != 0 {
		t.Errorf("expected no publish for the no-op path, got %+v", pub.calls)
	}
}

func TestCompleteStarNag_PublishesHide(t *testing.T) {
	repo := newFakeStarNagStateRepository()
	ctx := withTenant(context.Background(), testStarNagCompanyID)
	pub := &fakeStarNagVisibilityPublisher{}
	uc := NewCompleteStarNag(repo, pub)
	if err := uc.Execute(ctx, testStarNagUserID); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(pub.calls) != 1 || pub.calls[0].Event != "hide" {
		t.Fatalf("expected exactly one hide publish, got %+v", pub.calls)
	}
}

func TestDisableStarNag_PublishesHide(t *testing.T) {
	repo := newFakeStarNagStateRepository()
	ctx := withTenant(context.Background(), testStarNagCompanyID)
	pub := &fakeStarNagVisibilityPublisher{}
	uc := NewDisableStarNag(repo, pub)
	if err := uc.Execute(ctx, testStarNagUserID); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(pub.calls) != 1 || pub.calls[0].Event != "hide" {
		t.Fatalf("expected exactly one hide publish, got %+v", pub.calls)
	}
}

func TestOpenWebStarNag_PublishesHide(t *testing.T) {
	repo := newFakeStarNagStateRepository()
	ctx := withTenant(context.Background(), testStarNagCompanyID)
	pub := &fakeStarNagVisibilityPublisher{}
	uc := NewOpenWebStarNag(repo, pub)
	if err := uc.Execute(ctx, testStarNagUserID); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(pub.calls) != 1 || pub.calls[0].Event != "hide" {
		t.Fatalf("expected exactly one hide publish, got %+v", pub.calls)
	}
}

func TestForceShowStarNag_PublishesShowWithGhCard(t *testing.T) {
	repo := newFakeStarNagStateRepository()
	ctx := withTenant(context.Background(), testStarNagCompanyID)
	pub := &fakeStarNagVisibilityPublisher{}
	uc := NewForceShowStarNag(repo, pub)
	if err := uc.Execute(ctx, testStarNagUserID); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(pub.calls) != 1 || pub.calls[0].Event != "show" || pub.calls[0].Mode != "gh" || pub.calls[0].Surface != "card" {
		t.Fatalf("expected one show/gh/card publish, got %+v", pub.calls)
	}
}

func TestForceShowStarNag_AlreadyVisible_DoesNotPublish(t *testing.T) {
	repo := newFakeStarNagStateRepository()
	ctx := withTenant(context.Background(), testStarNagCompanyID)
	state, _ := repo.GetOrCreate(ctx, testStarNagCompanyID, testStarNagUserID)
	state.ActivePrompt = &domain.ActiveStarNagPrompt{Source: "threshold", Mode: "web", Surface: "toast"}
	_ = repo.Save(ctx, state)

	pub := &fakeStarNagVisibilityPublisher{}
	uc := NewForceShowStarNag(repo, pub)
	if err := uc.Execute(ctx, testStarNagUserID); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(pub.calls) != 0 {
		t.Errorf("expected no publish for the already-visible no-op, got %+v", pub.calls)
	}
}

func TestStarOrcaFromNag_PublishesHideOnlyWhenStarred(t *testing.T) {
	repo := newFakeStarNagStateRepository()
	ctx := withTenant(context.Background(), testStarNagCompanyID)
	pub := &fakeStarNagVisibilityPublisher{}
	uc := NewStarOrcaFromNag(repo, &fakeScmStarCheckPort{starRepositoryOK: true, starRepositoryResult: true}, pub)
	if _, err := uc.Execute(ctx, testStarNagUserID); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(pub.calls) != 1 || pub.calls[0].Event != "hide" {
		t.Fatalf("expected exactly one hide publish, got %+v", pub.calls)
	}
}

func TestStarOrcaFromNag_NotStarred_DoesNotPublish(t *testing.T) {
	repo := newFakeStarNagStateRepository()
	ctx := withTenant(context.Background(), testStarNagCompanyID)
	pub := &fakeStarNagVisibilityPublisher{}
	uc := NewStarOrcaFromNag(repo, &fakeScmStarCheckPort{starRepositoryOK: false}, pub)
	if _, err := uc.Execute(ctx, testStarNagUserID); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(pub.calls) != 0 {
		t.Errorf("expected no publish when nothing changed, got %+v", pub.calls)
	}
}

func TestShowPreparedStarNagAgentValueMoment_PublishesShowWithWebToast(t *testing.T) {
	repo := newFakeStarNagStateRepository()
	ctx := withTenant(context.Background(), testStarNagCompanyID)
	pub := &fakeStarNagVisibilityPublisher{}
	uc := NewShowPreparedStarNagAgentValueMoment(repo, pub)
	if err := uc.Execute(ctx, testStarNagUserID); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(pub.calls) != 1 || pub.calls[0].Event != "show" || pub.calls[0].Mode != "web" || pub.calls[0].Surface != "toast" {
		t.Fatalf("expected one show/web/toast publish, got %+v", pub.calls)
	}
}
