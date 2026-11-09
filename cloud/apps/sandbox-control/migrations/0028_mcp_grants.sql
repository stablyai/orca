-- MCP OAuth grants (src/mcp/oauth.ts): tie grants to the credential that approved them, bound their
-- lifetime, remember revoked families and let housekeeping purge abandoned registrations. Additive.

-- The orca_sk_ key that approved the grant (NULL: a desktop approval code). Revoking that key
-- revokes every token of the grant.
ALTER TABLE oauth_codes ADD COLUMN grantor_key_id TEXT;
-- Set when a used code is presented again (replay), so a racing exchange revokes what it minted.
ALTER TABLE oauth_codes ADD COLUMN replayed_at INTEGER;
ALTER TABLE api_keys ADD COLUMN grantor_key_id TEXT;
-- Absolute end of a grant (90 days from the code exchange): refresh is refused after it.
ALTER TABLE api_keys ADD COLUMN family_expires_at INTEGER;
CREATE INDEX api_keys_grantor ON api_keys (grantor_key_id) WHERE grantor_key_id IS NOT NULL;

-- Revoked grant families. Checked after minting, so a token minted concurrently with a revocation
-- or replay never survives it.
CREATE TABLE oauth_revoked_families (
  family_id TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  revoked_at INTEGER NOT NULL
);

-- Last successful code exchange; registrations that never complete one are purged after a day.
ALTER TABLE oauth_clients ADD COLUMN last_granted_at INTEGER;
