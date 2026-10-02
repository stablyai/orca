import {
  roomDeliveryFixture,
  roomActivityFixture,
  roomMessageFixture,
  roomParticipantFixture
} from '../../../shared/rooms.test-fixture'
import { expect, it, vi } from 'vitest'

import { RoomDatabase } from './database'
import { finalizeStoppedRoomTranscripts } from './transcript-stop-settlement'
import { RoomTranscriptTurnState } from './transcript-turn-state'

it('clears matching stopped activity when the live delivery binding was lost', () => {
  const participant = roomParticipantFixture({
    id: 'participant-1',
    roomId: 'room-1',
    providerSession: null
  })
  const delivery = roomDeliveryFixture({
    id: 'delivery-1',
    participantId: participant.id,
    messageId: 'message-1'
  })
  const db = new RoomDatabase(':memory:')
  vi.spyOn(db.activities, 'get').mockReturnValue(
    roomActivityFixture({ state: 'working', anchorSequence: 7 })
  )
  vi.spyOn(db.messages, 'get').mockReturnValue(roomMessageFixture({ sequence: 7 }))
  vi.spyOn(db.messages.deliveries, 'get').mockReturnValue(delivery)
  vi.spyOn(db.participants, 'get').mockReturnValue(participant)
  const turnState = new RoomTranscriptTurnState(db, vi.fn())
  const removeActivity = vi.spyOn(turnState, 'removeActivity').mockImplementation(() => {})

  try {
    finalizeStoppedRoomTranscripts({
      db,
      deliveries: [delivery],
      activeDeliveries: new Map([[participant.id, null]]),
      turnState,
      emit: vi.fn(),
      onSettled: vi.fn(),
      timestamp: 100
    })

    expect(removeActivity).toHaveBeenCalledWith(participant.id)
  } finally {
    db.close()
  }
})
