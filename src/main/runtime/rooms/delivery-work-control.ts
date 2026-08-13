import type SyncDatabase from '../../sqlite/sync-database'
import type { RoomDelivery, RoomWorkState } from '../../../shared/rooms'
import { deliveryFromRow, type RoomRow } from './rows'

export function roomDeliveryWorkState(db: SyncDatabase.Database, roomId: string): RoomWorkState {
  const row = db
    .prepare(
      `SELECT
         EXISTS(
           SELECT 1 FROM room_deliveries d
           JOIN room_messages m ON m.id = d.message_id
           WHERE m.room_id = ? AND (
             d.state IN ('pending', 'delivering') OR
             (d.state = 'delivered' AND d.responded_at IS NULL) OR
             (d.state = 'failed' AND d.error = 'room_delivery_uncertain') OR
             (d.state = 'suppressed' AND d.error = 'room_stopping')
           )
         ) AS active,
         EXISTS(
           SELECT 1 FROM room_deliveries d
           JOIN room_messages m ON m.id = d.message_id
           WHERE m.room_id = ? AND d.state = 'suppressed' AND d.error = 'room_stopped'
         ) AS stopped`
    )
    .get(roomId, roomId) as { active: number; stopped: number }
  return row.active ? 'active' : row.stopped ? 'stopped' : 'idle'
}

export function stopRoomDeliveries(
  db: SyncDatabase.Database,
  roomId: string
): { stopped: RoomDelivery[]; deliveries: RoomDelivery[] } {
  const stopped = (
    db
      .prepare(
        `SELECT d.* FROM room_deliveries d
         JOIN room_messages m ON m.id = d.message_id
         WHERE m.room_id = ? AND (
           d.state IN ('pending', 'delivering') OR
           (d.state = 'delivered' AND d.responded_at IS NULL) OR
           (d.state = 'failed' AND d.error = 'room_delivery_uncertain') OR
           (d.state = 'suppressed' AND d.error = 'room_stopping')
         )`
      )
      .all(roomId) as RoomRow[]
  ).map(deliveryFromRow)
  if (stopped.length === 0) {
    return { stopped, deliveries: [] }
  }
  const ids = stopped.map((delivery) => delivery.id)
  const placeholders = ids.map(() => '?').join(', ')
  db.prepare(
    `UPDATE room_deliveries SET state = 'suppressed', phase = NULL, error = CASE
       WHEN state = 'pending' OR (state = 'delivering' AND phase = 'waking')
         THEN 'room_stopped'
       ELSE 'room_stopping'
     END,
     next_attempt_at = ?, delivered_at = NULL, provider_turn_id = NULL,
     response_message_id = NULL, responded_at = NULL WHERE id IN (${placeholders})`
  ).run(Number.MAX_SAFE_INTEGER, ...ids)
  return { stopped, deliveries: deliveriesById(db, ids) }
}

export function stopMessageDeliveries(
  db: SyncDatabase.Database,
  messageId: string
): { stopped: RoomDelivery[]; deliveries: RoomDelivery[] } {
  const stopped = (
    db
      .prepare(
        `SELECT * FROM room_deliveries WHERE message_id = ? AND (
           state IN ('pending', 'delivering', 'failed', 'suppressed') OR
           (state = 'delivered' AND responded_at IS NULL)
         )`
      )
      .all(messageId) as RoomRow[]
  ).map(deliveryFromRow)
  if (stopped.length === 0) {
    return { stopped, deliveries: [] }
  }
  const ids = stopped.map((delivery) => delivery.id)
  const placeholders = ids.map(() => '?').join(', ')
  db.prepare(
    `UPDATE room_deliveries SET state = 'suppressed', phase = NULL,
     error = 'room_message_deleted', next_attempt_at = ?, delivered_at = NULL,
     provider_turn_id = NULL, response_message_id = NULL, responded_at = NULL
     WHERE id IN (${placeholders})`
  ).run(Number.MAX_SAFE_INTEGER, ...ids)
  return { stopped, deliveries: deliveriesById(db, ids) }
}

