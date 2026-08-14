import type { NativeChatMessage } from '../../../shared/native-chat-types'
import type { RoomDelivery, RoomEvent, RoomMessage, RoomParticipant } from '../../../shared/rooms'
import type { RoomDatabase } from './database'
import type { RoomHarnessAdapter, RoomHarnessLifecycleEvent } from './harness-adapter'
import type { RoomHarnessTurnUserMessage } from './harness-lifecycle'
import { roomParticipantHarnessBinding } from './participant-harness-binding'
import { providerMessageId, RoomTranscriptTurnState } from './transcript-turn-state'

type ActiveWatcher = {
  providerSessionId: string
  transcriptPath: string | null
  unsubscribe: () => void
}

export class RoomTranscriptBridge {
  private readonly watchers = new Map<string, ActiveWatcher>()
  private readonly generations = new Map<string, number>()
  private readonly turnState: RoomTranscriptTurnState
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
  ) {
    this.turnState = new RoomTranscriptTurnState(db, emit)
  }

  async ensure(participant: RoomParticipant): Promise<void> {
    const binding = roomParticipantHarnessBinding(participant)
    const adapter = participant.agent ? this.adapters[participant.agent] : undefined
    const session = participant.providerSession
    if (!adapter || !binding || !session) {
      this.disposeParticipant(participant.id)
      return
    }
    this.turnState.restore(participant)
    const transcriptPath = session.transcriptPath ?? null
    const current = this.watchers.get(participant.id)
    if (current?.providerSessionId === session.id && current.transcriptPath === transcriptPath) {
      return
    }
    if (current) {
      current.unsubscribe()
      this.watchers.delete(participant.id)
      this.turnState.clearParticipant(participant)
      this.activeDeliveries.delete(participant.id)
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
    this.turnState.disposeParticipant(participantId)
    this.suppressedControls.delete(participantId)
    this.activeDeliveries.delete(participantId)
  }

  forgetParticipants(participantIds: readonly string[]): void {
    for (const participantId of participantIds) {
      this.disposeParticipant(participantId)
      this.generations.delete(participantId)
    }
  }

  dispose(): void {
    for (const watcher of this.watchers.values()) {
      watcher.unsubscribe()
    }
    this.watchers.clear()
    this.generations.clear()
    this.turnState.dispose()
    this.suppressedControls.clear()
    this.activeDeliveries.clear()
  }

  suppressSessionControl(participantId: string): void {
    this.suppressedControls.add(participantId)
  }

  clearSessionControlSuppression(participantId: string): void {
    this.suppressedControls.delete(participantId)
  }

  clearStoppedDeliveries(participantIds: readonly string[]): void {
    for (const participantId of participantIds) {
      this.activeDeliveries.delete(participantId)
      this.turnState.clearParticipant(this.db.participants.get(participantId))
    }
  }

  currentTurnDeliveryId(participantId: string): string | null {
    return this.activeDeliveries.get(participantId) ?? null
  }

  currentTurnDeliveryIdForConversation(conversationId: string): string | null {
    let current: RoomDelivery | null = null
    for (const [participantId, watcher] of this.watchers) {
      if (watcher.providerSessionId === conversationId) {
        const deliveryId = this.activeDeliveries.get(participantId)
        if (!deliveryId) {
          continue
        }
        try {
          const delivery = this.db.messages.deliveries.get(deliveryId)
          if ((delivery.deliveredAt ?? 0) > (current?.deliveredAt ?? 0)) {
            current = delivery
          }
        } catch {
          continue
        }
      }
    }
    return current?.id ?? null
  }

  ingestStatus(participantId: string, event: RoomHarnessLifecycleEvent | null): void {
    if (event) {
      this.ingestLifecycle(participantId, event)
    }
  }

  async refreshContext(participant: RoomParticipant): Promise<RoomParticipant> {
    const adapter = participant.agent ? this.adapters[participant.agent] : undefined
    const binding = roomParticipantHarnessBinding(participant)
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
      this.turnState.remember(participantId, event.messages, !event.replay)
      if (event.type === 'activity') {
        this.turnState.rememberStart(participant, delivery, event)
        participant = this.updateParticipant(participant, 'busy', event.timestamp)
        this.turnState.emitActivity(participant, event)
        return
      }
      if (event.type === 'final') {
        const settled = this.turnState.publishFinal(
          participant,
          delivery,
          session.id,
          event,
          this.onSettled
        )
        if (settled) {
          participant = this.updateParticipant(participant, 'online', event.timestamp)
          this.turnState.removeActivity(participant.id)
          this.emit(participant.roomId, {
            type: 'activity.cleared',
            participantId: participant.id
          })
        } else {
          participant = this.updateParticipant(participant, 'busy', event.timestamp)
        }
      } else {
        participant = this.updateParticipant(
          participant,
          event.type === 'failed' ? 'error' : 'online',
          event.timestamp
        )
        const retainPartial =
          event.type === 'interrupted' &&
          event.messages.some(
            (message) =>
              message.role === 'assistant' &&
              message.blocks.some((block) => block.type === 'text' && block.text.trim())
          )
        if (retainPartial) {
          this.turnState.emitActivity(participant, event)
        } else {
          this.turnState.removeActivity(participant.id)
        }
        this.turnState.ignorePending(participant.id, session.id)
        if (retainPartial) {
          this.turnState.disposeParticipant(participant.id)
        }
        const failed = this.db.messages.deliveries.failResponse(
          delivery.id,
          event.type === 'failed' ? 'room_turn_failed' : 'room_turn_interrupted',
          event.timestamp
        )
        this.emit(participant.roomId, { type: 'delivery.updated', delivery: failed })
        if (!retainPartial) {
          this.emit(participant.roomId, {
            type: 'activity.cleared',
            participantId: participant.id
          })
        }
        this.onSettled()
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
      return delivery.state === 'delivered' && !delivery.respondedAt ? delivery : null
    } catch {
      return null
    }
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
}
