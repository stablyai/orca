export const SESSION_LINK_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS session_links (
  id TEXT PRIMARY KEY,
  document TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS session_link_participants (
  session_id TEXT PRIMARY KEY,
  link_id TEXT NOT NULL REFERENCES session_links(id)
);
CREATE TABLE IF NOT EXISTS session_link_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  link_id TEXT NOT NULL REFERENCES session_links(id),
  document TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_session_link_events ON session_link_events(link_id, sequence);
`
