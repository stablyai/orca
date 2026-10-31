import type { PushNotification } from '@orca-cloud/push-contract'
import type { PushDatabase } from './push-database.js'
import { parsePushDeliveryPayload } from './push-delivery-payload.js'

export type CoveredPushBatch = { id?: string; notification: PushNotification }

export async function reconcileQueuedDismissal(
  tx: PushDatabase,
  host: string,
  registrationId: string,
  notification: PushNotification,
  now: number,
  fences: CoveredPushBatch[] = []
): Promise<boolean> {
  if (!notification.notificationId) return false
  const key = [host, notification.notificationEpoch, notification.notificationId]
  const [dismissed] = await tx.query(
    'SELECT notification_seq FROM push_dismissed_events WHERE host_fingerprint = ? AND notification_epoch = ? AND notification_id = ?',
    key
  )
  if (notification.kind !== 'dismiss') {
    const covered = Number(dismissed?.notification_seq ?? -1) >= notification.notificationSeq
    if (covered) {
      fences.push({ notification })
    }
    return covered
  }
  await tx.query(
    `INSERT INTO push_dismissed_events(host_fingerprint, notification_epoch, notification_id, notification_seq, created_at)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(host_fingerprint, notification_epoch, notification_id)
    DO UPDATE SET notification_seq = CASE WHEN push_dismissed_events.notification_seq > excluded.notification_seq THEN push_dismissed_events.notification_seq ELSE excluded.notification_seq END, created_at = excluded.created_at`,
    [...key, notification.notificationSeq, now]
  )
  const lock = tx.dialect === 'postgres' ? ' FOR UPDATE' : ''
  const deliveries = await tx.query(
    `SELECT batch_id, payload_json FROM push_delivery_batches WHERE host_fingerprint = ? AND registration_id = ? AND kind = 'alert' AND state = 'pending' AND expires_at > ? ORDER BY batch_id${lock}`,
    [host, registrationId, now]
  )
  for (const delivery of deliveries) {
    const queued = parsePushDeliveryPayload(String(delivery.payload_json))
    if (
      queued.notificationEpoch !== notification.notificationEpoch ||
      queued.notificationId !== notification.notificationId ||
      queued.notificationSeq > notification.notificationSeq
    )
      continue
    fences.push({ id: String(delivery.batch_id), notification: queued })
  }
  return false
}

export async function isDismissedAlert(
  tx: PushDatabase,
  host: string,
  notification: PushNotification
): Promise<boolean> {
  if (notification.kind === 'dismiss' || !notification.notificationId) return false
  const rows = await tx.query(
    'SELECT notification_seq FROM push_dismissed_events WHERE host_fingerprint = ? AND notification_epoch = ? AND notification_id = ?',
    [host, notification.notificationEpoch, notification.notificationId]
  )
  return Number(rows[0]?.notification_seq ?? -1) >= notification.notificationSeq
}

// Handoff is complete while the descriptors and proof still belong to live duties.
export async function retireCoveredPushBatches(
  tx: PushDatabase,
  covered: CoveredPushBatch[],
  now: number
): Promise<void> {
  for (const batch of covered) {
    if (!batch.id) continue
    const removed = await tx.query(
      "DELETE FROM push_delivery_batches WHERE batch_id = ? AND state = 'pending' AND lease_until <= ? RETURNING batch_id",
      [batch.id, now]
    )
    if (removed.length)
      await tx.query('DELETE FROM push_batch_admissions WHERE batch_id = ?', [batch.id])
  }
}
