DROP INDEX IF EXISTS auth.idx_auth_sessions_refresh_token_hash;
ALTER TABLE auth.sessions
    DROP COLUMN IF EXISTS refresh_token_hash,
    DROP COLUMN IF EXISTS refresh_expires_at;
