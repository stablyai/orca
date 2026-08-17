import type SyncDatabase from '../../sqlite/sync-database'
import type { RoomDelivery } from '../../../shared/rooms'
import { deliveryFromRow, type RoomRow } from './rows'
import {
  claimRoomBroadcastDeliveries,
  isBroadcastMessage,
  isInitialBroadcastDispatch,
  retargetRoomMessageDeliveries
} from './delivery-broadcast-operations'
import { claimRoomBroadcastSteer } from './delivery-broadcast-steer'
import {
  assertRoomMessageDeliveryMutable,
  hasRoomQueueEditReservation
} from './delivery-mutability'
import { retargetDormantRoomQueueTarget } from './delivery-dormant-target'
import { reorderRoomBroadcastQueue } from './delivery-broadcast-queue-reorder'

export {
  assertRoomMessageDeliveryMutable,
  claimRoomBroadcastDeliveries,
  claimRoomBroadcastSteer,
  isBroadcastMessage,
  isInitialBroadcastDispatch,
  reorderRoomBroadcastQueue,
  retargetRoomMessageDeliveries
}

const listForMessage = (db: SyncDatabase.Database, messageId: string): RoomDelivery[] =>
  (
    db
      .prepare('SELECT * FROM room_deliveries WHERE message_id = ? ORDER BY participant_id')
      .all(messageId) as RoomRow[]
  ).map(deliveryFromRow)

const getDelivery = (db: SyncDatabase.Database, id: string): RoomDelivery =>
  deliveryFromRow(db.prepare('SELECT * FROM room_deliveries WHERE id = ?').get(id) as RoomRow)

const listRoomParticipantQueue = (
  db: SyncDatabase.Database,
  participantId: string
): RoomDelivery[] =>
  (
    db
      .prepare(
        `SELECT d.* FROM room_deliveries d JOIN room_messages m ON m.id = d.message_id
         WHERE d.participant_id = ? AND (
           d.state = 'pending' OR
           (d.state = 'suppressed' AND d.error = 'room_stopped' AND d.attempts = 0 AND d.intent = 'next')
         ) AND m.actor_kind = 'user' AND m.queue_edit_token IS NULL
         ORDER BY d.queue_position, m.sequence`
      )
      .all(participantId) as RoomRow[]
  ).map(deliveryFromRow)

export function returnRoomSteerToNext(
  db: SyncDatabase.Database,
  id: string,
  error: string | null,
  now = Date.now(),
  moveToHead = true
): RoomDelivery {
  const delivery = getDelivery(db, id)
  if (!moveToHead && delivery.queuePosition === undefined) {
    throw new Error('room_delivery_queue_stale')
  }
  const position = moveToHead
    ? Number(
        (
          db
            .prepare(
              `SELECT COALESCE(MIN(queue_position), 0) - 1 AS position
               FROM room_deliveries WHERE participant_id = ? AND id <> ?`
            )
            .get(delivery.participantId, id) as RoomRow
        ).position
      )
    : delivery.queuePosition!
  db.prepare(
    `UPDATE room_deliveries SET state = 'pending', intent = 'next', phase = NULL,
     error = ?, next_attempt_at = ?, queue_position = ?
     WHERE id = ? AND state = 'delivering' AND intent = 'steer'`
  ).run(error, now, position, id)
  return getDelivery(db, id)
}

export function retryRoomDelivery(
  db: SyncDatabase.Database,
  id: string,
  now = Date.now()
): RoomDelivery {
  const changed = db
    .prepare(
      `UPDATE room_deliveries SET state = 'pending', intent = 'next', error = NULL, next_attempt_at = ?
     WHERE id = ? AND (
       state = 'failed' OR
       (state = 'suppressed' AND error IS NULL)
     ) AND EXISTS (
       SELECT 1 FROM room_participants participant
       WHERE participant.id = room_deliveries.participant_id
         AND participant.participation = 'active'
     )`
    )
    .run(now, id).changes
  if (changed !== 1) {
    const row = db
      .prepare(
        `SELECT delivery.*, participant.participation FROM room_deliveries delivery
         LEFT JOIN room_participants participant ON participant.id = delivery.participant_id
         WHERE delivery.id = ?`
      )
      .get(id) as RoomRow | undefined
    if (!row) {
      throw new Error('room_delivery_not_found')
    }
    if (row.state !== 'failed' && !(row.state === 'suppressed' && row.error === null)) {
      throw new Error('room_delivery_queue_stale')
    }
    throw new Error(
      row.participation === 'active' ? 'room_delivery_queue_stale' : 'room_delivery_target_invalid'
    )
  }
  return getDelivery(db, id)
}

