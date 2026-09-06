import type SyncDatabase from '../../sqlite/sync-database'
import type { RoomDelivery } from '../../../shared/rooms'
import { deliveryFromRow, type RoomRow } from './rows'

export function awaitingRoomDeliveryResponseGroup(
  db: SyncDatabase.Database,
  participantId: string,
  providerTurnId: string
): RoomDelivery[] {
  return (
    db
      .prepare(
        `SELECT d.* FROM room_deliveries d JOIN room_messages m ON m.id = d.message_id
         WHERE d.participant_id = ? AND d.provider_turn_id = ?
         AND d.state = 'delivered' AND d.responded_at IS NULL
         ORDER BY m.sequence DESC`
      )
      .all(participantId, providerTurnId) as RoomRow[]
  ).map(deliveryFromRow)
}

export function listRoomDeliveriesForTurn(
  db: SyncDatabase.Database,
  participantId: string,
  providerTurnId: string
): RoomDelivery[] {
  return (
    db
      .prepare(
        `SELECT * FROM room_deliveries WHERE participant_id = ? AND provider_turn_id = ?
         ORDER BY queue_position`
      )
      .all(participantId, providerTurnId) as RoomRow[]
  ).map(deliveryFromRow)
}

export function markRoomDeliveryResponseGroup(
  db: SyncDatabase.Database,
  participantId: string,
  providerTurnId: string,
  responseMessageId: string | null,
  respondedAt: number
): RoomDelivery[] {
  db.prepare(
    `UPDATE room_deliveries SET response_message_id = ?, responded_at = ?,
     state = 'delivered', error = NULL
     WHERE participant_id = ? AND provider_turn_id = ?
     AND responded_at IS NULL AND (
       state = 'delivered' OR (state = 'suppressed' AND error = 'room_stopping')
     )`
  ).run(responseMessageId, respondedAt, participantId, providerTurnId)
  return listRoomDeliveriesForTurn(db, participantId, providerTurnId)
}

export function failRoomDeliveryResponseGroup(
  db: SyncDatabase.Database,
  participantId: string,
  providerTurnId: string,
  fail: (deliveryId: string) => RoomDelivery
): RoomDelivery[] {
  return awaitingRoomDeliveryResponseGroup(db, participantId, providerTurnId).map(({ id }) =>
    fail(id)
  )
}
