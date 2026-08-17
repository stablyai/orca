import type SyncDatabase from '../../sqlite/sync-database'
import type { RoomDelivery, RoomWorkState } from '../../../shared/rooms'
import { deliveryFromRow, type RoomRow } from './rows'
import {
  finishRoomStop,
  resumeRoomDeliveries,
  roomDeliveryWorkState,
  stopMessageDeliveries,
  stopRoomDeliveries,
  supersedeRoomStop
} from './delivery-work-control'
import { listRoomAutoSteerDue, listRoomDue, nextRoomDueAt } from './delivery-due-queries'
import { claimRoomDelivery } from './delivery-claim-operations'
import type { RoomReadyTarget } from './delivery-readiness-evidence'
import { deferPausedRoomDelivery } from './delivery-paused-claim'
import {
  assertRoomMessageDeliveryMutable,
  claimRoomBroadcastDeliveries,
  claimRoomBroadcastSteer,
  isInitialBroadcastDispatch,
  isBroadcastMessage,
  reorderRoomBroadcastQueue,
  reorderRoomDeliveryQueue,
  retryRoomDelivery,
  returnRoomSteerToNext,
  suppressRoomParticipantQueuedDeliveries,
  retargetRoomMessageDeliveries
} from './delivery-queue-operations'
import {
  awaitingRoomDeliveryResponseGroup,
  failRoomDeliveryResponseGroup,
  listRoomDeliveriesForTurn,
  markRoomDeliveryResponseGroup
} from './delivery-turn-groups'
import { recoverRoomDeliveries, suppressDeletedRoomMessageDeliveries } from './delivery-recovery'
import { listMutableRoomBroadcastIds, normalizeNewRoomBroadcasts } from './delivery-broadcast-order'
import { removeDormantRoomMessageTarget } from './delivery-dormant-target'
import { finishRoomDelivery } from './delivery-completion'

export class RoomDeliveryStore {
  constructor(private readonly db: SyncDatabase.Database) {}

  listForMessage(messageId: string): RoomDelivery[] {
    const rows = this.db
      .prepare('SELECT * FROM room_deliveries WHERE message_id = ? ORDER BY participant_id')
      .all(messageId) as RoomRow[]
    return rows.map(deliveryFromRow)
  }

