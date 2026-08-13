import type SyncDatabase from '../../sqlite/sync-database'
import type { RoomDelivery, RoomDeliveryAttempt, RoomWorkState } from '../../../shared/rooms'
import { deliveryFromRow, type RoomRow } from './rows'
import {
  finishRoomStop,
  resumeRoomDeliveries,
  roomDeliveryWorkState,
  stopMessageDeliveries,
  stopRoomDeliveries,
  supersedeRoomStop
} from './delivery-work-control'

export class RoomDeliveryStore {
  constructor(private readonly db: SyncDatabase.Database) {}

  listForMessage(messageId: string): RoomDelivery[] {
    return (
      this.db
        .prepare('SELECT * FROM room_deliveries WHERE message_id = ? ORDER BY participant_id')
        .all(messageId) as RoomRow[]
    ).map(deliveryFromRow)
  }

  listForMessages(messageIds: string[]): RoomDelivery[] {
    if (messageIds.length === 0) {
      return []
    }
    const placeholders = messageIds.map(() => '?').join(', ')
    return (
      this.db
        .prepare(
          `SELECT * FROM room_deliveries WHERE message_id IN (${placeholders})
           ORDER BY message_id, participant_id`
        )
        .all(...messageIds) as RoomRow[]
    ).map(deliveryFromRow)
  }

  listDue(now = Date.now(), limit = 100, excludedRoomIds: readonly string[] = []): RoomDelivery[] {
    const excluded = excludedRoomIds.map(() => '?').join(', ')
    return (
      this.db
        .prepare(
          `SELECT d.* FROM room_deliveries d JOIN room_messages message ON message.id = d.message_id
         WHERE d.state = 'pending' AND d.next_attempt_at <= ?
           ${excluded ? `AND message.room_id NOT IN (${excluded})` : ''}
           AND NOT EXISTS (
             SELECT 1 FROM room_deliveries blocked
             JOIN room_messages blocked_message ON blocked_message.id = blocked.message_id
             WHERE blocked.participant_id = d.participant_id AND blocked.id <> d.id AND (
               blocked.state = 'delivering' OR
               (blocked.state = 'delivered' AND blocked.responded_at IS NULL) OR
               (blocked.state = 'failed' AND blocked.error = 'room_delivery_uncertain') OR
               (blocked.state = 'suppressed' AND blocked.error = 'room_stopping') OR
               (blocked_message.sequence < message.sequence AND blocked.state = 'pending')
             )
           )
         ORDER BY d.next_attempt_at, message.sequence LIMIT ?`
        )
        .all(now, ...excludedRoomIds, Math.min(Math.max(limit, 1), 500)) as RoomRow[]
    ).map(deliveryFromRow)
  }

  nextDueAt(excludedRoomIds: readonly string[] = []): number | null {
    const excluded = excludedRoomIds.map(() => '?').join(', ')
    const row = this.db
      .prepare(
        `SELECT min(d.next_attempt_at) AS next_due_at
         FROM room_deliveries d JOIN room_messages message ON message.id = d.message_id
         WHERE d.state = 'pending'
           ${excluded ? `AND message.room_id NOT IN (${excluded})` : ''}
           AND NOT EXISTS (
             SELECT 1 FROM room_deliveries blocked
             JOIN room_messages blocked_message ON blocked_message.id = blocked.message_id
             WHERE blocked.participant_id = d.participant_id AND blocked.id <> d.id AND (
               blocked.state = 'delivering' OR
               (blocked.state = 'delivered' AND blocked.responded_at IS NULL) OR
               (blocked.state = 'failed' AND blocked.error = 'room_delivery_uncertain') OR
               (blocked.state = 'suppressed' AND blocked.error = 'room_stopping') OR
               (blocked_message.sequence < message.sequence AND blocked.state = 'pending')
             )
           )
         `
      )
      .get(...excludedRoomIds) as RoomRow
    return row.next_due_at === null ? null : Number(row.next_due_at)
  }

  recoverInterrupted(now = Date.now()): void {
    const interrupted = (
      this.db
        .prepare(
          `SELECT * FROM room_deliveries WHERE state = 'delivering' OR (
             state = 'delivered' AND provider_turn_id IS NULL AND responded_at IS NULL
           )`
        )
        .all() as RoomRow[]
    ).map(deliveryFromRow)
    for (const delivery of interrupted) {
      const uncertain = delivery.phase !== 'waking'
      this.finish(
        delivery,
        uncertain ? 'failed' : 'pending',
        uncertain ? 'room_delivery_uncertain' : 'delivery_interrupted',
        uncertain ? Number.MAX_SAFE_INTEGER : now,
        now
      )
    }
  }

  suppressDeletedMessages(): void {
    this.db
      .prepare(
        `UPDATE room_deliveries SET state = 'suppressed', phase = NULL,
         error = 'room_message_deleted', next_attempt_at = ?
         WHERE message_id IN (SELECT id FROM room_messages WHERE deleted_at IS NOT NULL) AND (
           state IN ('pending', 'delivering') OR
           (state = 'delivered' AND responded_at IS NULL) OR
           (state = 'failed' AND error = 'room_delivery_uncertain')
         )`
      )
      .run(Number.MAX_SAFE_INTEGER)
  }

  workState(roomId: string): RoomWorkState {
    return roomDeliveryWorkState(this.db, roomId)
  }

  stopRoom(roomId: string): { stopped: RoomDelivery[]; deliveries: RoomDelivery[] } {
    return stopRoomDeliveries(this.db, roomId)
  }

