import type { CloudDatabase, CloudNotifications } from '@orca-cloud/cloud-database'
import {
  CONNECTOR_LIMITS,
  ConnectorDeliverySchema,
  type ConnectorAcksRequest,
  type ConnectorConversation,
  type ConnectorDelivery
} from '@orca-cloud/connector-contract'
import { conversationKey, conversationOf } from './connector-threads.js'

// NOTIFY channel; the payload is the host id whose inbox changed.
export const INBOX_CHANNEL = 'connector_inbox'

type DeliveryEnvelope = 'deliveryId' | 'seq' | 'expiresAt' | 'conversation'
// The kind-specific part of a delivery; the inbox assigns the envelope.
export type DeliveryBody = ConnectorDelivery extends infer D
  ? D extends ConnectorDelivery
    ? Omit<D, DeliveryEnvelope>
    : never
  : never

export type ExpiredThread = { hostId: string; conversation: ConnectorConversation }
export type EnqueueResult = 'queued' | 'duplicate' | 'dropped'
export type Unsettled = { deliveryId: string; conversation: ConnectorConversation }

// The row's own start expired or was dropped without ever being leased: a send never outlives it.
const behindDeadStart = (row: string) => `${row}.kind <> 'start' AND EXISTS (SELECT 1
  FROM connector_inbox s
  WHERE s.host_id = ${row}.host_id AND s.source = ${row}.source
    AND s.external_id = ${row}.external_id AND s.kind = 'start'
    AND s.seq < ${row}.seq AND s.state IN ('expired', 'dropped') AND s.lease_until IS NULL
    AND NOT EXISTS (SELECT 1 FROM connector_inbox n WHERE n.host_id = s.host_id
      AND n.source = s.source AND n.external_id = s.external_id AND n.kind = 'start' AND n.seq > s.seq
      AND n.seq < ${row}.seq))`

// States: pending -> leased -> received -> done, or expired / dropped. A start can enter as held,
// unleasable until attach() finishes its prompt; it blocks and expires like pending. Text leaves
// with settlement.
export class ConnectorInbox {
  constructor(
    private readonly database: CloudDatabase,
    private readonly notifications: CloudNotifications,
    private readonly now: () => number
  ) {}

