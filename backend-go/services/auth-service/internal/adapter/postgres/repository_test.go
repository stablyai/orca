//go:build integration

// Integration tests run against a real Postgres via testcontainers-go, per
// specs/backend-go/standards/testing-strategy.md — gated behind the
// "integration" build tag so `go test ./...` (unit tests only) stays fast
// and Docker-free; run these explicitly with
// `go test -tags=integration ./internal/adapter/postgres/...`.
package postgres

import (
	"context"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/stablyai/orca-go/common/testutil"
	"github.com/stablyai/orca-go/services/auth-service/internal/domain"
)

func setupRepository(t *testing.T) *Repository {
	t.Helper()
	dsn := testutil.StartPostgres(t, "auth")

	migrationsPath, err := filepath.Abs("../../../migrations")
	if err != nil {
		t.Fatalf("resolving migrations path: %v", err)
	}
	// Uses the golang-migrate CLI directly rather than importing the
	// library, matching usage-service's reference integration test.
	cmd := exec.Command("migrate", "-path", migrationsPath, "-database", dsn, "up")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("running migrations: %v\n%s", err, out)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatalf("connecting to postgres: %v", err)
	}
	t.Cleanup(pool.Close)

	return New(pool)
}

func TestRepository_CreateUser_RejectsDuplicateEmailInTenant(t *testing.T) {
	repo := setupRepository(t)
	ctx := context.Background()

	tenantID := uuid.NewString()
	u1, err := domain.NewUser(uuid.NewString(), tenantID, "dup@example.com", "First", domain.RoleUser, true, time.Now())
	if err != nil {
		t.Fatalf("building user: %v", err)
	}
	if _, err := repo.CreateUser(ctx, u1, "hash1"); err != nil {
		t.Fatalf("first create: %v", err)
	}

	u2, err := domain.NewUser(uuid.NewString(), tenantID, "dup@example.com", "Second", domain.RoleUser, true, time.Now())
	if err != nil {
		t.Fatalf("building user: %v", err)
	}
	if _, err := repo.CreateUser(ctx, u2, "hash2"); err == nil {
		t.Fatal("expected an error for a duplicate (tenant_id, email)")
	}
}

func TestRepository_SessionLifecycle(t *testing.T) {
	repo := setupRepository(t)
	ctx := context.Background()

	tenantID := uuid.NewString()
	user, err := domain.NewUser(uuid.NewString(), tenantID, "session-user@example.com", "User", domain.RoleUser, true, time.Now())
	if err != nil {
		t.Fatalf("building user: %v", err)
	}
	if _, err := repo.CreateUser(ctx, user, "hash1"); err != nil {
		t.Fatalf("create user: %v", err)
	}

	now := time.Now().UTC().Truncate(time.Second)
	session, err := domain.NewSession(domain.HashSessionToken("raw-token"), user.ID, tenantID, now, now.Add(time.Hour))
	if err != nil {
		t.Fatalf("building session: %v", err)
	}
	if err := repo.CreateSession(ctx, session); err != nil {
		t.Fatalf("create session: %v", err)
	}

	got, err := repo.GetSessionByTokenHash(ctx, session.TokenHash)
	if err != nil {
		t.Fatalf("get session: %v", err)
	}
	if got.UserID != user.ID || got.RevokedAt != nil {
		t.Errorf("unexpected session: %+v", got)
	}

	if err := repo.RevokeSession(ctx, session.TokenHash, now.Add(time.Minute)); err != nil {
		t.Fatalf("revoke session: %v", err)
	}
	got, err = repo.GetSessionByTokenHash(ctx, session.TokenHash)
	if err != nil {
		t.Fatalf("get session after revoke: %v", err)
	}
	if got.RevokedAt == nil {
		t.Error("expected RevokedAt to be set after revoke")
	}
}

func TestRepository_AuditLog_AppendAndQueryFiltersByTenant(t *testing.T) {
	repo := setupRepository(t)
	ctx := context.Background()

	tenant1 := uuid.NewString()
	tenant2 := uuid.NewString()

	e1, _ := domain.NewAuditEntry(uuid.NewString(), tenant1, uuid.NewString(), "user.login", "target-1", domain.OutcomeAllowed, "", time.Now())
	e2, _ := domain.NewAuditEntry(uuid.NewString(), tenant2, uuid.NewString(), "user.login", "target-2", domain.OutcomeAllowed, "", time.Now())
	if err := repo.Append(ctx, e1); err != nil {
		t.Fatalf("append e1: %v", err)
	}
	if err := repo.Append(ctx, e2); err != nil {
		t.Fatalf("append e2: %v", err)
	}

	entries, _, err := repo.Query(ctx, tenant1, time.Time{}, "", "", "", "", 50)
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	if len(entries) != 1 || entries[0].TenantID != tenant1 {
		t.Errorf("expected only tenant1's entry, got %+v", entries)
	}
}
