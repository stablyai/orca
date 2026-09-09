package usecase

import (
	"cmp"
	"context"
	"fmt"
	"log/slog"
	"strings"

	"github.com/google/uuid"

	"github.com/stablyai/orca-go/services/auth-service/internal/domain"
)

// Bootstrap creates the first admin user in a completely fresh deployment
// — the gap found live on 2026-08-17 (docs/execution-plan.md §0): a fresh
// Postgres has zero users, CreateUser requires an existing admin caller
// (requireAdminActor), and there was no way to break that cycle. Mirrors
// the old TS backend's own first-boot admin bootstrap
// (ORCA_ADMIN_EMAIL/ORCA_ADMIN_PASSWORD, auto-generated + logged if unset)
// — same operator-facing behavior, reimplemented for backend-go's
// tenant-scoped user model.
//
// Runs ONCE, at service startup (cmd/server/main.go), never via an RPC —
// this is intentionally not reachable from any client, to avoid it being a
// standing "create an admin with no auth" attack surface after first boot.
//
// Provisions a tenant-service company as the first step of a synchronous
// saga before creating the User row — see
// specs/backend-go/bugs/missing-v2/BUG-002: the original design stamped an
// operator-supplied BOOTSTRAP_TENANT_ID onto the admin user with no
// corresponding tenant-service row, so every profile.* call 500'd for that
// user. tenant-service.CreateCompany is documented as "the operation that
// creates" a tenant (tenant-service/internal/usecase/create_company.go) —
// it originates the tenant_id itself, so this bootstrap must ask for one
// rather than inventing its own.
type Bootstrap struct {
	users   UserRepository
	audit   AuditRepository
	hasher  PasswordHasher
	clock   Clock
	tenants TenantProvisioner
}

// TenantProvisioner is the one tenant-service call bootstrap needs to
// originate a tenant for the admin it's about to create. Implemented by
// internal/adapter/grpcclient.TenantProvisioner.
type TenantProvisioner interface {
	CreateCompany(ctx context.Context, name string) (tenantID string, err error)
}

func NewBootstrap(users UserRepository, audit AuditRepository, hasher PasswordHasher, clock Clock, tenants TenantProvisioner) *Bootstrap {
	return &Bootstrap{users: users, audit: audit, hasher: hasher, clock: clock, tenants: tenants}
}

// BootstrapConfig carries the operator-supplied (or auto-generated) admin
// credentials — see cmd/server/main.go for where these come from
// (BOOTSTRAP_COMPANY_NAME/BOOTSTRAP_ADMIN_EMAIL/BOOTSTRAP_ADMIN_PASSWORD).
// No TenantID field — tenant-service originates it (see Bootstrap's doc
// comment).
type BootstrapConfig struct {
	CompanyName string // optional; empty => derive from Email's domain
	Email       string
	Password    string // empty => auto-generate and log it
}

// EnsureAdmin is a no-op if any user already exists anywhere (not just this
// tenant) — bootstrap is strictly a "first boot of a totally fresh
// deployment" action, never something that re-runs against a live system.
// Returns the plaintext password ONLY when one was auto-generated (so
// main.go can log it once, the same "printed to stdout on first boot, never
// stored" contract the old backend used) — empty string when the operator
// supplied their own via BOOTSTRAP_ADMIN_PASSWORD.
func (b *Bootstrap) EnsureAdmin(ctx context.Context, cfg BootstrapConfig, logger *slog.Logger) (generatedPassword string, err error) {
	if cfg.Email == "" {
		logger.Info("auth-service: bootstrap skipped (BOOTSTRAP_ADMIN_EMAIL not set)")
		return "", nil
	}

	exists, err := b.users.HasAnyUsers(ctx)
	if err != nil {
		return "", fmt.Errorf("bootstrap: checking for existing users: %w", err)
	}
	if exists {
		logger.Info("auth-service: bootstrap skipped (users already exist)")
		return "", nil
	}

	// Saga step 1: originate the tenant. No User row exists yet, so a
	// failure here needs no compensation — bootstrap simply didn't run,
	// safe to retry on next boot.
	tenantID, err := b.tenants.CreateCompany(ctx, cmp.Or(cfg.CompanyName, defaultCompanyName(cfg.Email)))
	if err != nil {
		return "", fmt.Errorf("bootstrap: provisioning tenant company: %w", err)
	}

	password := cfg.Password
	if password == "" {
		password, err = generateRandomToken(16)
		if err != nil {
			return "", fmt.Errorf("bootstrap: generating admin password: %w", err)
		}
	}

	passwordHash, err := b.hasher.Hash(password)
	if err != nil {
		return "", fmt.Errorf("bootstrap: hashing admin password: %w", err)
	}

	now := b.clock.Now()
	user, err := domain.NewUser(uuid.NewString(), tenantID, cfg.Email, "Admin", domain.RoleAdmin, true, now)
	if err != nil {
		return "", fmt.Errorf("bootstrap: constructing admin user: %w", err)
	}
	created, err := b.users.CreateUser(ctx, user, passwordHash)
	if err != nil {
		// Saga step 2 failed, leaving an orphaned (userless) Company row
		// from step 1. No DeleteCompany RPC exists on tenant-service today
		// — rather than adding a destructive RPC whose only caller would
		// ever be this rare, first-boot-only failure path, log loudly and
		// leave the orphan: an inert company with zero users is not a
		// correctness or security issue, just a small amount of unused
		// state, and bootstrap is safe to retry on the next boot.
		logger.Error("bootstrap: user creation failed after tenant company was provisioned — company left orphaned",
			slog.String("tenant_id", tenantID), slog.Any("err", err))
		return "", fmt.Errorf("bootstrap: creating admin user: %w", err)
	}

	if entry, err := domain.NewAuditEntry(uuid.NewString(), created.TenantID, created.ID, "user.bootstrap_created", created.ID, domain.OutcomeAllowed, "", now); err == nil {
		_ = b.audit.Append(ctx, entry)
	}

	logger.Info("auth-service: bootstrap admin created", slog.String("email", cfg.Email), slog.String("tenant_id", tenantID))

	if cfg.Password == "" {
		return password, nil // caller logs this once; never persisted in plaintext anywhere
	}
	return "", nil
}

// defaultCompanyName derives a placeholder company name from the admin
// email's domain (e.g. "admin@acme.com" -> "acme.com") when the operator
// doesn't set BOOTSTRAP_COMPANY_NAME — renameable later via the real
// profile.updateCompany RPC, matching this bootstrap's existing
// "auto-generate, operator fixes up later if they care" posture for the
// password.
func defaultCompanyName(email string) string {
	if _, domain, ok := strings.Cut(email, "@"); ok && domain != "" {
		return domain
	}
	return "Default Company"
}
