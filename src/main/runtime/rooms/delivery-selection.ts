import type { RoomDelivery, RoomParticipant } from '../../../shared/rooms'
import type { RoomDatabase } from './database'

export function selectConcurrentDeliveries(due: RoomDelivery[]): RoomDelivery[] {
  const participants = new Set<string>()
  return due.filter((delivery) => {
    if (participants.has(delivery.participantId)) {
      return false
    }
    participants.add(delivery.participantId)
    return true
  })
}

export function deliveryFailureState(exhausted: boolean): RoomDelivery['state'] {
  return exhausted ? 'failed' : 'pending'
}

export function suppressPausedDelivery(
  db: RoomDatabase,
  delivery: RoomDelivery,
  participant: RoomParticipant
): RoomDelivery | null {
  return participant.participation === 'paused'
    ? db.messages.deliveries.complete(
        delivery.id,
        'suppressed',
        'room_participant_paused',
        Number.MAX_SAFE_INTEGER
      )
    : null
}
