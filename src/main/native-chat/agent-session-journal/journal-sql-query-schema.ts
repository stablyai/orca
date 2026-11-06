export function journalSqlQuerySchema(): string {
  return `
CREATE TABLE IF NOT EXISTS journal_proj_input_candidates (
  session_id TEXT NOT NULL,
  generation TEXT NOT NULL,
  entry_key TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  effective_fence INTEGER NOT NULL,
  handover_fence INTEGER,
  PRIMARY KEY (session_id, generation, entry_key)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS journal_proj_input_candidates_effective
  ON journal_proj_input_candidates(session_id, generation, effective_fence, ordinal);
CREATE INDEX IF NOT EXISTS journal_proj_input_candidates_handover
  ON journal_proj_input_candidates(session_id, generation, handover_fence, ordinal)
  WHERE handover_fence IS NOT NULL;
CREATE TABLE IF NOT EXISTS journal_proj_aliases (
  session_id TEXT NOT NULL,
  generation TEXT NOT NULL,
  entry_key TEXT NOT NULL,
  target_key TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY (session_id, generation, entry_key)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS journal_proj_aliases_target
  ON journal_proj_aliases(session_id, generation, target_key, ordinal);
CREATE TABLE IF NOT EXISTS journal_proj_native_entries (
  session_id TEXT NOT NULL,
  generation TEXT NOT NULL,
  entry_key TEXT NOT NULL,
  basis TEXT NOT NULL,
  PRIMARY KEY (session_id, generation, entry_key)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS journal_proj_native_entries_basis
  ON journal_proj_native_entries(session_id, generation, basis);
`
}
