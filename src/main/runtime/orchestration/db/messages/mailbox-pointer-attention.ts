import type { MessageType, MessageRow } from '../../types'
import type { OrchestrationDb } from '../orchestration-db'
import { exposeMessageListTimestamps } from '../utc-timestamp'

const OUTSIDE_FETCHED_BATCH_SQL = `NOT EXISTS (
  SELECT 1 FROM outstanding_deliveries AS delivery, json_each(delivery.message_ids) AS member
  WHERE delivery.mailbox_handle = messages.to_handle AND member.value = messages.id
)`

// Why: delivered_at IS NULL filter — push-on-idle delivers each row at most once; read (set only by check) wouldn't prevent replay.
export function getUndeliveredUnreadMessages(
  this: OrchestrationDb,
  toHandle: string,
  types?: MessageType[],
  options?: {
    excludeTypes?: readonly string[]
    excludeFetched?: boolean
    excludeMessageIds?: readonly string[]
    limit?: number
  }
): MessageRow[] {
  const conditions = [
    'to_handle = ?',
    'read = 0',
    'delivered_at IS NULL',
    'pointer_enter_pending = 0',
    "delivery_contract = 'current_delivery'"
  ]
  const params: (string | number)[] = [toHandle]
  if (options?.excludeFetched) {
    conditions.push(OUTSIDE_FETCHED_BATCH_SQL)
  }
  if (options?.excludeMessageIds?.length) {
    conditions.push('id NOT IN (SELECT value FROM json_each(?))')
    params.push(JSON.stringify(options.excludeMessageIds))
  }
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
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SELECT * reads the migrated messages schema represented by MessageRow.
    this.db
      .prepare(
        `SELECT * FROM messages
         WHERE ${conditions.join(' AND ')}
         ORDER BY sequence${limitSql}`
      )
      .all(...params) as MessageRow[]
  )
}

export function getMailboxPointerAttentionIds(
  this: OrchestrationDb,
  mailboxHandle: string,
  ids: readonly string[]
): string[] {
  if (ids.length === 0) {
    return []
  }
  return this.db
    .prepare(
      `SELECT id FROM messages INDEXED BY idx_messages_id
       WHERE to_handle = ? AND read = 0 AND delivered_at IS NULL
         AND delivery_contract = 'current_delivery'
         AND id IN (${ids.map(() => '?').join(',')}) AND ${OUTSIDE_FETCHED_BATCH_SQL}`
    )
    .all(mailboxHandle, ...ids)
    .flatMap((row) => (typeof row.id === 'string' ? [row.id] : []))
}
