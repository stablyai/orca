import {
  finalizeMailboxDelivery,
  markDeliveryAcknowledged,
  requireDeliveryRaw
} from './mailbox-delivery-finalization'
export { finalizeMailboxDelivery } from './mailbox-delivery-finalization'
import type { DeliveryRow, MessageRow, MessageType } from '../orchestration-records'
import { OrchestrationError } from '../../orchestration-error'
import { generateId } from '../generated-id'
import type { OrchestrationDb } from '../orchestration-db'
import { exposeDeliveryTimestamps, exposeMessageListTimestamps } from '../utc-timestamp'
import { requireMailboxConsumer } from './mailbox-consumer'
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

export type MailboxDeliveryParams = {
  runId: string
  mailboxHandle: string
  consumerGeneration: number
  consumerSource?: 'dispatch' | 'attachment'
  limit?: number
  wakeTypes?: MessageType[]
}

export type MailboxDeliveryBatch = {
  delivery: DeliveryRow
  messages: MessageRow[]
  replayed: boolean
  finalResponse?: {
    runId: string
    dispatchId?: string
    deliveryId: string | null
    messages: object[]
    count: number
    replayed: boolean
    deliveryAcknowledged?: boolean
    acknowledged: string | null
    timedOut: boolean
    cancelled: boolean
    connectionLost: boolean
    formatted?: string
    next?: string
  }
}

