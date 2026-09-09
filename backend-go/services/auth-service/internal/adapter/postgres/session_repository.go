package postgres

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/stablyai/orca-go/services/auth-service/internal/domain"
	"github.com/stablyai/orca-go/services/auth-service/internal/usecase"
)

// nullableString returns nil for an empty string — used so an unset
// refresh_token_hash is stored as SQL NULL, not the empty string, letting
// the partial unique index on that column (see migration 0007) ignore
// sessions with no refresh token, matching domain.Session's own
// empty-means-unset convention for this field.
func nullableString(v string) *string {
	if v == "" {
		return nil
	}
	return &v
}

// nullableTime returns nil for a zero time.Time — same rationale as
// nullableString, applied to RefreshExpiresAt.
func nullableTime(t time.Time) *time.Time {
	if t.IsZero() {
		return nil
	}
	return &t
}

func (r *Repository) CreateSession(ctx context.Context, session domain.Session) error {
	_, err := r.pool.Exec(ctx, `
		INSERT INTO auth.sessions (token_hash, user_id, tenant_id, created_at, expires_at, revoked_at, refresh_token_hash, refresh_expires_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
	`, session.TokenHash, session.UserID, session.TenantID, session.CreatedAt, session.ExpiresAt, session.RevokedAt,
		nullableString(session.RefreshTokenHash), nullableTime(session.RefreshExpiresAt))
	if err != nil {
		return fmt.Errorf("postgres: insert session: %w", err)
	}
	return nil
}

// scanSession scans the 8-column (token_hash, user_id, tenant_id,
// created_at, expires_at, revoked_at, refresh_token_hash,
// refresh_expires_at) shape every session query below selects, in that
// order — factored out so CreateSession's column list, this scan, and every
// SELECT stay in the same order without repeating the nullable-conversion
// dance at each call site.
func scanSession(row rowScanner) (domain.Session, error) {
	var s domain.Session
	var refreshHash *string
	var refreshExpiresAt *time.Time
	err := row.Scan(&s.TokenHash, &s.UserID, &s.TenantID, &s.CreatedAt, &s.ExpiresAt, &s.RevokedAt, &refreshHash, &refreshExpiresAt)
	if err != nil {
		return domain.Session{}, err
	}
	if refreshHash != nil {
		s.RefreshTokenHash = *refreshHash
	}
	if refreshExpiresAt != nil {
		s.RefreshExpiresAt = *refreshExpiresAt
	}
	return s, nil
}

func (r *Repository) GetSessionByTokenHash(ctx context.Context, tokenHash string) (domain.Session, error) {
	row := r.pool.QueryRow(ctx, `
		SELECT token_hash, user_id, tenant_id, created_at, expires_at, revoked_at, refresh_token_hash, refresh_expires_at
		FROM auth.sessions
		WHERE token_hash = $1
	`, tokenHash)

	s, err := scanSession(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.Session{}, fmt.Errorf("postgres: query session: %w", usecase.ErrSessionNotFound)
	}
	if err != nil {
		return domain.Session{}, fmt.Errorf("postgres: scan session row: %w", err)
	}
	return s, nil
}

// GetSessionByRefreshTokenHash looks up a session by its refresh token's
// hash — RefreshSession's lookup (CR-RBAC-003/TASK-BE-011).
func (r *Repository) GetSessionByRefreshTokenHash(ctx context.Context, refreshTokenHash string) (domain.Session, error) {
	row := r.pool.QueryRow(ctx, `
		SELECT token_hash, user_id, tenant_id, created_at, expires_at, revoked_at, refresh_token_hash, refresh_expires_at
		FROM auth.sessions
		WHERE refresh_token_hash = $1
	`, refreshTokenHash)

	s, err := scanSession(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.Session{}, fmt.Errorf("postgres: query session by refresh token: %w", usecase.ErrSessionNotFound)
	}
	if err != nil {
		return domain.Session{}, fmt.Errorf("postgres: scan session row: %w", err)
	}
	return s, nil
}

func (r *Repository) RevokeSession(ctx context.Context, tokenHash string, revokedAt time.Time) error {
	tag, err := r.pool.Exec(ctx, `
		UPDATE auth.sessions SET revoked_at = $2
		WHERE token_hash = $1
	`, tokenHash, revokedAt)
	if err != nil {
		return fmt.Errorf("postgres: revoke session: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("postgres: revoke session: %w", usecase.ErrSessionNotFound)
	}
	return nil
}

// ListForUser returns every session (revoked or not, expired or not) for
// userID — the admin-console session-inspection view needs the full
// history, not just currently-valid sessions.
func (r *Repository) ListForUser(ctx context.Context, userID string) ([]domain.Session, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT token_hash, user_id, tenant_id, created_at, expires_at, revoked_at, refresh_token_hash, refresh_expires_at
		FROM auth.sessions
		WHERE user_id = $1
		ORDER BY created_at DESC
	`, userID)
	if err != nil {
		return nil, fmt.Errorf("postgres: query sessions for user: %w", err)
	}
	defer rows.Close()

	var out []domain.Session
	for rows.Next() {
		s, err := scanSession(rows)
		if err != nil {
			return nil, fmt.Errorf("postgres: scan session row: %w", err)
		}
		out = append(out, s)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("postgres: iterate session rows: %w", err)
	}
	return out, nil
}

// RevokeAllForUser force-revokes every currently-unrevoked session for
// userID and returns how many were revoked.
func (r *Repository) RevokeAllForUser(ctx context.Context, userID string, revokedAt time.Time) (int32, error) {
	tag, err := r.pool.Exec(ctx, `
		UPDATE auth.sessions SET revoked_at = $2
		WHERE user_id = $1 AND revoked_at IS NULL
	`, userID, revokedAt)
	if err != nil {
		return 0, fmt.Errorf("postgres: revoke all sessions for user: %w", err)
	}
	return int32(tag.RowsAffected()), nil
}

// CountActive returns the number of currently-valid (unrevoked, unexpired)
// sessions across every tenant, as of now.
func (r *Repository) CountActive(ctx context.Context, now time.Time) (int32, error) {
	var n int32
	err := r.pool.QueryRow(ctx, `
		SELECT COUNT(*) FROM auth.sessions
		WHERE revoked_at IS NULL AND expires_at > $1
	`, now).Scan(&n)
	if err != nil {
		return 0, fmt.Errorf("postgres: count active sessions: %w", err)
	}
	return n, nil
}
