// Fixture preparation only: called while the disposable arm is stopped, before the timed read-only pressure observations.
import { DatabaseSync } from 'node:sqlite'
import { hasTable, openReadOnly } from './native-chat-4a-sqlite-observer'

export type RetiredHistory = { rows: number; payloadBytes: number }

/** Equivalent current original-history items copied under an unrelated retired epoch; never alters a live head or current row. */
export function prepareRetiredHistory(
  file: string,
  source: string,
  target: string,
  epoch: string,
  limit: number
): RetiredHistory {
  const db = new DatabaseSync(file, { timeout: 2_000 })
  try {
    const domain = hasTable(db, 'journal_chat_state')
    const heads = domain ? 'journal_chat_state' : 'journal_sessions'
    if (
      !db.prepare(`SELECT 1 FROM ${heads} WHERE session_id=? AND epoch IS NOT NULL`).get(target)
    ) {
      throw new Error('retired fixture target has no ready current head')
    }
    db.exec('BEGIN IMMEDIATE')
    if (domain) {
      const columns = db
        .prepare('PRAGMA table_info(journal_items)')
        .all()
        .map((row) => String(row.name))
      const quoted = columns.map((column) => `"${column.replaceAll('"', '""')}"`)
      const select = columns.map((column, index) =>
        column === 'session_id' || column === 'epoch' ? '?' : quoted[index]!
      )
      db.prepare(`INSERT INTO journal_items (${quoted.join(',')}) SELECT ${select.join(',')}
        FROM (SELECT * FROM journal_items WHERE session_id=? AND epoch=
        (SELECT epoch FROM journal_chat_state WHERE session_id=?) ORDER BY ordinal LIMIT ?)`).run(
        target,
        epoch,
        source,
        source,
        limit
      )
    } else {
      db.prepare(`INSERT INTO journal_rows(session_id,epoch,seq,ts,row_json)
        SELECT ?,?,seq,ts,row_json FROM (
          SELECT seq,ts,row_json,ROW_NUMBER() OVER (
            PARTITION BY json_extract(row_json,'$.itemId') ORDER BY seq DESC) AS latest
          FROM journal_rows WHERE session_id=? AND epoch=
            (SELECT epoch FROM journal_sessions WHERE session_id=?) AND json_extract(row_json,'$.kind')='item'
        ) WHERE latest=1 ORDER BY seq LIMIT ?`).run(target, epoch, source, source, limit)
    }
    const table = domain ? 'journal_items' : 'journal_rows'
    const payload = domain ? 'payload_json' : 'row_json'
    const result = db
      .prepare(`SELECT count(*) AS n,COALESCE(sum(octet_length(${payload})),0) AS bytes
      FROM ${table} WHERE session_id=? AND epoch=?`)
      .get(target, epoch)!
    if (Number(result.n) !== limit) {
      throw new Error(`retired fixture copied ${String(result.n)} rows, expected ${limit}`)
    }
    db.exec('COMMIT')
    return { rows: Number(result.n), payloadBytes: Number(result.bytes) }
  } finally {
    if (db.isTransaction) {
      db.exec('ROLLBACK')
    }
    db.close()
  }
}

/** One short read-only count under the unrelated target; lengths read stored payload sizes without loading their bodies. */
export function retiredHistory(file: string, sessionId: string): RetiredHistory {
  const db = openReadOnly(file)
  try {
    const domain = hasTable(db, 'journal_chat_state')
    const table = domain ? 'journal_items' : 'journal_rows'
    const heads = domain ? 'journal_chat_state' : 'journal_sessions'
    const payload = domain ? 'payload_json' : 'row_json'
    const row = db
      .prepare(`SELECT count(*) AS n,COALESCE(sum(octet_length(item.${payload})),0) AS bytes
      FROM ${table} item JOIN ${heads} head ON item.session_id=head.session_id
      WHERE item.session_id=? AND head.epoch IS NOT NULL AND item.epoch<>head.epoch`)
      .get(sessionId)!
    return { rows: Number(row.n), payloadBytes: Number(row.bytes) }
  } finally {
    db.close()
  }
}
