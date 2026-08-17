import type SyncDatabase from '../../sqlite/sync-database'
import type { RoomDelivery } from '../../../shared/rooms'
import { deliveryFromRow, type RoomRow } from './rows'

const QUEUEABLE = `(d.state = 'pending' OR (
  d.state = 'suppressed' AND d.error = 'room_stopped'
  AND d.attempts = 0 AND d.intent = 'next'
))`

const MUTABLE = `(d.attempts = 0 AND (
  d.state = 'pending' OR (d.state = 'suppressed' AND (
    d.error IN ('room_delivery_retargeted', 'room_participant_paused')
    OR (d.error = 'room_stopped' AND d.intent = 'next')
  ))
))`

export function listMutableRoomBroadcastIds(db: SyncDatabase.Database, roomId: string): string[] {
  return (
    db
      .prepare(
        `SELECT m.id FROM room_messages m
         WHERE m.room_id = ? AND m.actor_kind = 'user'
         AND m.queue_edit_token IS NULL
         AND EXISTS (
           SELECT 1 FROM room_participants p
           WHERE p.room_id = m.room_id AND p.actor_kind = 'agent' AND p.participation = 'active'
         )
         AND NOT EXISTS (
           SELECT 1 FROM room_participants p
           WHERE p.room_id = m.room_id AND p.actor_kind = 'agent' AND p.participation = 'active'
           AND NOT EXISTS (
             SELECT 1 FROM room_deliveries d
             WHERE d.message_id = m.id AND d.participant_id = p.id AND ${QUEUEABLE}
           )
         )
         AND NOT EXISTS (
           SELECT 1 FROM room_deliveries d WHERE d.message_id = m.id AND NOT ${MUTABLE}
         )
         ORDER BY m.sequence`
      )
      .all(roomId) as RoomRow[]
  ).map((row) => String(row.id))
}

export function normalizeNewRoomBroadcasts(
  db: SyncDatabase.Database,
  roomId: string,
  previousIds: readonly string[]
): RoomDelivery[] {
  const previous = new Set(previousIds)
  const promoted = listMutableRoomBroadcastIds(db, roomId).filter((id) => !previous.has(id))
  if (promoted.length === 0) {
    return []
  }
  const placeholders = promoted.map(() => '?').join(', ')
  const ordered = db
    .prepare(
      `SELECT m.id, MIN(d.queue_position) AS position, m.sequence
       FROM room_messages m JOIN room_deliveries d ON d.message_id = m.id
       WHERE m.id IN (${placeholders}) AND ${QUEUEABLE}
       GROUP BY m.id ORDER BY position, m.sequence`
    )
    .all(...promoted) as RoomRow[]
  const participants = db
    .prepare(
      `SELECT id FROM room_participants
       WHERE room_id = ? AND actor_kind = 'agent' AND participation = 'active' ORDER BY id`
    )
    .all(roomId) as RoomRow[]
  const find = db.prepare(
    `SELECT id FROM room_deliveries d
     WHERE d.message_id = ? AND d.participant_id = ? AND ${QUEUEABLE}`
  )
  const tail = db.prepare(
    'SELECT COALESCE(MAX(queue_position), 0) + 1 AS position FROM room_deliveries WHERE participant_id = ?'
  )
  const update = db.prepare('UPDATE room_deliveries SET queue_position = ? WHERE id = ?')
  const next = new Map(
    participants.map((participant) => {
      const id = String(participant.id)
      return [id, Number((tail.get(id) as RoomRow).position)]
    })
  )
  const changed: string[] = []
  for (const message of ordered) {
    for (const participant of participants) {
      const participantId = String(participant.id)
      const delivery = find.get(String(message.id), participantId) as RoomRow
      const position = next.get(participantId)!
      update.run(position, String(delivery.id))
      next.set(participantId, position + 1)
      changed.push(String(delivery.id))
    }
  }
  if (changed.length === 0) {
    return []
  }
  const changedPlaceholders = changed.map(() => '?').join(', ')
  const rows = db
    .prepare(`SELECT * FROM room_deliveries WHERE id IN (${changedPlaceholders})`)
    .all(...changed) as RoomRow[]
  const byId = new Map(rows.map((row) => [String(row.id), deliveryFromRow(row)]))
  return changed.map((id) => byId.get(id)!)
}
