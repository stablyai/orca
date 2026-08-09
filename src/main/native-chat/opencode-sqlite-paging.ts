import type { NativeChatMessage } from '../../shared/native-chat-types'
import type SyncDatabase from '../sqlite/sync-database'

// SQLite's variable-bind limit is 999 by default; keep the parts IN-list well below it.
const OPENCODE_PART_MESSAGE_BATCH = 400

export type OpenCodeMessageRow = {
  id: string
  time_created: number
  data: string | null
}

export type OpenCodePartRow = {
  id: string
  message_id: string
  time_created: number
  data: string | null
}

type OpenCodeMappedMessage = {
  offset: number
  message: NativeChatMessage
}

export type OpenCodeMessageMapper = (
  message: OpenCodeMessageRow,
  parts: OpenCodePartRow[]
) => NativeChatMessage | null

function dedupeMappedOpenCodeMessages(
  mapped: readonly OpenCodeMappedMessage[]
): OpenCodeMappedMessage[] {
  const byId = new Map<string, OpenCodeMappedMessage>()
  for (const entry of mapped) {
    if (!byId.has(entry.message.id)) {
      byId.set(entry.message.id, entry)
    }
  }
  return [...byId.values()].sort((left, right) => left.offset - right.offset)
}

function selectOpenCodeWindowMessages(
  db: SyncDatabase,
  sessionId: string,
  limit: number,
  offset: number
): OpenCodeMessageRow[] {
  return db
    .prepare(
      `SELECT m.id, m.time_created, m.data
       FROM message m
       WHERE m.session_id = ?
       ORDER BY m.time_created ASC, m.id ASC
       LIMIT ? OFFSET ?`
    )
    .all(sessionId, limit, offset) as OpenCodeMessageRow[]
}

function selectOpenCodePartsForMessages(
  db: SyncDatabase,
  sessionId: string,
  filterBySessionId: boolean,
  messageIds: readonly string[]
): OpenCodePartRow[] {
  const rows: OpenCodePartRow[] = []
  for (let start = 0; start < messageIds.length; start += OPENCODE_PART_MESSAGE_BATCH) {
    const chunk = messageIds.slice(start, start + OPENCODE_PART_MESSAGE_BATCH)
    const placeholders = chunk.map(() => '?').join(', ')
    const batch = db
      .prepare(
        `SELECT id, message_id, time_created, data
         FROM part
         WHERE message_id IN (${placeholders})
           ${filterBySessionId ? 'AND session_id = ?' : ''}
         ORDER BY message_id ASC, time_created ASC, id ASC`
      )
      .all(...chunk, ...(filterBySessionId ? [sessionId] : [])) as OpenCodePartRow[]
    rows.push(...batch)
  }
  return rows
}

function mapOpenCodeWindowMessages(
  db: SyncDatabase,
  sessionId: string,
  filterPartsBySessionId: boolean,
  messageRows: readonly OpenCodeMessageRow[],
  offset: number,
  mapMessage: OpenCodeMessageMapper
): OpenCodeMappedMessage[] {
  const parts = selectOpenCodePartsForMessages(
    db,
    sessionId,
    filterPartsBySessionId,
    messageRows.map((row) => row.id)
  )
  const partsByMessage = new Map<string, OpenCodePartRow[]>()
  for (const part of parts) {
    const bucket = partsByMessage.get(part.message_id)
    if (bucket) {
      bucket.push(part)
    } else {
      partsByMessage.set(part.message_id, [part])
    }
  }

  const mapped: OpenCodeMappedMessage[] = []
  for (const [index, row] of messageRows.entries()) {
    const message = mapMessage(row, partsByMessage.get(row.id) ?? [])
    if (message) {
      mapped.push({ offset: offset + index, message })
    }
  }
  return dedupeMappedOpenCodeMessages(mapped)
}

function readMappedOpenCodeWindow(
  db: SyncDatabase,
  sessionId: string,
  filterPartsBySessionId: boolean,
  offset: number,
  limit: number,
  mapMessage: OpenCodeMessageMapper
): OpenCodeMappedMessage[] {
  return mapOpenCodeWindowMessages(
    db,
    sessionId,
    filterPartsBySessionId,
    selectOpenCodeWindowMessages(db, sessionId, limit, offset),
    offset,
    mapMessage
  )
}

function hasMappedOpenCodeMessageBefore(
  db: SyncDatabase,
  sessionId: string,
  filterPartsBySessionId: boolean,
  beforeOffset: number,
  scanLimit: number,
  mapMessage: OpenCodeMessageMapper
): boolean {
  let cursor = beforeOffset
  while (cursor > 0) {
    const start = Math.max(0, cursor - scanLimit)
    if (
      readMappedOpenCodeWindow(
        db,
        sessionId,
        filterPartsBySessionId,
        start,
        cursor - start,
        mapMessage
      ).length > 0
    ) {
      return true
    }
    cursor = start
  }
  return false
}

export function readMappedOpenCodeTail(args: {
  db: SyncDatabase
  sessionId: string
  windowEnd: number
  limit: number
  mapMessage: OpenCodeMessageMapper
  /** Newer schemas include part.session_id; keep older DBs readable. */
  filterPartsBySessionId?: boolean
}): { messages: NativeChatMessage[]; hasMore: boolean; beforeOffset: number } {
  const { db, sessionId, windowEnd, mapMessage } = args
  const limit = Number.isInteger(args.limit) && args.limit > 0 ? args.limit : 0
  const filterPartsBySessionId = args.filterPartsBySessionId === true
  const normalizedWindowEnd =
    Number.isInteger(windowEnd) && windowEnd > 0
      ? windowEnd
      : Number.isFinite(windowEnd) && windowEnd > 0
        ? Math.floor(windowEnd)
        : 0
  if (limit === 0 || normalizedWindowEnd === 0) {
    return { messages: [], hasMore: false, beforeOffset: 0 }
  }
  const scanLimit = Math.max(limit, 40)
  let cursor = normalizedWindowEnd
  let mapped: OpenCodeMappedMessage[] = []

  // Page over raw rows in bounded chunks, but use mapped rows for the visible
  // page so malformed/lifecycle rows cannot consume a history slot.
  while (cursor > 0 && mapped.length < limit) {
    const start = Math.max(0, cursor - scanLimit)
    mapped = [
      ...readMappedOpenCodeWindow(
        db,
        sessionId,
        filterPartsBySessionId,
        start,
        cursor - start,
        mapMessage
      ),
      ...mapped
    ]
    cursor = start
  }

  const dedupedMapped = dedupeMappedOpenCodeMessages(mapped)
  const selected = dedupedMapped.slice(-limit)
  const beforeOffset = selected[0]?.offset ?? 0
  const hasScannedEarlierMessage = dedupedMapped.some(({ offset }) => offset < beforeOffset)
  return {
    messages: selected.map(({ message }) => message),
    hasMore:
      beforeOffset > 0 &&
      (hasScannedEarlierMessage ||
        (cursor > 0 &&
          hasMappedOpenCodeMessageBefore(
            db,
            sessionId,
            filterPartsBySessionId,
            beforeOffset,
            scanLimit,
            mapMessage
          ))),
    beforeOffset
  }
}
