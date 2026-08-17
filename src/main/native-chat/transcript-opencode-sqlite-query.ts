import type { NativeChatMessage } from '../../shared/native-chat-types'
import { extractString, parseJsonObject } from '../ai-vault/session-scanner-values'
import SyncDatabase from '../sqlite/sync-database'
import { opencodeMessageBlocks } from './transcript-opencode-part-blocks'

// Why: OpenCode (1.17+) persists sessions in one SQLite DB (opencode.db) —
// `message` rows (role/finish/tokens in `data` JSON) and `part` rows
// (text/reasoning/tool/step-start in `data` JSON). This module maps that onto
// the NativeChatMessage model (part→block mapping lives in
// transcript-opencode-part-blocks.ts). Electron-free: it runs on the OpenCode
// SQLite worker thread, like the AI-Vault scanner (#8864).
//
// Cursor model: pages key off the implicit `message` rowid (insert order, so
// monotonic within a session). The rowid doubles as the renderer-facing
// `beforeOffset` cursor, which the chat view treats as opaque.

/** One message plus the rowid/fingerprint metadata the live watcher diffs on. */
export type OpenCodeTranscriptItem = {
  rowid: number
  /** `${time_updated}:${partCount}` — changes when parts stream into a message. */
  fingerprint: string
  message: NativeChatMessage
}

export type OpenCodeTranscriptPage = {
  /** Oldest-first, messages with no renderable blocks dropped. */
  items: OpenCodeTranscriptItem[]
  hasMore: boolean
  /** Pagination cursor for the next older page: the oldest raw scanned row,
   *  except after an overshoot trim, where it is the oldest KEPT item's rowid
   *  so trimmed messages are re-read, never skipped. Null on an empty page. */
  beforeMessageRowId: number | null
}

/** Cheap change signal the live watcher polls instead of re-reading pages. */
export type OpenCodeTranscriptSignal = {
  messageCount: number
  partCount: number
  maxMessageRowId: number
  /** Catches in-place part updates (tool-result backfill) the counts miss. */
  maxPartTimeUpdated: number
}

/** Parts fetched per IN() batch — keeps the minted SQL arity bounded. */
const PART_ID_BATCH = 100

function openReadonlyDatabase(dbPath: string): SyncDatabase {
  const db = new SyncDatabase(dbPath, { readonly: true, fileMustExist: true })
  // Why: guard a SELECT bug from ever mutating the user's DB (same as the scanner).
  db.pragma('query_only = ON')
  return db
}

function sessionExists(db: SyncDatabase, sessionId: string): boolean {
  return db.prepare('SELECT 1 FROM session WHERE id = ?').get(sessionId) != null
}

/**
 * Poll-sized change signal for one session. Returns null when the session row
 * does not exist (yet) — the watcher keeps polling instead of settling a miss.
 */
export function readOpenCodeTranscriptSignal(
  dbPath: string,
  sessionId: string
): OpenCodeTranscriptSignal | null {
  const db = openReadonlyDatabase(dbPath)
  try {
    if (!sessionExists(db, sessionId)) {
      return null
    }
    const messageRow = db
      .prepare(
        'SELECT COUNT(*) AS message_count, COALESCE(MAX(rowid), 0) AS max_message_rowid FROM message WHERE session_id = ?'
      )
      .get(sessionId) as { message_count: number; max_message_rowid: number } | undefined
    const partRow = db
      .prepare(
        'SELECT COUNT(*) AS part_count, COALESCE(MAX(time_updated), 0) AS max_part_time_updated FROM part WHERE session_id = ?'
      )
      .get(sessionId) as { part_count: number; max_part_time_updated: number } | undefined
    return {
      messageCount: messageRow?.message_count ?? 0,
      partCount: partRow?.part_count ?? 0,
      maxMessageRowId: messageRow?.max_message_rowid ?? 0,
      maxPartTimeUpdated: partRow?.max_part_time_updated ?? 0
    }
  } finally {
    db.close()
  }
}

/**
 * Read one oldest-first page of a session's messages.
 * @param args.limit - Maximum renderable messages to return.
 * @param args.beforeMessageRowId - Page strictly older messages than this rowid.
 * @returns The page, or null when the session row does not exist in this DB.
 */
