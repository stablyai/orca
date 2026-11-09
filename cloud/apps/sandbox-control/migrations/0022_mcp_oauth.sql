-- MCP OAuth 2.1 (src/mcp/oauth.ts). Additive only: older Workers ignore the new columns.

-- Tokens issued to MCP clients are api_keys rows (kind oauth / oauth_refresh). A grant "family" is
-- every token descended from one authorization code: replaying a used code or a rotated refresh
-- token revokes the whole family (OAuth 2.1 refresh token rotation / code replay).
ALTER TABLE api_keys ADD COLUMN client_id TEXT;
-- The resource (RFC 8707) an access token is for; the MCP endpoint checks it.
ALTER TABLE api_keys ADD COLUMN audience TEXT;
ALTER TABLE api_keys ADD COLUMN family_id TEXT;
CREATE INDEX api_keys_family ON api_keys (family_id) WHERE family_id IS NOT NULL;

ALTER TABLE oauth_codes ADD COLUMN family_id TEXT;
ALTER TABLE oauth_codes ADD COLUMN created_at INTEGER;

-- One-time approval codes a signed-in desktop mints (POST /v1/oauth-approvals) so a user can
-- approve an MCP client on the consent page without handling a long-lived API key. Hash only.
CREATE TABLE oauth_approvals (
  code_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  creator_role TEXT,
  scopes TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  created_at INTEGER NOT NULL
);
