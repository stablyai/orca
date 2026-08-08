/* eslint-disable max-lines -- transcript and activity publication share one pending-turn state */
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
import type {
  RoomHarnessAdapter,
  RoomHarnessBinding,
  RoomHarnessLifecycleEvent
} from './harness-adapter'
import type { RoomHarnessTurnUserMessage } from './harness-lifecycle'
import { extractRoomReplyRecipients } from './mentions'

type ActiveWatcher = {
  providerSessionId: string
  transcriptPath: string | null
  unsubscribe: () => void
}

type PendingProviderMessage = { message: NativeChatMessage; publishable: boolean }

export class RoomTranscriptBridge {
  private readonly watchers = new Map<string, ActiveWatcher>()
  private readonly generations = new Map<string, number>()
  private readonly pending = new Map<string, Map<string, PendingProviderMessage>>()
  private readonly activityStartedAt = new Map<string, number>()
  private readonly activityAnchorSequence = new Map<string, number | null>()
  private readonly suppressedControls = new Set<string>()
  /** Room delivery bound to the participant's current turn (null = direct turn). */
  private readonly activeDeliveries = new Map<string, string | null>()

  constructor(
    private readonly db: RoomDatabase,
    private readonly adapters: Record<string, RoomHarnessAdapter>,
    private readonly emit: (roomId: string, event: RoomEvent) => void,
    private readonly confirmTurn: (
      participantId: string,
      userMessage: RoomHarnessTurnUserMessage
    ) => RoomDelivery | null,
    private readonly onSettled: (message?: RoomMessage) => void
  ) {}

  async ensure(participant: RoomParticipant): Promise<void> {
    const binding = this.binding(participant)
    const adapter = participant.agent ? this.adapters[participant.agent] : undefined
    const session = participant.providerSession
    if (!adapter || !binding || !session) {
      this.disposeParticipant(participant.id)
      return
    }
    this.restoreActivity(participant)
    const transcriptPath = session.transcriptPath ?? null
    const current = this.watchers.get(participant.id)
    if (current?.providerSessionId === session.id && current.transcriptPath === transcriptPath) {
      return
    }
    if (current) {
      current.unsubscribe()
      this.watchers.delete(participant.id)
      this.pending.delete(participant.id)
      this.activityStartedAt.delete(participant.id)
      this.activityAnchorSequence.delete(participant.id)
      this.activeDeliveries.delete(participant.id)
      this.db.activities.remove(participant.id)
      this.emit(participant.roomId, { type: 'activity.cleared', participantId: participant.id })
    }
    const generation = (this.generations.get(participant.id) ?? 0) + 1
    this.generations.set(participant.id, generation)
    const subscription = await adapter.subscribe(binding, {
      onSnapshot: (messages) => this.ingestSnapshot(participant.id, messages),
      onEvent: (event) => this.ingestLifecycle(participant.id, event),
      onOpaqueAppend: () => this.refreshContextById(participant.id)
    })
    if (this.generations.get(participant.id) !== generation) {
      subscription.unsubscribe()
      return
    }
    this.watchers.set(participant.id, {
      providerSessionId: session.id,
      transcriptPath,
      unsubscribe: subscription.unsubscribe
    })
  }

  disposeParticipant(participantId: string): void {
    this.generations.set(participantId, (this.generations.get(participantId) ?? 0) + 1)
    this.watchers.get(participantId)?.unsubscribe()
    this.watchers.delete(participantId)
    this.pending.delete(participantId)
    this.activityStartedAt.delete(participantId)
    this.activityAnchorSequence.delete(participantId)
    this.suppressedControls.delete(participantId)
    this.activeDeliveries.delete(participantId)
  }

  dispose(): void {
    for (const watcher of this.watchers.values()) {
      watcher.unsubscribe()
    }
    this.watchers.clear()
    this.generations.clear()
    this.pending.clear()
    this.activityStartedAt.clear()
    this.activityAnchorSequence.clear()
    this.suppressedControls.clear()
    this.activeDeliveries.clear()
  }

  suppressSessionControl(participantId: string): void {
    this.suppressedControls.add(participantId)
  }

  clearSessionControlSuppression(participantId: string): void {
    this.suppressedControls.delete(participantId)
  }

  currentTurnDeliveryId(participantId: string): string | null {
    return this.activeDeliveries.get(participantId) ?? null
  }
  ingestStatus(participantId: string, event: RoomHarnessLifecycleEvent | null): void {
    if (event) {
      this.ingestLifecycle(participantId, event)
    }
  }

