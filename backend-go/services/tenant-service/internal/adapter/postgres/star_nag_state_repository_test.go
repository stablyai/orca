//go:build integration

// See repository_test.go's file header — same testcontainers-go convention,
// gated behind the "integration" build tag.
package postgres

import (
	"context"
	"testing"
	"time"

	"github.com/stablyai/orca-go/services/tenant-service/internal/domain"
)

func TestStarNagStateRepository_GetOrCreate_LazilyInsertsDefault(t *testing.T) {
	pool := setupPool(t)
	companies := NewCompanyRepository(pool)
	repo := NewStarNagStateRepository(pool)
	ctx := context.Background()

	company, _ := domain.NewCompany("11111111-1111-1111-1111-111111111111", "Acme", nil)
	if _, err := companies.Create(ctx, company); err != nil {
		t.Fatalf("create company: %v", err)
	}

	userID := "22222222-2222-2222-2222-222222222222"
	state, err := repo.GetOrCreate(ctx, company.ID, userID)
	if err != nil {
		t.Fatalf("get or create: %v", err)
	}
	if state.NextThreshold != domain.StarNagInitialThreshold {
		t.Errorf("expected NextThreshold=%d, got %d", domain.StarNagInitialThreshold, state.NextThreshold)
	}
	if state.Completed {
		t.Error("expected Completed=false for a brand-new row")
	}
	if state.BaselineAgents != nil || state.AppVersion != nil || state.DeferredUntil != nil ||
		state.AgentValueMomentAppVersion != nil || state.ActivePrompt != nil {
		t.Errorf("expected every optional field zero-valued for a brand-new row, got %+v", state)
	}
}

func TestStarNagStateRepository_GetOrCreate_ReturnsExistingUnchanged(t *testing.T) {
	pool := setupPool(t)
	companies := NewCompanyRepository(pool)
	repo := NewStarNagStateRepository(pool)
	ctx := context.Background()

	company, _ := domain.NewCompany("11111111-1111-1111-1111-111111111111", "Acme", nil)
	if _, err := companies.Create(ctx, company); err != nil {
		t.Fatalf("create company: %v", err)
	}

	userID := "33333333-3333-3333-3333-333333333333"
	first, err := repo.GetOrCreate(ctx, company.ID, userID)
	if err != nil {
		t.Fatalf("first get or create: %v", err)
	}
	first.Completed = true
	first.NextThreshold = 70
	if err := repo.Save(ctx, first); err != nil {
		t.Fatalf("save: %v", err)
	}

	second, err := repo.GetOrCreate(ctx, company.ID, userID)
	if err != nil {
		t.Fatalf("second get or create: %v", err)
	}
	if !second.Completed || second.NextThreshold != 70 {
		t.Errorf("expected the persisted values to be returned unchanged, got %+v", second)
	}
}

func TestStarNagStateRepository_Save_RoundTripsActivePrompt(t *testing.T) {
	pool := setupPool(t)
	companies := NewCompanyRepository(pool)
	repo := NewStarNagStateRepository(pool)
	ctx := context.Background()

	company, _ := domain.NewCompany("11111111-1111-1111-1111-111111111111", "Acme", nil)
	if _, err := companies.Create(ctx, company); err != nil {
		t.Fatalf("create company: %v", err)
	}

	userID := "44444444-4444-4444-4444-444444444444"
	state, err := repo.GetOrCreate(ctx, company.ID, userID)
	if err != nil {
		t.Fatalf("get or create: %v", err)
	}

	baseline := int64(12)
	appVersion := "1.2.3"
	deferredUntil := time.Now().Add(domain.StarNagCooldown).UTC().Truncate(time.Second)
	state.BaselineAgents = &baseline
	state.AppVersion = &appVersion
	state.DeferredUntil = &deferredUntil
	state.ActivePrompt = &domain.ActiveStarNagPrompt{
		Source:            "force_show",
		Mode:              "gh",
		Surface:           "card",
		OpenedRepoTracked: true,
		ShownAt:           time.Now().UTC().Truncate(time.Second),
	}
	if err := repo.Save(ctx, state); err != nil {
		t.Fatalf("save: %v", err)
	}

	got, err := repo.GetOrCreate(ctx, company.ID, userID)
	if err != nil {
		t.Fatalf("re-fetch: %v", err)
	}
	if got.ActivePrompt == nil {
		t.Fatal("expected ActivePrompt to round-trip non-nil")
	}
	if got.ActivePrompt.Source != "force_show" || got.ActivePrompt.Mode != "gh" ||
		got.ActivePrompt.Surface != "card" || !got.ActivePrompt.OpenedRepoTracked {
		t.Errorf("unexpected ActivePrompt round-trip: %+v", got.ActivePrompt)
	}
	if got.BaselineAgents == nil || *got.BaselineAgents != baseline {
		t.Errorf("expected BaselineAgents=%d to round-trip, got %+v", baseline, got.BaselineAgents)
	}

	// Clearing ActivePrompt back to nil must persist as SQL NULL, not a
	// stale JSON value.
	got.ActivePrompt = nil
	if err := repo.Save(ctx, got); err != nil {
		t.Fatalf("save clearing active prompt: %v", err)
	}
	cleared, err := repo.GetOrCreate(ctx, company.ID, userID)
	if err != nil {
		t.Fatalf("re-fetch after clearing: %v", err)
	}
	if cleared.ActivePrompt != nil {
		t.Errorf("expected ActivePrompt to be cleared to nil, got %+v", cleared.ActivePrompt)
	}
}

func TestStarNagStateRepository_ScopedByCompanyID(t *testing.T) {
	pool := setupPool(t)
	companies := NewCompanyRepository(pool)
	repo := NewStarNagStateRepository(pool)
	ctx := context.Background()

	companyA, _ := domain.NewCompany("11111111-1111-1111-1111-111111111111", "Company A", nil)
	companyB, _ := domain.NewCompany("55555555-5555-5555-5555-555555555555", "Company B", nil)
	if _, err := companies.Create(ctx, companyA); err != nil {
		t.Fatalf("create company A: %v", err)
	}
	if _, err := companies.Create(ctx, companyB); err != nil {
		t.Fatalf("create company B: %v", err)
	}

	userID := "66666666-6666-6666-6666-666666666666"
	if _, err := repo.GetOrCreate(ctx, companyA.ID, userID); err != nil {
		t.Fatalf("get or create under company A: %v", err)
	}

	_, found, err := repo.get(ctx, companyB.ID, userID)
	if err != nil {
		t.Fatalf("get scoped to company B: %v", err)
	}
	if found {
		t.Error("expected a row belonging to a different company to resolve as not-found")
	}
}
