import type { MessageType, MessageRow } from '../../types'
import { exposeMessageTimestamps, exposeMessageListTimestamps } from '../utc-timestamp'
import { addLifecycleRejectionMarker } from '../lifecycle-rejection-marker'
import type { OrchestrationDb } from '../orchestration-db'

const MESSAGE_ID_UPDATE_BATCH_SIZE = 500
const MESSAGE_MUTATION_SAVEPOINT = 'message_id_mutation'

function runBatchedMessageMutation(
  db: OrchestrationDb,
  ids: string[],
  sqlForPlaceholders: (placeholders: string) => string
): void {
  if (ids.length === 0) {
    return
  }
  db.db.exec(`SAVEPOINT ${MESSAGE_MUTATION_SAVEPOINT}`)
  try {
    for (let offset = 0; offset < ids.length; offset += MESSAGE_ID_UPDATE_BATCH_SIZE) {
      const batch = ids.slice(offset, offset + MESSAGE_ID_UPDATE_BATCH_SIZE)
      const placeholders = batch.map(() => '?').join(',')
      db.db.prepare(sqlForPlaceholders(placeholders)).run(...batch)
    }
    db.db.exec(`RELEASE ${MESSAGE_MUTATION_SAVEPOINT}`)
  } catch (error) {
    db.db.exec(`ROLLBACK TO ${MESSAGE_MUTATION_SAVEPOINT}`)
    db.db.exec(`RELEASE ${MESSAGE_MUTATION_SAVEPOINT}`)
    throw error
  }
}

export function getUnreadMessages(
  this: OrchestrationDb,
  toHandle: string,
  types?: MessageType[]
): MessageRow[] {
  if (types && types.length > 0) {
    const placeholders = types.map(() => '?').join(',')
    return exposeMessageListTimestamps(
      this.db
        .prepare(
          `SELECT * FROM messages
           WHERE to_handle = ? AND read = 0 AND delivery_contract = 'current_delivery'
             AND type IN (${placeholders}) ORDER BY sequence`
        )
        .all(toHandle, ...types) as MessageRow[]
    )
  }
  return exposeMessageListTimestamps(
    this.db
      .prepare(
        `SELECT * FROM messages
         WHERE to_handle = ? AND read = 0 AND delivery_contract = 'current_delivery'
         ORDER BY sequence`
      )
      .all(toHandle) as MessageRow[]
  )
}

export function convertLifecycleMessageToRejection(
  this: OrchestrationDb,
  messageId: string,
  code: string,
  reason: string
): MessageRow | undefined {
  const message = this.getMessageById(messageId)
  if (
    !message ||
    !['worker_done', 'heartbeat', 'escalation', 'decision_gate'].includes(message.type)
  ) {
    return message
  }

  const originalBody = message.body ? `\n\nOriginal body:\n${message.body}` : ''
  const body = `Orca rejected this ${message.type}: ${reason}${originalBody}`
  const payload = addLifecycleRejectionMarker(message.payload, code, reason)
  // Why: rejected lifecycle signals stay auditable but must not reach read paths as actionable completion/liveness events.
  this.db
    .prepare(
      `UPDATE messages
       SET type = CASE WHEN type IN ('escalation', 'decision_gate') THEN 'status' ELSE type END,
           priority = 'high', subject = ?, body = ?, payload = ?
       WHERE id = ?`
    )
    .run(`Rejected ${message.type}: ${message.subject}`, body, payload, messageId)
  return this.getMessageById(messageId)
}

