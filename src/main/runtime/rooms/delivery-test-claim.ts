import type { RoomDelivery } from '../../../shared/rooms'
import type { RoomDatabase } from './database'
import { roomDeliveryReadiness } from './delivery-readiness-evidence'
import { roomParticipantHarnessBinding } from './participant-harness-binding'

export function claimRoomBroadcastForTest(
  db: RoomDatabase,
  messageId: string
): RoomDelivery[] | null {
  const roomId = db.messages.get(messageId).roomId
  const readiness = db.participants
    .list(roomId)
    .filter(
      (participant) => participant.actorKind === 'agent' && participant.participation === 'active'
    )
    .map((participant) => {
      const binding = roomParticipantHarnessBinding(participant)
      return roomDeliveryReadiness(participant, binding)
    })
  return db.messages.deliveries.claimBroadcast(messageId, readiness)
}
