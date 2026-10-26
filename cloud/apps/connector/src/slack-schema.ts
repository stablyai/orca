// The Slack edge's tables, applied with the connector schema; same column rules as there.
const SLACK_SCHEMA = `
CREATE TABLE IF NOT EXISTS connector_slack_installs (
  team_id TEXT PRIMARY KEY,
  bot_user_id TEXT NOT NULL,
  bot_token TEXT NOT NULL,
  paused INTEGER NOT NULL,
  installed_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS connector_slack_identities (
  team_id TEXT NOT NULL,
  slack_user_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  default_host_id TEXT,
  default_project TEXT,
  channel_projects TEXT NOT NULL,
  linked_at BIGINT NOT NULL,
  PRIMARY KEY (team_id, slack_user_id)
);

CREATE TABLE IF NOT EXISTS connector_slack_users (
  team_id TEXT NOT NULL,
  slack_user_id TEXT NOT NULL,
  membership TEXT NOT NULL,
  display_name TEXT NOT NULL,
  checked_at BIGINT NOT NULL,
  PRIMARY KEY (team_id, slack_user_id)
);

CREATE TABLE IF NOT EXISTS connector_slack_seen (
  message_key TEXT PRIMARY KEY,
  seen_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS connector_slack_seen_age ON connector_slack_seen(seen_at);

CREATE TABLE IF NOT EXISTS connector_thread_context (
  external_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  team_id TEXT NOT NULL,
  author_user_id TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (external_id, ts)
);
CREATE INDEX IF NOT EXISTS connector_thread_context_author
  ON connector_thread_context(team_id, author_user_id);

CREATE TABLE IF NOT EXISTS connector_slack_posts (
  post_id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  thread_ts TEXT NOT NULL,
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  turn_key TEXT,
  rev INTEGER NOT NULL,
  state TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  queued_at BIGINT NOT NULL,
  next_at BIGINT NOT NULL,
  slack_ts TEXT,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS connector_slack_posts_due ON connector_slack_posts(state, next_at);
CREATE INDEX IF NOT EXISTS connector_slack_posts_channel
  ON connector_slack_posts(channel_id, state, queued_at);
CREATE INDEX IF NOT EXISTS connector_slack_posts_turn ON connector_slack_posts(turn_key);
`

export function slackSchemaStatements(): string[] {
  return SLACK_SCHEMA.split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0)
}
