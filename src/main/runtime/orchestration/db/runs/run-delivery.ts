import type { MessageType, MessageRow, RunRow, DeliveryRow } from '../../types'
import { OrchestrationError } from '../../orchestration-error'
import { generateId } from '../generated-id'
import { exposeMessageListTimestamps, exposeDeliveryTimestamps } from '../utc-timestamp'
import { ORCHESTRATION_DELIVERY_BATCH_LIMIT } from '../messages/mailbox-routing-page'
import type { OrchestrationDb } from '../orchestration-db'

export function requireCurrentConsumer(
  this: OrchestrationDb,
  runId: string,
  consumerGeneration: number
): RunRow {
  const run = this.getRunRaw(runId)
  if (!run || run.legacy === 1 || run.consumer_generation !== consumerGeneration) {
    throw new OrchestrationError(
      'consumer_fenced',
      'This mailbox consumer has been replaced. Rebind with orchestration run-use.'
    )
  }
  return run
}

export function getDeliveryRaw(this: OrchestrationDb, id: string): DeliveryRow | undefined {
  return this.db.prepare('SELECT * FROM deliveries WHERE id = ?').get(id) as DeliveryRow | undefined
}

export function getDeliveryMessages(this: OrchestrationDb, delivery: DeliveryRow): MessageRow[] {
  const ids = JSON.parse(delivery.message_ids) as string[]
  if (ids.length === 0) {
    return []
  }
  const rows = this.db
    .prepare(`SELECT * FROM messages WHERE id IN (${ids.map(() => '?').join(',')})`)
    .all(...ids) as MessageRow[]
  const byId = new Map(rows.map((row) => [row.id, row]))
  return exposeMessageListTimestamps(
    ids.map((id) => byId.get(id)).filter((row): row is MessageRow => row !== undefined)
  )
}