  stopMessage(messageId: string): { stopped: RoomDelivery[]; deliveries: RoomDelivery[] } {
    return stopMessageDeliveries(this.db, messageId)
  }

  resumeRoom(roomId: string, now = Date.now()): RoomDelivery[] {
    return resumeRoomDeliveries(this.db, roomId, now)
  }

  supersedeRoomStop(roomId: string): RoomDelivery[] {
    return supersedeRoomStop(this.db, roomId)
  }

  finishRoomStop(deliveryIds: readonly string[]): RoomDelivery[] {
    return finishRoomStop(this.db, deliveryIds)
  }

  retry(id: string, now = Date.now()): RoomDelivery {
    this.db
      .prepare(
        `UPDATE room_deliveries SET state = 'pending', error = NULL, next_attempt_at = ?
         WHERE id = ? AND (
           state = 'failed' OR
           (state = 'suppressed' AND error IS NULL)
         )`
      )
      .run(now, id)
    return this.get(id)
  }

  claim(id: string): RoomDelivery | null {
    const changed = this.db
      .prepare(
        `UPDATE room_deliveries SET state = 'delivering', phase = 'waking', error = NULL,
         attempts = attempts + 1
         WHERE id = ? AND state IN ('pending', 'failed')`
      )
      .run(id).changes
    return changed === 1 ? this.get(id) : null
  }

  complete(
    id: string,
    state: RoomDelivery['state'],
    error: string | null,
    nextAttemptAt = Date.now()
  ): RoomDelivery {
    const delivery = this.get(id)
    return delivery.state === 'delivering'
      ? this.finish(delivery, state, error, nextAttemptAt)
      : delivery
  }

  setPhase(id: string, phase: NonNullable<RoomDelivery['phase']>): RoomDelivery {
    this.db
      .prepare("UPDATE room_deliveries SET phase = ? WHERE id = ? AND state = 'delivering'")
      .run(phase, id)
    return this.get(id)
  }

  delivering(participantId: string): RoomDelivery | null {
    const row = this.db
      .prepare(
        `SELECT * FROM room_deliveries WHERE participant_id = ? AND state = 'delivering'
         ORDER BY next_attempt_at, id LIMIT 1`
      )
      .get(participantId) as RoomRow | undefined
    return row ? deliveryFromRow(row) : null
  }

  confirmTurn(id: string, providerTurnId: string, now = Date.now()): RoomDelivery {
    this.db
      .prepare(
        `UPDATE room_deliveries SET state = 'delivered', phase = NULL, error = NULL,
         delivered_at = ?, provider_turn_id = ? WHERE id = ? AND (
           state = 'delivering' OR (state = 'failed' AND error = 'room_delivery_uncertain')
         )`
      )
      .run(now, providerTurnId, id)
    return this.get(id)
  }

  awaitingResponse(participantId: string): RoomDelivery | null {
    const row = this.db
      .prepare(
        `SELECT * FROM room_deliveries WHERE participant_id = ? AND state = 'delivered'
         AND responded_at IS NULL ORDER BY delivered_at, id LIMIT 1`
      )
      .get(participantId) as RoomRow | undefined
    return row ? deliveryFromRow(row) : null
  }

  awaitingResponseForTurn(participantId: string, providerTurnId: string): RoomDelivery | null {
    const row = this.db
      .prepare(
        `SELECT * FROM room_deliveries WHERE participant_id = ? AND provider_turn_id = ?
         AND state = 'delivered' AND responded_at IS NULL LIMIT 1`
      )
      .get(participantId, providerTurnId) as RoomRow | undefined
    return row ? deliveryFromRow(row) : null
  }

  markResponded(id: string, responseMessageId: string | null, respondedAt: number): RoomDelivery {
    this.db
      .prepare(
        `UPDATE room_deliveries SET response_message_id = ?, responded_at = ?
         WHERE id = ? AND state = 'delivered' AND responded_at IS NULL`
      )
      .run(responseMessageId, respondedAt, id)
    return this.get(id)
  }

  failResponse(id: string, error: string, now = Date.now()): RoomDelivery {
    const delivery = this.get(id)
    return delivery.state === 'delivered'
      ? this.finish(delivery, 'failed', error, Number.MAX_SAFE_INTEGER, now)
      : delivery
  }

  get(id: string): RoomDelivery {
    const row = this.db.prepare('SELECT * FROM room_deliveries WHERE id = ?').get(id) as
      | RoomRow
      | undefined
    if (!row) {
      throw new Error('room_delivery_not_found')
    }
    return deliveryFromRow(row)
  }

  private finish(
    delivery: RoomDelivery,
    state: RoomDelivery['state'],
    error: string | null,
    nextAttemptAt: number,
    now = Date.now()
  ): RoomDelivery {
    const history = [...(delivery.attemptHistory ?? [])]
    if (error && delivery.phase) {
      const attempt: RoomDeliveryAttempt = {
        attempt: delivery.attempts,
        phase: delivery.phase,
        error,
        at: now
      }
      history.push(attempt)
    }
    this.db
      .prepare(
        `UPDATE room_deliveries SET state = ?, phase = NULL, error = ?, next_attempt_at = ?,
         delivered_at = ?, provider_turn_id = NULL, attempt_history_json = ?
         WHERE id = ? AND state = ?`
      )
      .run(
        state,
        error,
        nextAttemptAt,
        state === 'delivered' ? now : null,
        JSON.stringify(history.slice(-5)),
        delivery.id,
        delivery.state
      )
    return this.get(delivery.id)
  }
}
