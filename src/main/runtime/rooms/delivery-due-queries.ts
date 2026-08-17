import type SyncDatabase from '../../sqlite/sync-database'
import type { RoomDelivery } from '../../../shared/rooms'
import { deliveryFromRow, type RoomRow } from './rows'

export function listRoomDue(
  db: SyncDatabase.Database,
  now: number,
  limit: number,
  excludedRoomIds: readonly string[]
): RoomDelivery[] {
  const excluded = excludedRoomIds.map(() => '?').join(', ')
  return (
    db
      .prepare(
        `SELECT d.* FROM room_deliveries d JOIN room_messages message ON message.id = d.message_id JOIN rooms room ON room.id = message.room_id JOIN room_participants participant ON participant.id = d.participant_id AND participant.participation = 'active' WHERE d.state = 'pending' AND d.intent = 'next' AND d.next_attempt_at <= ? AND room.delivery_queue_stopped = 0 AND message.queue_edit_token IS NULL ${excluded ? `AND message.room_id NOT IN (${excluded})` : ''} AND NOT EXISTS (SELECT 1 FROM room_deliveries blocked JOIN room_messages blocked_message ON blocked_message.id = blocked.message_id WHERE blocked.participant_id = d.participant_id AND blocked.id <> d.id AND blocked_message.queue_edit_token IS NULL AND (blocked.state = 'delivering' OR (blocked.state = 'delivered' AND blocked.responded_at IS NULL) OR (blocked.state = 'failed' AND blocked.error = 'room_delivery_uncertain') OR (blocked.state = 'suppressed' AND blocked.error = 'room_stopping') OR (blocked.state = 'pending' AND (blocked.queue_position < d.queue_position OR (blocked.queue_position = d.queue_position AND blocked_message.sequence < message.sequence))))) ORDER BY d.next_attempt_at, d.queue_position, message.sequence LIMIT ?`
      )
      .all(now, ...excludedRoomIds, Math.min(Math.max(limit, 1), 500)) as RoomRow[]
  ).map(deliveryFromRow)
}

export function listRoomAutoSteerDue(
  db: SyncDatabase.Database,
  now: number,
  limit: number,
  excludedRoomIds: readonly string[]
): RoomDelivery[] {
  const excluded = excludedRoomIds.map(() => '?').join(', ')
  return (
    db
      .prepare(
        `SELECT d.* FROM room_deliveries d
         JOIN room_messages message ON message.id = d.message_id
         JOIN rooms room ON room.id = message.room_id
         JOIN room_participants participant ON participant.id = d.participant_id
         WHERE d.state = 'pending' AND d.intent = 'next' AND d.attempts = 0
         AND d.next_attempt_at <= ? AND room.delivery_queue_stopped = 0
         AND message.actor_kind = 'agent' AND message.queue_edit_token IS NULL
         AND participant.participation = 'active' AND participant.terminal_handle IS NULL
         AND json_extract(participant.provider_session_json, '$.transport') = 'machine'
         ${excluded ? `AND message.room_id NOT IN (${excluded})` : ''}
         AND NOT EXISTS (
           SELECT 1 FROM room_deliveries blocked
           JOIN room_messages blocked_message ON blocked_message.id = blocked.message_id
           WHERE blocked.participant_id = d.participant_id AND blocked.id <> d.id
           AND blocked_message.queue_edit_token IS NULL AND (
             blocked.state = 'delivering' OR
             (blocked.state = 'failed' AND blocked.error = 'room_delivery_uncertain') OR
             (blocked.state = 'suppressed' AND blocked.error = 'room_stopping') OR
             (blocked_message.actor_kind = 'agent' AND blocked.state = 'pending'
               AND blocked.intent = 'next' AND (
                 blocked.queue_position < d.queue_position OR
                 (blocked.queue_position = d.queue_position
                   AND blocked_message.sequence < message.sequence)
               ))
           )
         )
         ORDER BY d.next_attempt_at, d.queue_position, message.sequence LIMIT ?`
      )
      .all(now, ...excludedRoomIds, Math.min(Math.max(limit, 1), 500)) as RoomRow[]
  ).map(deliveryFromRow)
}

export function nextRoomDueAt(
  db: SyncDatabase.Database,
  excludedRoomIds: readonly string[]
): number | null {
  const excluded = excludedRoomIds.map(() => '?').join(', ')
  const row = db
    .prepare(
      `SELECT min(d.next_attempt_at) AS next_due_at FROM room_deliveries d JOIN room_messages message ON message.id = d.message_id JOIN rooms room ON room.id = message.room_id JOIN room_participants participant ON participant.id = d.participant_id AND participant.participation = 'active' WHERE d.state = 'pending' AND d.intent = 'next' AND room.delivery_queue_stopped = 0 AND message.queue_edit_token IS NULL ${excluded ? `AND message.room_id NOT IN (${excluded})` : ''} AND NOT EXISTS (SELECT 1 FROM room_deliveries blocked JOIN room_messages blocked_message ON blocked_message.id = blocked.message_id WHERE blocked.participant_id = d.participant_id AND blocked.id <> d.id AND blocked_message.queue_edit_token IS NULL AND (blocked.state = 'delivering' OR (blocked.state = 'delivered' AND blocked.responded_at IS NULL) OR (blocked.state = 'failed' AND blocked.error = 'room_delivery_uncertain') OR (blocked.state = 'suppressed' AND blocked.error = 'room_stopping') OR (blocked.state = 'pending' AND (blocked.queue_position < d.queue_position OR (blocked.queue_position = d.queue_position AND blocked_message.sequence < message.sequence)))))`
    )
    .get(...excludedRoomIds) as RoomRow
  return row.next_due_at === null ? null : Number(row.next_due_at)
}
