import type Database from '../../sqlite/sync-database'
export type MailHistoryChange = {
  kind: 'receipt' | 'row' | 'record'
  sessionId: string
  key: string
}
type Capture = {
  listeners: Set<(changes: readonly MailHistoryChange[]) => void>
  flush: () => void
  cancelRetry: () => void
}
const captures = new WeakMap<Database.Database, Capture>()

/** TEMP nominations commit/rollback with their writer; JS callbacks only schedule a committed read. */
export function observeMailHistoryChanges(
  db: Database.Database,
  listener: (changes: readonly MailHistoryChange[]) => void
): () => void {
  let capture = captures.get(db)
  if (!capture) {
    let scheduled = false
    let flushing = false
    let retry: ReturnType<typeof setTimeout> | undefined
    const current: Capture = {
      listeners: new Set(),
      flush: () => {},
      cancelRetry: () => {
        clearTimeout(retry)
        retry = undefined
      }
    }
    const schedule = () => {
      if (!scheduled) {
        scheduled = true
        queueMicrotask(() => {
          scheduled = false
          try {
            current.flush()
          } catch (error) {
            console.warn('[orchestration] original mail notification pending', error)
            if (!retry && current.listeners.size) {
              retry = setTimeout(() => {
                retry = undefined
                schedule()
              }, 100)
              retry.unref()
            }
          }
        })
      }
      return 0
    }
    current.flush = () => {
      if (flushing || db.isTransaction || !current.listeners.size) {
        return
      }
      const rows = db
        .prepare(
          'SELECT rowid, kind, session_id, reference FROM mail_history_changes ORDER BY rowid'
        )
        .all()
      if (!rows.length) {
        return
      }
      const changes: MailHistoryChange[] = []
      for (const row of rows) {
        if (
          (row.kind === 'receipt' || row.kind === 'row' || row.kind === 'record') &&
          typeof row.session_id === 'string' &&
          typeof row.reference === 'string'
        ) {
          changes.push({ kind: row.kind, sessionId: row.session_id, key: row.reference })
        }
      }
      flushing = true
      try {
        for (const notify of current.listeners) {
          notify(changes)
        }
        db.prepare('DELETE FROM mail_history_changes WHERE rowid <= ?').run(rows.at(-1)?.rowid)
      } finally {
        flushing = false
      }
    }
    db.function('nominate_mail_history', {}, schedule)
    db.exec(`CREATE TEMP TABLE mail_history_changes (
      kind TEXT NOT NULL, session_id TEXT NOT NULL, reference TEXT NOT NULL,
      UNIQUE(kind, session_id, reference))`)
    for (const event of ['INSERT', 'UPDATE', 'DELETE']) {
      const prefixes = event === 'UPDATE' ? ['OLD', 'NEW'] : [event === 'DELETE' ? 'OLD' : 'NEW']
      for (const [table, kind, ref] of [
        ['agent_session_command_receipts', 'receipt', 'operation_id'],
        ['journal_rows', 'row', 'json_array(epoch, seq)'],
        ['agent_session_records', 'record', "''"]
      ]) {
        const nominations = prefixes
          .map((row) => {
            const reference =
              table === 'journal_rows'
                ? `json_array(${row}.epoch, ${row}.seq)`
                : ref === "''"
                  ? ref
                  : `${row}.${ref}`
            return `INSERT INTO mail_history_changes VALUES ('${kind}', ${row}.session_id, ${reference})
              ON CONFLICT(kind, session_id, reference) DO UPDATE SET
              rowid = (SELECT COALESCE(MAX(rowid), 0) + 1 FROM mail_history_changes);`
          })
          .join('\n')
        const relevantRecord =
          event === 'UPDATE' && kind === 'record'
            ? `WHEN json_extract(CASE WHEN json_valid(OLD.record_json) THEN OLD.record_json ELSE '{}' END, '$.location')
              IS NOT json_extract(CASE WHEN json_valid(NEW.record_json) THEN NEW.record_json ELSE '{}' END, '$.location')
            OR json_extract(CASE WHEN json_valid(OLD.record_json) THEN OLD.record_json ELSE '{}' END, '$.conversationCommand')
              IS NOT json_extract(CASE WHEN json_valid(NEW.record_json) THEN NEW.record_json ELSE '{}' END, '$.conversationCommand')`
            : ''
        db.exec(`CREATE TEMP TRIGGER capture_mail_${kind}_${event.toLowerCase()}
          AFTER ${event} ON main.${table} ${relevantRecord}
          BEGIN ${nominations} SELECT nominate_mail_history(); END`)
      }
    }
    captures.set(db, current)
    capture = current
  }
  capture.listeners.add(listener)
  return () => {
    capture.listeners.delete(listener)
    if (!capture.listeners.size) {
      capture.cancelRetry()
    }
  }
}
export function flushMailHistoryChanges(db: Database.Database): void {
  captures.get(db)?.flush()
}
export function cancelMailHistoryRetry(db: Database.Database): void {
  captures.get(db)?.cancelRetry()
}
export function disposeMailHistoryChanges(db: Database.Database): void {
  const capture = captures.get(db)
  capture?.cancelRetry()
  if (capture) {
    capture.flush = () => {}
  }
  capture?.listeners.clear()
  captures.delete(db)
}