// Why: delivered_at IS NULL filter — push-on-idle delivers each row at most once; read (set only by check) wouldn't prevent replay.
export function getUndeliveredUnreadMessages(
  this: OrchestrationDb,
  toHandle: string,
  types?: MessageType[],
  options?: { excludeTypes?: readonly string[]; limit?: number }
): MessageRow[] {
  const conditions = [
    'to_handle = ?',
    'read = 0',
    'delivered_at IS NULL',
    'pointer_enter_pending = 0',
    "delivery_contract = 'current_delivery'"
  ]
  const params: (string | number)[] = [toHandle]
  if (types?.length) {
    conditions.push(`type IN (${types.map(() => '?').join(',')})`)
    params.push(...types)
  }
  if (options?.excludeTypes?.length) {
    conditions.push(`type NOT IN (${options.excludeTypes.map(() => '?').join(',')})`)
    params.push(...options.excludeTypes)
  }
  const limitSql = options?.limit === undefined ? '' : ' LIMIT ?'
  if (options?.limit !== undefined) {
    params.push(Math.max(1, Math.floor(options.limit)))
  }
  return exposeMessageListTimestamps(
    this.db
      .prepare(
        `SELECT * FROM messages
         WHERE ${conditions.join(' AND ')}
         ORDER BY sequence${limitSql}`
      )
      .all(...params) as MessageRow[]
  )
}

export function getUndeliveredUnreadMailboxHandles(this: OrchestrationDb): string[] {
  return (
    this.db
      .prepare(
        `SELECT DISTINCT to_handle FROM messages
         WHERE read = 0 AND delivered_at IS NULL
           AND pointer_enter_pending = 0
           AND delivery_contract = 'current_delivery'`
      )
      .all() as { to_handle: string }[]
  ).map((row) => row.to_handle)
}

export function getAllMessages(this: OrchestrationDb, toHandle: string, limit = 20): MessageRow[] {
  return exposeMessageListTimestamps(
    this.db
      .prepare('SELECT * FROM messages WHERE to_handle = ? ORDER BY sequence DESC LIMIT ?')
      .all(toHandle, limit) as MessageRow[]
  )
}

export function getMessageById(this: OrchestrationDb, id: string): MessageRow | undefined {
  const message = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as
    | MessageRow
    | undefined
  return message ? exposeMessageTimestamps(message) : undefined
}

export function markAsRead(this: OrchestrationDb, ids: string[]): void {
  runBatchedMessageMutation(
    this,
    ids,
    (placeholders) =>
      `UPDATE messages
       SET read = 1, pointer_enter_pending = 0, pointer_pty_id = NULL,
           pointer_process_incarnation = NULL
       WHERE id IN (${placeholders})`
  )
}

// Why: use datetime('now') so delivered_at matches the space-format UTC shape of the table's other timestamps for correct ordering (§3.2).
export function markAsDelivered(this: OrchestrationDb, ids: string[]): void {
  runBatchedMessageMutation(
    this,
    ids,
    (placeholders) =>
      `UPDATE messages
       SET delivered_at = datetime('now'), pointer_enter_pending = 0,
           pointer_pty_id = NULL, pointer_process_incarnation = NULL
       WHERE id IN (${placeholders})`
  )
}

export function markAsUndelivered(this: OrchestrationDb, ids: string[]): void {
  runBatchedMessageMutation(
    this,
    ids,
    (placeholders) =>
      `UPDATE messages
       SET delivered_at = NULL, pointer_enter_pending = 0, pointer_pty_id = NULL,
           pointer_process_incarnation = NULL
       WHERE read = 0 AND id IN (${placeholders})`
  )
}