  async refreshContext(participant: RoomParticipant): Promise<RoomParticipant> {
    const adapter = participant.agent ? this.adapters[participant.agent] : undefined
    const binding = this.binding(participant)
    if (!adapter || !binding) {
      return participant
    }
    const context = await adapter.context(binding, participant.context)
    if (JSON.stringify(context) === JSON.stringify(participant.context)) {
      return participant
    }
    const updated = this.db.participants.update(participant.id, { context })
    if (participant.context.compaction !== 'completed' && context.compaction === 'completed') {
      this.db.deliveryConfiguration.requireFull(participant.id)
    }
    this.emit(updated.roomId, { type: 'participant.updated', participant: updated })
    return updated
  }

  private refreshContextById(participantId: string): void {
    try {
      void this.refreshContext(this.db.participants.get(participantId)).catch(() => {})
    } catch {}
  }

  private ingestSnapshot(participantId: string, messages: NativeChatMessage[]): void {
    this.guard(participantId, () => {
      const participant = this.db.participants.get(participantId)
      const session = participant.providerSession
      if (!session) {
        return
      }
      this.db.providerMessages.observeSnapshot(
        participantId,
        session.id,
        messages.map(providerMessageId)
      )
    })
  }

  private ingestLifecycle(participantId: string, event: RoomHarnessLifecycleEvent): void {
    this.guard(participantId, () => {
      let participant = this.db.participants.get(participantId)
      const session = participant.providerSession
      if (!session) {
        return
      }
      if (event.userMessage) {
        const confirmed = this.confirmTurn(participantId, event.userMessage)
        this.activeDeliveries.set(participantId, confirmed?.id ?? null)
      }
      const delivery = this.activeDelivery(participantId)
      if (this.suppressedControls.has(participantId)) {
        // A real room delivery always wins over a stale control suppression.
        // Otherwise /model, /effort and /fast lifecycle noise stays out of chat.
        if (delivery) {
          this.suppressedControls.delete(participantId)
        } else {
          if (event.type !== 'activity') {
            this.suppressedControls.delete(participantId)
            void this.refreshContext(participant).catch(() => {})
          }
          return
        }
      }
      if (!delivery) {
        participant = this.updateParticipant(
          participant,
          event.type === 'activity' ? 'busy' : event.type === 'failed' ? 'error' : 'online',
          event.timestamp
        )
        void this.refreshContext(participant).catch(() => {})
        return
      }
      this.remember(participantId, event.messages, !event.replay)
      if (event.type === 'activity') {
        this.rememberActivityStart(participant, delivery, event)
        participant = this.updateParticipant(participant, 'busy', event.timestamp)
        this.emitActivity(participant, event)
        return
      }
      if (event.type === 'final') {
        this.publishFinal(participant, delivery, session.id, event)
        participant = this.updateParticipant(participant, 'online', event.timestamp)
        this.db.activities.remove(participant.id)
        this.emit(participant.roomId, { type: 'activity.cleared', participantId: participant.id })
        this.activityStartedAt.delete(participant.id)
        this.activityAnchorSequence.delete(participant.id)
      } else {
        participant = this.updateParticipant(
          participant,
          event.type === 'failed' ? 'error' : 'online',
          event.timestamp
        )
        this.emitActivity(participant, event)
        this.ignorePending(participant.id, session.id)
        this.db.activities.remove(participant.id)
        this.activityStartedAt.delete(participant.id)
        this.activityAnchorSequence.delete(participant.id)
      }
      void this.refreshContext(participant).catch(() => {})
    })
  }

  /** The delivery bound to the open turn, unless it has already been answered
   *  (a hook final can publish before the transcript final replays). */
  private activeDelivery(participantId: string): RoomDelivery | null {
    const deliveryId = this.activeDeliveries.get(participantId)
    if (!deliveryId) {
      return null
    }
    try {
      const delivery = this.db.messages.deliveries.get(deliveryId)
      return delivery.respondedAt ? null : delivery
    } catch {
      return null
    }
  }

