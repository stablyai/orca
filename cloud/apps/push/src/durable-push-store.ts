import { isDismissedAlert, reconcileQueuedDismissal } from './push-queued-dismissal.js'
import { parsePushDeliveryPayload } from './push-delivery-payload.js'
import { createHash, randomUUID } from 'node:crypto'
import { PUSH_LIMITS, type PushNotification } from '@orca-cloud/push-contract'
import type { PushDatabase, SqlRow } from './push-database.js'

const RETENTION_MS = 24 * 60 * 60_000
export const DELIVERY_LEASE_MS = 30_000
export type QueuedPushDelivery = {
  id: string
  registrationId: string
  hostFingerprint: string
  notification: PushNotification
  expiresAt: number
  lease: string
  attempts: number
}

export class DurablePushStore {
  constructor(
    private readonly database: PushDatabase,
    private readonly now = Date.now
  ) {}

  async accept(
    host: string,
    registrationId: string,
    notification: PushNotification
  ): Promise<'queued' | 'rate_limited' | 'error'> {
    const now = this.now()
    const kind = notification.kind ?? 'alert'
    const eventId = createHash('sha256')
      .update(
        JSON.stringify([host, kind, notification.notificationEpoch, notification.notificationSeq])
      )
      .digest('hex')
    const { sound: _sound, kind: _kind, ...content } = notification
    const fingerprint = createHash('sha256')
      .update(JSON.stringify({ kind, ...content }))
      .digest('hex')
    return this.database.transaction(async (tx) => {
      await tx.lockQuotaScope(`push-events:${host}`)
      const [existing] = await tx.query('SELECT * FROM push_events WHERE event_id = ?', [eventId])
      if (existing && existing.fingerprint !== fingerprint) return 'error'
      const expiresAt = existing
        ? Number(existing.expires_at)
        : Math.min(
            notification.expiresAt ?? Infinity,
            now + PUSH_LIMITS.notificationTtlSeconds * 1000
          )
      if (expiresAt <= now) return 'error'
      if (!existing) {
        const [count] = await tx.query(
          'SELECT COUNT(*) AS total FROM push_events WHERE host_fingerprint = ? AND kind = ? AND created_at > ?',
          [host, kind, now - PUSH_LIMITS.eventQuotaWindowMs]
        )
        if (Number(count?.total ?? 0) >= PUSH_LIMITS.hostEventsPerWindow) return 'rate_limited'
        await tx.query(
          'INSERT INTO push_events(event_id, host_fingerprint, kind, fingerprint, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
          [eventId, host, kind, fingerprint, now, expiresAt]
        )
      }
      const [recipient] = await tx.query(
        'SELECT event_id FROM push_event_recipients WHERE event_id = ? AND registration_id = ?',
        [eventId, registrationId]
      )
      if (recipient) return 'queued'
      if (await reconcileQueuedDismissal(tx, host, registrationId, notification, now))
        return 'queued'
      await tx.query(
        `INSERT INTO push_delivery_batches(batch_id, host_fingerprint, registration_id, kind, payload_json, state, due_at, expires_at, lease_until, attempts, created_at)
        VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, 0, 0, ?)`,
        [
          randomUUID(),
          host,
          registrationId,
          kind,
          JSON.stringify(notification),
          now,
          expiresAt,
          now
        ]
      )
      await tx.query(
        'INSERT INTO push_event_recipients(event_id, registration_id, created_at) VALUES (?, ?, ?)',
        [eventId, registrationId, now]
      )
      return 'queued'
    })
  }

