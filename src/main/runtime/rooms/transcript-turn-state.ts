import type { NativeChatMessage } from '../../../shared/native-chat-types'
import type {
  RoomAgentActivity,
  RoomCompletedActivity,
  RoomDelivery,
  RoomEvent,
  RoomMessage,
  RoomParticipant
} from '../../../shared/rooms'
import type { RoomDatabase } from './database'
import type { RoomHarnessLifecycleEvent } from './harness-adapter'
import { extractRoomReplyRecipients } from './mentions'

export type PendingProviderMessage = { message: NativeChatMessage; publishable: boolean }

export function selectRoomTranscriptFinal(
  pending: PendingProviderMessage[],
  explicitBody: string | null
): { candidate: PendingProviderMessage | null; body: string | null } {
  const matching = explicitBody
    ? pending.findLast(({ message }) => finalBodyMatches(assistantBody(message), explicitBody))
    : null
  const candidate =
    matching ??
    (explicitBody ? null : pending.findLast(({ message }) => assistantBody(message) !== null)) ??
    null
  return { candidate, body: candidate ? assistantBody(candidate.message) : explicitBody }
}

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
    const messageStart = event.messages
      .map((message) => message.timestamp)
      .filter((timestamp): timestamp is number => timestamp !== null)
      .reduce((earliest, timestamp) => Math.min(earliest, timestamp), event.timestamp)
    if (!this.startedAt.has(participantId)) {
      this.startedAt.set(participantId, messageStart)
    }
    if (!this.anchorSequence.has(participantId)) {
      this.anchorSequence.set(participantId, this.db.messages.get(delivery.messageId).sequence)
    }
  }

  completed(
    participantId: string,
    pending: PendingProviderMessage[],
    finalMessage: PendingProviderMessage | null,
    event: RoomHarnessLifecycleEvent
  ): RoomCompletedActivity | null {
    const messages = pending
      .map(({ message }) => message)
      .filter((message) => message !== finalMessage?.message && isActivityMessage(message))
    const messageStart = messages
      .map((message) => message.timestamp)
      .filter((timestamp): timestamp is number => timestamp !== null)
      .reduce<number | undefined>(
        (earliest, timestamp) =>
          earliest === undefined ? timestamp : Math.min(earliest, timestamp),
        undefined
      )
    const startedAt = this.startedAt.get(participantId) ?? messageStart
    return startedAt === undefined
      ? null
      : { state: 'completed', messages, startedAt, completedAt: event.timestamp }
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
    const completedActivity = this.completed(participant.id, pending, candidate, event)
    this.ignorePending(participant.id, providerSessionId, finalProviderMessageId)
    if (candidate?.message.providerError) {
      const failed = this.db.messages.deliveries.failResponse(
        delivery.id,
        'room_provider_error',
        event.timestamp
      )
      this.emit(participant.roomId, { type: 'delivery.updated', delivery: failed })
      onSettled()
      return true
    }
    if (!body) {
      if (event.source === 'status') {
        return false
      }
      const failed = this.db.messages.deliveries.failResponse(
        delivery.id,
        'room_empty_response',
        event.timestamp
      )
      this.emit(participant.roomId, { type: 'delivery.updated', delivery: failed })
      onSettled()
      return true
    }
    const roomParticipants = this.db.participants.list(participant.roomId)
    const reply = extractRoomReplyRecipients(body, roomParticipants, participant.identity)
    if (reply.silent) {
      this.db.transaction(() => {
        this.db.providerMessages.ignore(participant.id, providerSessionId, finalProviderMessageId)
        this.db.messages.deliveries.markResponded(delivery.id, null, event.timestamp)
      })
      this.emit(participant.roomId, {
        type: 'delivery.updated',
        delivery: this.db.messages.deliveries.get(delivery.id)
      })
      onSettled()
      return true
    }
    const message = this.db.providerMessages.createReply({
      participant,
      delivery,
      providerSessionId,
      providerMessageId: finalProviderMessageId,
      body: reply.body,
      mentions: reply.mentions,
      createdAt: candidate?.message.timestamp ?? event.timestamp,
      ...(completedActivity ? { activity: completedActivity } : {})
    })
    if (!message) {
      return false
    }
    this.emit(participant.roomId, {
      type: 'delivery.updated',
      delivery: this.db.messages.deliveries.get(delivery.id)
    })
    this.emit(participant.roomId, { type: 'message.created', message })
    onSettled(message)
    return true
  }
}

export function providerMessageId(message: NativeChatMessage): string {
  return message.turnId ?? message.id
}

function isActivityMessage(message: NativeChatMessage): boolean {
  return message.role === 'assistant' || message.role === 'reasoning' || message.role === 'tool'
}

function assistantBody(message: NativeChatMessage): string | null {
  if (message.role !== 'assistant') {
    return null
  }
  const body = message.blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join('\n\n')
  return body || null
}

function finalBodyMatches(candidate: string | null, explicit: string): boolean {
  return candidate === explicit || candidate?.startsWith(explicit) === true
}
