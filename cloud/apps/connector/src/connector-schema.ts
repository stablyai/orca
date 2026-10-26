// Applied at startup for both dialects, so every column type reads the same in SQLite and PostgreSQL.
const CONNECTOR_SCHEMA = `
CREATE TABLE IF NOT EXISTS connector_hosts (
  host_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  host_name TEXT NOT NULL,
  platform TEXT NOT NULL,
  runtime TEXT NOT NULL,
  orca_version TEXT NOT NULL,
  hello_rev BIGINT NOT NULL,
  hello TEXT NOT NULL,
  unsettled_due INTEGER NOT NULL,
  events_seq BIGINT,
  first_seen_at BIGINT NOT NULL,
  last_seen_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS connector_hosts_account ON connector_hosts(account_id);

CREATE TABLE IF NOT EXISTS connector_threads (
  external_id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  thread_ts TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  host_id TEXT NOT NULL,
  place_id TEXT NOT NULL,
  pane_key TEXT,
  agent TEXT,
  open_turn_id BIGINT,
  turn_state TEXT,
  turn_stop_reason TEXT,
  pending_prompt TEXT,
  created_at BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS connector_threads_slack
  ON connector_threads(team_id, channel_id, thread_ts, owner_user_id);
CREATE INDEX IF NOT EXISTS connector_threads_host ON connector_threads(host_id);

CREATE TABLE IF NOT EXISTS connector_inbox (
  host_id TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  seq BIGINT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT,
  state TEXT NOT NULL,
  lease_until BIGINT,
  expires_at BIGINT NOT NULL,
  result TEXT,
  created_at BIGINT NOT NULL,
  settled_at BIGINT,
  PRIMARY KEY (host_id, delivery_id)
);
CREATE INDEX IF NOT EXISTS connector_inbox_host_state ON connector_inbox(host_id, state, seq);
CREATE INDEX IF NOT EXISTS connector_inbox_conversation
  ON connector_inbox(host_id, external_id, seq);
CREATE INDEX IF NOT EXISTS connector_inbox_expiry ON connector_inbox(state, expires_at);
`

export function connectorSchemaStatements(): string[] {
  return CONNECTOR_SCHEMA.split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0)
}
