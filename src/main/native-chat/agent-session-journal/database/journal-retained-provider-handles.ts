import type Database from '../../../sqlite/sync-database'

export function journalProviderHandleOwners(db: Database.Database, nativeId: string): string[] {
  return db
    .prepare(`SELECT session_id FROM agent_session_records WHERE adopted_native_id = ?
    UNION SELECT session_id FROM journal_retained_provider_handles WHERE native_id = ?`)
    .all(nativeId, nativeId)
    .map(({ session_id }) => String(session_id))
}

function inactiveLinks(json: string): string {
  return `CASE WHEN instr(${json}, '"inactiveProviderHandleLinks"') > 0 AND json_valid(${json})
    THEN CASE WHEN json_type(${json}, '$.inactiveProviderHandleLinks') = 'array'
      THEN json_extract(${json}, '$.inactiveProviderHandleLinks') END END`
}

function insertHandles(session: string, source: string): string {
  return `INSERT OR IGNORE INTO journal_retained_provider_handles(session_id,native_id)
    SELECT session_id, native_id FROM (
      SELECT ${session} AS session_id, CASE WHEN link.type = 'object' THEN COALESCE(
        json_extract(link.value, '$.handle.nativeId'),
        json_extract(link.value, '$.handle.sessionId'),
        json_extract(link.value, '$.handle.threadId')
      ) END AS native_id FROM ${source}
    ) WHERE typeof(native_id) = 'text';`
}

/** Triggers keep the index up to date even when an older build writes session records. */
export function ensureJournalRetainedProviderHandles(
  db: Database.Database,
  inTransaction: (run: () => void) => void
): void {
  if (
    db.prepare("SELECT 1 FROM sqlite_master WHERE name='journal_retained_provider_handles'").get()
  ) {
    return
  }
  const next = inactiveLinks('NEW.record_json')
  inTransaction(() => {
    db.exec(`CREATE TABLE journal_retained_provider_handles (
        session_id TEXT NOT NULL,
        native_id TEXT NOT NULL,
        PRIMARY KEY(session_id,native_id)
      ) WITHOUT ROWID;
      CREATE INDEX journal_retained_provider_handles_native
        ON journal_retained_provider_handles(native_id);
      CREATE TRIGGER journal_retained_provider_handles_insert AFTER INSERT ON agent_session_records
      WHEN ${next} IS NOT NULL
      BEGIN
        ${insertHandles('NEW.session_id', `json_each(${next}) AS link`)}
      END;
      CREATE TRIGGER journal_retained_provider_handles_update AFTER UPDATE OF record_json
      ON agent_session_records WHEN (${next}) IS NOT (${inactiveLinks('OLD.record_json')})
      BEGIN
        DELETE FROM journal_retained_provider_handles WHERE session_id=OLD.session_id;
        ${insertHandles('NEW.session_id', `json_each(${next}) AS link`)}
      END;
      CREATE TRIGGER journal_retained_provider_handles_delete AFTER DELETE ON agent_session_records
      BEGIN
        DELETE FROM journal_retained_provider_handles WHERE session_id=OLD.session_id;
      END;
      ${insertHandles(
        'session_id',
        `agent_session_records, json_each(${inactiveLinks('record_json')}) AS link`
      )}`)
  })
}