export function getOrCreateMailboxDelivery(
  this: OrchestrationDb,
  params: MailboxDeliveryParams
): MailboxDeliveryBatch | undefined {
  this.db.exec('BEGIN IMMEDIATE')
  try {
    requireMailboxConsumer(this, params)
    const batch = selectMailboxDelivery(this, params)
    this.db.exec('COMMIT')
    return batch
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

// A consuming read hands over its batch and records the caller's receipt in the same commit.
export function takeMailboxDelivery(
  this: OrchestrationDb,
  params: MailboxDeliveryParams & { recordTaken?: (batch: MailboxDeliveryBatch) => void }
): MailboxDeliveryBatch | undefined {
  this.db.exec('BEGIN IMMEDIATE')
  try {
    requireMailboxConsumer(this, params)
    const selected = selectMailboxDelivery(this, params)
    const batch = selected && {
      ...selected,
      delivery: exposeDeliveryTimestamps(markDeliveryAcknowledged(this, selected.delivery))
    }
    if (batch) {
      params.recordTaken?.(batch)
    }
    this.db.exec('COMMIT')
    return batch
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

function selectMailboxDelivery(
  db: OrchestrationDb,
  params: MailboxDeliveryParams
): MailboxDeliveryBatch | undefined {
  const limit = Math.min(
    Math.max(params.limit ?? ORCHESTRATION_DELIVERY_BATCH_LIMIT, 1),
    ORCHESTRATION_DELIVERY_BATCH_LIMIT
  )
  const outstanding = db.db
    .prepare('SELECT id FROM outstanding_deliveries WHERE mailbox_handle = ?')
    .get(params.mailboxHandle)
  if (typeof outstanding?.id === 'string') {
    const existing = requireDeliveryRaw(db, outstanding.id)
    if (existing.consumer_generation !== params.consumerGeneration) {
      throw new OrchestrationError(
        'consumer_fenced',
        'This mailbox Delivery belongs to a fenced consumer generation.'
      )
    }
    const messages = db.getDeliveryMessages(existing)
    return { delivery: exposeDeliveryTimestamps(existing), messages, replayed: true }
  }
  if (params.wakeTypes?.length) {
    const placeholders = params.wakeTypes.map(() => '?').join(',')
    const matching = db.db
      .prepare(
        `SELECT 1 FROM messages
         WHERE run_id = ? AND to_handle = ? AND read = 0
           AND delivery_contract = 'current_delivery'
           AND type IN (${placeholders}) LIMIT 1`
      )
      .get(params.runId, params.mailboxHandle, ...params.wakeTypes)
    if (!matching) {
      return undefined
    }
  }
  const messageIds = db.db
    .prepare(
      `SELECT id FROM messages
       WHERE run_id = ? AND to_handle = ? AND read = 0
         AND delivery_contract = 'current_delivery'
       ORDER BY sequence ASC LIMIT ?`
    )
    .all(params.runId, params.mailboxHandle, limit)
    .flatMap((row) => (typeof row?.id === 'string' ? [row.id] : []))
  if (messageIds.length === 0) {
    return undefined
  }
  const deliveryId = generateId('delivery')
  db.db
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
      JSON.stringify(messageIds)
    )
  const delivery = requireDeliveryRaw(db, deliveryId)
  const messages = db.getDeliveryMessages(delivery)
  return { delivery: exposeDeliveryTimestamps(delivery), messages, replayed: false }
}

export function acknowledgeMailboxDelivery(
  this: OrchestrationDb,
  params: {
    runId: string
    mailboxHandle: string
    consumerGeneration: number
    consumerSource?: 'dispatch' | 'attachment'
    deliveryId: string
  }
): { delivery: DeliveryRow; duplicate: boolean } {
  this.db.exec('BEGIN IMMEDIATE')
  try {
    requireMailboxConsumer(this, params)
    const delivery = this.getDeliveryRaw(params.deliveryId)
    if (
      !delivery ||
      delivery.run_id !== params.runId ||
      delivery.mailbox_handle !== params.mailboxHandle
    ) {
      throw staleDelivery(this, params.deliveryId)
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
    const acknowledged = markDeliveryAcknowledged(this, delivery)
    this.db.exec('COMMIT')
    return { delivery: exposeDeliveryTimestamps(acknowledged), duplicate: false }
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

export function staleDelivery(db: OrchestrationDb, deliveryId: string): OrchestrationError {
  return new OrchestrationError(
    'stale_delivery',
    !db.getDeliveryRaw(deliveryId) && db.getMessageById(deliveryId)
      ? `${deliveryId} is a message id, not a delivery id. Acknowledge the batch with the deliveryId field from the check response; process the entire batch before acknowledging.`
      : `Delivery ${deliveryId} does not belong to this mailbox. --ack requires a delivery_* ID returned by orchestration check; process the entire batch before acknowledging.`
  )
}

export function hasOutstandingMailboxDelivery(
  this: OrchestrationDb,
  mailboxHandle: string
): boolean {
  return Boolean(
    this.db
      .prepare('SELECT 1 FROM outstanding_deliveries WHERE mailbox_handle = ? LIMIT 1')
      .get(mailboxHandle)
  )
}

export function getOutstandingMailboxDelivery(
  this: OrchestrationDb,
  mailboxHandle: string
): { id: string; messageIds: string[] } | undefined {
  const row = this.db
    .prepare('SELECT id, message_ids FROM outstanding_deliveries WHERE mailbox_handle = ? LIMIT 1')
    .get(mailboxHandle)
  if (typeof row?.id !== 'string' || typeof row.message_ids !== 'string') {
    return undefined
  }
  const messageIds: unknown = JSON.parse(row.message_ids)
  return Array.isArray(messageIds) && messageIds.every((id): id is string => typeof id === 'string')
    ? { id: row.id, messageIds }
    : undefined
}

export function fenceUnacknowledgedMailboxDeliveries(
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
  finalizeMailboxDelivery: typeof finalizeMailboxDelivery
  getDeliveryRaw: typeof getDeliveryRaw
  getDeliveryMessages: typeof getDeliveryMessages
  getOrCreateMailboxDelivery: typeof getOrCreateMailboxDelivery
  acknowledgeMailboxDelivery: typeof acknowledgeMailboxDelivery
  takeMailboxDelivery: typeof takeMailboxDelivery
  hasOutstandingMailboxDelivery: typeof hasOutstandingMailboxDelivery
  getOutstandingMailboxDelivery: typeof getOutstandingMailboxDelivery
  fenceUnacknowledgedMailboxDeliveries: typeof fenceUnacknowledgedMailboxDeliveries
}

export function attachRoleMailboxDelivery(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    finalizeMailboxDelivery,
    getDeliveryRaw,
    getDeliveryMessages,
    getOrCreateMailboxDelivery,
    acknowledgeMailboxDelivery,
    takeMailboxDelivery,
    hasOutstandingMailboxDelivery,
    getOutstandingMailboxDelivery,
    fenceUnacknowledgedMailboxDeliveries
  })
}
