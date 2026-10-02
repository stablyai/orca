import { describe, expect, it } from 'vitest'
import type { RoomAgentActivity, RoomEvent } from '../../../shared/rooms'
import { RoomEventBus } from './event-bus'

describe('RoomEventBus', () => {
  it('replays current activity when the room is reopened', () => {
    const bus = new RoomEventBus()
    const activity: RoomAgentActivity = {
      participantId: 'agent-1',
      identity: 'codex',
      state: 'working',
      kind: 'thinking',
      messages: [],
      startedAt: 1,
      updatedAt: 2,
      anchorSequence: 3
    }
    bus.emit('room-1', { type: 'activity.updated', activity })
    const events: RoomEvent[] = []

    bus.subscribe('room-1', { type: 'end' }, (event) => events.push(event))

    expect(events).toEqual([{ type: 'end' }, { type: 'activity.updated', activity }])
  })
})
