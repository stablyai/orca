import type SyncDatabase from '../../sqlite/sync-database'
import type { RoomDelivery } from '../../../shared/rooms'
import { deliveryFromRow, type RoomRow } from './rows'

export const isRoomDeliveryMutable = (delivery: RoomDelivery): boolean =>
  delivery.attempts === 0 &&
  (delivery.state === 'pending' ||
    (delivery.state === 'suppressed' &&
      (delivery.error === 'room_delivery_retargeted' ||
        delivery.error === 'room_participant_paused' ||
        (delivery.error === 'room_stopped' && delivery.intent === 'next'))))

export const hasRoomQueueEditReservation = (
  db: SyncDatabase.Database,
  participantId: string
): boolean =>
  Boolean(
    db
      .prepare(
        `SELECT 1 FROM room_deliveries d JOIN room_messages m ON m.id = d.message_id
         WHERE d.participant_id = ? AND m.queue_edit_token IS NOT NULL
         AND (d.state = 'pending' OR (d.state = 'suppressed' AND d.error = 'room_stopped'
           AND d.attempts = 0 AND d.intent = 'next')) LIMIT 1`
      )
      .get(participantId)
  )

export function assertRoomMessageDeliveryMutable(
  db: SyncDatabase.Database,
  messageId: string,
  editToken?: string
): void {
  const message = db
    .prepare('SELECT delivery_attempted, queue_edit_token FROM room_messages WHERE id = ?')
    .get(messageId) as RoomRow | undefined
  const deliveries = (
    db.prepare('SELECT * FROM room_deliveries WHERE message_id = ?').all(messageId) as RoomRow[]
  ).map(deliveryFromRow)
  if (
    !message ||
    Number(message.delivery_attempted) === 1 ||
    (editToken ? message.queue_edit_token !== editToken : message.queue_edit_token !== null) ||
    deliveries.some((delivery) => !isRoomDeliveryMutable(delivery))
  ) {
    throw new Error('room_delivery_queue_stale')
  }
}
