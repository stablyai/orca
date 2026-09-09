package usecase

import (
	"context"
	"errors"

	"github.com/google/uuid"

	"github.com/stablyai/orca-go/common/apperrors"
	"github.com/stablyai/orca-go/services/auth-service/internal/domain"
)

// minAdminSetPasswordLength is the floor CreateUser enforces on an
// admin-supplied password — no established minimum exists elsewhere in this
// service (login/registration never enforced one either), so this is a
// conservative, reasonable bar rather than a documented product decision.
const minAdminSetPasswordLength = 8

// CreateUserInput mirrors CreateUserRequest 1:1 — see CreateUser.Execute's
// doc comment for the Password field's contract.
type CreateUserInput struct {
	Email    string
	Name     string
	TenantID string
	Role     domain.Role
	// Password: empty means "auto-generate" — Execute returns the plaintext
	// exactly once via CreateUserOutput.GeneratedPassword. A caller-supplied
	// value (>= minAdminSetPasswordLength) is used as-is, hashed the same
	// way either path.
	Password string
}

// CreateUserOutput carries the created user plus, only when Input.Password
// was empty, the one-time plaintext password the caller must relay to the
// new user out of band (never stored, never logged past this return).
type CreateUserOutput struct {
	User              domain.User
	GeneratedPassword string
}

// CreateUser is an admin-console operation: creates a user with a bcrypt
// password hash (cost >= 12, enforced by adapter/bcrypt).
type CreateUser struct {
	users  UserRepository
	audit  AuditRepository
	hasher PasswordHasher
	clock  Clock
	opa    OPAClient
}

func NewCreateUser(users UserRepository, audit AuditRepository, hasher PasswordHasher, clock Clock, opa OPAClient) *CreateUser {
	return &CreateUser{users: users, audit: audit, hasher: hasher, clock: clock, opa: opa}
}

func (uc *CreateUser) Execute(ctx context.Context, in CreateUserInput) (CreateUserOutput, error) {
	actor, err := requireAdminActor(ctx, uc.users, uc.opa)
	if err != nil {
		return CreateUserOutput{}, err
	}

	if in.Role == "" {
		in.Role = domain.RoleUser
	}

	// Why this branches: there is still no invite/reset-link flow in this
	// scaffold (see README "Known gaps") — an admin either sets the new
	// user's password directly (and relays it out of band themselves) or
	// leaves it blank and gets a one-time generated value back to relay
	// instead. Either way the account is immediately usable, unlike the
	// original always-random-never-returned design this replaced.
	var generatedPassword string
	password := in.Password
	if password == "" {
		generatedPassword, err = generateRandomToken(24)
		if err != nil {
			return CreateUserOutput{}, apperrors.New(apperrors.KindInternal, "AUTH_PASSWORD_GEN_FAILED", "failed to generate initial password", err)
		}
		password = generatedPassword
	} else if len(password) < minAdminSetPasswordLength {
		return CreateUserOutput{}, apperrors.New(apperrors.KindInvalidArgument, "AUTH_WEAK_PASSWORD", "password must be at least 8 characters", nil)
	}

	passwordHash, err := uc.hasher.Hash(password)
	if err != nil {
		return CreateUserOutput{}, apperrors.New(apperrors.KindInternal, "AUTH_PASSWORD_HASH_FAILED", "failed to hash initial password", err)
	}

	now := uc.clock.Now()
	user, err := domain.NewUser(uuid.NewString(), in.TenantID, in.Email, in.Name, in.Role, true, now)
	if err != nil {
		return CreateUserOutput{}, apperrors.New(apperrors.KindInvalidArgument, "AUTH_INVALID_USER", err.Error(), err)
	}

	created, err := uc.users.CreateUser(ctx, user, passwordHash)
	if errors.Is(err, ErrUserAlreadyExists) {
		return CreateUserOutput{}, apperrors.New(apperrors.KindAlreadyExists, "AUTH_USER_EXISTS", "a user with this email already exists in this tenant", err)
	}
	if err != nil {
		return CreateUserOutput{}, apperrors.New(apperrors.KindInternal, "AUTH_USER_CREATE_FAILED", "failed to create user", err)
	}

	if entry, err := domain.NewAuditEntry(uuid.NewString(), created.TenantID, actor.ID, "user.created", created.ID, domain.OutcomeAllowed, "", now); err == nil {
		_ = uc.audit.Append(ctx, entry)
	}

	return CreateUserOutput{User: created, GeneratedPassword: generatedPassword}, nil
}
