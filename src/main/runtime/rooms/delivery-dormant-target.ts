import type SyncDatabase from '../../sqlite/sync-database'
import type { RoomDelivery } from '../../../shared/rooms'
import { retargetRoomMessageDeliveries } from './delivery-broadcast-operations'
import { assertRoomMessageDeliveryMutable } from './delivery-mutability'
import { deliveryFromRow, type RoomRow } from './rows'

const listForMessage = (db: SyncDatabase.Database, messageId: string): RoomDelivery[] =>
  (
    db.prepare('SELECT * FROM room_deliveries WHERE message_id = ?').all(messageId) as RoomRow[]
  ).map(deliveryFromRow)

const isDormant = (delivery: RoomDelivery): boolean =>
  delivery.state === 'suppressed' &&
  delivery.error === 'room_participant_paused' &&
  delivery.attempts === 0 &&
  delivery.intent === 'next'

export function retargetDormantRoomQueueTarget(
  db: SyncDatabase.Database,
  participantId: string,
  messageId: string,
  currentQueue: readonly RoomDelivery[],
  deliveryIds: readonly string[],
  now = Date.now()
): RoomDelivery[] | null {
  const dormant = listForMessage(db, messageId).find(
    (delivery) => delivery.participantId === participantId && isDormant(delivery)
  )
  if (!dormant) {
    return null
  }
  const withoutDormant = deliveryIds.filter((id) => id !== dormant.id)
  if (
    deliveryIds.length !== currentQueue.length + 1 ||
    new Set(deliveryIds).size !== deliveryIds.length ||
    !deliveryIds.includes(dormant.id) ||
    withoutDormant.some((id, index) => id !== currentQueue[index]?.id)
  ) {
    throw new Error('room_delivery_queue_stale')
  }
  assertRoomMessageDeliveryMutable(db, messageId)
  return retargetRoomMessageDeliveries(db, messageId, [participantId], now)
}

export type DormantTargetRemoval = {
  deleteMessage: boolean
  deliveries: RoomDelivery[]
}

export function removeDormantRoomMessageTarget(
  db: SyncDatabase.Database,
  messageId: string,
  participantId: string
): DormantTargetRemoval | null {
  assertRoomMessageDeliveryMutable(db, messageId)
  const deliveries = listForMessage(db, messageId)
  const selected = deliveries.find(
    (delivery) => delivery.participantId === participantId && isDormant(delivery)
  )
  if (!selected) {
    return null
  }
  const conceptualTargets = deliveries.filter(
    (delivery) =>
      !(delivery.state === 'suppressed' && delivery.error === 'room_delivery_retargeted')
  )
  if (conceptualTargets.length === 1) {
    return { deleteMessage: true, deliveries: [] }
  }
  const changed = db
    .prepare(
      `UPDATE room_deliveries SET error = 'room_delivery_retargeted', next_attempt_at = ?
       WHERE id = ? AND state = 'suppressed' AND error = 'room_participant_paused'
         AND attempts = 0 AND intent = 'next'`
    )
    .run(Number.MAX_SAFE_INTEGER, selected.id).changes
  if (changed !== 1) {
    throw new Error('room_delivery_queue_stale')
  }
  const delivery = deliveryFromRow(
    db.prepare('SELECT * FROM room_deliveries WHERE id = ?').get(selected.id) as RoomRow
  )
  return { deleteMessage: false, deliveries: [delivery] }
}
