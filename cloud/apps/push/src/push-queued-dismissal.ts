import type { PushNotification } from '@orca-cloud/push-contract'
import type { PushDatabase } from './push-database.js'
import { parsePushDeliveryPayload } from './push-delivery-payload.js'

export async function reconcileQueuedDismissal(
  tx: PushDatabase,
  host: string,
  registrationId: string,
  notification: PushNotification,
  now: number
): Promise<boolean> {
  if (!notification.notificationId) return false
  const key = [host, notification.notificationEpoch, notification.notificationId]
  const [dismissed] = await tx.query(
    'SELECT notification_seq FROM push_dismissed_events WHERE host_fingerprint = ? AND notification_epoch = ? AND notification_id = ?',
    key
  )
  if (notification.kind !== 'dismiss')
    return Number(dismissed?.notification_seq ?? -1) >= notification.notificationSeq
  await tx.query(
    `INSERT INTO push_dismissed_events(host_fingerprint, notification_epoch, notification_id, notification_seq, created_at)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(host_fingerprint, notification_epoch, notification_id)
    DO UPDATE SET notification_seq = CASE WHEN push_dismissed_events.notification_seq > excluded.notification_seq THEN push_dismissed_events.notification_seq ELSE excluded.notification_seq END, created_at = excluded.created_at`,
    [...key, notification.notificationSeq, now]
  )
  const deliveries = await tx.query(
    "SELECT batch_id, payload_json FROM push_delivery_batches WHERE host_fingerprint = ? AND registration_id = ? AND kind = 'alert' AND state = 'pending' AND lease_until <= ?",
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
    await tx.query(
      'UPDATE push_delivery_batches SET payload_json = ?, state = ? WHERE batch_id = ?',
      ['{}', 'dismissed', delivery.batch_id]
    )
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
