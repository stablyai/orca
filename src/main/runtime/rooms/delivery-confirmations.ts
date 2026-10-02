import type { RoomDelivery, RoomEvent, RoomParticipant } from '../../../shared/rooms'
import type { RoomDatabase } from './database'
import type { RoomHarnessAdapter } from './harness-adapter'
import type { RoomHarnessTurnUserMessage } from './harness-lifecycle'
import type { PendingRoomDeliveryConfirmation } from './delivery-configuration'
import { roomDeliveryAttemptsFromTurn } from './delivery-prompt'
import { roomParticipantHarnessBinding } from './participant-harness-binding'

export class RoomDeliveryConfirmations {
  private readonly pending = new Map<string, PendingRoomDeliveryConfirmation>()
  private readonly deadlines = new Map<string, ReturnType<typeof setTimeout>>()
  private disposed = false

  constructor(
    private readonly db: RoomDatabase,
    private readonly adapters: Record<string, RoomHarnessAdapter>,
    private readonly emit: (roomId: string, event: RoomEvent) => void,
    private readonly wake: () => void,
    private readonly deadlineMs: number
  ) {}

  dispose(): void {
    this.disposed = true
    this.deadlines.forEach((timer) => clearTimeout(timer))
    this.deadlines.clear()
    this.pending.clear()
  }

  prepare(
    deliveryId: string,
    participantId: string,
    configuration: PendingRoomDeliveryConfirmation['configuration']
  ): void {
    this.pending.set(deliveryId, { participantId, configuration })
  }

  discard(deliveryId: string): void {
    this.pending.delete(deliveryId)
    this.clearDeadline(deliveryId)
  }

  arm(deliveryId: string): void {
    this.clearDeadline(deliveryId)
    if (this.disposed) {
      return
    }
    const timer = setTimeout(() => {
      this.deadlines.delete(deliveryId)
      void this.expire(deliveryId)
    }, this.deadlineMs)
    timer.unref?.()
    this.deadlines.set(deliveryId, timer)
  }

  clearRoom(roomId: string): void {
    for (const deliveryId of this.pending.keys()) {
      try {
        const delivery = this.db.messages.deliveries.get(deliveryId)
        if (this.db.messages.get(delivery.messageId).roomId !== roomId) {
          continue
        }
      } catch {
        continue
      }
      this.discard(deliveryId)
    }
  }

  confirm(participantId: string, userMessage: RoomHarnessTurnUserMessage): RoomDelivery | null {
    const markers = roomDeliveryAttemptsFromTurn(userMessage.text)
    if (markers.length === 0) {
      return this.db.messages.deliveries.awaitingResponseForTurn(participantId, userMessage.id)
    }
    const delivery = markers.reduce<RoomDelivery | null>((match, marker) => {
      if (match) {
        return match
      }
      try {
        const candidate = this.db.messages.deliveries.get(marker.deliveryId)
        const confirmable =
          candidate.participantId === participantId &&
          (candidate.state === 'delivering' ||
            (candidate.state === 'failed' && candidate.error === 'room_delivery_uncertain'))
        const matchingAttempt =
          marker.attempt === candidate.attempts ||
          (marker.attempt === null &&
            candidate.state === 'failed' &&
            candidate.error === 'room_delivery_uncertain')
        return confirmable && matchingAttempt ? candidate : null
      } catch {
        return null
      }
    }, null)
    if (!delivery) {
      return this.db.messages.deliveries.awaitingResponseForTurn(participantId, userMessage.id)
    }
    const pending = this.pending.get(delivery.id)
    if (pending && pending.participantId !== participantId) {
      return this.db.messages.deliveries.awaitingResponseForTurn(participantId, userMessage.id)
    }
    const message = this.db.messages.get(delivery.messageId)
    const confirmed = this.db.transaction(() => {
      const result = this.db.messages.deliveries.confirmTurn(delivery.id, userMessage.id)
      if (pending) {
        this.db.deliveryConfiguration.commit(participantId, pending.configuration)
      } else {
        this.db.deliveryConfiguration.requireFull(participantId)
      }
      return result
    })
    this.discard(delivery.id)
    this.emit(message.roomId, { type: 'delivery.updated', delivery: confirmed })
    this.wake()
    return confirmed
  }

  private clearDeadline(deliveryId: string): void {
    clearTimeout(this.deadlines.get(deliveryId))
    this.deadlines.delete(deliveryId)
  }

  private async expire(deliveryId: string): Promise<void> {
    if (this.disposed || !this.pending.has(deliveryId)) {
      return
    }
    let delivery: RoomDelivery
    try {
      delivery = this.db.messages.deliveries.get(deliveryId)
    } catch {
      this.pending.delete(deliveryId)
      return
    }
    if (delivery.state !== 'delivering') {
      this.pending.delete(deliveryId)
      return
    }
    const participant = this.participantOrNull(delivery.participantId)
    const adapter = participant?.agent ? this.adapters[participant.agent] : undefined
    const binding = participant ? roomParticipantHarnessBinding(participant) : null
    const status = adapter && binding ? await adapter.status(binding).catch(() => null) : null
    if (status?.isRunningAgent && status.status === 'working') {
      this.arm(deliveryId)
      return
    }
    if (this.disposed || !this.pending.has(deliveryId)) {
      return
    }
    this.pending.delete(deliveryId)
    const message = this.db.messages.get(delivery.messageId)
    const uncertain = this.db.messages.deliveries.complete(
      deliveryId,
      'failed',
      'room_delivery_uncertain',
      Number.MAX_SAFE_INTEGER
    )
    this.emit(message.roomId, { type: 'delivery.updated', delivery: uncertain })
    this.wake()
  }

  private participantOrNull(id: string): RoomParticipant | null {
    try {
      return this.db.participants.get(id)
    } catch {
      return null
    }
  }
}
