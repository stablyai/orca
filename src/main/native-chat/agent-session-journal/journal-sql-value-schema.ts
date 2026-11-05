export function journalSqlValueSchema(): string {
  return `
CREATE TABLE IF NOT EXISTS journal_proj_collections (
  session_id TEXT NOT NULL,
  generation TEXT NOT NULL,
  collection TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  next_ordinal INTEGER NOT NULL DEFAULT 0,
  next_incarnation INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, generation, collection)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS journal_proj_values (
  session_id TEXT NOT NULL,
  generation TEXT NOT NULL,
  collection TEXT NOT NULL,
  entry_key TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  incarnation INTEGER NOT NULL,
  value_json TEXT NOT NULL,
  PRIMARY KEY (session_id, generation, collection, entry_key)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS journal_proj_values_order
  ON journal_proj_values(session_id, generation, collection, ordinal);
CREATE TABLE IF NOT EXISTS journal_proj_value_snapshots (
  session_id TEXT NOT NULL,
  generation TEXT NOT NULL,
  collection TEXT NOT NULL,
  entry_key TEXT NOT NULL,
  incarnation INTEGER NOT NULL,
  value_json TEXT NOT NULL,
  PRIMARY KEY (session_id, generation, collection, entry_key, incarnation)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS journal_proj_value_refs (
  session_id TEXT NOT NULL,
  generation TEXT NOT NULL,
  holder_collection TEXT NOT NULL,
  holder_key TEXT NOT NULL,
  holder_incarnation INTEGER NOT NULL,
  source_collection TEXT NOT NULL,
  source_key TEXT NOT NULL,
  source_incarnation INTEGER NOT NULL,
  PRIMARY KEY (session_id, generation, holder_collection, holder_key, holder_incarnation,
    source_collection, source_key, source_incarnation)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS journal_proj_value_refs_source
  ON journal_proj_value_refs(session_id, generation, source_collection, source_key, source_incarnation);
`
}
