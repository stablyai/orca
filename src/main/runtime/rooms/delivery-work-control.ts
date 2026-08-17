import type SyncDatabase from '../../sqlite/sync-database'
import type { RoomDelivery, RoomWorkState } from '../../../shared/rooms'
import { deliveryFromRow, type RoomRow } from './rows'

export const roomDeliveryDispatchStopped = (db: SyncDatabase.Database, roomId: string): boolean =>
  Boolean(db.prepare('SELECT 1 FROM rooms WHERE id = ? AND delivery_queue_stopped = 1').get(roomId))

export function roomDeliveryWorkState(db: SyncDatabase.Database, roomId: string): RoomWorkState {
  const row = db
    .prepare(
      `SELECT rooms.delivery_queue_stopped AS stopped,
         EXISTS(
           SELECT 1 FROM room_deliveries d
           JOIN room_messages m ON m.id = d.message_id
           WHERE m.room_id = ? AND (
             (d.state = 'pending' AND EXISTS (
               SELECT 1 FROM room_participants participant
               WHERE participant.id = d.participant_id
                 AND participant.participation = 'active'
             )) OR
             d.state = 'delivering' OR
             (d.state = 'delivered' AND d.responded_at IS NULL) OR
             (d.state = 'failed' AND d.error = 'room_delivery_uncertain')
           )
         ) AS active,
         EXISTS(
           SELECT 1 FROM room_deliveries d
           JOIN room_messages m ON m.id = d.message_id
           WHERE m.room_id = ? AND d.state = 'suppressed' AND d.error = 'room_stopping'
         ) AS stopping
       FROM rooms WHERE rooms.id = ?`
    )
    .get(roomId, roomId, roomId) as { active: number; stopping: number; stopped: number }
  return row.stopping ? 'active' : row.stopped ? 'stopped' : row.active ? 'active' : 'idle'
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
       WHEN state = 'pending'
         THEN 'room_stopped'
       ELSE 'room_stopping'
     END,
     next_attempt_at = ?, response_message_id = NULL, responded_at = NULL
     WHERE id IN (${placeholders})`
  ).run(Number.MAX_SAFE_INTEGER, ...ids)
  db.prepare('UPDATE rooms SET delivery_queue_stopped = 1 WHERE id = ?').run(roomId)
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
): { resumed: RoomDelivery[]; deliveries: RoomDelivery[] } {
  const stopping = db
    .prepare(
      `SELECT 1 FROM room_deliveries d JOIN room_messages m ON m.id = d.message_id
       WHERE m.room_id = ? AND d.state = 'suppressed' AND d.error = 'room_stopping' LIMIT 1`
    )
    .get(roomId)
  if (stopping) {
    throw new Error('room_stop_in_progress')
  }
  const manuallyPaused = roomDeliveryDispatchStopped(db, roomId)
  const manuallyStopped = manuallyPaused
    ? (
        db
          .prepare(
            `SELECT d.* FROM room_deliveries d
         JOIN room_messages m ON m.id = d.message_id
         WHERE m.room_id = ? AND d.state = 'suppressed' AND d.error = 'room_stopped'`
          )
          .all(roomId) as RoomRow[]
      ).map(deliveryFromRow)
    : []
  const resumable = manuallyPaused
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
    if (manuallyPaused) {
      db.prepare('UPDATE rooms SET delivery_queue_stopped = 0 WHERE id = ?').run(roomId)
    }
    return { resumed: [], deliveries: [] }
  }
  const ids = resumable.map((delivery) => delivery.id)
  const placeholders = ids.map(() => '?').join(', ')
  if (manuallyPaused) {
    db.prepare(
      `UPDATE room_deliveries SET
       attempts = CASE WHEN intent = 'steer' THEN MAX(attempts, 1) ELSE attempts END,
       intent = CASE WHEN intent = 'steer' THEN 'next' ELSE intent END,
       state = CASE WHEN participant_id IN (
         SELECT id FROM room_participants WHERE participation = 'active'
       ) OR attempts > 0 THEN 'pending' ELSE 'suppressed' END,
       phase = NULL,
       error = CASE WHEN participant_id IN (
         SELECT id FROM room_participants WHERE participation = 'active'
       ) OR attempts > 0 THEN NULL ELSE 'room_participant_paused' END,
       next_attempt_at = CASE WHEN participant_id IN (
         SELECT id FROM room_participants WHERE participation = 'active'
       ) OR attempts > 0 THEN ? ELSE ? END,
       delivered_at = NULL, provider_turn_id = NULL,
       response_message_id = NULL, responded_at = NULL WHERE id IN (${placeholders})`
    ).run(now, Number.MAX_SAFE_INTEGER, ...ids)
  } else {
    db.prepare(
      `UPDATE room_deliveries SET state = 'pending', phase = NULL, error = NULL,
       next_attempt_at = ?, delivered_at = NULL, provider_turn_id = NULL,
       response_message_id = NULL, responded_at = NULL WHERE id IN (${placeholders})`
    ).run(now, ...ids)
  }
  const deliveries = deliveriesById(db, ids)
  if (manuallyPaused) {
    db.prepare('UPDATE rooms SET delivery_queue_stopped = 0 WHERE id = ?').run(roomId)
  }
  const activeIds = new Set(
    (
      db
        .prepare('SELECT id FROM room_participants WHERE room_id = ? AND participation = ?')
        .all(roomId, 'active') as RoomRow[]
    ).map((row) => String(row.id))
  )
  return {
    resumed: deliveries.filter(
      (delivery) => delivery.state === 'pending' && activeIds.has(delivery.participantId)
    ),
    deliveries
  }
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
    db.prepare('UPDATE rooms SET delivery_queue_stopped = 0 WHERE id = ?').run(roomId)
    return []
  }
  db.prepare(
    `UPDATE room_deliveries SET error = 'room_stopped_superseded'
     WHERE state = 'suppressed' AND error = 'room_stopped'
       AND message_id IN (SELECT id FROM room_messages WHERE room_id = ?)`
  ).run(roomId)
  db.prepare('UPDATE rooms SET delivery_queue_stopped = 0 WHERE id = ?').run(roomId)
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
    `UPDATE room_deliveries SET error = 'room_stopped', delivered_at = NULL,
     provider_turn_id = NULL, response_message_id = NULL, responded_at = NULL
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
  return ids.flatMap((id) => {
    const delivery = deliveries.get(id)
    return delivery ? [delivery] : []
  })
}
