import { randomUUID } from 'node:crypto'
import type SyncDatabase from '../../sqlite/sync-database'
import type { CreateRoomMessage } from './message-input'
import type { RoomRow } from './rows'

export function createRoomMessageDeliveries(
  db: SyncDatabase.Database,
  input: CreateRoomMessage,
  messageId: string,
  hopCount: number,
  loopLimit: number,
  now: number
): void {
  const targets =
    input.enqueueDeliveries === false
      ? []
      : (db
          .prepare(
            `SELECT id FROM room_participants
             WHERE room_id = ? AND actor_kind = 'agent' AND participation = 'active'`
          )
          .all(input.roomId) as RoomRow[])
  const requested = input.targetParticipantIds ? new Set(input.targetParticipantIds) : null
  if (
    requested &&
    (requested.size !== input.targetParticipantIds!.length ||
      [...requested].some((id) => !targets.some((target) => target.id === id)))
  ) {
    throw new Error('room_delivery_target_invalid')
  }
  const selected = requested
    ? targets.filter((target) => requested.has(String(target.id)))
    : targets
  const suppressed =
    input.actorKind === 'agent' && loopLimit > 0 && hopCount > 0 && hopCount % loopLimit === 0
  const insert = db.prepare(
    `INSERT OR IGNORE INTO room_deliveries
     (id, message_id, participant_id, state, next_attempt_at, queue_position)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
  const nextPosition = db.prepare(
    'SELECT COALESCE(MAX(queue_position), 0) + 1 AS position FROM room_deliveries WHERE participant_id = ?'
  )
  for (const target of selected) {
    if (target.id === input.senderId) {
      continue
    }
    const participantId = String(target.id)
    const position = nextPosition.get(participantId) as RoomRow
    insert.run(
      randomUUID(),
      messageId,
      participantId,
      suppressed ? 'suppressed' : 'pending',
      now,
      Number(position.position)
    )
  }
}
