import { randomUUID } from 'node:crypto'
import type SyncDatabase from '../../sqlite/sync-database'
import type {
  RoomDelivery,
  RoomMessage,
  RoomParticipant,
  RoomSettledActivity
} from '../../../shared/rooms'
import type { RoomMessageStore } from './messages'
import type { RoomRow } from './rows'

export class RoomProviderMessageStore {
  constructor(
    private readonly db: SyncDatabase.Database,
    private readonly messages: RoomMessageStore
  ) {}

  observeSnapshot(
    participantId: string,
    providerSessionId: string,
    providerMessageIds: string[]
  ): void {
    const current = this.db
      .prepare('SELECT provider_session_id FROM room_provider_streams WHERE participant_id = ?')
      .get(participantId) as RoomRow | undefined
    const now = Date.now()
    this.db.exec('SAVEPOINT room_provider_snapshot')
    try {
      if (current?.provider_session_id !== providerSessionId) {
        this.db
          .prepare('DELETE FROM room_provider_messages WHERE participant_id = ?')
          .run(participantId)
      }
      this.db
        .prepare(
          `INSERT INTO room_provider_streams
           (participant_id, provider_session_id, initialized_at, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(participant_id) DO UPDATE SET provider_session_id = excluded.provider_session_id,
             initialized_at = excluded.initialized_at, updated_at = excluded.updated_at`
        )
        .run(participantId, providerSessionId, now, now)
      const insert = this.db.prepare(
        `INSERT OR IGNORE INTO room_provider_messages
         (participant_id, provider_session_id, provider_message_id, observed_at)
         VALUES (?, ?, ?, ?)`
      )
      for (const id of providerMessageIds) {
        insert.run(participantId, providerSessionId, id, now)
      }
      this.db.exec('RELEASE room_provider_snapshot')
    } catch (error) {
      this.db.exec('ROLLBACK TO room_provider_snapshot')
      this.db.exec('RELEASE room_provider_snapshot')
      throw error
    }
  }

  hasObservedSession(participantId: string, providerSessionId: string): boolean {
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM room_provider_streams
           WHERE participant_id = ? AND provider_session_id = ?
           UNION ALL
           SELECT 1 FROM room_provider_messages
           WHERE participant_id = ? AND provider_session_id = ?
           LIMIT 1`
        )
        .get(participantId, providerSessionId, participantId, providerSessionId)
    )
  }

  resetStream(participantId: string): void {
    this.db.prepare('DELETE FROM room_provider_streams WHERE participant_id = ?').run(participantId)
  }

  ignore(participantId: string, providerSessionId: string, providerMessageId: string): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO room_provider_messages
         (participant_id, provider_session_id, provider_message_id, observed_at)
         VALUES (?, ?, ?, ?)`
      )
      .run(participantId, providerSessionId, providerMessageId, Date.now())
  }

  createReply(input: {
    participant: RoomParticipant
    delivery: RoomDelivery
    providerSessionId: string
    providerMessageId: string
    body: string
    mentions: string[]
    createdAt: number
    activity?: RoomSettledActivity
    settleDelivery?: boolean
    enqueueDeliveries?: boolean
    replyToId?: string
    retainObserved?: boolean
  }): RoomMessage | null {
    this.db.exec('SAVEPOINT room_provider_reply')
    try {
      const observed = this.db
        .prepare(
          `INSERT INTO room_provider_messages
           (participant_id, provider_session_id, provider_message_id, observed_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(participant_id, provider_session_id, provider_message_id)
           DO UPDATE SET observed_at = room_provider_messages.observed_at
           WHERE ? = 1 AND room_provider_messages.room_message_id IS NULL`
        )
        .run(
          input.participant.id,
          input.providerSessionId,
          input.providerMessageId,
          input.createdAt,
          input.retainObserved ? 1 : 0
        )
      if (observed.changes === 0) {
        this.db.exec('RELEASE room_provider_reply')
        return null
      }
      const group = input.delivery.providerTurnId
        ? this.messages.deliveries.awaitingResponseGroup(
            input.participant.id,
            input.delivery.providerTurnId
          )
        : []
      const parent = this.messages.get(
        input.replyToId ?? group[0]?.messageId ?? input.delivery.messageId
      )
      const message = this.messages.create({
        id: randomUUID(),
        roomId: input.participant.roomId,
        senderId: input.participant.id,
        senderIdentity: input.participant.identity,
        actorKind: 'agent',
        body: input.body,
        replyToId: parent.id,
        mentions: input.mentions,
        metadata: {
          providerSessionId: input.providerSessionId,
          providerMessageId: input.providerMessageId,
          ...(input.activity ? { activity: input.activity } : {})
        },
        createdAt: input.createdAt,
        enqueueDeliveries: input.enqueueDeliveries
      }).message
      if (input.settleDelivery !== false) {
        if (input.delivery.providerTurnId) {
          this.messages.deliveries.markRespondedGroup(
            input.participant.id,
            input.delivery.providerTurnId,
            message.id,
            input.createdAt
          )
        } else {
          this.messages.deliveries.markResponded(input.delivery.id, message.id, input.createdAt)
        }
      }
      this.db
        .prepare(
          `UPDATE room_provider_messages SET room_message_id = ?
           WHERE participant_id = ? AND provider_session_id = ? AND provider_message_id = ?`
        )
        .run(message.id, input.participant.id, input.providerSessionId, input.providerMessageId)
      this.db
        .prepare('DELETE FROM room_agent_activity WHERE participant_id = ?')
        .run(input.participant.id)
      this.db.exec('RELEASE room_provider_reply')
      return message
    } catch (error) {
      this.db.exec('ROLLBACK TO room_provider_reply')
      this.db.exec('RELEASE room_provider_reply')
      throw error
    }
  }
}
