// Read-only source sizes and persisted outline keys, queried outside either product arm.
import { openReadOnly, hasTable } from './native-chat-4a-sqlite-observer'

function openItemSource(file: string, sessionId: string) {
  const db = openReadOnly(file)
  try {
    const domain = hasTable(db, 'journal_chat_state')
    if (!domain && !hasTable(db, 'journal_outcomes')) {
      throw new Error('unsupported current-item storage; observation unexercised')
    }
    const head = domain
      ? `SELECT session_id,epoch,epoch AS source,
          (SELECT COALESCE(max(ordinal),0) FROM journal_items
          WHERE session_id=head.session_id AND epoch=head.epoch) AS position
          FROM journal_chat_state head WHERE session_id=?`
      : `SELECT head.session_id,head.epoch,head.generation AS source,head.through_seq AS position
          FROM journal_outcome_epochs head JOIN journal_sessions live
          ON live.session_id=head.session_id AND live.epoch=head.epoch
          WHERE head.session_id=? AND head.prefix_seq=0 AND head.format BETWEEN 1 AND 3`
    const baseline = db.prepare(head).get(sessionId)
    if (
      !baseline ||
      typeof baseline.epoch !== 'string' ||
      typeof baseline.position !== 'number' ||
      (typeof baseline.source !== 'string' && typeof baseline.source !== 'number')
    ) {
      throw new Error('no supported current item source; observation unexercised')
    }
    const tail = domain
      ? `SELECT head.epoch,head.source,item.ordinal AS position,item.item_id AS id,
          'items' AS field,0 AS deleted,item.rowid AS stored_row
          FROM journal_items item JOIN head ON item.session_id=head.session_id AND item.epoch=head.epoch
          WHERE item.ordinal>? ORDER BY item.ordinal DESC LIMIT ?`
      : `SELECT head.epoch,head.source,item.seq AS position,json_extract(item.entry_key,'$') AS id,
          item.field,item.deleted,item.rowid AS stored_row
          FROM journal_outcomes item JOIN head ON item.generation=head.source
          WHERE item.seq>? AND item.seq<=head.position ORDER BY item.seq DESC LIMIT ?`
    return {
      db,
      epoch: baseline.epoch,
      source: baseline.source,
      position: baseline.position,
      // Sort only bounded metadata; fetch bodies after obsolete revisions/deletions are excluded.
      items: `WITH head AS (${head}),recent AS (${tail}),latest AS (
        SELECT *,ROW_NUMBER() OVER (PARTITION BY field,id ORDER BY position DESC) AS rank FROM recent)
        SELECT latest.*,stored.${domain ? 'payload_json' : 'value_json'} AS json FROM latest
        JOIN ${domain ? 'journal_items' : 'journal_outcomes'} stored ON stored.rowid=latest.stored_row
        WHERE latest.rank=1 AND latest.field='items' AND typeof(latest.id)='text'
        AND latest.deleted=0 AND latest.epoch=? AND latest.source=?`,
      close: () => db.close()
    }
  } catch (error) {
    db.close()
    throw error
  }
}

/** Current burst identities only; each read releases its snapshot before the caller dispatches. */
export function runningToolsObserver(file: string, sessionId: string) {
  const source = openItemSource(file, sessionId)
  try {
    const query = source.db.prepare(`${source.items}
      AND json_extract(json,'$.body.kind')='tool-call' AND json_extract(json,'$.body.state')='running'`)
    return {
      epoch: source.epoch,
      position: source.position,
      read: () =>
        query
          .all(sessionId, source.position, 40, source.epoch, source.source)
          .map((item) => String(item.id)),
      close: source.close
    }
  } catch (error) {
    source.close()
    throw error
  }
}

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
    if (!hasTable(db, 'journal_chat_state') || !hasTable(db, 'journal_outline_cache')) {
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
    if (!hasTable(db, 'journal_chat_state') || !hasTable(db, 'journal_outline_cache')) {
      return false
    }
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

/** At most 40 source records, newest revision per key; SQLite returns bytes, never the growing ASCII body. */
export function streamTextObserver(file: string, sessionId: string, marker: string) {
  const source = openItemSource(file, sessionId)
  try {
    const query = source.db
      .prepare(`SELECT octet_length(json_extract(json,'$.body.blocks[0].text')) AS bytes,
      json_extract(json,'$.body.state') AS state FROM (${source.items})
      WHERE substr(json_extract(json,'$.body.blocks[0].text'),1,length(?))=? ORDER BY position DESC LIMIT 1`)
    return {
      read: () => {
        const row = query.get(sessionId, -1, 40, source.epoch, source.source, marker, marker)
        return { bytes: Number(row?.bytes ?? 0), completed: row?.state === 'completed' }
      },
      close: source.close
    }
  } catch (error) {
    source.close()
    throw error
  }
}