  listForMessages(messageIds: string[]): RoomDelivery[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM room_deliveries WHERE message_id IN (${messageIds.map(() => '?').join(', ')})
         ORDER BY message_id, participant_id`
      )
      .all(...messageIds) as RoomRow[]
    return rows.map(deliveryFromRow)
  }

  listDue(now = Date.now(), limit = 100, excludedRoomIds: readonly string[] = []): RoomDelivery[] {
    return listRoomDue(this.db, now, limit, excludedRoomIds)
  }

  listAutoSteerDue(
    now = Date.now(),
    limit = 100,
    excludedRoomIds: readonly string[] = []
  ): RoomDelivery[] {
    return listRoomAutoSteerDue(this.db, now, limit, excludedRoomIds)
  }

  nextDueAt(excludedRoomIds: readonly string[] = []): number | null {
    return nextRoomDueAt(this.db, excludedRoomIds)
  }

  recoverInterrupted(now = Date.now()): void {
    recoverRoomDeliveries(this.db, now, (...args) => finishRoomDelivery(this.db, ...args))
  }

  suppressDeletedMessages(): void {
    suppressDeletedRoomMessageDeliveries(this.db)
  }

  workState(roomId: string): RoomWorkState {
    return roomDeliveryWorkState(this.db, roomId)
  }

  supersedeRoomStop(roomId: string): RoomDelivery[] {
    return supersedeRoomStop(this.db, roomId)
  }

  stopRoom(roomId: string): { stopped: RoomDelivery[]; deliveries: RoomDelivery[] } {
    return stopRoomDeliveries(this.db, roomId)
  }

  stopMessage(messageId: string): { stopped: RoomDelivery[]; deliveries: RoomDelivery[] } {
    return stopMessageDeliveries(this.db, messageId)
  }

  resumeRoom(
    roomId: string,
    now = Date.now()
  ): { resumed: RoomDelivery[]; deliveries: RoomDelivery[] } {
    return resumeRoomDeliveries(this.db, roomId, now)
  }

  finishRoomStop(deliveryIds: readonly string[]): RoomDelivery[] {
    return finishRoomStop(this.db, deliveryIds)
  }

  retry(id: string, now = Date.now()): RoomDelivery {
    return retryRoomDelivery(this.db, id, now)
  }

  reorder(
    participantId: string,
    deliveryIds: readonly string[],
    movedDeliveryId?: string,
    retargetMessageId?: string
  ): RoomDelivery[] {
    return reorderRoomDeliveryQueue(
      this.db,
      participantId,
      deliveryIds,
      movedDeliveryId,
      retargetMessageId
    )
  }

  reorderAll(
    roomId: string,
    messageIds: readonly string[],
    movedMessageId?: string,
    retargetMessageId?: string
  ): RoomDelivery[] {
    return reorderRoomBroadcastQueue(this.db, roomId, messageIds, movedMessageId, retargetMessageId)
  }

  retarget(messageId: string, participantIds: readonly string[], now = Date.now()): RoomDelivery[] {
    return retargetRoomMessageDeliveries(this.db, messageId, participantIds, now)
  }

  removeDormantTarget(
    messageId: string,
    participantId: string
  ): ReturnType<typeof removeDormantRoomMessageTarget> {
    return removeDormantRoomMessageTarget(this.db, messageId, participantId)
  }

  assertMessageMutable(messageId: string): void {
    assertRoomMessageDeliveryMutable(this.db, messageId)
  }

  claim(id: string): RoomDelivery | null {
    return claimRoomDelivery(this.db, id)
  }

  claimBroadcast(messageId: string, readiness: readonly RoomReadyTarget[]): RoomDelivery[] | null {
    return claimRoomBroadcastDeliveries(this.db, messageId, readiness)
  }

  claimBroadcastSteer(
    messageId: string,
    expectedTargets: Parameters<typeof claimRoomBroadcastSteer>[2],
    steerParticipantIds: readonly string[]
  ): RoomDelivery[] | null {
    return claimRoomBroadcastSteer(this.db, messageId, expectedTargets, steerParticipantIds)
  }

  isBroadcastMessage(messageId: string): boolean {
    return isBroadcastMessage(this.db, messageId)
  }

  isInitialBroadcastDispatch(messageId: string): boolean {
    return isInitialBroadcastDispatch(this.db, messageId)
  }

  listMutableBroadcastIds(roomId: string): string[] {
    return listMutableRoomBroadcastIds(this.db, roomId)
  }

  normalizeNewBroadcasts(roomId: string, previousIds: readonly string[]): RoomDelivery[] {
    return normalizeNewRoomBroadcasts(this.db, roomId, previousIds)
  }

  suppressParticipantQueue(participantId: string): RoomDelivery[] {
    return suppressRoomParticipantQueuedDeliveries(this.db, participantId)
  }

  claimSteer(id: string): RoomDelivery | null {
    return claimRoomDelivery(this.db, id, true)
  }

  returnSteerToNext(
    id: string,
    error: string | null,
    now = Date.now(),
    moveToHead = true
  ): RoomDelivery {
    return returnRoomSteerToNext(this.db, id, error, now, moveToHead)
  }

  deferPaused(delivery: RoomDelivery, now = Date.now()): RoomDelivery | null {
    return deferPausedRoomDelivery(this.db, delivery, now)
  }

  complete(
    id: string,
    state: RoomDelivery['state'],
    error: string | null,
    nextAttemptAt = Date.now()
  ): RoomDelivery {
    const delivery = this.get(id)
    return delivery.state === 'delivering'
      ? finishRoomDelivery(this.db, delivery, state, error, nextAttemptAt)
      : delivery
  }

  setPhase(id: string, phase: NonNullable<RoomDelivery['phase']>): RoomDelivery {
    this.db
      .prepare("UPDATE room_deliveries SET phase = ? WHERE id = ? AND state = 'delivering'")
      .run(phase, id)
    return this.get(id)
  }

  delivering(participantId: string, intent?: RoomDelivery['intent']): RoomDelivery | null {
    const row = this.db
      .prepare(
        `SELECT * FROM room_deliveries WHERE participant_id = ? AND state = 'delivering'
         ${intent ? 'AND intent = ?' : ''}
         ORDER BY next_attempt_at, id LIMIT 1`
      )
      .get(...(intent ? [participantId, intent] : [participantId])) as RoomRow | undefined
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
         AND state = 'delivered' AND responded_at IS NULL
         ORDER BY queue_position DESC, delivered_at DESC LIMIT 1`
      )
      .get(participantId, providerTurnId) as RoomRow | undefined
    return row ? deliveryFromRow(row) : null
  }

  awaitingResponseGroup(participantId: string, providerTurnId: string): RoomDelivery[] {
    return awaitingRoomDeliveryResponseGroup(this.db, participantId, providerTurnId)
  }

  listForTurn(participantId: string, providerTurnId: string): RoomDelivery[] {
    return listRoomDeliveriesForTurn(this.db, participantId, providerTurnId)
  }

  markResponded(id: string, responseMessageId: string | null, respondedAt: number): RoomDelivery {
    this.db
      .prepare(
        `UPDATE room_deliveries SET response_message_id = ?, responded_at = ?,
         state = 'delivered', error = NULL
         WHERE id = ? AND responded_at IS NULL AND (
           state = 'delivered' OR (state = 'suppressed' AND error = 'room_stopping')
         )`
      )
      .run(responseMessageId, respondedAt, id)
    return this.get(id)
  }

  markRespondedGroup(
    participantId: string,
    providerTurnId: string,
    responseMessageId: string | null,
    respondedAt: number
  ): RoomDelivery[] {
    return markRoomDeliveryResponseGroup(
      this.db,
      participantId,
      providerTurnId,
      responseMessageId,
      respondedAt
    )
  }

  failResponse(id: string, error: string, now = Date.now()): RoomDelivery {
    const delivery = this.get(id)
    return delivery.state === 'delivered'
      ? finishRoomDelivery(this.db, delivery, 'failed', error, Number.MAX_SAFE_INTEGER, now)
      : delivery
  }

  failResponseGroup(
    participantId: string,
    providerTurnId: string,
    error: string,
    now = Date.now()
  ): RoomDelivery[] {
    return failRoomDeliveryResponseGroup(this.db, participantId, providerTurnId, (id) =>
      this.failResponse(id, error, now)
    )
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
}