  async claim(): Promise<QueuedPushDelivery | null> {
    return this.database.transaction(async (tx) => {
      await tx.lockQuotaScope('push-worker-claim')
      const now = this.now()
      const params = [now, now, now, now]
      const predicate =
        "state = 'pending' AND lease_until <= ? AND expires_at > ? AND due_at <= ? AND NOT EXISTS (SELECT 1 FROM push_delivery_batches busy WHERE busy.registration_id = push_delivery_batches.registration_id AND busy.lease_until > ?)"
      let [row] = await tx.query(
        `SELECT * FROM push_delivery_batches WHERE ${predicate} ORDER BY due_at, created_at, batch_id LIMIT 1`,
        params
      )
      if (!row) return null
      await tx.lockQuotaScope(`push-events:${String(row.host_fingerprint)}`)
      ;[row] = await tx.query('SELECT * FROM push_delivery_batches WHERE batch_id = ?', [
        row.batch_id
      ])
      if (!row || row.state !== 'pending' || Number(row.expires_at) <= now) return null
      const notification = parsePushDeliveryPayload(String(row.payload_json))
      if (await isDismissedAlert(tx, String(row.host_fingerprint), notification)) {
        await tx.query(
          "UPDATE push_delivery_batches SET state = 'dismissed', payload_json = '{}' WHERE batch_id = ?",
          [row.batch_id]
        )
        return null
      }
      const lease = randomUUID()
      await tx.query(
        'UPDATE push_delivery_batches SET lease_token = ?, lease_until = ?, attempts = attempts + 1 WHERE batch_id = ?',
        [lease, now + DELIVERY_LEASE_MS, row.batch_id]
      )
      return this.delivery(row, lease)
    })
  }

  private delivery(row: SqlRow, lease: string): QueuedPushDelivery {
    return {
      id: String(row.batch_id),
      registrationId: String(row.registration_id),
      hostFingerprint: String(row.host_fingerprint),
      notification: parsePushDeliveryPayload(String(row.payload_json)),
      expiresAt: Number(row.expires_at),
      lease,
      attempts: Number(row.attempts) + 1
    }
  }

  async renew(delivery: QueuedPushDelivery): Promise<void> {
    await this.database.query(
      "UPDATE push_delivery_batches SET lease_until = ? WHERE batch_id = ? AND lease_token = ? AND state = 'pending'",
      [this.now() + DELIVERY_LEASE_MS, delivery.id, delivery.lease]
    )
  }

  async finish(
    delivery: QueuedPushDelivery,
    retryAfterMs?: number,
    outcome = 'done'
  ): Promise<void> {
    const now = this.now()
    const retryAt = retryAfterMs === undefined ? Infinity : now + Math.max(1000, retryAfterMs)
    const retry = retryAt < delivery.expiresAt
    await this.database.query(
      `UPDATE push_delivery_batches SET state = ?, payload_json = ?, due_at = ?, lease_until = 0, lease_token = NULL
      WHERE batch_id = ? AND lease_token = ? AND state = 'pending'`,
      [
        retry ? 'pending' : retryAfterMs !== undefined ? 'expired' : outcome,
        retry ? JSON.stringify(delivery.notification) : '{}',
        retry ? retryAt : now,
        delivery.id,
        delivery.lease
      ]
    )
  }

  async pendingCount(registrationId: string): Promise<number> {
    const [row] = await this.database.query(
      "SELECT COUNT(*) AS total FROM push_delivery_batches WHERE registration_id = ? AND state = 'pending'",
      [registrationId]
    )
    return Number(row?.total ?? 0)
  }

  async prune(): Promise<number> {
    const now = this.now()
    await this.database.query(
      "UPDATE push_delivery_batches SET state = 'expired', payload_json = '{}' WHERE expires_at <= ? AND state = 'pending'",
      [now]
    )
    await this.database.query('DELETE FROM push_dismissed_events WHERE created_at < ?', [
      now - RETENTION_MS
    ])
    await this.database.query('DELETE FROM push_delivery_batches WHERE expires_at < ?', [
      now - RETENTION_MS
    ])
    await this.database.query('DELETE FROM push_event_recipients WHERE created_at < ?', [
      now - RETENTION_MS
    ])
    const [result] = await this.database.query('DELETE FROM push_events WHERE created_at < ?', [
      now - RETENTION_MS
    ])
    return Number(result?.changes ?? 0)
  }
}
