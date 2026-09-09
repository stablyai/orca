import type { DeliveryRow, MessageRow, MessageType } from '../../types'
import { OrchestrationError } from '../../orchestration-error'
import { generateId } from '../generated-id'
import type { OrchestrationDb } from '../orchestration-db'
import { exposeDeliveryTimestamps, exposeMessageListTimestamps } from '../utc-timestamp'
import { ORCHESTRATION_DELIVERY_BATCH_LIMIT } from './mailbox-routing-page'

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

export function getOrCreateMailboxDelivery(
  this: OrchestrationDb,
  params: {
    runId: string
    mailboxHandle: string
    consumerGeneration: number
    limit?: number
    wakeTypes?: MessageType[]
    requireCurrentRunConsumer?: boolean
  }
): { delivery: DeliveryRow; messages: MessageRow[]; replayed: boolean } | undefined {
  const limit = Math.min(
    Math.max(params.limit ?? ORCHESTRATION_DELIVERY_BATCH_LIMIT, 1),
    ORCHESTRATION_DELIVERY_BATCH_LIMIT
  )
  this.db.exec('BEGIN IMMEDIATE')
  try {
    if (params.requireCurrentRunConsumer) {
      this.requireCurrentConsumer(params.runId, params.consumerGeneration)
    }
    const existing = this.db
      .prepare("SELECT * FROM deliveries WHERE mailbox_handle = ? AND status = 'outstanding'")
      .get(params.mailboxHandle) as DeliveryRow | undefined
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
    if (params.wakeTypes?.length) {
      const placeholders = params.wakeTypes.map(() => '?').join(',')
      const matching = this.db
        .prepare(
          `SELECT 1 FROM messages
           WHERE run_id = ? AND to_handle = ? AND read = 0
             AND delivery_contract = 'current_delivery'
             AND type IN (${placeholders}) LIMIT 1`
        )
        .get(params.runId, params.mailboxHandle, ...params.wakeTypes)
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
        .all(params.runId, params.mailboxHandle, limit) as MessageRow[]
    )
    if (messages.length === 0) {
      this.db.exec('COMMIT')
      return undefined
    }
    const deliveryId = generateId('delivery')
    this.db
      .prepare(
        `INSERT INTO deliveries (
           id, run_id, mailbox_handle, consumer_generation, message_ids
         ) VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        deliveryId,
        params.runId,
        params.mailboxHandle,
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

export function acknowledgeMailboxDelivery(
  this: OrchestrationDb,
  params: {
    runId: string
    mailboxHandle: string
    consumerGeneration: number
    deliveryId: string
    requireCurrentRunConsumer?: boolean
  }
): { delivery: DeliveryRow; duplicate: boolean } {
  this.db.exec('BEGIN IMMEDIATE')
  try {
    if (params.requireCurrentRunConsumer) {
      this.requireCurrentConsumer(params.runId, params.consumerGeneration)
    }
    const delivery = this.getDeliveryRaw(params.deliveryId)
    if (
      !delivery ||
      delivery.run_id !== params.runId ||
      delivery.mailbox_handle !== params.mailboxHandle
    ) {
      throw new OrchestrationError(
        'stale_delivery',
        `Delivery ${params.deliveryId} does not belong to this mailbox.`
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
        .prepare(
          `UPDATE messages
           SET read = 1, pointer_enter_pending = 0, pointer_pty_id = NULL,
               pointer_process_incarnation = NULL
           WHERE id IN (${placeholders})`
        )
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

export function hasOutstandingMailboxDelivery(
  this: OrchestrationDb,
  mailboxHandle: string
): boolean {
  return Boolean(
    this.db
      .prepare(
        "SELECT 1 FROM deliveries WHERE mailbox_handle = ? AND status = 'outstanding' LIMIT 1"
      )
      .get(mailboxHandle)
  )
}

export function fenceOutstandingMailboxDelivery(
  this: OrchestrationDb,
  mailboxHandle: string
): void {
  this.db
    .prepare(
      "UPDATE deliveries SET status = 'fenced' WHERE mailbox_handle = ? AND status = 'outstanding'"
    )
    .run(mailboxHandle)
}

export type RoleMailboxDeliveryMethods = {
  getDeliveryRaw: typeof getDeliveryRaw
  getDeliveryMessages: typeof getDeliveryMessages
  getOrCreateMailboxDelivery: typeof getOrCreateMailboxDelivery
  acknowledgeMailboxDelivery: typeof acknowledgeMailboxDelivery
  hasOutstandingMailboxDelivery: typeof hasOutstandingMailboxDelivery
  fenceOutstandingMailboxDelivery: typeof fenceOutstandingMailboxDelivery
}

export function attachRoleMailboxDelivery(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    getDeliveryRaw,
    getDeliveryMessages,
    getOrCreateMailboxDelivery,
    acknowledgeMailboxDelivery,
    hasOutstandingMailboxDelivery,
    fenceOutstandingMailboxDelivery
  })
}
