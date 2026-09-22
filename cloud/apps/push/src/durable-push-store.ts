import { isDismissedAlert, reconcileQueuedDismissal } from './push-queued-dismissal.js'
import { parsePushDeliveryPayload } from './push-delivery-payload.js'
import { createHash, randomUUID } from 'node:crypto'
import { PUSH_LIMITS, type PushNotification } from '@orca-cloud/push-contract'
import type { PushDatabase, SqlRow } from './push-database.js'

const RETENTION_MS = 24 * 60 * 60_000
// accept() caps expires_at at due_at + TTL, so older due_at is expired: scans skip an unpruned backlog.
const TTL_MS = PUSH_LIMITS.notificationTtlSeconds * 1000
// Covers one claimer per worker drain skipping a device another drain holds.
const CLAIM_CANDIDATE_ATTEMPTS = 4
export const PRUNE_BATCH_ROWS = 2_000
export const PRUNE_MAX_BATCHES = 50
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
    private readonly now = Date.now,
    // Claim, finish and prune traffic; accept() and renew() stay on the request-path database.
    private readonly background = database
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
    return this.background.transaction(async (tx) => {
      // The previous revision's claim holds this key exclusively; sharing it makes that claim snapshot
      // only after our leases commit. Drop one release after every worker runs this revision.
      if (!(await tx.tryLockSharedScope('push-worker-claim'))) return null
      const now = this.now()
      // SQLite already serializes the whole transaction.
      const lockRow = tx.dialect === 'postgres' ? ' FOR UPDATE SKIP LOCKED' : ''
      const skipped: string[] = []
      for (let attempt = 0; attempt < CLAIM_CANDIDATE_ATTEMPTS; attempt++) {
        const excluded = skipped.map(() => ' AND registration_id <> ?').join('')
        const [row] = await tx.query(
          `SELECT * FROM push_delivery_batches WHERE state = 'pending' AND lease_until <= ? AND expires_at > ? AND due_at <= ? AND due_at > ?${excluded}
          AND NOT EXISTS (SELECT 1 FROM push_delivery_batches busy WHERE busy.registration_id = push_delivery_batches.registration_id AND busy.state = 'pending' AND busy.lease_until > 0 AND busy.lease_until > ?)
          ORDER BY due_at, created_at, batch_id LIMIT 1${lockRow}`,
          [now, now, now, now - TTL_MS, ...skipped, now]
        )
        if (!row) return null
        if (await this.ownsDeviceHead(tx, row, now)) return await this.lease(tx, row, now)
        skipped.push(String(row.registration_id))
      }
      return null
    })
  }

  // The row lock alone lets a second claimer skip this device's head and lease the row behind it.
  // Under the device lock, a fresh read sees every committed lease and every uncommitted head.
  private async ownsDeviceHead(tx: PushDatabase, row: SqlRow, now: number): Promise<boolean> {
    const registrationId = String(row.registration_id)
    if (!(await tx.tryLockScope(`push-device:${registrationId}`))) return false
    const [device] = await tx.query(
      `SELECT (SELECT batch_id FROM push_delivery_batches WHERE registration_id = ? AND state = 'pending' AND expires_at > ? AND due_at > ? ORDER BY due_at, created_at, batch_id LIMIT 1) AS head,
      EXISTS (SELECT 1 FROM push_delivery_batches WHERE registration_id = ? AND state = 'pending' AND lease_until > 0 AND lease_until > ?) AS busy`,
      [registrationId, now, now - TTL_MS, registrationId, now]
    )
    return device?.head === row.batch_id && !Number(device?.busy)
  }

  private async lease(
    tx: PushDatabase,
    row: SqlRow,
    now: number
  ): Promise<QueuedPushDelivery | null> {
    const notification = parsePushDeliveryPayload(String(row.payload_json))
    if (await isDismissedAlert(tx, String(row.host_fingerprint), notification)) {
      await tx.query('DELETE FROM push_delivery_batches WHERE batch_id = ?', [row.batch_id])
      return null
    }
    const lease = randomUUID()
    await tx.query(
      'UPDATE push_delivery_batches SET lease_token = ?, lease_until = ?, attempts = attempts + 1 WHERE batch_id = ?',
      [lease, now + DELIVERY_LEASE_MS, row.batch_id]
    )
    return this.delivery(row, lease)
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

  // Ungated: a keyed one-row write must not queue behind claims, or a lease can lapse mid-send.
  async renew(delivery: QueuedPushDelivery): Promise<void> {
    await this.database.query(
      "UPDATE push_delivery_batches SET lease_until = ? WHERE batch_id = ? AND lease_token = ? AND state = 'pending'",
      [this.now() + DELIVERY_LEASE_MS, delivery.id, delivery.lease]
    )
  }

  // A finished batch is deleted: accept() dedups on push_event_recipients, never on this row.
  async finish(delivery: QueuedPushDelivery, retryAfterMs?: number): Promise<void> {
    const now = this.now()
    const retryAt = retryAfterMs === undefined ? Infinity : now + Math.max(1000, retryAfterMs)
    if (retryAt >= delivery.expiresAt) {
      await this.background.query(
        "DELETE FROM push_delivery_batches WHERE batch_id = ? AND lease_token = ? AND state = 'pending'",
        [delivery.id, delivery.lease]
      )
      return
    }
    await this.background.query(
      `UPDATE push_delivery_batches SET payload_json = ?, due_at = ?, lease_until = 0, lease_token = NULL
      WHERE batch_id = ? AND lease_token = ? AND state = 'pending'`,
      [JSON.stringify(delivery.notification), retryAt, delivery.id, delivery.lease]
    )
  }

  async pendingCount(registrationId: string): Promise<number> {
    const [row] = await this.database.query(
      "SELECT COUNT(*) AS total FROM push_delivery_batches WHERE registration_id = ? AND state = 'pending'",
      [registrationId]
    )
    return Number(row?.total ?? 0)
  }

  // Bounded per call and per statement, so it drains any backlog on its own without holding locks.
  async prune(): Promise<number> {
    const now = this.now()
    // Also clears terminal rows older revisions kept, since each carries a past expires_at.
    let deleted = await this.deleteInBatches(
      'push_delivery_batches',
      'batch_id',
      'expires_at <= ? AND lease_until <= ?',
      [now, now]
    )
    // A day, not the 15-minute quota window: a host replaying an event after that must stay deduped.
    for (const [table, key] of [
      ['push_dismissed_events', 'host_fingerprint, notification_epoch, notification_id'],
      ['push_event_recipients', 'event_id, registration_id'],
      ['push_events', 'event_id']
    ] as const) {
      deleted += await this.deleteInBatches(table, key, 'created_at < ?', [now - RETENTION_MS])
    }
    return deleted
  }

  private async deleteInBatches(
    table: string,
    key: string,
    where: string,
    params: unknown[]
  ): Promise<number> {
    const lockRows = this.background.dialect === 'postgres' ? ' FOR UPDATE SKIP LOCKED' : ''
    let total = 0
    for (let batch = 0; batch < PRUNE_MAX_BATCHES; batch++) {
      const [result] = await this.background.query(
        `DELETE FROM ${table} WHERE (${key}) IN (SELECT ${key} FROM ${table} WHERE ${where} LIMIT ${PRUNE_BATCH_ROWS}${lockRows})`,
        params
      )
      const changes = Number(result?.changes ?? 0)
      total += changes
      if (changes < PRUNE_BATCH_ROWS) break
    }
    return total
  }
}