export function areUnreadMessages(this: OrchestrationDb, toHandle: string, ids: string[]): boolean {
  let matched = 0
  for (let offset = 0; offset < ids.length; offset += MESSAGE_ID_UPDATE_BATCH_SIZE) {
    const batch = ids.slice(offset, offset + MESSAGE_ID_UPDATE_BATCH_SIZE)
    const placeholders = batch.map(() => '?').join(',')
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM messages INDEXED BY idx_messages_id
         WHERE to_handle = ? AND read = 0 AND delivery_contract = 'current_delivery'
           AND id IN (${placeholders})`
      )
      .get(toHandle, ...batch) as { count: number }
    matched += row.count
  }
  return matched === ids.length
}

// Why: superseded lifecycle messages stay in history but must not be consumed or injected after their dispatch finished.
export function markAsReadAndDelivered(this: OrchestrationDb, ids: string[]): void {
  runBatchedMessageMutation(
    this,
    ids,
    (placeholders) =>
      `UPDATE messages
       SET read = 1, delivered_at = COALESCE(delivered_at, datetime('now')),
           pointer_enter_pending = 0, pointer_pty_id = NULL,
           pointer_process_incarnation = NULL
       WHERE id IN (${placeholders})`
  )
}

export function getInbox(this: OrchestrationDb, limit = 20): MessageRow[] {
  return exposeMessageListTimestamps(
    this.db
      .prepare('SELECT * FROM messages ORDER BY sequence DESC LIMIT ?')
      .all(limit) as MessageRow[]
  )
}

// Why: read-only history for a handle — returns every message regardless of read/delivered state, never flips the read bit (§3.3).
export function getAllMessagesForHandle(
  this: OrchestrationDb,
  toHandle: string,
  limit = 100,
  types?: MessageType[]
): MessageRow[] {
  if (types && types.length > 0) {
    const placeholders = types.map(() => '?').join(',')
    return exposeMessageListTimestamps(
      this.db
        .prepare(
          `SELECT * FROM messages WHERE to_handle = ? AND type IN (${placeholders}) ORDER BY sequence DESC LIMIT ?`
        )
        .all(toHandle, ...types, limit) as MessageRow[]
    )
  }
  return exposeMessageListTimestamps(
    this.db
      .prepare('SELECT * FROM messages WHERE to_handle = ? ORDER BY sequence DESC LIMIT ?')
      .all(toHandle, limit) as MessageRow[]
  )
}

// Why: ask wait-loop read — to_handle filter shows only replies to the worker; afterSequence resumes past its own outbound ask.
export function getThreadMessagesFor(
  this: OrchestrationDb,
  threadId: string,
  toHandle: string,
  afterSequence?: number
): MessageRow[] {
  if (afterSequence !== undefined) {
    return exposeMessageListTimestamps(
      this.db
        .prepare(
          'SELECT * FROM messages WHERE thread_id = ? AND to_handle = ? AND sequence > ? ORDER BY sequence ASC'
        )
        .all(threadId, toHandle, afterSequence) as MessageRow[]
    )
  }
  return exposeMessageListTimestamps(
    this.db
      .prepare('SELECT * FROM messages WHERE thread_id = ? AND to_handle = ? ORDER BY sequence ASC')
      .all(threadId, toHandle) as MessageRow[]
  )
}

export type MessageInboxMethods = {
  getUnreadMessages: typeof getUnreadMessages
  convertLifecycleMessageToRejection: typeof convertLifecycleMessageToRejection
  getUndeliveredUnreadMessages: typeof getUndeliveredUnreadMessages
  getUndeliveredUnreadMailboxHandles: typeof getUndeliveredUnreadMailboxHandles
  getAllMessages: typeof getAllMessages
  getMessageById: typeof getMessageById
  markAsRead: typeof markAsRead
  markAsDelivered: typeof markAsDelivered
  markAsUndelivered: typeof markAsUndelivered
  areUnreadMessages: typeof areUnreadMessages
  markAsReadAndDelivered: typeof markAsReadAndDelivered
  getInbox: typeof getInbox
  getAllMessagesForHandle: typeof getAllMessagesForHandle
  getThreadMessagesFor: typeof getThreadMessagesFor
}

export function attachMessageInbox(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    getUnreadMessages,
    convertLifecycleMessageToRejection,
    getUndeliveredUnreadMessages,
    getUndeliveredUnreadMailboxHandles,
    getAllMessages,
    getMessageById,
    markAsRead,
    markAsDelivered,
    markAsUndelivered,
    areUnreadMessages,
    markAsReadAndDelivered,
    getInbox,
    getAllMessagesForHandle,
    getThreadMessagesFor
  })
}
