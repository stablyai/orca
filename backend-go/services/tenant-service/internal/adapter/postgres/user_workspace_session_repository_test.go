//go:build integration

// See repository_test.go's file header — same testcontainers-go convention,
// gated behind the "integration" build tag.
package postgres

import (
	"context"
	"sync"
	"testing"

	"github.com/stablyai/orca-go/services/tenant-service/internal/domain"
)

func TestUserWorkspaceSessionRepository_GetNotFoundWhenNoRow(t *testing.T) {
	pool := setupPool(t)
	companies := NewCompanyRepository(pool)
	repo := NewUserWorkspaceSessionRepository(pool)
	ctx := context.Background()

	company, _ := domain.NewCompany("11111111-1111-1111-1111-111111111111", "Acme", nil)
	if _, err := companies.Create(ctx, company); err != nil {
		t.Fatalf("create company: %v", err)
	}

	_, found, err := repo.Get(ctx, company.ID, "22222222-2222-2222-2222-222222222222", "local")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if found {
		t.Error("expected found=false when no session row exists")
	}
}

func TestUserWorkspaceSessionRepository_SetThenGet_RoundTrips(t *testing.T) {
	pool := setupPool(t)
	companies := NewCompanyRepository(pool)
	repo := NewUserWorkspaceSessionRepository(pool)
	ctx := context.Background()

	company, _ := domain.NewCompany("11111111-1111-1111-1111-111111111111", "Acme", nil)
	if _, err := companies.Create(ctx, company); err != nil {
		t.Fatalf("create company: %v", err)
	}
	userID := "33333333-3333-3333-3333-333333333333"

	if err := repo.Set(ctx, company.ID, userID, "local", `{"tabs":["a","b"]}`); err != nil {
		t.Fatalf("set: %v", err)
	}
	got, found, err := repo.Get(ctx, company.ID, userID, "local")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if !found {
		t.Fatal("expected found=true after Set")
	}
	if got != `{"tabs":["a","b"]}` {
		t.Errorf("want the saved session round-tripped, got %q", got)
	}
}

// TestUserWorkspaceSessionRepository_ScopedByHostID confirms host_id is a
// real partitioning key: the same user gets independent sessions per host,
// not one shared row (CR-STORAGE-004a's whole reason for a dedicated table
// instead of a user_profiles column — see BE-SOL-STORAGE-001 §3).
func TestUserWorkspaceSessionRepository_ScopedByHostID(t *testing.T) {
	pool := setupPool(t)
	companies := NewCompanyRepository(pool)
	repo := NewUserWorkspaceSessionRepository(pool)
	ctx := context.Background()

	company, _ := domain.NewCompany("11111111-1111-1111-1111-111111111111", "Acme", nil)
	if _, err := companies.Create(ctx, company); err != nil {
		t.Fatalf("create company: %v", err)
	}
	userID := "44444444-4444-4444-4444-444444444444"

	if err := repo.Set(ctx, company.ID, userID, "local", `{"host":"local"}`); err != nil {
		t.Fatalf("set local: %v", err)
	}
	if err := repo.Set(ctx, company.ID, userID, "env-1", `{"host":"env-1"}`); err != nil {
		t.Fatalf("set env-1: %v", err)
	}

	local, found, err := repo.Get(ctx, company.ID, userID, "local")
	if err != nil || !found {
		t.Fatalf("get local: found=%v err=%v", found, err)
	}
	if local != `{"host":"local"}` {
		t.Errorf("local session leaked env-1's data: %q", local)
	}

	env1, found, err := repo.Get(ctx, company.ID, userID, "env-1")
	if err != nil || !found {
		t.Fatalf("get env-1: found=%v err=%v", found, err)
	}
	if env1 != `{"host":"env-1"}` {
		t.Errorf("env-1 session leaked local's data: %q", env1)
	}
}

func TestUserWorkspaceSessionRepository_ScopedByCompanyID(t *testing.T) {
	pool := setupPool(t)
	companies := NewCompanyRepository(pool)
	repo := NewUserWorkspaceSessionRepository(pool)
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
	if err := repo.Set(ctx, companyA.ID, userID, "local", `{"a":1}`); err != nil {
		t.Fatalf("set under company A: %v", err)
	}

	_, found, err := repo.Get(ctx, companyB.ID, userID, "local")
	if err != nil {
		t.Fatalf("get scoped to company B: %v", err)
	}
	if found {
		t.Error("expected a row belonging to a different company to resolve as not-found")
	}
}

