// Read-only source sizes and persisted outline keys, queried outside either product arm.
import { openReadOnly, hasTable } from './native-chat-4a-sqlite-observer'

export type OutlineCacheState = {
  epoch: string
  sequence: number
  revision: number
  cacheSequence: number | null
  cacheRevision: number | null
  budgetBytes: number | null
  matchesSource: boolean
}

/** One statement observes the persisted cache key and its authoritative source together; no materialization is requested. */
export function outlineCacheState(file: string, sessionId: string): OutlineCacheState | null {
  const db = openReadOnly(file)
  try {
    if (!hasTable(db, 'journal_outline_cache')) {
      return null
    }
    const row = db
      .prepare(`SELECT head.epoch,head.last_sequence,head.submissions_revision,
      cache.source_sequence,cache.source_revision,cache.budget_bytes,
      json_valid(cache.outline_json) AS valid FROM journal_chat_state head
      LEFT JOIN journal_outline_cache cache ON cache.session_id=head.session_id AND cache.epoch=head.epoch
      WHERE head.session_id=?`)
      .get(sessionId)
    if (!row || row.epoch === null) {
      throw new Error('outline observation has no ready source')
    }
    return {
      epoch: String(row.epoch),
      sequence: Number(row.last_sequence),
      revision: Number(row.submissions_revision),
      cacheSequence: row.source_sequence === null ? null : Number(row.source_sequence),
      cacheRevision: row.source_revision === null ? null : Number(row.source_revision),
      budgetBytes: row.budget_bytes === null ? null : Number(row.budget_bytes),
      matchesSource:
        Boolean(row.valid) &&
        row.source_sequence === row.last_sequence &&
        row.source_revision === row.submissions_revision
    }
  } finally {
    db.close()
  }
}

/** Confirm the served outline equals the persisted value for the still-current source key (including its budget). */
export function outlineCacheContains(file: string, sessionId: string, value: unknown): boolean {
  const db = openReadOnly(file)
  try {
    return Boolean(
      db
        .prepare(`SELECT 1 FROM journal_outline_cache cache JOIN journal_chat_state head
      ON head.session_id=cache.session_id AND head.epoch=cache.epoch
      AND head.last_sequence=cache.source_sequence AND head.submissions_revision=cache.source_revision
      WHERE cache.session_id=? AND cache.outline_json=?`)
        .get(sessionId, JSON.stringify(value))
    )
  } finally {
    db.close()
  }
}

/** Read only the latest eight stored rows; SQLite returns the current ASCII stream's byte count, never its growing body. */
export function streamTextObserver(file: string, sessionId: string, marker: string) {
  const db = openReadOnly(file)
  const source = hasTable(db, 'journal_chat_state')
    ? `SELECT payload_json AS json FROM journal_items WHERE session_id=? AND epoch=
        (SELECT epoch FROM journal_chat_state WHERE session_id=?) ORDER BY ordinal DESC LIMIT 8`
    : `SELECT row_json AS json FROM journal_rows WHERE session_id=? AND epoch=
        (SELECT epoch FROM journal_sessions WHERE session_id=?) ORDER BY seq DESC LIMIT 8`
  const query =
    db.prepare(`SELECT octet_length(json_extract(json,'$.body.blocks[0].text')) AS bytes,
      json_extract(json,'$.body.state') AS state FROM (${source})
      WHERE substr(json_extract(json,'$.body.blocks[0].text'),1,length(?))=? LIMIT 1`)
  return {
    read: () => {
      const row = query.get(sessionId, sessionId, marker, marker)
      return { bytes: Number(row?.bytes ?? 0), completed: row?.state === 'completed' }
    },
    close: () => db.close()
  }
}
