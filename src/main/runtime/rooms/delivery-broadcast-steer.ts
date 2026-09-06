import type SyncDatabase from '../../sqlite/sync-database'
import type { RoomDelivery, RoomParticipant, RoomProviderSession } from '../../../shared/rooms'
import { deliveryFromRow, parseRoomJson, type RoomRow } from './rows'
import { isBroadcastMessage } from './delivery-broadcast-operations'
import { roomDeliveryDispatchStopped } from './delivery-work-control'
import { isRoomDeliveryMutable } from './delivery-mutability'

const listForMessage = (db: SyncDatabase.Database, messageId: string): RoomDelivery[] =>
  (
    db
      .prepare('SELECT * FROM room_deliveries WHERE message_id = ? ORDER BY participant_id')
      .all(messageId) as RoomRow[]
  ).map(deliveryFromRow)

export function claimRoomBroadcastSteer(
  db: SyncDatabase.Database,
  messageId: string,
  expectedTargets: readonly RoomBroadcastSteerTarget[],
  steerParticipantIds: readonly string[]
): RoomDelivery[] | null {
  db.exec('BEGIN IMMEDIATE')
  try {
    if (!isBroadcastMessage(db, messageId)) {
      return (db.exec('ROLLBACK'), null)
    }
    const message = db
      .prepare('SELECT room_id, queue_edit_token FROM room_messages WHERE id = ?')
      .get(messageId) as RoomRow
    if (
      message.queue_edit_token !== null ||
      roomDeliveryDispatchStopped(db, String(message.room_id))
    ) {
      return (db.exec('ROLLBACK'), null)
    }
    const activeRows = db
      .prepare(
        `SELECT id, state, process_incarnation, worktree_id, terminal_handle, provider_session_json
         FROM room_participants WHERE room_id = ? AND actor_kind = 'agent'
         AND participation = 'active' ORDER BY id`
      )
      .all(String(message.room_id)) as RoomRow[]
    const active = activeRows.map((row) => String(row.id))
    if (
      expectedTargets.length !== activeRows.length ||
      new Set(expectedTargets.map((target) => target.participantId)).size !== activeRows.length ||
      expectedTargets.some((target) => {
        const row = activeRows.find((candidate) => String(candidate.id) === target.participantId)
        const session = row
          ? parseRoomJson<RoomProviderSession | null>(row.provider_session_json, null)
          : null
        return (
          !row ||
          row.state !== target.state ||
          row.process_incarnation !== target.processIncarnation ||
          row.worktree_id !== target.worktreeId ||
          row.terminal_handle !== null ||
          session?.transport !== 'machine' ||
          session.key !== target.providerSessionKey ||
          session.id !== target.providerSessionId
        )
      })
    ) {
      return (db.exec('ROLLBACK'), null)
    }
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
      ) ||
      steerParticipantIds.some((id) => !active.includes(id))
    ) {
      return (db.exec('ROLLBACK'), null)
    }
    const steer = new Set(steerParticipantIds)
    const update = db.prepare(
      `UPDATE room_deliveries SET state = 'delivering', intent = ?, phase = ?, error = NULL,
       attempts = attempts + 1 WHERE id = ? AND state = 'pending' AND intent = 'next'`
    )
    for (const delivery of rows) {
      const selected = steer.has(delivery.participantId)
      if (
        update.run(selected ? 'steer' : 'next', selected ? 'submitting' : 'waking', delivery.id)
          .changes !== 1
      ) {
        return (db.exec('ROLLBACK'), null)
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

export type RoomBroadcastSteerTarget = {
  participantId: string
  state: RoomParticipant['state']
  processIncarnation: string | null
  worktreeId: string
  providerSessionKey: RoomProviderSession['key']
  providerSessionId: string
}
