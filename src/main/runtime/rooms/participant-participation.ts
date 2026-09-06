import type { RoomEvent, RoomParticipant } from '../../../shared/rooms'
import type { RoomDatabase } from './database'

export function updateRoomParticipant(
  db: RoomDatabase,
  id: string,
  input: Parameters<RoomDatabase['participants']['update']>[1],
  assertWritable: (roomId: string) => void,
  emit: (roomId: string, event: RoomEvent) => void,
  wake: () => void
): RoomParticipant {
  const current = db.participants.get(id)
  assertWritable(current.roomId)
  const pausing = current.participation !== 'paused' && input.participation === 'paused'
  const result = db.transaction(() => {
    const previousBroadcastIds = pausing
      ? db.messages.deliveries.listMutableBroadcastIds(current.roomId)
      : []
    const participant = db.participants.update(id, input)
    const suppressed = pausing ? db.messages.deliveries.suppressParticipantQueue(id) : []
    const normalized = pausing
      ? db.messages.deliveries.normalizeNewBroadcasts(current.roomId, previousBroadcastIds)
      : []
    const deliveries = [
      ...new Map([...suppressed, ...normalized].map((item) => [item.id, item])).values()
    ]
    return { participant, deliveries }
  })
  const participationChanged = result.participant.participation !== current.participation
  emit(result.participant.roomId, { type: 'participant.updated', participant: result.participant })
  for (const delivery of result.deliveries) {
    emit(result.participant.roomId, { type: 'delivery.updated', delivery })
  }
  if (participationChanged) {
    emit(result.participant.roomId, {
      type: 'room.updated',
      room: db.core.get(result.participant.roomId)
    })
    wake()
  }
  return result.participant
}
