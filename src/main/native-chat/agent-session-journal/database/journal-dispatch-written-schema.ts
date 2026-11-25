/** Additive so older writers can still open this journal and ignore receipt timestamps. */
export const JOURNAL_DISPATCH_WRITTEN_SCHEMA = `
    CREATE TABLE IF NOT EXISTS journal_dispatch_written (
      session_id TEXT NOT NULL,
      epoch TEXT NOT NULL,
      handover_sequence INTEGER NOT NULL,
      written_at INTEGER NOT NULL,
      PRIMARY KEY(session_id,epoch,handover_sequence)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS journal_pending_dispatch_handover ON journal_submission_attempts(
      session_id,epoch,message_id,
      json_extract(facts_json,'$.handover.sequence'),
      json_extract(facts_json,'$.handover.fence'),
      json_extract(facts_json,'$.handover.scope.kind')
    ) WHERE current=1 AND dispatch_state='pending';
`