export function resumeRoomDeliveries(
  db: SyncDatabase.Database,
  roomId: string,
  now: number
): RoomDelivery[] {
  const stopping = db
    .prepare(
      `SELECT 1 FROM room_deliveries d JOIN room_messages m ON m.id = d.message_id
       WHERE m.room_id = ? AND d.state = 'suppressed' AND d.error = 'room_stopping' LIMIT 1`
    )
    .get(roomId)
  if (stopping) {
    throw new Error('room_stop_in_progress')
  }
  const manuallyStopped = (
    db
      .prepare(
        `SELECT d.* FROM room_deliveries d
         JOIN room_messages m ON m.id = d.message_id
         WHERE m.room_id = ? AND d.state = 'suppressed' AND d.error = 'room_stopped'`
      )
      .all(roomId) as RoomRow[]
  ).map(deliveryFromRow)
  const resumable =
    manuallyStopped.length > 0
      ? manuallyStopped
      : (
          db
            .prepare(
              `SELECT d.* FROM room_deliveries d
               JOIN room_messages m ON m.id = d.message_id
               WHERE m.room_id = ? AND d.state = 'suppressed' AND d.error IS NULL
                 AND m.sequence = (
                   SELECT max(latest.sequence) FROM room_messages latest
                   JOIN room_deliveries latest_delivery
                     ON latest_delivery.message_id = latest.id
                   WHERE latest.room_id = ? AND latest_delivery.state = 'suppressed'
                     AND latest_delivery.error IS NULL
                 )`
            )
            .all(roomId, roomId) as RoomRow[]
        ).map(deliveryFromRow)
  if (resumable.length === 0) {
    return []
  }
  const ids = resumable.map((delivery) => delivery.id)
  const placeholders = ids.map(() => '?').join(', ')
  db.prepare(
    `UPDATE room_deliveries SET state = 'pending', phase = NULL, error = NULL,
     next_attempt_at = ?, delivered_at = NULL, provider_turn_id = NULL,
     response_message_id = NULL, responded_at = NULL WHERE id IN (${placeholders})`
  ).run(now, ...ids)
  return deliveriesById(db, ids)
}

export function supersedeRoomStop(db: SyncDatabase.Database, roomId: string): RoomDelivery[] {
  const stopping = db
    .prepare(
      `SELECT 1 FROM room_deliveries d JOIN room_messages m ON m.id = d.message_id
       WHERE m.room_id = ? AND d.state = 'suppressed' AND d.error = 'room_stopping' LIMIT 1`
    )
    .get(roomId)
  if (stopping) {
    throw new Error('room_stop_in_progress')
  }
  const stopped = (
    db
      .prepare(
        `SELECT d.* FROM room_deliveries d JOIN room_messages m ON m.id = d.message_id
         WHERE m.room_id = ? AND d.state = 'suppressed' AND d.error = 'room_stopped'`
      )
      .all(roomId) as RoomRow[]
  ).map(deliveryFromRow)
  if (stopped.length === 0) {
    return []
  }
  db.prepare(
    `UPDATE room_deliveries SET error = 'room_stopped_superseded'
     WHERE state = 'suppressed' AND error = 'room_stopped'
       AND message_id IN (SELECT id FROM room_messages WHERE room_id = ?)`
  ).run(roomId)
  return deliveriesById(
    db,
    stopped.map((delivery) => delivery.id)
  )
}

export function finishRoomStop(
  db: SyncDatabase.Database,
  deliveryIds: readonly string[]
): RoomDelivery[] {
  if (deliveryIds.length === 0) {
    return []
  }
  const placeholders = deliveryIds.map(() => '?').join(', ')
  db.prepare(
    `UPDATE room_deliveries SET error = 'room_stopped'
     WHERE id IN (${placeholders}) AND state = 'suppressed' AND error = 'room_stopping'`
  ).run(...deliveryIds)
  return deliveriesById(db, [...deliveryIds])
}

function deliveriesById(db: SyncDatabase.Database, ids: string[]): RoomDelivery[] {
  const placeholders = ids.map(() => '?').join(', ')
  const rows = db
    .prepare(`SELECT * FROM room_deliveries WHERE id IN (${placeholders})`)
    .all(...ids) as RoomRow[]
  const deliveries = new Map(rows.map((row) => [String(row.id), deliveryFromRow(row)]))
  return ids.map((id) => deliveries.get(id)!)
}
