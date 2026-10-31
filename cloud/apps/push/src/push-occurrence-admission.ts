import type { PushDatabase } from './push-database.js'
import type { PushDeviceRegistration } from './device-registry-store.js'
import type { QueuedPushDelivery } from './durable-push-store.js'
import {
  fenceDismissedOccurrences,
  occurrenceIdentity,
  occurrenceLock,
  occurrenceTarget,
  type OccurrenceIdentity
} from './push-occurrence-authority.js'
import { isDismissedAlert } from './push-queued-dismissal.js'

export { pushDestination } from './push-occurrence-authority.js'

export type OccurrenceAdmission = 'admitted' | 'superseded' | 'deferred' | 'skipped'
export type OccurrenceAdmissionPort = {
  acquire(device: PushDeviceRegistration): Promise<OccurrenceAdmission>
  finalize(sent: boolean): Promise<void>
  renew(): Promise<void>
}

export function occurrenceAdmission(
  database: PushDatabase,
  queued: QueuedPushDelivery,
  now: () => number
): OccurrenceAdmissionPort {
  const { notification: n } = queued
  let identity: OccurrenceIdentity | undefined
  return {
    async acquire(device) {
      return database.transaction(async (tx) => {
        if (!(await tx.tryLockScope(`push-events:${queued.hostFingerprint}`))) {
          return 'deferred'
        }
        const lock = tx.dialect === 'postgres' ? ' FOR UPDATE SKIP LOCKED' : ''
        const [batch] = await tx.query(
          `SELECT batch_id FROM push_delivery_batches WHERE batch_id = ? AND host_fingerprint = ?
          AND registration_id = ? AND lease_token = ? AND state = 'pending' AND lease_until > ? AND expires_at > ?${lock}`,
          [queued.id, queued.hostFingerprint, queued.registrationId, queued.lease, now(), now()]
        )
        if (!batch) {
          return 'deferred'
        }
        if (await isDismissedAlert(tx, queued.hostFingerprint, n)) {
          return (await fenceDismissedOccurrences(
            tx,
            queued.hostFingerprint,
            queued.registrationId,
            [{ id: queued.id, notification: n }],
            now(),
            true
          ))
            ? 'superseded'
            : 'deferred'
        }
        if (!n.origin || !n.occurrence) {
          return 'skipped'
        }
        const target = await occurrenceTarget(
          tx,
          queued.hostFingerprint,
          queued.registrationId,
          true
        )
        if (!target || target === 'deferred') {
          return 'deferred'
        }
        const actual = target.device
        if (
          actual.platform !== device.platform ||
          actual.token !== device.token ||
          (actual.apns_environment ?? '') !== (device.apnsEnvironment ?? '') ||
          (actual.route_key ?? undefined) !== device.routeKey ||
          actual.dead_at != null ||
          device.registrationId !== queued.registrationId ||
          device.hostFingerprint !== queued.hostFingerprint
        ) {
          return 'deferred'
        }
        if (!device.routeKey || !target.domain) {
          return 'skipped'
        }
        const candidate = occurrenceIdentity(target.domain, n)
        if (!candidate) {
          return 'skipped'
        }
        if (!(await tx.tryLockScope(occurrenceLock(candidate)))) {
          return 'deferred'
        }
        const [row] = await tx.query(
          'SELECT * FROM push_occurrence_domains WHERE destination = ? AND route_key = ? AND origin = ? AND occurrence = ?',
          candidate
        )
        if (row?.state === 'dismissed' && Number(row.created_at) >= now() - 24 * 60 * 60_000) {
          return 'superseded'
        }
        if (row) {
          if (row.state === 'sent' && Number(row.created_at) >= now() - 24 * 60 * 60_000) {
            return 'superseded'
          }
          if (
            row.state === 'inflight' &&
            Number(row.lease_until) > now() &&
            row.batch_id !== queued.id
          ) {
            return 'deferred'
          }
        }
        await tx.query(
          `INSERT INTO push_occurrence_domains(destination, route_key, origin, occurrence, state, batch_id, attempt, winner_host, lease_until, created_at)
          VALUES (?, ?, ?, ?, 'inflight', ?, ?, ?, ?, ?) ON CONFLICT(destination, route_key, origin, occurrence) DO UPDATE SET state = excluded.state, batch_id = excluded.batch_id, attempt = excluded.attempt, winner_host = excluded.winner_host, lease_until = excluded.lease_until, created_at = excluded.created_at`,
          [...candidate, queued.id, queued.lease, queued.hostFingerprint, now() + 30_000, now()]
        )
        await tx.query(
          `INSERT INTO push_batch_admissions(batch_id, destination, route_key, attempt, expires_at)
          VALUES (?, ?, ?, ?, ?) ON CONFLICT(batch_id, destination, route_key) DO UPDATE SET attempt = excluded.attempt`,
          [queued.id, candidate[0], candidate[1], queued.lease, queued.expiresAt]
        )
        identity = candidate
        return 'admitted'
      })
    },
    async finalize(sent) {
      const admittedIdentity = identity
      if (!admittedIdentity) {
        return
      }
      for (let attempt = 0; ; attempt++) {
        try {
          await database.transaction(async (tx) => {
            await tx.lockScope(occurrenceLock(admittedIdentity))
            const fence = [...admittedIdentity, queued.id, queued.lease]
            await tx.query(
              sent
                ? "UPDATE push_occurrence_domains SET state = 'sent' WHERE destination = ? AND route_key = ? AND origin = ? AND occurrence = ? AND state = 'inflight' AND batch_id = ? AND attempt = ?"
                : "DELETE FROM push_occurrence_domains WHERE destination = ? AND route_key = ? AND origin = ? AND occurrence = ? AND state = 'inflight' AND batch_id = ? AND attempt = ?",
              fence
            )
          })
          return
        } catch (error) {
          if (attempt === 3) {
            throw error
          }
          await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)))
        }
      }
    },
    async renew() {
      const admittedIdentity = identity
      if (!admittedIdentity) {
        return
      }
      await database.transaction(async (tx) => {
        await tx.lockScope(occurrenceLock(admittedIdentity))
        await tx.query(
          "UPDATE push_occurrence_domains SET lease_until = ? WHERE destination = ? AND route_key = ? AND origin = ? AND occurrence = ? AND state = 'inflight' AND batch_id = ? AND attempt = ?",
          [now() + 30_000, ...admittedIdentity, queued.id, queued.lease]
        )
      })
    }
  }
}
