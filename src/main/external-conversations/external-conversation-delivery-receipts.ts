import { z } from 'zod'
import { lazyZodSchema } from '../../shared/schema/lazy-zod-schema'
import {
  CONNECTOR_SOURCES,
  type ConnectorSource
} from '../../shared/connectors/external-conversation-link'
import type { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import { OrchestrationError } from '../runtime/orchestration/orchestration-error'
import { hashCanonical } from '../runtime/rpc/orchestration/mutations/orchestration-mutation-receipt'
import { refused, type ConversationKey, type Delivery } from './external-conversation-types'

export type DeliveryReceiptDb = OrchestrationDb

const RecordedDelivery = lazyZodSchema(() =>
  z.discriminatedUnion('outcome', [
    z.object({ outcome: z.literal('accepted') }),
    z.object({
      outcome: z.literal('unknown'),
      reason: z.enum(['writer_failed', 'replayed_after_restart'])
    })
  ])
)

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
    // connector.mute: a send a thread's mute held before the agent, which started no turn.
    method: 'connector.start' | 'connector.send' | 'connector.cancel' | 'connector.mute',
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
    if (!this.admits(key, deliveryId, method)) {
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

  /** Whether `run` would take this delivery now (its receipt exists, or the backlog has room),
   *  without writing anything. */
  admits(
    key: ConversationKey,
    deliveryId: string,
    method: 'connector.start' | 'connector.send' | 'connector.cancel' | 'connector.mute'
  ): boolean {
    const db = this.settledDb()
    return (
      Boolean(
        db.getMutationReceipt(
          callerFingerprint(key.source),
          JSON.stringify([key.externalId, deliveryId])
        )
      ) ||
      db.countPendingMutationReceipts(CONNECTOR_FINGERPRINTS) <
        CONNECTOR_PENDING_RECEIPT_LIMIT +
          (method === 'connector.cancel' ? CONNECTOR_CANCEL_RECEIPT_RESERVE : 0)
    )
  }

  /** A send whose words another delivery's turn carried: it settles as that delivery did, and its
   *  receipt records it, so a resend replays it rather than running it again. */
  async carried<Result extends { outcome: string }>(
    key: ConversationKey,
    deliveryId: string,
    text: string,
    done: Promise<Result>
  ): Promise<Result> {
    await this.run(key, deliveryId, 'connector.send', [text], async () => {
      const result = await done
      // Only an accepted turn leaves a receipt; any other outcome is the carrying delivery's to say.
      return result.outcome === 'accepted'
        ? { outcome: 'accepted' }
        : refused('conversation_cancelled')
    })
    return await done
  }

  /** Read-only: whether a receipt exists for the delivery, settled or still running. */
  known(key: ConversationKey, deliveryId: string): boolean {
    const requestId = JSON.stringify([key.externalId, deliveryId])
    const fingerprint = callerFingerprint(key.source)
    return (
      this.inFlight.has(JSON.stringify([fingerprint, requestId])) ||
      Boolean(this.settledDb().getMutationReceipt(fingerprint, requestId))
    )
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

  /** What a send a thread's mute held came to, so a resend replays it without a turn's automations;
   *  null for any other delivery. Another payload under its id is refused, as `run` refuses it. */
  heldByMute(key: ConversationKey, deliveryId: string, payload: unknown): Promise<Delivery> | null {
    const requestId = JSON.stringify([key.externalId, deliveryId])
    const row = this.settledDb().getMutationReceipt(callerFingerprint(key.source), requestId)
    if (row?.method !== 'connector.mute') {
      return null
    }
    return row.payload_hash === hashCanonical(payload)
      ? this.recorded(key, deliveryId).then((recorded) => recorded ?? LOST)
      : Promise.resolve(refused('delivery_id_reused'))
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
