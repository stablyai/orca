import type { NativeChatMessage } from '../../../shared/native-chat-types'
import type {
  RoomAgentActivity,
  RoomDelivery,
  RoomEvent,
  RoomMessage,
  RoomParticipant,
  RoomSettledActivity
} from '../../../shared/rooms'
import type { RoomDatabase } from './database'
import type { RoomHarnessLifecycleEvent } from './harness-adapter'
import { extractRoomReplyRecipients } from './mentions'
import { publishRoomTurnOutput } from './transcript-turn-output'
import {
  isRoomActivityMessage,
  selectRoomTranscriptFinal,
  type PendingProviderMessage
} from './transcript-final-selection'

export { selectRoomTranscriptFinal } from './transcript-final-selection'

export class RoomTranscriptTurnState {
  private readonly pending = new Map<string, Map<string, PendingProviderMessage>>()
  private readonly startedAt = new Map<string, number>()
  private readonly anchorSequence = new Map<string, number | null>()

  constructor(
    private readonly db: RoomDatabase,
    private readonly emit: (roomId: string, event: RoomEvent) => void
  ) {}

  disposeParticipant(participantId: string): void {
    this.pending.delete(participantId)
    this.startedAt.delete(participantId)
    this.anchorSequence.delete(participantId)
  }

  clearParticipant(participant: RoomParticipant): void {
    this.disposeParticipant(participant.id)
    this.db.activities.remove(participant.id)
    this.emit(participant.roomId, { type: 'activity.cleared', participantId: participant.id })
  }

  dispose(): void {
    this.pending.clear()
    this.startedAt.clear()
    this.anchorSequence.clear()
  }

  failResponse(
    participant: RoomParticipant,
    delivery: RoomDelivery,
    error: string,
    timestamp: number
  ): void {
    const failed = delivery.providerTurnId
      ? this.db.messages.deliveries.failResponseGroup(
          participant.id,
          delivery.providerTurnId,
          error,
          timestamp
        )
      : [this.db.messages.deliveries.failResponse(delivery.id, error, timestamp)]
    for (const item of failed) {
      this.emit(participant.roomId, { type: 'delivery.updated', delivery: item })
    }
  }

  remember(participantId: string, messages: NativeChatMessage[], publishable: boolean): void {
    const pending = this.pending.get(participantId) ?? new Map<string, PendingProviderMessage>()
    for (const message of messages) {
      const id = providerMessageId(message)
      const current = pending.get(id)
      pending.set(id, {
        message: current
          ? { ...message, timestamp: current.message.timestamp ?? message.timestamp }
          : message,
        publishable: publishable || current?.publishable === true
      })
    }
    if (pending.size > 0) {
      this.pending.set(participantId, pending)
    }
  }

  entries(participantId: string): PendingProviderMessage[] {
    return [...(this.pending.get(participantId)?.values() ?? [])]
  }

  emitActivity(participant: RoomParticipant, event: RoomHarnessLifecycleEvent): void {
    const pending = this.entries(participant.id)
    const activity: RoomAgentActivity = {
      participantId: participant.id,
      identity: participant.identity,
      state: event.type === 'failed' || event.type === 'interrupted' ? event.type : 'working',
      kind: event.activity?.kind ?? 'working',
      ...(event.activity?.detail ? { detail: event.activity.detail } : {}),
      ...(event.permission ? { permission: event.permission } : {}),
      ...(event.input ? { input: event.input } : {}),
      messages: pending.map(({ message }) => message),
      startedAt: this.startedAt.get(participant.id) ?? event.timestamp,
      updatedAt: event.timestamp,
      anchorSequence: this.anchorSequence.get(participant.id) ?? null
    }
    this.db.activities.upsert(activity)
    this.emit(participant.roomId, { type: 'activity.updated', activity })
  }

  restore(participant: RoomParticipant): void {
    if (this.pending.has(participant.id)) {
      return
    }
    const activity = this.db.activities.get(participant.id)
    if (!activity) {
      return
    }
    if (activity.state !== 'working') {
      this.db.activities.remove(participant.id)
      this.emit(participant.roomId, { type: 'activity.cleared', participantId: participant.id })
      return
    }
    this.pending.set(
      participant.id,
      new Map(
        activity.messages.map((message) => [
          providerMessageId(message),
          { message, publishable: false }
        ])
      )
    )
    this.startedAt.set(participant.id, activity.startedAt)
    this.anchorSequence.set(participant.id, activity.anchorSequence)
  }

  rememberStart(
    participant: RoomParticipant,
    delivery: RoomDelivery,
    event: RoomHarnessLifecycleEvent
  ): void {
    const participantId = participant.id
    if (!this.startedAt.has(participantId)) {
      this.startedAt.set(participantId, delivery.deliveredAt ?? event.timestamp)
    }
    if (!this.anchorSequence.has(participantId)) {
      this.anchorSequence.set(participantId, this.db.messages.get(delivery.messageId).sequence)
    }
  }

