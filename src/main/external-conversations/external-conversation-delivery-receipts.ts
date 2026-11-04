import { z } from 'zod'
import { CONNECTOR_SOURCES, type ConnectorSource } from '../../shared/external-conversation-link'
import type { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import { OrchestrationError } from '../runtime/orchestration/orchestration-error'
import { hashCanonical } from '../runtime/rpc/orchestration-mutation-receipt'
import { refused, type ConversationKey, type Delivery } from './external-conversation-types'

export type DeliveryReceiptDb = OrchestrationDb

const RecordedDelivery = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('accepted'), reopened: z.literal(true).optional() }),
  z.object({
    outcome: z.literal('unknown'),
    reason: z.enum(['launch_outcome_unknown', 'writer_failed', 'replayed_after_restart'])
  })
])

const LOST: Delivery = { outcome: 'unknown', reason: 'replayed_after_restart' }

// Reserve only part of the shared ledger for unsettled connector deliveries.
export const CONNECTOR_PENDING_RECEIPT_LIMIT = 1_000

// Headroom only cancels may use, so a full backlog can still be cancelled away.
export const CONNECTOR_CANCEL_RECEIPT_RESERVE = 100

const callerFingerprint = (source: ConnectorSource): string => `connector:${source}`
const CONNECTOR_FINGERPRINTS = CONNECTOR_SOURCES.map(callerFingerprint)

/** Deduplicate durable delivery IDs; interrupted writes remain unknown and refused deliveries leave no receipt. */
export class DeliveryReceipts {
  private readonly inFlight = new Map<string, Promise<Delivery>>()
  private leftoversSettled = false

  constructor(private readonly db: () => DeliveryReceiptDb) {}

  run(
    key: ConversationKey,
    deliveryId: string,
    method: 'connector.start' | 'connector.send' | 'connector.cancel',
    payload: unknown,
    execute: () => Promise<Delivery>
  ): Promise<Delivery> {
    const identity = {
      callerFingerprint: callerFingerprint(key.source),
      requestId: JSON.stringify([key.externalId, deliveryId]),
      method,
      payloadHash: hashCanonical(payload)
    }
    const flightKey = JSON.stringify([identity.callerFingerprint, identity.requestId])
    const db = this.settledDb()
    if (
      !db.getMutationReceipt(identity.callerFingerprint, identity.requestId) &&
      db.countPendingMutationReceipts(CONNECTOR_FINGERPRINTS) >=
        CONNECTOR_PENDING_RECEIPT_LIMIT +
          (method === 'connector.cancel' ? CONNECTOR_CANCEL_RECEIPT_RESERVE : 0)
    ) {
      return Promise.resolve(refused('delivery_backlog_full'))
    }
    let begun: ReturnType<DeliveryReceiptDb['beginMutationReceipt']>
    try {
      begun = db.beginMutationReceipt(identity)
    } catch (error) {
      if (error instanceof OrchestrationError && error.code === 'request_mismatch') {
        return Promise.resolve(refused('delivery_id_reused'))
      }
      throw error
    }
    if (begun.disposition === 'completed') {
      const recorded = RecordedDelivery.safeParse(JSON.parse(begun.row.receipt ?? 'null'))
      return Promise.resolve(recorded.success ? recorded.data : LOST)
    }
    if (begun.disposition === 'pending') {
      return this.inFlight.get(flightKey) ?? Promise.resolve(LOST)
    }
    const delivery = execute().then(
      (result) => {
        if (result.outcome === 'refused') {
          db.discardPendingMutationReceipt(identity.callerFingerprint, identity.requestId)
        } else {
          db.completeMutationReceipt({ ...identity, receipt: JSON.stringify(result) })
        }
        return result
      },
      (error: unknown) => {
        db.discardPendingMutationReceipt(identity.callerFingerprint, identity.requestId)
        throw error
      }
    )
    this.inFlight.set(flightKey, delivery)
    const forget = (): void => {
      this.inFlight.delete(flightKey)
    }
    delivery.then(forget, forget)
    return delivery
  }

  /** Read-only: what a received delivery came to, or null when nothing was recorded (refusals and answers leave none). */
  recorded(key: ConversationKey, deliveryId: string): Promise<Delivery | null> {
    const requestId = JSON.stringify([key.externalId, deliveryId])
    const fingerprint = callerFingerprint(key.source)
    const running = this.inFlight.get(JSON.stringify([fingerprint, requestId]))
    if (running) {
      return running
    }
    const row = this.settledDb().getMutationReceipt(fingerprint, requestId)
    if (row?.state !== 'completed') {
      return Promise.resolve(null)
    }
    const recorded = RecordedDelivery.safeParse(JSON.parse(row.receipt ?? 'null'))
    return Promise.resolve(recorded.success ? recorded.data : LOST)
  }

  private settledDb(): DeliveryReceiptDb {
    const db = this.db()
    if (!this.leftoversSettled) {
      // Settle old pending rows as unknown; deleting them could repeat effects they already wrote.
      db.settlePendingMutationReceipts(CONNECTOR_FINGERPRINTS, JSON.stringify(LOST))
      this.leftoversSettled = true
    }
    return db
  }
}
