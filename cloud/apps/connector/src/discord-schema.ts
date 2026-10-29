// The Discord edge's own tables, applied with the connector schema; same column rules as there.
const DISCORD_SCHEMA = `
CREATE TABLE IF NOT EXISTS connector_discord_gateway (
  slot INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  resume_url TEXT NOT NULL,
  sequence BIGINT NOT NULL
);
`

export function discordSchemaStatements(): string[] {
  return DISCORD_SCHEMA.split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0)
}
