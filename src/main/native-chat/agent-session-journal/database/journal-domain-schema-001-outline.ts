export const JOURNAL_DOMAIN_SCHEMA_001_OUTLINE = `
CREATE TABLE journal_outline_cache (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  source_sequence INTEGER NOT NULL,
  source_revision INTEGER NOT NULL,
  budget_bytes INTEGER NOT NULL,
  outline_json TEXT NOT NULL,
  PRIMARY KEY(session_id,epoch)
) WITHOUT ROWID;
`
