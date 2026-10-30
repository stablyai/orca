// Applied at startup for both dialects, so every column type reads the same in SQLite and PostgreSQL.
// Shipped statements are frozen; see connectorBootStatements for how to change the schema.
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
  source TEXT NOT NULL,
  external_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  container_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
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
  created_at BIGINT NOT NULL,
  PRIMARY KEY (source, external_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS connector_threads_place
  ON connector_threads(source, workspace_id, container_id, thread_id, owner_user_id);
CREATE INDEX IF NOT EXISTS connector_threads_host ON connector_threads(host_id);

CREATE TABLE IF NOT EXISTS connector_inbox (
  host_id TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  source TEXT NOT NULL,
  external_id TEXT NOT NULL,
  message_id TEXT,
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
  ON connector_inbox(host_id, source, external_id, seq);
CREATE INDEX IF NOT EXISTS connector_inbox_expiry ON connector_inbox(state, expires_at);

CREATE TABLE IF NOT EXISTS connector_seen (
  source TEXT NOT NULL,
  message_key TEXT NOT NULL,
  seen_at BIGINT NOT NULL,
  PRIMARY KEY (source, message_key)
);
CREATE INDEX IF NOT EXISTS connector_seen_age ON connector_seen(seen_at);

CREATE TABLE IF NOT EXISTS connector_identities (
  source TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  default_host_id TEXT,
  default_project TEXT,
  container_projects TEXT NOT NULL,
  linked_at BIGINT NOT NULL,
  PRIMARY KEY (source, workspace_id, user_id)
);

CREATE TABLE IF NOT EXISTS connector_thread_context (
  source TEXT NOT NULL,
  external_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  author_name TEXT,
  text TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (source, external_id, message_id)
);
CREATE INDEX IF NOT EXISTS connector_thread_context_author
  ON connector_thread_context(source, workspace_id, author_id);

CREATE TABLE IF NOT EXISTS connector_posts (
  source TEXT NOT NULL,
  post_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  container_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  turn_key TEXT,
  rev INTEGER NOT NULL,
  state TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  queued_at BIGINT NOT NULL,
  next_at BIGINT NOT NULL,
  message_ref TEXT,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (source, post_id)
);
CREATE INDEX IF NOT EXISTS connector_posts_due ON connector_posts(state, next_at);
CREATE INDEX IF NOT EXISTS connector_posts_container
  ON connector_posts(source, container_id, state, queued_at);
CREATE INDEX IF NOT EXISTS connector_posts_turn ON connector_posts(source, turn_key);
`

export function connectorSchemaStatements(): string[] {
  return CONNECTOR_SCHEMA.split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0)
}
