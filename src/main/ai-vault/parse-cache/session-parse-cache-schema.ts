export const SESSION_PARSE_ROWS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS rows(
  path TEXT PRIMARY KEY,
  mtime_ms REAL NOT NULL,
  size_bytes INTEGER,
  dependency_signature TEXT,
  platform TEXT NOT NULL,
  -- JSON, validated on read like any other untrusted file content.
  sidecar TEXT,
  session TEXT NOT NULL,
  skipped_records TEXT NOT NULL,
  -- Wall-clock ms the transcript was last parsed or found still on disk. Rows
  -- past an age are re-checked, which is what ends a row whose transcript was
  -- deleted outside Orca.
  seen_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS rows_seen_at ON rows(seen_at);
`
