import type SyncDatabase from '../../sqlite/sync-database'
import type { RoomDelivery } from '../../../shared/rooms'
import { deliveryFromRow, type RoomRow } from './rows'
import { isBroadcastMessage, retargetRoomMessageDeliveries } from './delivery-broadcast-operations'
import { assertRoomMessageDeliveryMutable } from './delivery-mutability'

const isSingleQueueMove = (
  currentIds: readonly string[],
  orderedIds: readonly string[],
  movedId: string
): boolean =>
  currentIds
    .filter((id) => id !== movedId)
    .every((id, index) => orderedIds.filter((candidate) => candidate !== movedId)[index] === id)

export function reorderRoomBroadcastQueue(
  db: SyncDatabase.Database,
  roomId: string,
  messageIds: readonly string[],
  movedMessageId?: string,
  retargetMessageId?: string
): RoomDelivery[] {
  if ((!movedMessageId && !retargetMessageId) || (movedMessageId && retargetMessageId)) {
    throw new Error('room_delivery_queue_stale')
  }
  const changedIds = retargetMessageId
    ? retargetRoomMessageDeliveries(
        db,
        retargetMessageId,
        (
          db
            .prepare(
              `SELECT id FROM room_participants
               WHERE room_id = ? AND actor_kind = 'agent' AND participation = 'active' ORDER BY id`
            )
            .all(roomId) as RoomRow[]
        ).map((row) => String(row.id)),
        Date.now()
      ).map((delivery) => delivery.id)
    : []
  const pending = (
    db
      .prepare(
        `SELECT d.* FROM room_deliveries d JOIN room_messages m ON m.id = d.message_id
         JOIN room_participants p ON p.id = d.participant_id AND p.participation = 'active'
         WHERE m.room_id = ? AND (
           d.state = 'pending' OR
           (d.state = 'suppressed' AND d.error = 'room_stopped' AND d.attempts = 0 AND d.intent = 'next')
         ) AND m.actor_kind = 'user' AND m.queue_edit_token IS NULL
         ORDER BY d.queue_position, m.sequence`
      )
      .all(roomId) as RoomRow[]
  ).map(deliveryFromRow)
  const currentIds = [...new Set(pending.map((delivery) => delivery.messageId))]
  const movedId = movedMessageId ?? retargetMessageId!
  if (
    messageIds.length !== currentIds.length ||
    new Set(messageIds).size !== currentIds.length ||
    messageIds.some((id) => !currentIds.includes(id)) ||
    !currentIds.includes(movedId) ||
    !isSingleQueueMove(currentIds, messageIds, movedId)
  ) {
    throw new Error('room_delivery_queue_stale')
  }
  assertRoomMessageDeliveryMutable(db, movedId)
  if (!isBroadcastMessage(db, movedId)) {
    throw new Error('room_delivery_queue_stale')
  }
  const order = new Map(messageIds.map((id, index) => [id, index]))
  const byParticipant = new Map<string, RoomDelivery[]>()
  for (const delivery of pending) {
    const deliveries = byParticipant.get(delivery.participantId) ?? []
    deliveries.push(delivery)
    byParticipant.set(delivery.participantId, deliveries)
  }
  const update = db.prepare(
    `UPDATE room_deliveries SET queue_position = ? WHERE id = ? AND (
      state = 'pending' OR
      (state = 'suppressed' AND error = 'room_stopped' AND attempts = 0 AND intent = 'next')
    )`
  )
  for (const deliveries of byParticipant.values()) {
    const positions = deliveries
      .map((delivery) => delivery.queuePosition ?? 0)
      .sort((a, b) => a - b)
    const sorted = [...deliveries].sort(
      (left, right) => order.get(left.messageId)! - order.get(right.messageId)!
    )
    sorted.forEach((delivery, index) => {
      if (update.run(positions[index], delivery.id).changes !== 1) {
        throw new Error('room_delivery_queue_stale')
      }
    })
  }
  return [...new Set([...pending.map((delivery) => delivery.id), ...changedIds])].map((id) =>
    deliveryFromRow(db.prepare('SELECT * FROM room_deliveries WHERE id = ?').get(id) as RoomRow)
  )
}
