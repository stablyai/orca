// The Slack edge's own tables, applied with the connector schema; same column rules as there.
const SLACK_SCHEMA = `
CREATE TABLE IF NOT EXISTS connector_slack_installs (
  team_id TEXT PRIMARY KEY,
  bot_user_id TEXT NOT NULL,
  bot_token TEXT NOT NULL,
  paused INTEGER NOT NULL,
  installed_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS connector_slack_users (
  team_id TEXT NOT NULL,
  slack_user_id TEXT NOT NULL,
  membership TEXT NOT NULL,
  display_name TEXT NOT NULL,
  checked_at BIGINT NOT NULL,
  PRIMARY KEY (team_id, slack_user_id)
);
`

export function slackSchemaStatements(): string[] {
  return SLACK_SCHEMA.split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0)
}
