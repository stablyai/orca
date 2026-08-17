import type { RoomDelivery, RoomEvent, RoomMessage } from '../../../shared/rooms'
import type { RoomDatabase } from './database'
import type { RoomTranscriptTurnState } from './transcript-turn-state'

export function clearStoppedRoomTranscripts(input: {
  db: RoomDatabase
  participantIds: readonly string[]
  activeDeliveries: Map<string, string | null>
  turnState: RoomTranscriptTurnState
  emit: (roomId: string, event: RoomEvent) => void
}): void {
  for (const participantId of input.participantIds) {
    input.activeDeliveries.delete(participantId)
    input.turnState.disposeParticipant(participantId)
    input.db.activities.remove(participantId)
    input.emit(input.db.participants.get(participantId).roomId, {
      type: 'activity.cleared',
      participantId
    })
  }
}

export function finalizeStoppedRoomTranscripts(input: {
  db: RoomDatabase
  deliveries: readonly RoomDelivery[]
  activeDeliveries: Map<string, string | null>
  turnState: RoomTranscriptTurnState
  emit: (roomId: string, event: RoomEvent) => void
  onSettled: (message?: RoomMessage) => void
  timestamp: number
}): void {
  for (const delivery of input.deliveries) {
    const activity = input.db.activities.get(delivery.participantId)
    const activeId = input.activeDeliveries.get(delivery.participantId)
    const anchorSequence = input.db.messages.get(delivery.messageId).sequence
    if (
      activeId !== delivery.id &&
      (activeId != null ||
        activity?.state !== 'working' ||
        activity.anchorSequence !== anchorSequence)
    ) {
      continue
    }
    const participant = input.db.participants.get(delivery.participantId)
    const session = participant.providerSession
    if (session) {
      input.turnState.restore(participant)
      input.turnState.publishInterrupted(
        participant,
        input.db.messages.deliveries.get(delivery.id),
        session.id,
        {
          type: 'interrupted',
          source: 'status',
          turnId: delivery.providerTurnId,
          timestamp: input.timestamp,
          messages: []
        },
        input.onSettled
      )
    }
    input.turnState.removeActivity(participant.id)
    input.activeDeliveries.delete(participant.id)
    input.emit(participant.roomId, {
      type: 'activity.cleared',
      participantId: participant.id
    })
  }
}