export function readOpenCodeTranscriptPage(args: {
  dbPath: string
  sessionId: string
  limit: number
  beforeMessageRowId?: number
}): OpenCodeTranscriptPage | null {
  const db = openReadonlyDatabase(args.dbPath)
  try {
    if (!sessionExists(db, args.sessionId)) {
      return null
    }
    // Why: same floor as the forward page — a 0/negative budget has no
    // meaningful page semantics and callers already clamp positive.
    const limit = Math.max(1, Math.floor(args.limit))
    // The upper bound is always bound: batching advances the cursor mid-page,
    // so the statement cannot vary with `beforeMessageRowId`'s presence.
    // MAX_SAFE_INTEGER is the "from the newest row" sentinel.
    const select = db.prepare(
      `SELECT rowid AS message_rowid, id, time_created, time_updated, data
         FROM message
         WHERE session_id = ? AND rowid < ?
         ORDER BY rowid DESC
         LIMIT ?`
    )
    // Why: like the forward page, `limit` counts renderable MESSAGES, not raw
    // rows — a window dense in non-renderable rows (step-start only) must not
    // come back under-filled (or empty) while older history remains, so keep
    // batching older raw rows until the message budget fills or rows run out.
    const collected: OpenCodeTranscriptItem[] = []
    let cursor: number | undefined = args.beforeMessageRowId
    let hasMore = false
    for (;;) {
      const rows = select.all(
        args.sessionId,
        cursor ?? Number.MAX_SAFE_INTEGER,
        limit + 1
      ) as MessageRow[]
      if (rows.length === 0) {
        break
      }
      // The (limit+1)th row is only a hasMore probe — never decoded.
      hasMore = rows.length > limit
      const selected = hasMore ? rows.slice(0, limit) : rows
      // Why: rows are newest-first, so the (limit+1)th probe row is the OLDEST —
      // drop it, never rows[0], or the page would lose the session's newest
      // message whenever more history exists.
      cursor = selected.at(-1)!.message_rowid
      collected.push(...mapMessageRows(db, args.sessionId, selected))
      if (!hasMore || collected.length >= limit) {
        break
      }
    }
    // Why: the batch that fills the budget can overshoot renderable messages.
    // Trim the OLDEST collected (keep the newest window) — but then the cursor
    // must name the oldest KEPT item: a raw-row cursor sits at/below the
    // trimmed messages, so the next `rowid < cursor` page would skip them
    // forever. Trimmed items also force hasMore — they are strictly more
    // pages below the kept window even when raw rows just ran out.
    const overshot = collected.length > limit
    const trimmed = overshot ? collected.slice(0, limit) : collected
    const items = trimmed.toReversed()
    return {
      items,
      hasMore: hasMore || overshot,
      // Why: raw-row cursor so a page of only non-renderable rows still
      // advances; after a trim, the oldest kept item's rowid keeps every
      // dropped message inside the next page's `rowid <` scan.
      beforeMessageRowId: overshot ? items[0]!.rowid : (cursor ?? null)
    }
  } finally {
    db.close()
  }
}

/** Forward page: strictly NEWER than a cursor, oldest-first — the rowid
 *  equivalent of the JSONL worker-read's byte-offset continuation. */
export type OpenCodeTranscriptForwardPage = {
  /** Oldest-first renderable messages after the cursor. */
  items: OpenCodeTranscriptItem[]
  hasMore: boolean
  /** Cursor the next continuation passes back: the newest KEPT item's rowid
   *  (after an overshoot trim, newer messages re-read next page), or the
   *  newest RAW scanned rowid when the page is empty — it advances even when
   *  every scanned row dropped as non-renderable, so a sparse page can never
   *  dead-end the `rowid >` walk. */
  nextMessageRowId: number
}

/**
 * Read the oldest-first messages STRICTLY NEWER than a rowid cursor, batching
 * raw rows until `limit` renderable messages are collected or rows run out.
 * @param args.afterMessageRowId - Resume strictly after this rowid.
 * @param args.limit - Maximum renderable messages to return.
 * @param args.upToMessageRowId - Frozen upper rowid boundary (archived pins);
 *   rows above it are excluded so the pin never leaks newer content.
 * @returns The page, or null when the session row does not exist in this DB.
 */
