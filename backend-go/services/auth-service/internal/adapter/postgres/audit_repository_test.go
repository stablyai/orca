//go:build integration

// Integration tests run against a real Postgres via testcontainers-go — see
// repository_test.go's setupRepository helper, reused here.
package postgres

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/stablyai/orca-go/services/auth-service/internal/domain"
)

// TestRepository_AuditLog_RoundTripsOutcomeAndIPAddress is TASK-BE-015's
// round-trip check: Outcome/IPAddress must survive Append -> Query intact,
// not just the 6 pre-existing fields TestRepository_AuditLog_AppendAndQueryFiltersByTenant
// (repository_test.go) already covers.
func TestRepository_AuditLog_RoundTripsOutcomeAndIPAddress(t *testing.T) {
	repo := setupRepository(t)
	ctx := context.Background()

	tenantID := uuid.NewString()
	e, err := domain.NewAuditEntry(uuid.NewString(), tenantID, uuid.NewString(), "user.login", "target-1", domain.OutcomeDenied, "203.0.113.7", time.Now())
	if err != nil {
		t.Fatalf("building audit entry: %v", err)
	}
	if err := repo.Append(ctx, e); err != nil {
		t.Fatalf("append: %v", err)
	}

	entries, _, err := repo.Query(ctx, tenantID, time.Time{}, "", "", "", "", 50)
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	if len(entries) != 1 {
		t.Fatalf("expected exactly 1 entry, got %d", len(entries))
	}
	got := entries[0]
	if got.Outcome != domain.OutcomeDenied {
		t.Errorf("expected Outcome %q, got %q", domain.OutcomeDenied, got.Outcome)
	}
	if got.IPAddress != "203.0.113.7" {
		t.Errorf("expected IPAddress %q, got %q", "203.0.113.7", got.IPAddress)
	}
}

// TestRepository_AuditLog_QueryFiltersByActorActionOutcome covers filtering
// individually and in combination — an empty filter value means "no filter
// on that dimension" (domain.AuditRepository.Query's doc comment).
func TestRepository_AuditLog_QueryFiltersByActorActionOutcome(t *testing.T) {
	repo := setupRepository(t)
	ctx := context.Background()

	tenantID := uuid.NewString()
	actorA := uuid.NewString()
	actorB := uuid.NewString()
	now := time.Now()

	seed := func(actorID, action string, outcome domain.Outcome) domain.AuditEntry {
		e, err := domain.NewAuditEntry(uuid.NewString(), tenantID, actorID, action, "target", outcome, "", now)
		if err != nil {
			t.Fatalf("building audit entry: %v", err)
		}
		if err := repo.Append(ctx, e); err != nil {
			t.Fatalf("append: %v", err)
		}
		return e
	}

	// 4 entries spanning every combination of {actorA, actorB} x
	// {allowed-ish action "user.login", denied action "project.delete"}.
	e1 := seed(actorA, "user.login", domain.OutcomeAllowed)
	e2 := seed(actorA, "project.delete", domain.OutcomeDenied)
	e3 := seed(actorB, "user.login", domain.OutcomeDenied)
	_ = seed(actorB, "project.delete", domain.OutcomeAllowed)

	assertIDs := func(t *testing.T, got []domain.AuditEntry, want ...string) {
		t.Helper()
		if len(got) != len(want) {
			t.Fatalf("expected %d entries, got %d: %+v", len(want), len(got), got)
		}
		gotIDs := map[string]bool{}
		for _, e := range got {
			gotIDs[e.ID] = true
		}
		for _, id := range want {
			if !gotIDs[id] {
				t.Errorf("expected entry %s in result, got %+v", id, got)
			}
		}
	}

	t.Run("filter by actor_id alone", func(t *testing.T) {
		entries, _, err := repo.Query(ctx, tenantID, time.Time{}, actorA, "", "", "", 50)
		if err != nil {
			t.Fatalf("query: %v", err)
		}
		assertIDs(t, entries, e1.ID, e2.ID)
	})

	t.Run("filter by action alone", func(t *testing.T) {
		entries, _, err := repo.Query(ctx, tenantID, time.Time{}, "", "user.login", "", "", 50)
		if err != nil {
			t.Fatalf("query: %v", err)
		}
		assertIDs(t, entries, e1.ID, e3.ID)
	})

	t.Run("filter by outcome alone", func(t *testing.T) {
		entries, _, err := repo.Query(ctx, tenantID, time.Time{}, "", "", domain.OutcomeDenied, "", 50)
		if err != nil {
			t.Fatalf("query: %v", err)
		}
		assertIDs(t, entries, e2.ID, e3.ID)
	})

	t.Run("filters combined", func(t *testing.T) {
		entries, _, err := repo.Query(ctx, tenantID, time.Time{}, actorA, "project.delete", domain.OutcomeDenied, "", 50)
		if err != nil {
			t.Fatalf("query: %v", err)
		}
		assertIDs(t, entries, e2.ID)
	})

	t.Run("no filters preserves prior no-filter behavior", func(t *testing.T) {
		entries, _, err := repo.Query(ctx, tenantID, time.Time{}, "", "", "", "", 50)
		if err != nil {
			t.Fatalf("query: %v", err)
		}
		if len(entries) != 4 {
			t.Fatalf("expected all 4 entries with no filters, got %d", len(entries))
		}
	})
}
