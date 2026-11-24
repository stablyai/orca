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
    const targetHead = db.prepare(`SELECT epoch FROM ${heads} WHERE session_id=?`).get(target)
    if (
      typeof targetHead?.epoch !== 'string' ||
      targetHead.epoch === epoch ||
      source === target ||
      !Number.isSafeInteger(limit) ||
      limit <= 0
    ) {
      throw new Error(
        'retired fixture requires an unrelated ready target, retired epoch and positive count'
      )
    }
    db.exec('BEGIN IMMEDIATE')
    let generation = 0
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
      const head = db
        .prepare(`SELECT head.* FROM journal_outcome_epochs head JOIN journal_sessions live
        ON live.session_id=head.session_id AND live.epoch=head.epoch WHERE head.session_id=?`)
        .get(source)
      if (!head || head.prefix_seq !== 0 || Number(head.format) < 1 || Number(head.format) > 3) {
        throw new Error('retired fixture requires a supported complete outcome source')
      }
      // No current epoch points at this generation: the main arm's existing sweeper owns its cleanup.
      generation = Number(
        db
          .prepare('INSERT INTO journal_outcome_generations(session_id,epoch) VALUES (?,?)')
          .run(target, epoch).lastInsertRowid
      )
      db.prepare(`INSERT INTO journal_outcomes(generation,seq,field,entry_key,format,ordinal,value_json,deleted)
        SELECT ?,seq,field,entry_key,format,ordinal,value_json,deleted FROM (
          SELECT *,ROW_NUMBER() OVER (PARTITION BY entry_key ORDER BY seq DESC) AS latest
          FROM journal_outcomes WHERE generation=? AND seq<=? AND field='items'
        ) WHERE latest=1 AND deleted=0 ORDER BY ordinal,entry_key LIMIT ?`).run(
        generation,
        head.generation,
        head.through_seq,
        limit
      )
    }
    const result = db
      .prepare(
        domain
          ? `SELECT count(*) AS n,COALESCE(sum(octet_length(payload_json)),0) AS bytes
          FROM journal_items WHERE session_id=? AND epoch=?`
          : `SELECT count(*) AS n,COALESCE(sum(octet_length(value_json)),0) AS bytes
          FROM journal_outcomes WHERE generation=?`
      )
      .get(...(domain ? [target, epoch] : [generation]))!
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
    const row = db
      .prepare(
        domain
          ? `SELECT count(*) AS n,COALESCE(sum(octet_length(item.payload_json)),0) AS bytes
          FROM journal_items item JOIN journal_chat_state head ON item.session_id=head.session_id
          WHERE item.session_id=? AND head.epoch IS NOT NULL AND item.epoch<>head.epoch`
          : `SELECT count(*) AS n,COALESCE(sum(octet_length(item.value_json)),0) AS bytes
          FROM journal_outcomes item JOIN journal_outcome_generations retired ON retired.generation=item.generation
          LEFT JOIN journal_outcome_epochs head ON head.session_id=retired.session_id
          AND head.epoch=retired.epoch AND head.generation=retired.generation
          WHERE retired.session_id=? AND head.session_id IS NULL`
      )
      .get(sessionId)!
    return { rows: Number(row.n), payloadBytes: Number(row.bytes) }
  } finally {
    db.close()
  }
}
