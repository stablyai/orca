package postgres

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/stablyai/orca-go/services/tenant-service/internal/domain"
)

// UserProfileRepository implements usecase.UserProfileRepository against
// tenant.user_profiles — 1:1 with a user, logical FK to auth-service.
type UserProfileRepository struct {
	pool *pgxpool.Pool
}

func NewUserProfileRepository(pool *pgxpool.Pool) *UserProfileRepository {
	return &UserProfileRepository{pool: pool}
}

// Upsert creates or updates a user's profile row, keyed on user_id.
func (r *UserProfileRepository) Upsert(ctx context.Context, p domain.UserProfile) error {
	settingsJSON, err := marshalSettings(p.Settings)
	if err != nil {
		return fmt.Errorf("postgres: marshal user profile settings: %w", err)
	}
	departmentID := nullableString(p.DepartmentID)

	_, err = r.pool.Exec(ctx, `
		INSERT INTO tenant.user_profiles (user_id, company_id, department_id, settings_json)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (user_id) DO UPDATE SET
			company_id     = EXCLUDED.company_id,
			department_id  = EXCLUDED.department_id,
			settings_json  = EXCLUDED.settings_json,
			updated_at     = now()
	`, p.UserID, p.CompanyID, departmentID, settingsJSON)
	if err != nil {
		return fmt.Errorf("postgres: upsert user profile: %w", err)
	}
	return nil
}

// Get looks up userID's profile, scoped by companyID — a profile row that
// exists but belongs to a different company resolves as not-found, same
// isolation rule as DepartmentRepository/TeamRepository (tenant-service.md §9).
func (r *UserProfileRepository) Get(ctx context.Context, companyID, userID string) (domain.UserProfile, bool, error) {
	row := r.pool.QueryRow(ctx, `
		SELECT user_id, company_id, department_id, settings_json
		FROM tenant.user_profiles
		WHERE user_id = $1 AND company_id = $2
	`, userID, companyID)

	var p domain.UserProfile
	var departmentID *string
	var settingsJSON string
	if err := row.Scan(&p.UserID, &p.CompanyID, &departmentID, &settingsJSON); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return domain.UserProfile{}, false, nil
		}
		return domain.UserProfile{}, false, fmt.Errorf("postgres: query user profile: %w", err)
	}
	if departmentID != nil {
		p.DepartmentID = *departmentID
	}

	settings, err := unmarshalSettings(settingsJSON)
	if err != nil {
		return domain.UserProfile{}, false, fmt.Errorf("postgres: unmarshal user profile settings: %w", err)
	}
	p.Settings = settings
	return p, true, nil
}

func (r *UserProfileRepository) ListUserIDsByDepartment(ctx context.Context, companyID, departmentID string) ([]string, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT user_id FROM tenant.user_profiles
		WHERE company_id = $1 AND department_id = $2
	`, companyID, departmentID)
	if err != nil {
		return nil, fmt.Errorf("postgres: query user ids by department: %w", err)
	}
	defer rows.Close()

	var out []string
	for rows.Next() {
		var uid string
		if err := rows.Scan(&uid); err != nil {
			return nil, fmt.Errorf("postgres: scan user id row: %w", err)
		}
		out = append(out, uid)
	}
	return out, rows.Err()
}

func (r *UserProfileRepository) ListUserIDsByCompany(ctx context.Context, companyID string) ([]string, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT user_id FROM tenant.user_profiles WHERE company_id = $1
	`, companyID)
	if err != nil {
		return nil, fmt.Errorf("postgres: query user ids by company: %w", err)
	}
	defer rows.Close()

	var out []string
	for rows.Next() {
		var uid string
		if err := rows.Scan(&uid); err != nil {
			return nil, fmt.Errorf("postgres: scan user id row: %w", err)
		}
		out = append(out, uid)
	}
	return out, rows.Err()
}

// GetOnboardingState reads userID's stored onboarding progress. Returns
// found=false when no profile row exists at all OR the row exists but
// onboarding_state_json is NULL (never saved) — both mean "wizard not
// started", the caller's existing default.
func (r *UserProfileRepository) GetOnboardingState(ctx context.Context, companyID, userID string) (string, bool, error) {
	row := r.pool.QueryRow(ctx, `
		SELECT onboarding_state_json FROM tenant.user_profiles
		WHERE user_id = $1 AND company_id = $2
	`, userID, companyID)

	var stateJSON *string
	if err := row.Scan(&stateJSON); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", false, nil
		}
		return "", false, fmt.Errorf("postgres: query onboarding state: %w", err)
	}
	if stateJSON == nil {
		return "", false, nil
	}
	return *stateJSON, true, nil
}