export function readOpenCodeTranscriptPageAfter(args: {
  dbPath: string
  sessionId: string
  afterMessageRowId: number
  limit: number
  upToMessageRowId?: number
}): OpenCodeTranscriptForwardPage | null {
  const db = openReadonlyDatabase(args.dbPath)
  try {
    if (!sessionExists(db, args.sessionId)) {
      return null
    }
    // Why: limit counts renderable MESSAGES (the worker-read contract), not raw
    // rows — a single raw batch can yield fewer messages than its row count, so
    // keep fetching batches until the message budget fills.
    const limit = Math.max(1, Math.floor(args.limit))
    const select = db.prepare(
      `SELECT rowid AS message_rowid, id, time_created, time_updated, data
         FROM message
         WHERE session_id = ? AND rowid > ?
           ${args.upToMessageRowId !== undefined ? 'AND rowid <= ?' : ''}
         ORDER BY rowid ASC
         LIMIT ?`
    )
    const items: OpenCodeTranscriptItem[] = []
    let cursor = args.afterMessageRowId
    let hasMore = false
    for (;;) {
      const rows = select.all(
        ...(args.upToMessageRowId !== undefined
          ? [args.sessionId, cursor, args.upToMessageRowId, limit + 1]
          : [args.sessionId, cursor, limit + 1])
      ) as MessageRow[]
      if (rows.length === 0) {
        break
      }
      // The (limit+1)th row is only a hasMore probe — never decoded.
      hasMore = rows.length > limit
      const selected = hasMore ? rows.slice(0, limit) : rows
      cursor = selected.at(-1)!.message_rowid
      items.push(...mapMessageRows(db, args.sessionId, selected))
      if (!hasMore || items.length >= limit) {
        break
      }
    }
    // Why: the batch that fills the budget can overshoot renderable messages;
    // trim the NEWEST collected — the cursor stops at the newest kept item so
    // the next continuation re-reads them, and hasMore must flag the trim:
    // the dropped messages are strictly newer pages even when raw rows ran
    // out mid-batch, so a probe-only `false` would strand them until the
    // caller happens to poll again.
    const overshot = items.length > limit
    const trimmed = overshot ? items.slice(0, limit) : items
    return {
      items: trimmed,
      hasMore: hasMore || overshot,
      nextMessageRowId: trimmed.length > 0 ? trimmed.at(-1)!.rowid : cursor
    }
  } finally {
    db.close()
  }
}

type MessageRow = {
  message_rowid: number
  id: string
  time_created: number
  time_updated: number
  data: string
}

type PartRow = {
  message_id: string
  time_updated: number
  data: string
}

function mapMessageRows(
  db: SyncDatabase,
  sessionId: string,
  rows: MessageRow[]
): OpenCodeTranscriptItem[] {
  if (rows.length === 0) {
    return []
  }
  const partsByMessage = new Map<string, PartRow[]>()
  const ids = rows.map((row) => row.id)
  for (let start = 0; start < ids.length; start += PART_ID_BATCH) {
    const batch = ids.slice(start, start + PART_ID_BATCH)
    const placeholders = batch.map(() => '?').join(', ')
    const partRows = db
      .prepare(
        `SELECT message_id, time_updated, data FROM part
         WHERE session_id = ? AND message_id IN (${placeholders})
         ORDER BY rowid`
      )
      .all(sessionId, ...batch) as PartRow[]
    for (const partRow of partRows) {
      const list = partsByMessage.get(partRow.message_id)
      if (list) {
        list.push(partRow)
      } else {
        partsByMessage.set(partRow.message_id, [partRow])
      }
    }
  }
  const items: OpenCodeTranscriptItem[] = []
  for (const row of rows) {
    const partList = partsByMessage.get(row.id) ?? []
    const blocks = opencodeMessageBlocks(partList)
    if (blocks.length === 0) {
      // Why: a streaming message starts as a bare row (only a step-start
      // part); emitting it would render an empty bubble, and its part rows
      // arrive later with a bumped time_updated fingerprint.
      continue
    }
    const record = parseJsonObject(row.data)
    const role = extractString(record?.role)
    items.push({
      rowid: row.message_rowid,
      // Why: fold MAX(part.time_updated) in — a tool-result backfill rewrites
      // an existing part row without adding one, so message time_updated plus
      // a part count alone cannot see it.
      fingerprint: `${row.time_updated}:${partList.length}:${maxPartTimeUpdated(partList)}`,
      message: {
        id: row.id,
        role: role === 'user' ? 'user' : role === 'assistant' ? 'assistant' : 'system',
        blocks,
        timestamp: Number.isFinite(row.time_created) ? row.time_created : null,
        source: 'transcript'
      }
    })
  }
  return items
}

function maxPartTimeUpdated(partRows: PartRow[]): number {
  let max = 0
  for (const partRow of partRows) {
    if (partRow.time_updated > max) {
      max = partRow.time_updated
    }
  }
  return max
}
