// The five tables the gateway spec names. Applied at startup for both dialects,
// so every column type has to read the same in SQLite and PostgreSQL.
const PUSH_SCHEMA = `
CREATE TABLE IF NOT EXISTS push_hosts (
  host_fingerprint TEXT PRIMARY KEY,
  host_public_key TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  last_seen_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS push_challenges (
  challenge_id TEXT PRIMARY KEY,
  host_fingerprint TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  transcript TEXT NOT NULL,
  expires_at BIGINT NOT NULL,
  consumed_at BIGINT
);
CREATE INDEX IF NOT EXISTS push_challenges_expires_at ON push_challenges(expires_at);

CREATE TABLE IF NOT EXISTS push_sessions (
  token_hash TEXT PRIMARY KEY,
  host_fingerprint TEXT NOT NULL,
  expires_at BIGINT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS push_sessions_expires_at ON push_sessions(expires_at);

CREATE TABLE IF NOT EXISTS push_devices (
  registration_id TEXT PRIMARY KEY,
  host_fingerprint TEXT NOT NULL,
  device_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  token TEXT NOT NULL,
  apns_environment TEXT,
  filter_json TEXT NOT NULL,
  dead_at BIGINT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS push_devices_host_device
  ON push_devices(host_fingerprint, device_id);

CREATE TABLE IF NOT EXISTS push_send_log (
  send_id TEXT PRIMARY KEY,
  host_fingerprint TEXT NOT NULL,
  registration_id TEXT NOT NULL,
  sent_at BIGINT NOT NULL
);
-- Both quota windows scan by identity and time, and the pruner scans by time alone.
CREATE INDEX IF NOT EXISTS push_send_log_host_sent_at ON push_send_log(host_fingerprint, sent_at);
CREATE INDEX IF NOT EXISTS push_send_log_registration_sent_at
  ON push_send_log(registration_id, sent_at);
CREATE INDEX IF NOT EXISTS push_send_log_sent_at ON push_send_log(sent_at);
`

export function pushSchemaStatements(): string[] {
  return PUSH_SCHEMA.split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0)
}
