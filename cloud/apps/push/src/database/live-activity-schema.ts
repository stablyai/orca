export const LIVE_ACTIVITY_SCHEMA = `
CREATE TABLE IF NOT EXISTS push_live_overviews (
  overview_id TEXT PRIMARY KEY,
  owner_fingerprint TEXT NOT NULL,
  control_hash TEXT NOT NULL,
  control_revision BIGINT NOT NULL,
  show_names INTEGER NOT NULL,
  discovery_complete INTEGER NOT NULL,
  token TEXT NOT NULL,
  apns_environment TEXT NOT NULL,
  scopes TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  revision BIGINT NOT NULL DEFAULT 0,
  next_at BIGINT NOT NULL,
  timestamp BIGINT NOT NULL DEFAULT 0,
  lease_id TEXT,
  lease_until BIGINT NOT NULL DEFAULT 0,
  sent_identity TEXT,
  sent_at BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS push_live_overviews_due ON push_live_overviews(next_at, lease_until);
CREATE INDEX IF NOT EXISTS push_live_overviews_owner ON push_live_overviews(owner_fingerprint, expires_at);
CREATE INDEX IF NOT EXISTS push_live_overviews_expiry ON push_live_overviews(expires_at);
CREATE TABLE IF NOT EXISTS push_live_contributions (
  overview_id TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  owner_fingerprint TEXT NOT NULL,
  sequence BIGINT NOT NULL,
  content TEXT NOT NULL,
  received_at BIGINT NOT NULL,
  retired INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(overview_id, scope_id)
);
CREATE INDEX IF NOT EXISTS push_live_contributions_owner ON push_live_contributions(owner_fingerprint);
`