export function getOrCreateRunDelivery(
  this: OrchestrationDb,
  params: {
    runId: string
    consumerGeneration: number
    limit?: number
    wakeTypes?: MessageType[]
  }
): { delivery: DeliveryRow; messages: MessageRow[]; replayed: boolean } | undefined {
  const limit = Math.min(
    Math.max(params.limit ?? ORCHESTRATION_DELIVERY_BATCH_LIMIT, 1),
    ORCHESTRATION_DELIVERY_BATCH_LIMIT
  )
  this.db.exec('BEGIN IMMEDIATE')
  try {
    this.requireCurrentConsumer(params.runId, params.consumerGeneration)
    const existing = this.db
      .prepare("SELECT * FROM deliveries WHERE run_id = ? AND status = 'outstanding'")
      .get(params.runId) as DeliveryRow | undefined
    if (existing) {
      if (existing.consumer_generation !== params.consumerGeneration) {
        throw new OrchestrationError(
          'consumer_fenced',
          'This mailbox Delivery belongs to a fenced consumer generation.'
        )
      }
      const messages = this.getDeliveryMessages(existing)
      this.db.exec('COMMIT')
      return { delivery: exposeDeliveryTimestamps(existing), messages, replayed: true }
    }

    const address = `run:${params.runId}`
    if (params.wakeTypes && params.wakeTypes.length > 0) {
      const placeholders = params.wakeTypes.map(() => '?').join(',')
      const matching = this.db
        .prepare(
          `SELECT 1 FROM messages
           WHERE run_id = ? AND to_handle = ? AND read = 0
             AND delivery_contract = 'current_delivery'
             AND type IN (${placeholders}) LIMIT 1`
        )
        .get(params.runId, address, ...params.wakeTypes)
      if (!matching) {
        this.db.exec('COMMIT')
        return undefined
      }
    }

    const messages = exposeMessageListTimestamps(
      this.db
        .prepare(
          `SELECT * FROM messages
           WHERE run_id = ? AND to_handle = ? AND read = 0
             AND delivery_contract = 'current_delivery'
           ORDER BY sequence ASC LIMIT ?`
        )
        .all(params.runId, address, limit) as MessageRow[]
    )
    if (messages.length === 0) {
      this.db.exec('COMMIT')
      return undefined
    }

    const deliveryId = generateId('delivery')
    this.db
      .prepare(
        `INSERT INTO deliveries (id, run_id, consumer_generation, message_ids)
         VALUES (?, ?, ?, ?)`
      )
      .run(
        deliveryId,
        params.runId,
        params.consumerGeneration,
        JSON.stringify(messages.map((message) => message.id))
      )
    const delivery = this.getDeliveryRaw(deliveryId) as DeliveryRow
    this.db.exec('COMMIT')
    return { delivery: exposeDeliveryTimestamps(delivery), messages, replayed: false }
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

export function acknowledgeRunDelivery(
  this: OrchestrationDb,
  params: {
    runId: string
    consumerGeneration: number
    deliveryId: string
  }
): { delivery: DeliveryRow; duplicate: boolean } {
  this.db.exec('BEGIN IMMEDIATE')
  try {
    this.requireCurrentConsumer(params.runId, params.consumerGeneration)
    const delivery = this.getDeliveryRaw(params.deliveryId)
    if (!delivery || delivery.run_id !== params.runId) {
      throw new OrchestrationError(
        'stale_delivery',
        `Delivery ${params.deliveryId} does not belong to this Run.`
      )
    }
    if (
      delivery.consumer_generation !== params.consumerGeneration ||
      delivery.status === 'fenced'
    ) {
      throw new OrchestrationError(
        'consumer_fenced',
        'This mailbox Delivery belongs to a fenced consumer generation.'
      )
    }
    if (delivery.status === 'acknowledged') {
      this.db.exec('COMMIT')
      return { delivery: exposeDeliveryTimestamps(delivery), duplicate: true }
    }

    const messageIds = JSON.parse(delivery.message_ids) as string[]
    if (messageIds.length > 0) {
      const placeholders = messageIds.map(() => '?').join(',')
      this.db
        .prepare(`UPDATE messages SET read = 1 WHERE id IN (${placeholders})`)
        .run(...messageIds)
    }
    this.db
      .prepare(
        "UPDATE deliveries SET status = 'acknowledged', acknowledged_at = datetime('now') WHERE id = ?"
      )
      .run(delivery.id)
    const acknowledged = this.getDeliveryRaw(delivery.id) as DeliveryRow
    this.db.exec('COMMIT')
    return { delivery: exposeDeliveryTimestamps(acknowledged), duplicate: false }
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

export function getRunMailboxHistory(
  this: OrchestrationDb,
  runId: string,
  limit = 100,
  types?: MessageType[]
): MessageRow[] {
  const address = `run:${runId}`
  // Why: SQLite reads a negative LIMIT as unbounded, so an unsanitized caller value dumps the whole mailbox.
  const rowLimit = Math.max(1, Math.floor(limit))
  if (types && types.length > 0) {
    const placeholders = types.map(() => '?').join(',')
    return exposeMessageListTimestamps(
      this.db
        .prepare(
          `SELECT * FROM messages WHERE run_id = ? AND to_handle = ?
           AND type IN (${placeholders}) ORDER BY sequence DESC LIMIT ?`
        )
        .all(runId, address, ...types, rowLimit) as MessageRow[]
    )
  }
  return exposeMessageListTimestamps(
    this.db
      .prepare(
        `SELECT * FROM messages WHERE run_id = ? AND to_handle = ?
         ORDER BY sequence DESC LIMIT ?`
      )
      .all(runId, address, rowLimit) as MessageRow[]
  )
}

export function getUnreadRunMailbox(
  this: OrchestrationDb,
  runId: string,
  limit = 100,
  types?: MessageType[]
): MessageRow[] {
  const address = `run:${runId}`
  const conditions = [
    'run_id = ?',
    'to_handle = ?',
    'read = 0',
    "delivery_contract = 'current_delivery'"
  ]
  const params: (string | number)[] = [runId, address]
  if (types?.length) {
    conditions.push(`type IN (${types.map(() => '?').join(',')})`)
    params.push(...types)
  }
  const indexClause = types?.length ? ' INDEXED BY idx_messages_unread_current_run_type' : ''
  params.push(Math.max(1, Math.floor(limit)))
  return exposeMessageListTimestamps(
    this.db
      .prepare(
        `SELECT * FROM messages${indexClause} WHERE ${conditions.join(' AND ')}
         ORDER BY sequence ASC LIMIT ?`
      )
      .all(...params) as MessageRow[]
  )
}

export function hasOutstandingRunDelivery(this: OrchestrationDb, runId: string): boolean {
  return Boolean(
    this.db
      .prepare("SELECT 1 FROM deliveries WHERE run_id = ? AND status = 'outstanding' LIMIT 1")
      .get(runId)
  )
}

export type RunDeliveryMethods = {
  requireCurrentConsumer: typeof requireCurrentConsumer
  getDeliveryRaw: typeof getDeliveryRaw
  getDeliveryMessages: typeof getDeliveryMessages
  getOrCreateRunDelivery: typeof getOrCreateRunDelivery
  acknowledgeRunDelivery: typeof acknowledgeRunDelivery
  getRunMailboxHistory: typeof getRunMailboxHistory
  getUnreadRunMailbox: typeof getUnreadRunMailbox
  hasOutstandingRunDelivery: typeof hasOutstandingRunDelivery
}

export function attachRunDelivery(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    requireCurrentConsumer,
    getDeliveryRaw,
    getDeliveryMessages,
    getOrCreateRunDelivery,
    acknowledgeRunDelivery,
    getRunMailboxHistory,
    getUnreadRunMailbox,
    hasOutstandingRunDelivery
  })
}
