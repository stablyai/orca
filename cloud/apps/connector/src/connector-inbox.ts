import type { CloudDatabase, CloudNotifications } from '@orca-cloud/cloud-database'
import {
  CONNECTOR_LIMITS,
  ConnectorDeliverySchema,
  type ConnectorAcksRequest,
  type ConnectorDelivery
} from '@orca-cloud/connector-contract'

// NOTIFY channel; the payload is the host id whose inbox changed.
export const INBOX_CHANNEL = 'connector_inbox'

type DeliveryEnvelope = 'deliveryId' | 'seq' | 'expiresAt' | 'conversation'
// The kind-specific part of a delivery; the inbox assigns the envelope.
export type DeliveryBody = ConnectorDelivery extends infer D
  ? D extends ConnectorDelivery
    ? Omit<D, DeliveryEnvelope>
    : never
  : never

export type EnqueueResult = 'queued' | 'duplicate' | 'dropped'
export type Unsettled = { deliveryId: string; conversation: { source: 'slack'; externalId: string } }

const conversation = (externalId: string) => ({ source: 'slack' as const, externalId })

// States: pending -> leased -> received -> done, or expired / dropped. Text leaves with settlement.
export class ConnectorInbox {
  constructor(
    private readonly database: CloudDatabase,
    private readonly notifications: CloudNotifications,
    private readonly now: () => number
  ) {}

  // Under the host lock, after the caller found the host and bound the thread (queueDelivery).
  async enqueue(
    transaction: CloudDatabase,
    input: { hostId: string; externalId: string; deliveryId: string; body: DeliveryBody }
  ): Promise<EnqueueResult> {
    const { hostId, externalId, deliveryId, body } = input
    const now = this.now()
    const { kind, ...payload } = body
    const [inserted] = await transaction.query(
      `INSERT INTO connector_inbox
       (host_id, delivery_id, external_id, seq, kind, payload, state, expires_at, created_at)
       SELECT ?, ?, ?, COALESCE(MAX(seq), 0) + 1, ?, ?, 'pending', ?, ?
       FROM connector_inbox WHERE host_id = ?
       ON CONFLICT (host_id, delivery_id) DO NOTHING`,
      [
        hostId,
        deliveryId,
        externalId,
        kind,
        JSON.stringify(payload),
        now + CONNECTOR_LIMITS.deliveryTtlMs,
        now,
        hostId
      ]
    )
    if (Number(inserted?.changes ?? 0) === 0) {
      return 'duplicate'
    }
    if (body.kind === 'cancel') {
      // A start the machine never received is dropped, with everything queued behind it, this
      // cancel included, so a retried cancel reads as a duplicate.
      const [dropped] = await transaction.query(
        `UPDATE connector_inbox SET state = 'dropped', payload = NULL, settled_at = ?
         WHERE host_id = ? AND external_id = ? AND state = 'pending'
           AND EXISTS (SELECT 1 FROM connector_inbox s WHERE s.host_id = connector_inbox.host_id
             AND s.external_id = connector_inbox.external_id AND s.kind = 'start'
             AND s.state = 'pending')`,
        [now, hostId, externalId]
      )
      if (Number(dropped?.changes ?? 0) > 0) {
        return 'dropped'
      }
    }
    await this.wake(transaction, hostId)
    return 'queued'
  }

