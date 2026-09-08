//go:build integration

// See repository_test.go's file header — same testcontainers-go convention,
// gated behind the "integration" build tag.
package postgres

import (
	"context"
	"testing"

	"github.com/stablyai/orca-go/services/tenant-service/internal/domain"
)

func TestUserProfileRepository_GetClientStateColumn_NotFoundWhenNoRow(t *testing.T) {
	pool := setupPool(t)
	companies := NewCompanyRepository(pool)
	repo := NewUserProfileRepository(pool)
	ctx := context.Background()

	company, _ := domain.NewCompany("11111111-1111-1111-1111-111111111111", "Acme", nil)
	if _, err := companies.Create(ctx, company); err != nil {
		t.Fatalf("create company: %v", err)
	}

	_, found, err := repo.GetClientStateColumn(ctx, company.ID, "22222222-2222-2222-2222-222222222222", "keybindings_json")
	if err != nil {
		t.Fatalf("get client state column: %v", err)
	}
	if found {
		t.Error("expected found=false when no profile row exists at all")
	}
}

func TestUserProfileRepository_GetClientStateColumn_NotFoundWhenColumnNull(t *testing.T) {
	pool := setupPool(t)
	companies := NewCompanyRepository(pool)
	repo := NewUserProfileRepository(pool)
	ctx := context.Background()

	company, _ := domain.NewCompany("11111111-1111-1111-1111-111111111111", "Acme", nil)
	if _, err := companies.Create(ctx, company); err != nil {
		t.Fatalf("create company: %v", err)
	}
	userID := "33333333-3333-3333-3333-333333333333"
	if err := repo.SetOnboardingState(ctx, company.ID, userID, `{}`); err != nil {
		t.Fatalf("set onboarding state (creates the row): %v", err)
	}

	_, found, err := repo.GetClientStateColumn(ctx, company.ID, userID, "ui_local_state_json")
	if err != nil {
		t.Fatalf("get client state column: %v", err)
	}
	if found {
		t.Error("expected found=false when the row exists but the column is NULL")
	}
}

func TestUserProfileRepository_SetClientStateColumn_ThenGet_RoundTrips(t *testing.T) {
	pool := setupPool(t)
	companies := NewCompanyRepository(pool)
	repo := NewUserProfileRepository(pool)
	ctx := context.Background()

	company, _ := domain.NewCompany("11111111-1111-1111-1111-111111111111", "Acme", nil)
	if _, err := companies.Create(ctx, company); err != nil {
		t.Fatalf("create company: %v", err)
	}
	userID := "44444444-4444-4444-4444-444444444444"

	for column, value := range map[string]string{
		"keybindings_json":                `{"save":"cmd+s"}`,
		"ui_local_state_json":             `{"sidebarWidth":240}`,
		"saved_runtime_environments_json": `{"envs":[]}`,
		"client_settings_json":            `{"theme":"dark"}`,
		"accounts_dev_server_json":        `{"acct1":"dev1"}`,
	} {
		if err := repo.SetClientStateColumn(ctx, company.ID, userID, column, value); err != nil {
			t.Fatalf("set %s: %v", column, err)
		}
		got, found, err := repo.GetClientStateColumn(ctx, company.ID, userID, column)
		if err != nil {
			t.Fatalf("get %s: %v", column, err)
		}
		if !found {
			t.Fatalf("expected found=true for %s after saving", column)
		}
		if got != value {
			t.Errorf("column %s: want %q, got %q", column, value, got)
		}
	}
}

func TestUserProfileRepository_ClientStateColumn_UnknownColumnRejected(t *testing.T) {
	pool := setupPool(t)
	repo := NewUserProfileRepository(pool)
	ctx := context.Background()

	if _, _, err := repo.GetClientStateColumn(ctx, "11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222", "settings_json; DROP TABLE tenant.user_profiles;--"); err == nil {
		t.Fatal("expected an error for an unwhitelisted column name, not a query built from it")
	}
	if err := repo.SetClientStateColumn(ctx, "11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222", "not_a_real_column", "{}"); err == nil {
		t.Fatal("expected an error for an unwhitelisted column name on Set too")
	}
}

func TestUserProfileRepository_ClientStateColumn_ScopedByCompanyID(t *testing.T) {
	pool := setupPool(t)
	companies := NewCompanyRepository(pool)
	repo := NewUserProfileRepository(pool)
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
	if err := repo.SetClientStateColumn(ctx, companyA.ID, userID, "keybindings_json", `{"save":"cmd+s"}`); err != nil {
		t.Fatalf("set: %v", err)
	}

	_, found, err := repo.GetClientStateColumn(ctx, companyB.ID, userID, "keybindings_json")
	if err != nil {
		t.Fatalf("get scoped to company B: %v", err)
	}
	if found {
		t.Error("expected a row belonging to a different company to resolve as not-found")
	}
}
