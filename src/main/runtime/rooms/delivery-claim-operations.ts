import type SyncDatabase from '../../sqlite/sync-database'
import type { RoomDelivery } from '../../../shared/rooms'
import { deliveryFromRow, type RoomRow } from './rows'

export function claimRoomDelivery(
  db: SyncDatabase.Database,
  id: string,
  steer = false
): RoomDelivery | null {
  const changed = db
    .prepare(
      steer
        ? `UPDATE room_deliveries SET state = 'delivering', intent = 'steer', phase = 'submitting',
           error = NULL, attempts = attempts + 1
           WHERE id = ? AND state = 'pending' AND attempts = 0 AND intent = 'next'
           AND EXISTS (SELECT 1 FROM room_messages editable
             WHERE editable.id = room_deliveries.message_id AND editable.queue_edit_token IS NULL)
           AND EXISTS (
             SELECT 1 FROM room_participants target
             WHERE target.id = room_deliveries.participant_id
               AND target.participation = 'active'
           )
           AND NOT EXISTS (
             SELECT 1 FROM rooms stopped JOIN room_messages candidate_message
               ON candidate_message.room_id = stopped.id
             WHERE candidate_message.id = room_deliveries.message_id
               AND stopped.delivery_queue_stopped = 1
           )
           AND NOT EXISTS (
             SELECT 1 FROM room_messages candidate_message
             WHERE candidate_message.id = room_deliveries.message_id
               AND candidate_message.actor_kind = 'user'
               AND EXISTS (
                 SELECT 1 FROM room_participants active
                 WHERE active.room_id = candidate_message.room_id
                   AND active.actor_kind = 'agent' AND active.participation = 'active'
               )
               AND NOT EXISTS (
                 SELECT 1 FROM room_participants active
                 WHERE active.room_id = candidate_message.room_id
                   AND active.actor_kind = 'agent' AND active.participation = 'active'
                   AND NOT EXISTS (
                     SELECT 1 FROM room_deliveries member
                     WHERE member.message_id = room_deliveries.message_id
                       AND member.participant_id = active.id
                       AND NOT (member.state = 'suppressed' AND member.error IN (
                         'room_delivery_retargeted', 'room_participant_paused'
                       ))
                   )
               )
           )`
        : `UPDATE room_deliveries SET state = 'delivering', phase = 'waking', error = NULL,
           attempts = attempts + 1
           WHERE id = ? AND intent = 'next' AND state IN ('pending', 'failed')
           AND EXISTS (SELECT 1 FROM room_messages editable
             WHERE editable.id = room_deliveries.message_id AND editable.queue_edit_token IS NULL)
           AND EXISTS (
             SELECT 1 FROM room_participants target
             WHERE target.id = room_deliveries.participant_id
               AND target.participation = 'active'
           )
           AND NOT EXISTS (
             SELECT 1 FROM rooms stopped JOIN room_messages candidate_message
               ON candidate_message.room_id = stopped.id
             WHERE candidate_message.id = room_deliveries.message_id
               AND stopped.delivery_queue_stopped = 1
           ) AND NOT EXISTS (
             SELECT 1 FROM room_deliveries blocked
             JOIN room_messages blocked_message ON blocked_message.id = blocked.message_id
             WHERE blocked.participant_id = room_deliveries.participant_id
               AND blocked.id <> room_deliveries.id
               AND blocked_message.queue_edit_token IS NULL AND (
                 blocked.state = 'delivering' OR
                 (blocked.state = 'delivered' AND blocked.responded_at IS NULL) OR
                 (blocked.state = 'failed' AND blocked.error = 'room_delivery_uncertain') OR
                 (blocked.state = 'suppressed' AND blocked.error = 'room_stopping') OR
                 (blocked.state = 'pending' AND (
                   blocked.queue_position < room_deliveries.queue_position OR
                   (blocked.queue_position = room_deliveries.queue_position AND
                    blocked_message.sequence < (
                      SELECT sequence FROM room_messages WHERE id = room_deliveries.message_id
                    ))
                 ))
               )
           ) AND NOT EXISTS (
             SELECT 1 FROM room_messages candidate_message
             WHERE candidate_message.id = room_deliveries.message_id
               AND candidate_message.actor_kind = 'user'
               AND EXISTS (
                 SELECT 1 FROM room_participants active
                 WHERE active.room_id = candidate_message.room_id
                   AND active.actor_kind = 'agent' AND active.participation = 'active'
               )
               AND NOT EXISTS (
                 SELECT 1 FROM room_participants active
                 WHERE active.room_id = candidate_message.room_id
                   AND active.actor_kind = 'agent' AND active.participation = 'active'
                   AND NOT EXISTS (
                     SELECT 1 FROM room_deliveries member
                     WHERE member.message_id = room_deliveries.message_id
                       AND member.participant_id = active.id AND member.state = 'pending'
                       AND member.intent = 'next' AND member.attempts = 0
                   )
               )
           )`
    )
    .run(id).changes
  if (changed !== 1) {
    return null
  }
  return deliveryFromRow(
    db.prepare('SELECT * FROM room_deliveries WHERE id = ?').get(id) as RoomRow
  )
}