  // Under the host lock (the poll's pass). Each conversation's head goes out; the next waits
  // until the head is received. A cancel skips the queue unless its start is still unreceived.
  async claim(
    transaction: CloudDatabase,
    hostId: string
  ): Promise<{ deliveries: ConnectorDelivery[]; nextLeaseDueAt: number | null }> {
    const now = this.now()
    const rows = await transaction.query(
      `SELECT delivery_id, external_id, seq, kind, payload, expires_at FROM connector_inbox i
       WHERE i.host_id = ? AND i.expires_at > ?
         AND (i.state = 'pending' OR (i.state = 'leased' AND i.lease_until <= ?))
         AND (
           NOT EXISTS (SELECT 1 FROM connector_inbox e WHERE e.host_id = i.host_id
             AND e.external_id = i.external_id AND e.seq < i.seq
             AND e.state IN ('pending', 'leased'))
           OR (i.kind = 'cancel' AND NOT EXISTS (SELECT 1 FROM connector_inbox s
             WHERE s.host_id = i.host_id AND s.external_id = i.external_id
               AND s.kind = 'start' AND s.state IN ('pending', 'leased')))
         )
       ORDER BY i.seq LIMIT ?`,
      [hostId, now, now, CONNECTOR_LIMITS.maxDeliveriesPerPoll]
    )
    const deliveries: ConnectorDelivery[] = []
    for (const row of rows) {
      // The expiry sweep doesn't take the host lock; the state guard keeps its verdict.
      const [leased] = await transaction.query(
        `UPDATE connector_inbox SET state = 'leased', lease_until = ?
         WHERE host_id = ? AND delivery_id = ?
           AND (state = 'pending' OR (state = 'leased' AND lease_until <= ?))`,
        [now + CONNECTOR_LIMITS.leaseMs, hostId, row.delivery_id, now]
      )
      if (Number(leased?.changes ?? 0) === 0) {
        continue
      }
      deliveries.push(
        ConnectorDeliverySchema.parse({
          ...JSON.parse(String(row.payload)),
          kind: row.kind,
          deliveryId: row.delivery_id,
          seq: Number(row.seq),
          expiresAt: Number(row.expires_at),
          conversation: conversation(String(row.external_id))
        })
      )
    }
    const [next] = await transaction.query(
      `SELECT MIN(lease_until) AS due FROM connector_inbox
       WHERE host_id = ? AND state = 'leased' AND expires_at > ?`,
      [hostId, now]
    )
    return { deliveries, nextLeaseDueAt: next?.due === null ? null : Number(next?.due) }
  }

  // What an earlier process received but never settled; the first poll after each hello lists it.
  async listUnsettled(transaction: CloudDatabase, hostId: string): Promise<Unsettled[]> {
    const rows = await transaction.query(
      `SELECT delivery_id, external_id FROM connector_inbox
       WHERE host_id = ? AND state = 'received' ORDER BY seq`,
      [hostId]
    )
    return rows.map((row) => ({
      deliveryId: String(row.delivery_id),
      conversation: conversation(String(row.external_id))
    }))
  }

  async wake(transaction: CloudDatabase, hostId: string): Promise<void> {
    await this.notifications.notify(transaction, INBOX_CHANNEL, hostId)
  }

  // A late received is accepted (it did arrive); the first done wins.
  async acknowledge(
    transaction: CloudDatabase,
    hostId: string,
    acks: ConnectorAcksRequest['acks']
  ): Promise<void> {
    const now = this.now()
    let changed = 0
    for (const ack of acks) {
      const [result] =
        ack.step === 'received'
          ? await transaction.query(
              `UPDATE connector_inbox SET state = 'received'
               WHERE host_id = ? AND delivery_id = ? AND state IN ('pending', 'leased', 'expired')`,
              [hostId, ack.deliveryId]
            )
          : await transaction.query(
              `UPDATE connector_inbox SET state = 'done', result = ?, payload = NULL, settled_at = ?
               WHERE host_id = ? AND delivery_id = ? AND state IN ('pending', 'leased', 'received', 'expired')`,
              [JSON.stringify(ack.result), now, hostId, ack.deliveryId]
            )
      changed += Number(result?.changes ?? 0)
    }
    // A received head lets the conversation's next delivery go out.
    if (changed > 0) {
      await this.wake(transaction, hostId)
    }
  }

  // Pending past its deadline, or leased and never received 30 s after it. Returns the threads hit.
  async expireDue(): Promise<{ hostId: string; externalId: string }[]> {
    const now = this.now()
    return await this.database.transaction(async (transaction) => {
      const rows = await transaction.query(
        `UPDATE connector_inbox SET state = 'expired', payload = NULL, settled_at = ?
         WHERE (state = 'pending' AND expires_at <= ?) OR (state = 'leased' AND expires_at <= ?)
         RETURNING host_id, external_id`,
        [now, now, now - CONNECTOR_LIMITS.leasedExpiryGraceMs]
      )
      const threads = new Map<string, { hostId: string; externalId: string }>()
      for (const row of rows) {
        const thread = { hostId: String(row.host_id), externalId: String(row.external_id) }
        threads.set(`${thread.hostId}\0${thread.externalId}`, thread)
      }
      for (const hostId of new Set([...threads.values()].map((thread) => thread.hostId))) {
        await this.wake(transaction, hostId)
      }
      return [...threads.values()]
    })
  }

  async pruneSettled(retentionMs: number): Promise<number> {
    const [result] = await this.database.query(
      `DELETE FROM connector_inbox
       WHERE state IN ('done', 'expired', 'dropped') AND settled_at < ?`,
      [this.now() - retentionMs]
    )
    return Number(result?.changes ?? 0)
  }
}
