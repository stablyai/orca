import { expect, it, vi } from 'vitest'
import type { RoomDelivery } from '../../../shared/rooms'
import type { RoomDatabase } from './database'
import { finalizeStoppedRoomTranscripts } from './transcript-stop-settlement'
import type { RoomTranscriptTurnState } from './transcript-turn-state'

it('clears matching stopped activity when the live delivery binding was lost', () => {
  const removeActivity = vi.fn()
  const participant = { id: 'participant-1', roomId: 'room-1', providerSession: null }
  const delivery = {
    id: 'delivery-1',
    participantId: participant.id,
    messageId: 'message-1'
  } as RoomDelivery
  const db = {
    activities: {
      get: () => ({ state: 'working', anchorSequence: 7 })
    },
    messages: {
      get: () => ({ sequence: 7 }),
      deliveries: { get: () => delivery }
    },
    participants: { get: () => participant }
  } as unknown as RoomDatabase

  finalizeStoppedRoomTranscripts({
    db,
    deliveries: [delivery],
    activeDeliveries: new Map([[participant.id, null]]),
    turnState: { removeActivity } as unknown as RoomTranscriptTurnState,
    emit: vi.fn(),
    onSettled: vi.fn(),
    timestamp: 100
  })

  expect(removeActivity).toHaveBeenCalledWith(participant.id)
})
