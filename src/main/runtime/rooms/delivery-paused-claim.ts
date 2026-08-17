import type SyncDatabase from '../../sqlite/sync-database'
import type { RoomDelivery, RoomDeliveryAttempt } from '../../../shared/rooms'
import { deliveryFromRow, type RoomRow } from './rows'

const getDelivery = (db: SyncDatabase.Database, id: string): RoomDelivery =>
  deliveryFromRow(db.prepare('SELECT * FROM room_deliveries WHERE id = ?').get(id) as RoomRow)

export function deferPausedRoomDelivery(
  db: SyncDatabase.Database,
  delivery: RoomDelivery,
  now = Date.now()
): RoomDelivery | null {
  const head = db
    .prepare(
      `SELECT COALESCE(MIN(queue_position), 0) - 1 AS position
       FROM room_deliveries WHERE participant_id = ? AND id <> ?`
    )
    .get(delivery.participantId, delivery.id) as RoomRow
  const history = [...(delivery.attemptHistory ?? [])]
  if (delivery.phase) {
    const attempt: RoomDeliveryAttempt = {
      attempt: delivery.attempts,
      phase: delivery.phase,
      error: 'room_participant_paused',
      at: now
    }
    history.push(attempt)
  }
  const changed = db
    .prepare(
      `UPDATE room_deliveries SET state = 'pending', intent = 'next', phase = NULL,
       error = 'room_participant_paused', next_attempt_at = ?, queue_position = ?,
       attempt_history_json = ?
       WHERE id = ? AND state = 'delivering' AND attempts = ? AND EXISTS (
         SELECT 1 FROM room_participants participant
         WHERE participant.id = room_deliveries.participant_id
           AND participant.participation = 'paused'
       )`
    )
    .run(
      now,
      Number(head.position),
      JSON.stringify(history.slice(-5)),
      delivery.id,
      delivery.attempts
    ).changes
  return changed === 1 ? getDelivery(db, delivery.id) : null
}
