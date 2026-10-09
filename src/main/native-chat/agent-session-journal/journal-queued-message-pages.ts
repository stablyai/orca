import { randomUUID } from 'node:crypto'
import {
  isAgentSessionQueueSource,
  type AgentSessionQueueSource
} from '../../../shared/agent-session-queue-pages'
import type { SqliteBindings } from '../../sqlite/sqlite-statement'
import type { JournalHostDatabase } from './journal-host-database'
import { getQueuedMessageHeader } from './queued-message-headers'
import { readStoredQueuedMessageRow } from './queued-message-stored-row'
import {
  QUEUED_MESSAGE_SOURCE_SQL,
  QUEUED_MESSAGE_UNSETTLED_SQL
} from './queued-message-source-index'

export type QueuePageAnchor = { position: number; messageId: string }
export type QueuePageRange = {
  source?: AgentSessionQueueSource
  anchor?: QueuePageAnchor
  direction: 'before' | 'after'
  inclusive?: boolean
}

function sourceBindings(source: AgentSessionQueueSource | undefined): SqliteBindings {
  return source === undefined ? [] : [source]
}

function rangeSql(range: QueuePageRange): { sql: string; bindings: SqliteBindings } {
  const comparison = range.direction === 'before' ? '<' : '>'
  return {
    sql: `${range.source === undefined ? '' : `AND ${QUEUED_MESSAGE_SOURCE_SQL} = ?`}
      ${range.anchor ? `AND (position, message_id) ${comparison}${range.inclusive ? '=' : ''} (?, ?)` : ''}`,
    bindings: [
      ...sourceBindings(range.source),
      ...(range.anchor ? [range.anchor.position, range.anchor.messageId] : [])
    ]
  }
}

export class JournalQueuedMessagePages {
  private incarnation = randomUUID()
  private epoch: string | undefined

  constructor(
    private readonly database: () => JournalHostDatabase,
    private readonly sessionId: string
  ) {}

  generation(epoch: string): string {
    if (this.epoch !== undefined && this.epoch !== epoch) {
      this.incarnation = randomUUID()
    }
    this.epoch = epoch
    return this.incarnation
  }

  read<T>(run: () => T): T {
    const database = this.database()
    return database.db.isTransaction ? run() : database.readTransaction(run)
  }

  counts(): Record<AgentSessionQueueSource, number> {
    const counts = { person: 0, agent: 0, unknown: 0 }
    for (const row of this.database()
      .db.prepare(`
      SELECT ${QUEUED_MESSAGE_SOURCE_SQL} AS source, COUNT(*) AS count
      FROM queued_messages WHERE session_id = ? AND ${QUEUED_MESSAGE_UNSETTLED_SQL}
      GROUP BY ${QUEUED_MESSAGE_SOURCE_SQL}`)
      .all(this.sessionId)) {
      if (isAgentSessionQueueSource(row.source) && typeof row.count === 'number') {
        counts[row.source] = row.count
      }
    }
    return counts
  }

  newestPersonMessageId(): string | null {
    const row = this.database()
      .db.prepare(`
      SELECT message_id FROM queued_messages
      WHERE session_id = ? AND ${QUEUED_MESSAGE_UNSETTLED_SQL} AND ${QUEUED_MESSAGE_SOURCE_SQL} = 'person'
      ORDER BY created_at DESC, position DESC, message_id DESC LIMIT 1`)
      .get(this.sessionId)
    return typeof row?.message_id === 'string' ? row.message_id : null
  }

  blockingReturnedMessageId(): string | null {
    const row = this.database()
      .db.prepare(`SELECT message_id FROM queued_messages
      WHERE session_id = ? AND state = 'returned' AND ${QUEUED_MESSAGE_UNSETTLED_SQL}
      ORDER BY position, message_id LIMIT 1`)
      .get(this.sessionId)
    return typeof row?.message_id === 'string' ? row.message_id : null
  }

  anchor(messageId: string, source?: AgentSessionQueueSource): QueuePageAnchor | null {
    const row = this.database()
      .db.prepare(`
      SELECT message_id, position FROM queued_messages
      WHERE session_id = ? AND message_id = ? AND ${QUEUED_MESSAGE_UNSETTLED_SQL}
      ${source === undefined ? '' : `AND ${QUEUED_MESSAGE_SOURCE_SQL} = ?`}`)
      .get(this.sessionId, messageId, ...sourceBindings(source))
    return typeof row?.message_id === 'string' && typeof row.position === 'number'
      ? { messageId: row.message_id, position: row.position }
      : null
  }

  hasRows(range: QueuePageRange): boolean {
    const { sql, bindings } = rangeSql(range)
    const row = this.database()
      .db.prepare(`
      SELECT 1 FROM queued_messages
      WHERE session_id = ? AND ${QUEUED_MESSAGE_UNSETTLED_SQL} ${sql}
      LIMIT 1`)
      .get(this.sessionId, ...bindings)
    return row !== undefined
  }

  *rows(range: QueuePageRange, size: number) {
    const { sql, bindings } = rangeSql(range)
    const order = range.direction === 'before' ? 'DESC' : 'ASC'
    for (const stored of this.database()
      .db.prepare(`
      SELECT session_id, message_id, position, body_json, fingerprint, created_at, host_instance,
        state, hold_reason, returned_reason, returned_rejection, settled_at, settled_by_op,
        consumed_as, carried_from, queued_epoch, queued_sequence,
        length(CAST(body_json AS BLOB)) AS body_bytes, ${QUEUED_MESSAGE_SOURCE_SQL} AS source
      FROM queued_messages WHERE session_id = ? AND ${QUEUED_MESSAGE_UNSETTLED_SQL} ${sql}
      ORDER BY position ${order}, message_id ${order} LIMIT ?`)
      .iterate(this.sessionId, ...bindings, size)) {
      const row = readStoredQueuedMessageRow(stored)
      const source = stored.source
      if (row && typeof stored.body_bytes === 'number' && isAgentSessionQueueSource(source)) {
        yield { row, source, bodyBytes: stored.body_bytes }
      }
    }
  }

  body(messageId: string) {
    const db = this.database().db
    const header = getQueuedMessageHeader(db, this.sessionId, messageId)
    if (!header || (header.state !== 'waiting' && header.state !== 'returned')) {
      return { header, json: null, bodyBytes: 0 }
    }
    const row = db
      .prepare(`SELECT body_json, length(CAST(body_json AS BLOB)) AS bytes
      FROM queued_messages WHERE session_id = ? AND message_id = ?`)
      .get(this.sessionId, messageId)
    return {
      header,
      json: typeof row?.body_json === 'string' ? row.body_json : null,
      bodyBytes: typeof row?.bytes === 'number' ? row.bytes : 0
    }
  }
}
