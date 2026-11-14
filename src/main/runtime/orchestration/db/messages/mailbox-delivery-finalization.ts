import type { DeliveryRow, MessageRow } from '../orchestration-records'
import type { OrchestrationDb } from '../orchestration-db'
import type { MailboxDeliveryParams, MailboxDeliveryBatch } from './role-mailbox-delivery'
import { OrchestrationError } from '../../orchestration-error'
import { exposeDeliveryTimestamps } from '../utc-timestamp'
import { requireMailboxConsumer } from './mailbox-consumer'

/** The caller's transaction owns reconciliation, final membership, read/ack and its response. */
export function finalizeMailboxDelivery(
  this: OrchestrationDb,
  params: MailboxDeliveryParams & {
    claim: MailboxDeliveryBatch
    messages: MessageRow[]
  }
): MailboxDeliveryBatch | undefined {
  if (!this.db.isTransaction) {
    throw new Error('mailbox finalization requires its take transaction')
  }
  requireMailboxConsumer(this, params)
  const raw = this.getDeliveryRaw(params.claim.delivery.id)
  if (
    !raw ||
    raw.run_id !== params.runId ||
    raw.mailbox_handle !== params.mailboxHandle ||
    raw.consumer_generation !== params.consumerGeneration ||
    raw.status === 'fenced'
  ) {
    throw new OrchestrationError(
      'consumer_fenced',
      'This mailbox Delivery belongs to a fenced consumer.'
    )
  }
  if (raw.status === 'acknowledged') {
    return undefined
  }
  if (raw.message_ids !== params.claim.delivery.message_ids) {
    throw new OrchestrationError(
      'consumer_fenced',
      'This mailbox Delivery changed while being checked.'
    )
  }
  const ids = params.messages.map((message) => message.id)
  const selected: string[] = JSON.parse(raw.message_ids)
  if (
    ids.some(
      (id, index) =>
        !selected.includes(id) ||
        ids.indexOf(id) !== index ||
        (index > 0 && selected.indexOf(id) <= selected.indexOf(ids[index - 1]!))
    )
  ) {
    throw new Error('mailbox finalization must be a subset of its original claim')
  }
  this.db.prepare('UPDATE deliveries SET message_ids=? WHERE id=?').run(JSON.stringify(ids), raw.id)
  const delivery = markDeliveryAcknowledged(this, { ...raw, message_ids: JSON.stringify(ids) })
  return {
    delivery: exposeDeliveryTimestamps(delivery),
    messages: params.messages,
    replayed: params.claim.replayed
  }
}

export function markDeliveryAcknowledged(db: OrchestrationDb, delivery: DeliveryRow): DeliveryRow {
  const messageIds: string[] = JSON.parse(delivery.message_ids)
  if (messageIds.length > 0) {
    const placeholders = messageIds.map(() => '?').join(',')
    db.db
      .prepare(
        `UPDATE messages
         SET read = 1, pointer_enter_pending = 0, pointer_pty_id = NULL,
             pointer_process_incarnation = NULL
         WHERE id IN (${placeholders})`
      )
      .run(...messageIds)
  }
  db.db
    .prepare(
      "UPDATE deliveries SET status = 'acknowledged', acknowledged_at = datetime('now') WHERE id = ?"
    )
    .run(delivery.id)
  return requireDeliveryRaw(db, delivery.id)
}

export function requireDeliveryRaw(db: OrchestrationDb, id: string): DeliveryRow {
  const delivery = db.getDeliveryRaw(id)
  if (!delivery) {
    throw new Error(`Delivery ${id} disappeared inside its transaction.`)
  }
  return delivery
}
