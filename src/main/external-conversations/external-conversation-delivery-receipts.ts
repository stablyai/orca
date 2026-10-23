import { z } from 'zod'
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

/**
 * A connector's delivery ids on orchestration's durable mutation receipts, under one caller
 * identity per source: the same id and payload share one answer, across restarts too, and another
 * payload is refused. A duplicate of one still running waits for it; a running one a restart
 * interrupted reads `unknown`. Refusals and throws wrote nothing, so they leave no receipt.
 */
export class DeliveryReceipts {
  private readonly inFlight = new Map<string, Promise<Delivery>>()

  constructor(private readonly db: () => DeliveryReceiptDb) {}

  run(
    key: ConversationKey,
    deliveryId: string,
    method: 'connector.start' | 'connector.send',
    payload: unknown,
    execute: () => Promise<Delivery>
  ): Promise<Delivery> {
    const identity = {
      callerFingerprint: `connector:${key.source}`,
      requestId: JSON.stringify([key.externalId, deliveryId]),
      method,
      payloadHash: hashCanonical(payload)
    }
    const flightKey = JSON.stringify([identity.callerFingerprint, identity.requestId])
    const db = this.db()
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
}