func TestUserWorkspaceSessionRepository_Patch_MergesIntoExisting(t *testing.T) {
	pool := setupPool(t)
	companies := NewCompanyRepository(pool)
	repo := NewUserWorkspaceSessionRepository(pool)
	ctx := context.Background()

	company, _ := domain.NewCompany("11111111-1111-1111-1111-111111111111", "Acme", nil)
	if _, err := companies.Create(ctx, company); err != nil {
		t.Fatalf("create company: %v", err)
	}
	userID := "77777777-7777-7777-7777-777777777777"

	if err := repo.Set(ctx, company.ID, userID, "local", `{"a":1,"b":2}`); err != nil {
		t.Fatalf("set: %v", err)
	}
	if err := repo.Patch(ctx, company.ID, userID, "local", `{"b":3,"c":4}`); err != nil {
		t.Fatalf("patch: %v", err)
	}

	got, found, err := repo.Get(ctx, company.ID, userID, "local")
	if err != nil || !found {
		t.Fatalf("get: found=%v err=%v", found, err)
	}
	// "a" must survive (untouched by the patch), "b" must be overwritten,
	// "c" must be added — a real shallow merge, not a blind overwrite.
	want := `{"a":1,"b":3,"c":4}`
	if got != want {
		t.Errorf("want merged session %s, got %s", want, got)
	}
}

func TestUserWorkspaceSessionRepository_Patch_CreatesRowWhenNoneExists(t *testing.T) {
	pool := setupPool(t)
	companies := NewCompanyRepository(pool)
	repo := NewUserWorkspaceSessionRepository(pool)
	ctx := context.Background()

	company, _ := domain.NewCompany("11111111-1111-1111-1111-111111111111", "Acme", nil)
	if _, err := companies.Create(ctx, company); err != nil {
		t.Fatalf("create company: %v", err)
	}
	userID := "88888888-8888-8888-8888-888888888888"

	if err := repo.Patch(ctx, company.ID, userID, "local", `{"first":true}`); err != nil {
		t.Fatalf("patch: %v", err)
	}
	got, found, err := repo.Get(ctx, company.ID, userID, "local")
	if err != nil || !found {
		t.Fatalf("get: found=%v err=%v", found, err)
	}
	if got != `{"first":true}` {
		t.Errorf("want %s, got %s", `{"first":true}`, got)
	}
}

// TestUserWorkspaceSessionRepository_Patch_ConcurrentPatchesDoNotLoseFields
// is the real-Postgres regression guard BE-SOL-STORAGE-001 §7 calls for:
// two goroutines patch DIFFERENT fields of the same session at
// (approximately) the same time — Patch's SELECT ... FOR UPDATE must
// serialize them so both fields survive, instead of one write clobbering
// the other's addition.
func TestUserWorkspaceSessionRepository_Patch_ConcurrentPatchesDoNotLoseFields(t *testing.T) {
	pool := setupPool(t)
	companies := NewCompanyRepository(pool)
	repo := NewUserWorkspaceSessionRepository(pool)
	ctx := context.Background()

	company, _ := domain.NewCompany("11111111-1111-1111-1111-111111111111", "Acme", nil)
	if _, err := companies.Create(ctx, company); err != nil {
		t.Fatalf("create company: %v", err)
	}
	userID := "99999999-9999-9999-9999-999999999999"
	if err := repo.Set(ctx, company.ID, userID, "local", `{}`); err != nil {
		t.Fatalf("seed initial row: %v", err)
	}

	var wg sync.WaitGroup
	errs := make(chan error, 2)
	wg.Add(2)
	go func() {
		defer wg.Done()
		if err := repo.Patch(ctx, company.ID, userID, "local", `{"fieldA":1}`); err != nil {
			errs <- err
		}
	}()
	go func() {
		defer wg.Done()
		if err := repo.Patch(ctx, company.ID, userID, "local", `{"fieldB":2}`); err != nil {
			errs <- err
		}
	}()
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatalf("concurrent patch failed: %v", err)
	}

	got, found, err := repo.Get(ctx, company.ID, userID, "local")
	if err != nil || !found {
		t.Fatalf("get: found=%v err=%v", found, err)
	}
	if got != `{"fieldA":1,"fieldB":2}` && got != `{"fieldB":2,"fieldA":1}` {
		t.Errorf("expected both concurrent patches' fields to survive, got %s", got)
	}
}
