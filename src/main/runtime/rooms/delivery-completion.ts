import type SyncDatabase from '../../sqlite/sync-database'
import type { RoomDelivery, RoomDeliveryAttempt } from '../../../shared/rooms'
import { deliveryFromRow, type RoomRow } from './rows'

export function finishRoomDelivery(
  db: SyncDatabase.Database,
  delivery: RoomDelivery,
  state: RoomDelivery['state'],
  error: string | null,
  nextAttemptAt: number,
  now = Date.now()
): RoomDelivery {
  const history = [...(delivery.attemptHistory ?? [])]
  if (error && delivery.phase) {
    const attempt: RoomDeliveryAttempt = {
      attempt: delivery.attempts,
      phase: delivery.phase,
      error,
      at: now
    }
    history.push(attempt)
  }
  db.prepare(
    `UPDATE room_deliveries SET state = ?, phase = NULL, error = ?, next_attempt_at = ?,
     delivered_at = ?, provider_turn_id = NULL, attempt_history_json = ?
     WHERE id = ? AND state = ?`
  ).run(
    state,
    error,
    nextAttemptAt,
    state === 'delivered' ? now : null,
    JSON.stringify(history.slice(-5)),
    delivery.id,
    delivery.state
  )
  const row = db.prepare('SELECT * FROM room_deliveries WHERE id = ?').get(delivery.id) as
    | RoomRow
    | undefined
  if (!row) {
    throw new Error('room_delivery_not_found')
  }
  return deliveryFromRow(row)
}
