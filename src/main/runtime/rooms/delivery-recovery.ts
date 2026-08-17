import type SyncDatabase from '../../sqlite/sync-database'
import type { RoomDelivery } from '../../../shared/rooms'
import { deliveryFromRow, type RoomRow } from './rows'

export function recoverRoomDeliveries(
  db: SyncDatabase.Database,
  now: number,
  finish: (
    delivery: RoomDelivery,
    state: RoomDelivery['state'],
    error: string,
    nextAttemptAt: number,
    now: number
  ) => RoomDelivery
): void {
  const interrupted = (
    db
      .prepare(
        `SELECT * FROM room_deliveries WHERE state = 'delivering' OR (
           state = 'delivered' AND provider_turn_id IS NULL AND responded_at IS NULL
         )`
      )
      .all() as RoomRow[]
  ).map(deliveryFromRow)
  for (const delivery of interrupted) {
    const uncertain = delivery.phase !== 'waking'
    finish(
      delivery,
      uncertain ? 'failed' : 'pending',
      uncertain ? 'room_delivery_uncertain' : 'delivery_interrupted',
      uncertain ? Number.MAX_SAFE_INTEGER : now,
      now
    )
  }
}

export function suppressDeletedRoomMessageDeliveries(db: SyncDatabase.Database): void {
  db.prepare(
    `UPDATE room_deliveries SET state = 'suppressed', phase = NULL,
     error = 'room_message_deleted', next_attempt_at = ?
     WHERE message_id IN (SELECT id FROM room_messages WHERE deleted_at IS NOT NULL) AND (
       state IN ('pending', 'delivering') OR
       (state = 'delivered' AND responded_at IS NULL) OR
       (state = 'failed' AND error = 'room_delivery_uncertain')
     )`
  ).run(Number.MAX_SAFE_INTEGER)
}
