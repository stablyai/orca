-- CR-RBAC-003/TASK-BE-011: session-refresh rotation fields. Nullable —
-- existing/older sessions and any session Login mints without a refresh
-- token simply have no refresh_token_hash, matching domain.Session's
-- empty-string/zero-time zero value for these fields.
ALTER TABLE auth.sessions
    ADD COLUMN refresh_token_hash TEXT,
    ADD COLUMN refresh_expires_at TIMESTAMPTZ;

-- Partial unique index (not a table-level UNIQUE) so multiple sessions with
-- no refresh token (NULL) don't collide against each other.
CREATE UNIQUE INDEX idx_auth_sessions_refresh_token_hash ON auth.sessions (refresh_token_hash)
    WHERE refresh_token_hash IS NOT NULL;
