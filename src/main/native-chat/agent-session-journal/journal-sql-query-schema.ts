export function journalSqlQuerySchema(): string {
  return `
CREATE TABLE IF NOT EXISTS journal_proj_submissions (
  session_id TEXT NOT NULL,
  generation TEXT NOT NULL,
  entry_key TEXT NOT NULL,
  item_key TEXT NOT NULL,
  input_ordinal INTEGER NOT NULL,
  fingerprint TEXT,
  submitted_at REAL NOT NULL,
  accepted_seq INTEGER,
  dispatch_state TEXT NOT NULL,
  write_failure INTEGER NOT NULL,
  echo_claimed INTEGER NOT NULL,
  item_present INTEGER NOT NULL,
  item_sequence INTEGER NOT NULL,
  item_unscoped INTEGER NOT NULL,
  PRIMARY KEY (session_id, generation, entry_key)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS journal_proj_submissions_echo
  ON journal_proj_submissions(session_id, generation, fingerprint, submitted_at, input_ordinal)
  WHERE dispatch_state<>'rejected' AND write_failure=0 AND echo_claimed=0 AND item_present=1;
CREATE INDEX IF NOT EXISTS journal_proj_submissions_echo_clear
  ON journal_proj_submissions(session_id, generation, fingerprint, submitted_at, input_ordinal)
  WHERE dispatch_state<>'rejected' AND write_failure=0 AND echo_claimed=0 AND item_present=1 AND accepted_seq IS NOT NULL;
CREATE INDEX IF NOT EXISTS journal_proj_submissions_unopened
  ON journal_proj_submissions(session_id, generation, item_sequence DESC, input_ordinal DESC)
  WHERE dispatch_state='accepted' AND item_present=1 AND item_unscoped=1;
CREATE INDEX IF NOT EXISTS journal_proj_submissions_item
  ON journal_proj_submissions(session_id, generation, item_key);
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
