import { DURABLE_PUSH_SCHEMA } from './durable-push-schema.js'
// Applied at startup for both dialects, including additive queue tables,
// so every column type has to read the same in SQLite and PostgreSQL.
const PUSH_SCHEMA = `
CREATE TABLE IF NOT EXISTS push_challenges (
  challenge_id TEXT PRIMARY KEY,
  host_fingerprint TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
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
CREATE UNIQUE INDEX IF NOT EXISTS push_sessions_host ON push_sessions(host_fingerprint);
CREATE INDEX IF NOT EXISTS push_sessions_expires_at ON push_sessions(expires_at);

CREATE TABLE IF NOT EXISTS push_devices (
  registration_id TEXT PRIMARY KEY,
  host_fingerprint TEXT NOT NULL,
  device_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  token TEXT NOT NULL,
  apns_environment TEXT,
  dead_at BIGINT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS push_devices_host_device
  ON push_devices(host_fingerprint, device_id);
`

export function pushSchemaStatements(): string[] {
  // Comments are stripped before the split so a ';' inside one cannot cut a
  // statement in half and hand SQLite an "incomplete input" fragment.
  return (PUSH_SCHEMA + DURABLE_PUSH_SCHEMA)
    .replace(/--[^\n]*/g, '')
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0)
}