  // Under the host lock, after the caller found the host and bound the thread (queueDelivery).
  async enqueue(
    transaction: CloudDatabase,
    input: {
      hostId: string
      conversation: ConnectorConversation
      deliveryId: string
      // The source message it carries, which a held start reads its thread up to.
      messageId?: string
      body: DeliveryBody
      held?: boolean
    }
  ): Promise<EnqueueResult> {
    const { hostId, conversation, deliveryId, body } = input
    const now = this.now()
    const { kind, ...payload } = body
    const [inserted] = await transaction.query(
      `INSERT INTO connector_inbox
       (host_id, delivery_id, source, external_id, message_id, seq, kind, payload, state,
        expires_at, created_at)
       SELECT ?, ?, ?, ?, ?, COALESCE(MAX(seq), 0) + 1, ?, ?, ?, ?, ?
       FROM connector_inbox WHERE host_id = ?
       ON CONFLICT (host_id, delivery_id) DO NOTHING`,
      [
        hostId,
        deliveryId,
        ...conversationKey(conversation),
        input.messageId ?? null,
        kind,
        JSON.stringify(payload),
        input.held ? 'held' : 'pending',
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
         WHERE host_id = ? AND source = ? AND external_id = ? AND state IN ('pending', 'held')
           AND EXISTS (SELECT 1 FROM connector_inbox s WHERE s.host_id = connector_inbox.host_id
             AND s.source = connector_inbox.source AND s.external_id = connector_inbox.external_id
             AND s.kind = 'start' AND s.state IN ('pending', 'held'))`,
        [now, hostId, ...conversationKey(conversation)]
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
      `SELECT delivery_id, source, external_id, seq, kind, payload, expires_at FROM connector_inbox i
       WHERE i.host_id = ? AND i.expires_at > ?
         AND (i.state = 'pending' OR (i.state = 'leased' AND i.lease_until <= ?))
         AND (
           NOT EXISTS (SELECT 1 FROM connector_inbox e WHERE e.host_id = i.host_id
             AND e.source = i.source AND e.external_id = i.external_id AND e.seq < i.seq
             AND e.state IN ('pending', 'held', 'leased'))
           OR (i.kind = 'cancel' AND NOT EXISTS (SELECT 1 FROM connector_inbox s
             WHERE s.host_id = i.host_id AND s.source = i.source AND s.external_id = i.external_id
               AND s.kind = 'start' AND s.state IN ('pending', 'held', 'leased')))
         )
         AND NOT (${behindDeadStart('i')})
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
          conversation: conversationOf(row)
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

  // Finishes a held start's prompt and lets it go out; false once it expired or was dropped.
  async attach(
    transaction: CloudDatabase,
    hostId: string,
    deliveryId: string,
    prompt: string
  ): Promise<boolean> {
    const now = this.now()
    const [row] = await transaction.query(
      `SELECT payload FROM connector_inbox
       WHERE host_id = ? AND delivery_id = ? AND state = 'held' AND expires_at > ?`,
      [hostId, deliveryId, now]
    )
    if (!row) {
      return false
    }
    // The expiry sweep doesn't take the host lock; the state guard keeps its verdict.
    const [attached] = await transaction.query(
      `UPDATE connector_inbox SET state = 'pending', payload = ?
       WHERE host_id = ? AND delivery_id = ? AND state = 'held' AND expires_at > ?`,
      [JSON.stringify({ ...JSON.parse(String(row.payload)), prompt }), hostId, deliveryId, now]
    )
    if (Number(attached?.changes ?? 0) === 0) {
      return false
    }
    await this.wake(transaction, hostId)
    return true
  }

  // What an earlier process received but never settled; the first poll after each hello lists it.
  async listUnsettled(transaction: CloudDatabase, hostId: string): Promise<Unsettled[]> {
    const rows = await transaction.query(
      `SELECT delivery_id, source, external_id FROM connector_inbox
       WHERE host_id = ? AND state = 'received' ORDER BY seq`,
      [hostId]
    )
    return rows.map((row) => ({
      deliveryId: String(row.delivery_id),
      conversation: conversationOf(row)
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

  // Pending or held past its deadline, or leased and never received 30 s after it, then what is
  // queued behind a start that never left. Returns the threads hit.
  // `effects` runs in the same transaction, so what the expiry owes the threads commits with it.
  async expireDue(
    effects?: (transaction: CloudDatabase, threads: ExpiredThread[]) => Promise<void>
  ): Promise<ExpiredThread[]> {
    const now = this.now()
    return await this.database.transaction(async (transaction) => {
      const due = await transaction.query(
        `UPDATE connector_inbox SET state = 'expired', payload = NULL, settled_at = ?
         WHERE (state IN ('pending', 'held') AND expires_at <= ?)
           OR (state = 'leased' AND expires_at <= ?)
         RETURNING host_id, source, external_id`,
        [now, now, now - CONNECTOR_LIMITS.leasedExpiryGraceMs]
      )
      // By state, not by this pass's verdicts, so a send that committed behind a start an earlier
      // pass expired goes too. A start that was leased may yet be received; what is behind it stays.
      const behind = await transaction.query(
        `UPDATE connector_inbox SET state = 'expired', payload = NULL, settled_at = ?
         WHERE state = 'pending' AND ${behindDeadStart('connector_inbox')}
         RETURNING host_id, source, external_id`,
        [now]
      )
      const rows = [...due, ...behind]
      const threads = new Map<string, ExpiredThread>()
      for (const row of rows) {
        const thread = { hostId: String(row.host_id), conversation: conversationOf(row) }
        threads.set([thread.hostId, ...conversationKey(thread.conversation)].join('\0'), thread)
      }
      for (const hostId of new Set([...threads.values()].map((thread) => thread.hostId))) {
        await this.wake(transaction, hostId)
      }
      await effects?.(transaction, [...threads.values()])
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