  settled(
    participantId: string,
    pending: PendingProviderMessage[],
    finalMessage: PendingProviderMessage | null,
    event: RoomHarnessLifecycleEvent,
    state: RoomSettledActivity['state']
  ): RoomSettledActivity | null {
    const messages = pending
      .map(({ message }) => message)
      .filter((message) => message !== finalMessage?.message && isRoomActivityMessage(message))
    const messageStart = messages
      .map((message) => message.timestamp)
      .filter((timestamp): timestamp is number => timestamp !== null)
      .reduce<number | undefined>(
        (earliest, timestamp) =>
          earliest === undefined ? timestamp : Math.min(earliest, timestamp),
        undefined
      )
    const startedAt = this.startedAt.get(participantId) ?? messageStart
    const completedAt = event.timestamp
    return startedAt === undefined ? null : { state, messages, startedAt, completedAt }
  }

  ignorePending(
    participantId: string,
    providerSessionId: string,
    exceptProviderMessageId?: string
  ): void {
    for (const { message } of this.pending.get(participantId)?.values() ?? []) {
      const id = providerMessageId(message)
      if (id !== exceptProviderMessageId) {
        this.db.providerMessages.ignore(participantId, providerSessionId, id)
      }
    }
    this.pending.delete(participantId)
  }

  removeActivity(participantId: string): void {
    this.db.activities.remove(participantId)
    this.startedAt.delete(participantId)
    this.anchorSequence.delete(participantId)
  }

  publishFinal(
    participant: RoomParticipant,
    delivery: RoomDelivery,
    providerSessionId: string,
    event: RoomHarnessLifecycleEvent,
    onSettled: (message?: RoomMessage) => void
  ): boolean {
    const pending = this.entries(participant.id)
    const explicitBody = event.text?.trim() || null
    const { candidate, body } = selectRoomTranscriptFinal(pending, explicitBody)
    const finalProviderMessageId = candidate?.publishable
      ? providerMessageId(candidate.message)
      : `status:${event.turnId ?? event.timestamp}`
    const completedActivity = this.settled(participant.id, pending, candidate, event, 'completed')
    if (candidate?.message.providerError) {
      this.ignorePending(participant.id, providerSessionId)
      this.failResponse(participant, delivery, 'room_provider_error', event.timestamp)
      onSettled()
      return true
    }
    if (!body) {
      if (event.source === 'status') {
        return false
      }
      this.ignorePending(participant.id, providerSessionId)
      this.failResponse(participant, delivery, 'room_empty_response', event.timestamp)
      onSettled()
      return true
    }
    const roomParticipants = this.db.participants.list(participant.roomId)
    const reply = extractRoomReplyRecipients(body, roomParticipants, participant.identity)
    const settled = publishRoomTurnOutput({
      db: this.db,
      participant,
      delivery,
      providerSessionId,
      providerMessageId: finalProviderMessageId,
      pending,
      candidate,
      reply,
      activity: completedActivity,
      timestamp: event.timestamp,
      settleDelivery: true,
      enqueueDeliveries: true,
      emit: this.emit,
      onSettled
    })
    if (settled) {
      this.ignorePending(participant.id, providerSessionId, finalProviderMessageId)
    }
    return settled
  }

  publishInterrupted(
    participant: RoomParticipant,
    delivery: RoomDelivery,
    providerSessionId: string,
    event: RoomHarnessLifecycleEvent,
    onSettled: (message?: RoomMessage) => void
  ): boolean {
    const pending = this.entries(participant.id)
    const { candidate, body } = selectRoomTranscriptFinal(pending, null)
    const activity = this.settled(participant.id, pending, candidate, event, 'interrupted')
    if (!activity) {
      return false
    }
    const finalProviderMessageId =
      candidate?.publishable === true
        ? providerMessageId(candidate.message)
        : `interrupted:${event.turnId ?? event.timestamp}`
    const settleDelivery = delivery.state === 'suppressed' && delivery.error === 'room_stopping'
    const reply = extractRoomReplyRecipients(body ?? '', [], participant.identity)
    const settled = publishRoomTurnOutput({
      db: this.db,
      participant,
      delivery,
      providerSessionId,
      providerMessageId: finalProviderMessageId,
      pending,
      candidate,
      reply,
      activity,
      timestamp: event.timestamp,
      settleDelivery,
      enqueueDeliveries: false,
      emit: this.emit,
      onSettled
    })
    if (settled) {
      this.ignorePending(participant.id, providerSessionId, finalProviderMessageId)
    }
    return settled
  }
}

export const providerMessageId = (message: NativeChatMessage): string => message.id
