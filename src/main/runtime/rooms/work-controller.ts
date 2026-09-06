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
    const fence = this.deliveries.requestRoomFence(roomId, { discardConfirmations: true })
    try {
      const result = this.db.transaction(() => this.db.messages.deliveries.stopRoom(roomId))
      result.deliveries.forEach((delivery) =>
        this.emit(roomId, { type: 'delivery.updated', delivery })
      )
      const stopping = result.deliveries.filter((delivery) => delivery.error === 'room_stopping')
      const participantIds = [...new Set(stopping.map((delivery) => delivery.participantId))]
      const interrupting = Promise.allSettled(
        participantIds.map(async (participantId): Promise<string[]> => {
          const ids = stopping
            .filter((delivery) => delivery.participantId === participantId)
            .map((delivery) => delivery.id)
          const participant = this.db.participants
            .list(roomId)
            .find((candidate) => candidate.id === participantId)
          if (!participant) {
            return ids
          }
          const adapter = participant.agent ? this.adapters[participant.agent] : undefined
          const binding = roomParticipantHarnessBinding(participant)
          if (adapter && binding && participant.state !== 'sleeping') {
            try {
              await adapter.interrupt(binding)
            } catch (error) {
              if (
                this.db.participants
                  .list(roomId)
                  .some((candidate) => candidate.id === participantId)
              ) {
                throw error
              }
            }
          }
          return ids
        })
      )
      await fence.ready
      const interrupts = await interrupting
      const stoppedIds = interrupts.flatMap((result) =>
        result.status === 'fulfilled' ? result.value : []
      )
      const stoppedSet = new Set(stoppedIds)
      this.transcript.finalizeStoppedDeliveries(
        result.stopped.filter((delivery) => stoppedSet.has(delivery.id))
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
      fence.release()
    }
  }

  async resume(roomId: string): Promise<number> {
    const result = this.db.transaction(() => this.db.messages.deliveries.resumeRoom(roomId))
    result.deliveries.forEach((delivery) =>
      this.emit(roomId, { type: 'delivery.updated', delivery })
    )
    this.emit(roomId, { type: 'room.updated', room: this.db.core.get(roomId) })
    this.deliveries.wake()
    return result.resumed.length
  }

  async stopMessage(messageId: string): Promise<void> {
    const roomId = this.db.messages.get(messageId).roomId
    const fence = this.deliveries.requestRoomFence(roomId, { discardConfirmations: true })
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
      await fence.ready
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
      fence.release()
    }
  }
}