export function suppressRoomParticipantQueuedDeliveries(
  db: SyncDatabase.Database,
  participantId: string
): RoomDelivery[] {
  const queued = (
    db
      .prepare(
        `SELECT * FROM room_deliveries WHERE participant_id = ? AND attempts = 0
         AND intent = 'next' AND (
           state = 'pending' OR (state = 'suppressed' AND error = 'room_stopped')
         )`
      )
      .all(participantId) as RoomRow[]
  ).map(deliveryFromRow)
  const suppress = db.prepare(
    `UPDATE room_deliveries SET state = 'suppressed', error = 'room_participant_paused',
     next_attempt_at = ?, phase = NULL WHERE id = ? AND attempts = 0 AND intent = 'next'
     AND (state = 'pending' OR (state = 'suppressed' AND error = 'room_stopped'))`
  )
  return queued.flatMap((delivery) =>
    suppress.run(Number.MAX_SAFE_INTEGER, delivery.id).changes === 1
      ? [getDelivery(db, delivery.id)]
      : []
  )
}

export function reorderRoomDeliveryQueue(
  db: SyncDatabase.Database,
  participantId: string,
  deliveryIds: readonly string[],
  movedDeliveryId?: string,
  retargetMessageId?: string
): RoomDelivery[] {
  if ((!movedDeliveryId && !retargetMessageId) || (movedDeliveryId && retargetMessageId)) {
    throw new Error('room_delivery_queue_stale')
  }
  const changedMessageDeliveryIds: string[] = []
  let pending = listRoomParticipantQueue(db, participantId)
  const dormantRetarget = retargetMessageId
    ? retargetDormantRoomQueueTarget(db, participantId, retargetMessageId, pending, deliveryIds)
    : null
  if (dormantRetarget) {
    changedMessageDeliveryIds.push(...dormantRetarget.map((delivery) => delivery.id))
    pending = listRoomParticipantQueue(db, participantId)
  }
  const pendingIds = new Set(pending.map(({ id }) => id))
  if (
    deliveryIds.length !== pending.length ||
    new Set(deliveryIds).size !== pending.length ||
    deliveryIds.some((id) => !pendingIds.has(id))
  ) {
    throw new Error('room_delivery_queue_stale')
  }
  const moved = movedDeliveryId
    ? pending.find((delivery) => delivery.id === movedDeliveryId)
    : retargetMessageId
      ? pending.find((delivery) => delivery.messageId === retargetMessageId)
      : undefined
  if (
    (movedDeliveryId || retargetMessageId) &&
    (!moved ||
      !isSingleQueueMove(
        pending.map(({ id }) => id),
        deliveryIds,
        moved.id
      ))
  ) {
    throw new Error('room_delivery_queue_stale')
  }
  if (moved) {
    assertRoomMessageDeliveryMutable(db, moved.messageId)
  }
  if (movedDeliveryId && moved && isBroadcastMessage(db, moved.messageId)) {
    throw new Error('room_delivery_queue_stale')
  }
  if (retargetMessageId) {
    if (!moved || (!dormantRetarget && !isBroadcastMessage(db, retargetMessageId))) {
      throw new Error('room_delivery_queue_stale')
    }
    if (!dormantRetarget) {
      const current = listForMessage(db, retargetMessageId)
      changedMessageDeliveryIds.push(...current.map((item) => item.id))
      db.prepare(
        `UPDATE room_deliveries SET state = 'suppressed', error = 'room_delivery_retargeted',
         next_attempt_at = ?, phase = NULL
         WHERE message_id = ? AND participant_id <> ? AND attempts = 0`
      ).run(Number.MAX_SAFE_INTEGER, retargetMessageId, participantId)
    }
  }
  pending = listRoomParticipantQueue(db, participantId)
  const orderedIds = [...deliveryIds]
  const editingReserved = hasRoomQueueEditReservation(db, participantId)
  const start = Math.min(...pending.map((delivery) => delivery.queuePosition ?? 0), 0)
  const positions = editingReserved
    ? pending.map((delivery) => delivery.queuePosition ?? 0).sort((left, right) => left - right)
    : pending.map((_, index) => start + index)
  const update = db.prepare(
    `UPDATE room_deliveries SET queue_position = ? WHERE id = ? AND participant_id = ? AND (
        state = 'pending' OR
        (state = 'suppressed' AND error = 'room_stopped' AND attempts = 0 AND intent = 'next')
      )`
  )
  for (const [index, id] of orderedIds.entries()) {
    if (update.run(positions[index], id, participantId).changes !== 1) {
      throw new Error('room_delivery_queue_stale')
    }
  }
  return [...new Set([...orderedIds, ...changedMessageDeliveryIds])].map((id) =>
    getDelivery(db, id)
  )
}

function isSingleQueueMove(
  currentIds: readonly string[],
  orderedIds: readonly string[],
  movedId: string
): boolean {
  return currentIds
    .filter((id) => id !== movedId)
    .every((id, index) => orderedIds.filter((candidate) => candidate !== movedId)[index] === id)
}
