// Changes since the shipped schema, applied after it on every boot, in order. Each must be
// idempotent and work for the revision still serving during a roll; never edit one that shipped.
// Split on semicolons, so none in comments.
const CONNECTOR_SCHEMA_CHANGES = `
CREATE TABLE IF NOT EXISTS connector_slack_apps (
  app_id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  client_secret TEXT NOT NULL,
  signing_secret TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
-- NULL for a workspace installed before apps were rows: only the legacy env-secret route reaches
-- it, until the operator binds it to its app.
ALTER TABLE connector_slack_installs ADD COLUMN IF NOT EXISTS app_id TEXT;
CREATE INDEX IF NOT EXISTS connector_slack_installs_app ON connector_slack_installs(app_id);

-- Channel order is per workspace: the same channel id in another workspace is another channel.
-- The shipped connector_posts_container stays: the shipped list recreates it on every boot.
CREATE INDEX IF NOT EXISTS connector_posts_channel_head
  ON connector_posts(source, workspace_id, container_id, state, queued_at);
`

export function connectorSchemaChanges(): string[] {
  return CONNECTOR_SCHEMA_CHANGES.split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0)
}
