import { randomUUID } from 'node:crypto'
import type SyncDatabase from '../../sqlite/sync-database'
import type { RoomDelivery } from '../../../shared/rooms'
import { deliveryFromRow, type RoomRow } from './rows'
import { listMutableRoomBroadcastIds, normalizeNewRoomBroadcasts } from './delivery-broadcast-order'
import { roomDeliveryDispatchStopped } from './delivery-work-control'
import { assertRoomMessageDeliveryMutable, isRoomDeliveryMutable } from './delivery-mutability'
import { activeRoomReadinessMatches, type RoomReadyTarget } from './delivery-readiness-evidence'

const listForMessage = (db: SyncDatabase.Database, messageId: string): RoomDelivery[] =>
  (
    db
      .prepare('SELECT * FROM room_deliveries WHERE message_id = ? ORDER BY participant_id')
      .all(messageId) as RoomRow[]
  ).map(deliveryFromRow)

const activeParticipantIds = (db: SyncDatabase.Database, roomId: string): string[] =>
  (
    db
      .prepare(
        `SELECT id FROM room_participants WHERE room_id = ? AND actor_kind = 'agent' AND participation = 'active' ORDER BY id`
      )
      .all(roomId) as RoomRow[]
  ).map((row) => String(row.id))

const isBroadcastMessage = (db: SyncDatabase.Database, messageId: string): boolean => {
  const message = db
    .prepare('SELECT room_id, actor_kind FROM room_messages WHERE id = ?')
    .get(messageId) as RoomRow | undefined
  if (!message || message.actor_kind !== 'user') {
    return false
  }
  const active = activeParticipantIds(db, String(message.room_id))
  const targets = (
    db
      .prepare(
        `SELECT DISTINCT d.participant_id FROM room_deliveries d JOIN room_participants p ON p.id = d.participant_id WHERE d.message_id = ? AND p.participation = 'active' AND NOT (d.state = 'suppressed' AND d.error IN ('room_delivery_retargeted', 'room_participant_paused'))`
      )
      .all(messageId) as RoomRow[]
  ).map((row) => String(row.participant_id))
  return (
    active.length > 0 &&
    active.length === targets.length &&
    active.every((id) => targets.includes(id))
  )
}

const isInitialBroadcastDispatch = (db: SyncDatabase.Database, messageId: string): boolean => {
  if (!isBroadcastMessage(db, messageId)) {
    return false
  }
  const message = db.prepare('SELECT room_id FROM room_messages WHERE id = ?').get(messageId) as
    | RoomRow
    | undefined
  if (!message) {
    return false
  }
  const active = activeParticipantIds(db, String(message.room_id))
  const rows = listForMessage(db, messageId).filter((delivery) =>
    active.includes(delivery.participantId)
  )
  return (
    rows.length === active.length &&
    rows.every(
      (delivery) =>
        delivery.state === 'pending' && delivery.intent === 'next' && delivery.attempts === 0
    )
  )
}