  private remember(
    participantId: string,
    messages: NativeChatMessage[],
    publishable: boolean
  ): void {
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

  private emitActivity(participant: RoomParticipant, event: RoomHarnessLifecycleEvent): void {
    const pending = [...(this.pending.get(participant.id)?.values() ?? [])]
    const activity: RoomAgentActivity = {
      participantId: participant.id,
      identity: participant.identity,
      state: event.type === 'failed' || event.type === 'interrupted' ? event.type : 'working',
      kind: event.activity?.kind ?? 'working',
      ...(event.activity?.detail ? { detail: event.activity.detail } : {}),
      messages: pending.map(({ message }) => message),
      startedAt: this.activityStartedAt.get(participant.id) ?? event.timestamp,
      updatedAt: event.timestamp,
      anchorSequence: this.activityAnchorSequence.get(participant.id) ?? null
    }
    this.db.activities.upsert(activity)
    this.emit(participant.roomId, { type: 'activity.updated', activity })
  }

  private restoreActivity(participant: RoomParticipant): void {
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
    this.activityStartedAt.set(participant.id, activity.startedAt)
    this.activityAnchorSequence.set(participant.id, activity.anchorSequence)
  }

  private publishFinal(
    participant: RoomParticipant,
    delivery: RoomDelivery,
    providerSessionId: string,
    event: RoomHarnessLifecycleEvent
  ): void {
    const pending = [...(this.pending.get(participant.id)?.values() ?? [])]
    const explicitBody = event.text?.trim() || null
    const matching = explicitBody
      ? pending.findLast(({ message }) => finalBodyMatches(assistantBody(message), explicitBody))
      : null
    const candidate =
      matching ??
      (explicitBody ? null : pending.findLast(({ message }) => assistantBody(message) !== null)) ??
      null
    const body = candidate ? assistantBody(candidate.message) : explicitBody
    const finalProviderMessageId = candidate?.publishable
      ? providerMessageId(candidate.message)
      : `status:${event.turnId ?? event.timestamp}`
    const completedActivity = this.completedActivity(participant.id, pending, candidate, event)
    this.ignorePending(participant.id, providerSessionId, finalProviderMessageId)
    if (candidate?.message.providerError) {
      const failed = this.db.messages.deliveries.failResponse(
        delivery.id,
        'room_provider_error',
        event.timestamp
      )
      this.emit(participant.roomId, { type: 'delivery.updated', delivery: failed })
      this.onSettled()
      return
    }
    if (!body) {
      return
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
      this.onSettled()
      return
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
      return
    }
    this.emit(participant.roomId, {
      type: 'delivery.updated',
      delivery: this.db.messages.deliveries.get(delivery.id)
    })
    this.emit(participant.roomId, { type: 'message.created', message })
    this.onSettled(message)
  }

  private rememberActivityStart(
    participant: RoomParticipant,
    delivery: RoomDelivery,
    event: RoomHarnessLifecycleEvent
  ): void {
    const participantId = participant.id
    const messageStart = event.messages
      .map((message) => message.timestamp)
      .filter((timestamp): timestamp is number => timestamp !== null)
      .reduce((earliest, timestamp) => Math.min(earliest, timestamp), event.timestamp)
    if (!this.activityStartedAt.has(participantId)) {
      this.activityStartedAt.set(participantId, messageStart)
    }
    if (!this.activityAnchorSequence.has(participantId)) {
      this.activityAnchorSequence.set(
        participantId,
        this.db.messages.get(delivery.messageId).sequence
      )
    }
  }

  private completedActivity(
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
    const startedAt = this.activityStartedAt.get(participantId) ?? messageStart
    if (startedAt === undefined) {
      return null
    }
    return { state: 'completed', messages, startedAt, completedAt: event.timestamp }
  }

  private ignorePending(
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

  private updateParticipant(
    participant: RoomParticipant,
    state: RoomParticipant['state'],
    lastSeenAt: number
  ): RoomParticipant {
    const updated = this.db.participants.update(participant.id, { state, lastSeenAt })
    this.emit(updated.roomId, { type: 'participant.updated', participant: updated })
    return updated
  }

  private guard(participantId: string, action: () => void): void {
    try {
      action()
    } catch {
      try {
        const participant = this.db.participants.update(participantId, { state: 'error' })
        this.emit(participant.roomId, { type: 'participant.updated', participant })
      } catch {
        this.disposeParticipant(participantId)
      }
    }
  }

  private binding(participant: RoomParticipant): RoomHarnessBinding | null {
    return participant.terminalHandle && participant.paneKey && participant.worktreeId
      ? {
          worktreeId: participant.worktreeId,
          terminalHandle: participant.terminalHandle,
          paneKey: participant.paneKey,
          providerSession: participant.providerSession
        }
      : null
  }
}

function providerMessageId(message: NativeChatMessage): string {
  return message.turnId ?? message.id
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

function isActivityMessage(message: NativeChatMessage): boolean {
  return message.role === 'assistant' || message.role === 'reasoning' || message.role === 'tool'
}

function finalBodyMatches(candidate: string | null, explicit: string): boolean {
  return candidate === explicit || candidate?.startsWith(explicit) === true
}
