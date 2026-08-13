import type { RoomEvent } from '../../../shared/rooms'
import type { RoomDatabase } from './database'
import type { RoomDeliveryWorker } from './delivery-worker'
import type { RoomHarnessAdapter } from './harness-adapter'
import { roomParticipantHarnessBinding } from './participant-harness-binding'
import type { RoomTranscriptBridge } from './transcript-bridge'

export class RoomWorkController {
  constructor(
    private readonly db: RoomDatabase,
    private readonly deliveries: RoomDeliveryWorker,
    private readonly transcript: RoomTranscriptBridge,
    private readonly adapters: Record<string, RoomHarnessAdapter>,
    private readonly emit: (roomId: string, event: RoomEvent) => void
  ) {}

  async stop(roomId: string): Promise<number> {
    const blocked = this.deliveries.blockRoom(roomId)
    try {
      const result = this.db.transaction(() => this.db.messages.deliveries.stopRoom(roomId))
      result.deliveries.forEach((delivery) =>
        this.emit(roomId, { type: 'delivery.updated', delivery })
      )
      const stopping = result.deliveries.filter((delivery) => delivery.error === 'room_stopping')
      const participantIds = [...new Set(stopping.map((delivery) => delivery.participantId))]
      this.transcript.clearStoppedDeliveries(participantIds)
      await blocked

      const interrupts = await Promise.allSettled(
        participantIds.map(async (participantId): Promise<string[]> => {
          const ids = stopping
            .filter((delivery) => delivery.participantId === participantId)
            .map((delivery) => delivery.id)
          const participant = this.db.participants.get(participantId)
          const adapter = participant.agent ? this.adapters[participant.agent] : undefined
          const binding = roomParticipantHarnessBinding(participant)
          if (adapter && binding && participant.state !== 'sleeping') {
            await adapter.interrupt(binding)
          }
          return ids
        })
      )
      const stoppedIds = interrupts.flatMap((result) =>
        result.status === 'fulfilled' ? result.value : []
      )
      const finished = this.db.transaction(() =>
        this.db.messages.deliveries.finishRoomStop(stoppedIds)
      )
      finished.forEach((delivery) => this.emit(roomId, { type: 'delivery.updated', delivery }))
      const failed = interrupts.find((result) => result.status === 'rejected')
      if (failed?.status === 'rejected') {
        throw failed.reason
      }
      return result.deliveries.length
    } finally {
      this.deliveries.unblockRoom(roomId)
    }
  }

  async resume(roomId: string): Promise<number> {
    const resumed = this.db.transaction(() => this.db.messages.deliveries.resumeRoom(roomId))
    resumed.forEach((delivery) => this.emit(roomId, { type: 'delivery.updated', delivery }))
    if (resumed.length > 0) {
      this.deliveries.wake()
    }
    return resumed.length
  }

  async stopMessage(messageId: string): Promise<void> {
    const roomId = this.db.messages.get(messageId).roomId
    const blocked = this.deliveries.blockRoom(roomId)
    try {
      const result = this.db.transaction(() => this.db.messages.deliveries.stopMessage(messageId))
      result.deliveries.forEach((delivery) =>
        this.emit(roomId, { type: 'delivery.updated', delivery })
      )
      const interruptIds = [
        ...new Set(
          result.stopped
            .filter(
              (delivery) =>
                delivery.state === 'delivered' ||
                delivery.state === 'failed' ||
                (delivery.state === 'suppressed' && delivery.error === 'room_stopping') ||
                (delivery.state === 'delivering' && delivery.phase !== 'waking')
            )
            .map((delivery) => delivery.participantId)
        )
      ]
      this.transcript.clearStoppedDeliveries(interruptIds)
      await blocked
      await Promise.allSettled(
        interruptIds.map(async (participantId) => {
          const participant = this.db.participants.get(participantId)
          const adapter = participant.agent ? this.adapters[participant.agent] : undefined
          const binding = roomParticipantHarnessBinding(participant)
          if (adapter && binding) {
            await adapter.interrupt(binding)
          }
        })
      )
    } finally {
      this.deliveries.unblockRoom(roomId)
    }
  }
}