export function claimRoomBroadcastDeliveries(
  db: SyncDatabase.Database,
  messageId: string,
  readiness: readonly RoomReadyTarget[]
): RoomDelivery[] | null {
  db.exec('BEGIN IMMEDIATE')
  try {
    if (!isBroadcastMessage(db, messageId)) {
      return (db.exec('ROLLBACK'), null)
    }
    const message = db
      .prepare('SELECT room_id, sequence, queue_edit_token FROM room_messages WHERE id = ?')
      .get(messageId) as RoomRow
    if (
      message.queue_edit_token !== null ||
      roomDeliveryDispatchStopped(db, String(message.room_id))
    ) {
      return (db.exec('ROLLBACK'), null)
    }
    if (!activeRoomReadinessMatches(db, String(message.room_id), readiness)) {
      return (db.exec('ROLLBACK'), null)
    }
    const active = activeParticipantIds(db, String(message.room_id))
    const rows = listForMessage(db, messageId).filter((delivery) =>
      active.includes(delivery.participantId)
    )
    if (
      rows.length !== active.length ||
      rows.some(
        (delivery) =>
          !isRoomDeliveryMutable(delivery) ||
          delivery.state !== 'pending' ||
          delivery.intent !== 'next'
      )
    ) {
      return (db.exec('ROLLBACK'), null)
    }
    const blocked = db.prepare(
      `SELECT 1 FROM room_deliveries blocked JOIN room_messages blocked_message ON blocked_message.id = blocked.message_id WHERE blocked.participant_id = ? AND blocked.id <> ? AND blocked_message.queue_edit_token IS NULL AND (blocked.state = 'delivering' OR (blocked.state = 'delivered' AND blocked.responded_at IS NULL) OR (blocked.state = 'failed' AND blocked.error = 'room_delivery_uncertain') OR (blocked.state = 'suppressed' AND blocked.error = 'room_stopping') OR (blocked.state = 'pending' AND (blocked.queue_position < ? OR (blocked.queue_position = ? AND blocked_message.sequence < ?)))) LIMIT 1`
    )
    for (const delivery of rows) {
      const parameters = [
        delivery.participantId,
        delivery.id,
        delivery.queuePosition ?? 0,
        delivery.queuePosition ?? 0,
        message.sequence
      ] as const
      if (blocked.get(...(parameters as [string, string, number, number, number]))) {
        return (db.exec('ROLLBACK'), null)
      }
    }
    const update = db.prepare(
      `UPDATE room_deliveries SET state = 'delivering', phase = 'waking', error = NULL, attempts = attempts + 1 WHERE id = ? AND state = 'pending' AND intent = 'next'`
    )
    for (const delivery of rows) {
      if (update.run(delivery.id).changes !== 1) {
        db.exec('ROLLBACK')
        return null
      }
    }
    const result = listForMessage(db, messageId).filter((delivery) =>
      active.includes(delivery.participantId)
    )
    db.exec('COMMIT')
    return result
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export function retargetRoomMessageDeliveries(
  db: SyncDatabase.Database,
  messageId: string,
  participantIds: readonly string[],
  now: number
): RoomDelivery[] {
  const message = db
    .prepare('SELECT room_id FROM room_messages WHERE id = ? AND actor_kind = ?')
    .get(messageId, 'user') as RoomRow | undefined
  if (!message) {
    throw new Error('room_message_forbidden')
  }
  const targets = new Set(participantIds)
  const available = db
    .prepare(
      `SELECT id FROM room_participants WHERE room_id = ? AND actor_kind = 'agent' AND participation = 'active'`
    )
    .all(String(message.room_id)) as RoomRow[]
  if (
    targets.size !== participantIds.length ||
    [...targets].some((id) => !available.some((row) => String(row.id) === id))
  ) {
    throw new Error('room_delivery_target_invalid')
  }
  assertRoomMessageDeliveryMutable(db, messageId)
  const current = listForMessage(db, messageId)
  const targetsAll = targets.size === available.length
  const previousBroadcastIds = targetsAll
    ? listMutableRoomBroadcastIds(db, String(message.room_id))
    : []
  const paused = current.some(
    (item) => item.state === 'suppressed' && item.error === 'room_stopped' && item.attempts === 0
  )
  const update = db.prepare(
    `UPDATE room_deliveries SET state = ?, intent = 'next', error = ?, next_attempt_at = ?, queue_position = ? WHERE id = ? AND attempts = 0`
  )
  const next = db.prepare(
    'SELECT COALESCE(MAX(queue_position), 0) + 1 AS position FROM room_deliveries WHERE participant_id = ?'
  )
  for (const delivery of current) {
    const enabled = targets.has(delivery.participantId)
    const keepPaused = enabled && paused
    const position =
      enabled && delivery.state !== 'pending' && !paused
        ? Number((next.get(delivery.participantId) as RoomRow).position)
        : (delivery.queuePosition ?? 0)
    update.run(
      enabled ? (keepPaused ? 'suppressed' : 'pending') : 'suppressed',
      enabled ? (keepPaused ? 'room_stopped' : null) : 'room_delivery_retargeted',
      enabled && !keepPaused ? now : Number.MAX_SAFE_INTEGER,
      position,
      delivery.id
    )
  }
  const insert = db.prepare(
    `INSERT INTO room_deliveries (id, message_id, participant_id, state, error, next_attempt_at, queue_position) VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
  for (const participantId of targets) {
    if (current.some((delivery) => delivery.participantId === participantId)) {
      continue
    }
    const row = next.get(participantId) as RoomRow
    insert.run(
      randomUUID(),
      messageId,
      participantId,
      paused ? 'suppressed' : 'pending',
      paused ? 'room_stopped' : null,
      paused ? Number.MAX_SAFE_INTEGER : now,
      Number(row.position)
    )
  }
  if (targetsAll) {
    normalizeNewRoomBroadcasts(db, String(message.room_id), previousBroadcastIds)
  }
  return listForMessage(db, messageId)
}

export { isBroadcastMessage, isInitialBroadcastDispatch }
