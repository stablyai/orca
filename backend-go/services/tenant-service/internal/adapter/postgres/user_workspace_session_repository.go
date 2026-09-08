package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// UserWorkspaceSessionRepository implements usecase.WorkspaceSessionRepository
// against tenant.user_workspace_sessions — CR-STORAGE-004a's per-(user_id,
// host_id) session state, a separate table (not a user_profiles column)
// because one user can have N sessions, keyed by host_id. See
// specs/backend-go/crs/v3/storage/solutions/
// BE-SOL-STORAGE-001-user-profile-json-columns.md §3/§4.
type UserWorkspaceSessionRepository struct {
	pool *pgxpool.Pool
}

func NewUserWorkspaceSessionRepository(pool *pgxpool.Pool) *UserWorkspaceSessionRepository {
	return &UserWorkspaceSessionRepository{pool: pool}
}

// Get reads userID's session for hostID, scoped by companyID — a row from a
// different company resolves as not-found, same isolation rule as
// UserProfileRepository (tenant-service.md §9). found=false means "no
// session ever saved for this (user, host) pair", never an error.
func (r *UserWorkspaceSessionRepository) Get(ctx context.Context, companyID, userID, hostID string) (string, bool, error) {
	row := r.pool.QueryRow(ctx, `
		SELECT session_json FROM tenant.user_workspace_sessions
		WHERE user_id = $1 AND host_id = $2 AND company_id = $3
	`, userID, hostID, companyID)

	var sessionJSON string
	if err := row.Scan(&sessionJSON); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", false, nil
		}
		return "", false, fmt.Errorf("postgres: query workspace session: %w", err)
	}
	return sessionJSON, true, nil
}

// Set fully replaces (or creates) userID's session row for hostID.
func (r *UserWorkspaceSessionRepository) Set(ctx context.Context, companyID, userID, hostID, sessionJSON string) error {
	_, err := r.pool.Exec(ctx, `
		INSERT INTO tenant.user_workspace_sessions (user_id, company_id, host_id, session_json, updated_at)
		VALUES ($1, $2, $3, $4, now())
		ON CONFLICT (user_id, host_id) DO UPDATE SET
			company_id   = EXCLUDED.company_id,
			session_json = EXCLUDED.session_json,
			updated_at   = now()
	`, userID, companyID, hostID, sessionJSON)
	if err != nil {
		return fmt.Errorf("postgres: set workspace session: %w", err)
	}
	return nil
}

// Patch shallow-merges patchJSON's top-level fields into the existing
// session row (creating one if none exists), inside a single transaction
// using SELECT ... FOR UPDATE to lock the row for the read-modify-write —
// unlike Set (always a full replace), two Patch calls landing close together
// must not silently drop whichever one lost the race. See
// BE-SOL-STORAGE-001 §4.
func (r *UserWorkspaceSessionRepository) Patch(ctx context.Context, companyID, userID, hostID, patchJSON string) error {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("postgres: begin patch workspace session tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }() // no-op once Commit succeeds

	row := tx.QueryRow(ctx, `
		SELECT session_json FROM tenant.user_workspace_sessions
		WHERE user_id = $1 AND host_id = $2 AND company_id = $3
		FOR UPDATE
	`, userID, hostID, companyID)

	var currentJSON string
	if err := row.Scan(&currentJSON); err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("postgres: query workspace session for update: %w", err)
	}

	merged, err := mergeShallowJSON(currentJSON, patchJSON)
	if err != nil {
		return fmt.Errorf("postgres: merge workspace session patch: %w", err)
	}

	if _, err := tx.Exec(ctx, `
		INSERT INTO tenant.user_workspace_sessions (user_id, company_id, host_id, session_json, updated_at)
		VALUES ($1, $2, $3, $4, now())
		ON CONFLICT (user_id, host_id) DO UPDATE SET
			company_id   = EXCLUDED.company_id,
			session_json = EXCLUDED.session_json,
			updated_at   = now()
	`, userID, companyID, hostID, merged); err != nil {
		return fmt.Errorf("postgres: upsert patched workspace session: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("postgres: commit patch workspace session tx: %w", err)
	}
	return nil
}

// mergeShallowJSON merges patchJSON's top-level fields into currentJSON
// (an empty currentJSON, e.g. no row existed yet, is treated as "{}"),
// patch fields taking precedence — a shallow, one-level merge only, per
// PatchWorkspaceSessionRequest's proto doc comment ("merge nông vào bản ghi
// hiện có, phía server").
func mergeShallowJSON(currentJSON, patchJSON string) (string, error) {
	base := map[string]json.RawMessage{}
	if currentJSON != "" {
		if err := json.Unmarshal([]byte(currentJSON), &base); err != nil {
			return "", fmt.Errorf("unmarshal existing session_json: %w", err)
		}
	}

	var patch map[string]json.RawMessage
	if err := json.Unmarshal([]byte(patchJSON), &patch); err != nil {
		return "", fmt.Errorf("unmarshal patch_json: %w", err)
	}
	for k, v := range patch {
		base[k] = v
	}

	merged, err := json.Marshal(base)
	if err != nil {
		return "", fmt.Errorf("marshal merged session_json: %w", err)
	}
	return string(merged), nil
}