// SetOnboardingState upserts ONLY onboarding_state_json — see
// usecase.UserProfileRepository's doc comment on why this isn't routed
// through Upsert. A brand-new row gets company_id from companyID and
// leaves department_id/settings_json at their column defaults
// (NULL/'{}'); an existing row's department_id/settings_json are left
// untouched (ON CONFLICT only sets onboarding_state_json/updated_at).
func (r *UserProfileRepository) SetOnboardingState(ctx context.Context, companyID, userID, stateJSON string) error {
	_, err := r.pool.Exec(ctx, `
		INSERT INTO tenant.user_profiles (user_id, company_id, onboarding_state_json)
		VALUES ($1, $2, $3)
		ON CONFLICT (user_id) DO UPDATE SET
			onboarding_state_json = EXCLUDED.onboarding_state_json,
			updated_at            = now()
	`, userID, companyID, stateJSON)
	if err != nil {
		return fmt.Errorf("postgres: set onboarding state: %w", err)
	}
	return nil
}

func nullableString(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// clientStateColumn is the postgres layer's own whitelist type — never built
// from unchecked input, only ever returned by columnNameFor's explicit
// switch below. GetClientStateColumn/SetClientStateColumn's public
// signatures deliberately take a plain string (not this type): the
// usecase.ClientStateRepository port stays proto/postgres-agnostic (see
// usecase/get_client_state.go's own ClientStateKind), and this file is the
// one place responsible for re-validating that string before it ever
// reaches a SQL statement.
type clientStateColumn string

const (
	columnKeybindings              clientStateColumn = "keybindings_json"
	columnUILocalState             clientStateColumn = "ui_local_state_json"
	columnSavedRuntimeEnvironments clientStateColumn = "saved_runtime_environments_json"
	columnClientSettings           clientStateColumn = "client_settings_json"
	columnAccountsDevServerMap     clientStateColumn = "accounts_dev_server_json"
)

// columnNameFor is the ONLY place allowed to turn an external "which column"
// string into a SQL identifier. Column names can't be bound as $N query
// parameters, so this explicit switch — not string interpolation of the
// input directly — is what stands between a caller and SQL injection via
// column name (TASK-BE-STORAGE-002's non-negotiable requirement).
func columnNameFor(column string) (clientStateColumn, bool) {
	switch clientStateColumn(column) {
	case columnKeybindings, columnUILocalState, columnSavedRuntimeEnvironments,
		columnClientSettings, columnAccountsDevServerMap:
		return clientStateColumn(column), true
	default:
		return "", false
	}
}

// GetClientStateColumn reads one of the 5 opaque per-user JSON columns added
// by 0006_client_state_and_workspace_sessions — same found=false semantics
// as GetOnboardingState (no row OR NULL column both mean "never saved").
// column must be one of the names columnNameFor whitelists; anything else is
// a caller bug (usecase.GetClientState.Execute's own switch is what actually
// prevents an unknown kind from ever reaching here), reported as an error,
// never silently ignored or built into a query.
func (r *UserProfileRepository) GetClientStateColumn(ctx context.Context, companyID, userID, column string) (string, bool, error) {
	col, ok := columnNameFor(column)
	if !ok {
		return "", false, fmt.Errorf("postgres: unknown client state column %q", column)
	}

	query := fmt.Sprintf(`SELECT %s FROM tenant.user_profiles WHERE user_id = $1 AND company_id = $2`, col)
	row := r.pool.QueryRow(ctx, query, userID, companyID)

	var valueJSON *string
	if err := row.Scan(&valueJSON); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", false, nil
		}
		return "", false, fmt.Errorf("postgres: query client state column %s: %w", col, err)
	}
	if valueJSON == nil {
		return "", false, nil
	}
	return *valueJSON, true, nil
}

// SetClientStateColumn upserts ONLY the named column, same partial-update
// shape as SetOnboardingState (a brand-new row gets company_id from
// companyID and leaves every other column at its default; an existing row's
// other columns are left untouched).
func (r *UserProfileRepository) SetClientStateColumn(ctx context.Context, companyID, userID, column, valueJSON string) error {
	col, ok := columnNameFor(column)
	if !ok {
		return fmt.Errorf("postgres: unknown client state column %q", column)
	}

	query := fmt.Sprintf(`
		INSERT INTO tenant.user_profiles (user_id, company_id, %s)
		VALUES ($1, $2, $3)
		ON CONFLICT (user_id) DO UPDATE SET
			%s        = EXCLUDED.%s,
			updated_at = now()
	`, col, col, col)
	if _, err := r.pool.Exec(ctx, query, userID, companyID, valueJSON); err != nil {
		return fmt.Errorf("postgres: set client state column %s: %w", col, err)
	}
	return nil
}
