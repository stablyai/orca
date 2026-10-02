import {
  roomParticipantFixture,
  roomDeliveryFixture,
  roomMessageFixture
} from '../../../shared/rooms.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { AgentJournalRenderItemSchema } from '../../../shared/agent-session-journal-schemas'
import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import type { NativeChatMessage } from '../../../shared/native-chat-types'

import { projectStructuredItemsToNativeChat } from '../../../shared/structured-agent-session-projection'
import { boundStreamItem } from '../../codex/codex-structured-item-stream-bounds'
import {
  codexJournalItem,
  codexStreamingJournalItem,
  type CodexThreadItem
} from '../../codex/codex-structured-item-translation'
import { RoomDatabase } from './database'
import { RoomTranscriptTurnState, selectRoomTranscriptFinal } from './transcript-turn-state'

function assistant(id: string, phase: 'commentary' | 'final', text: string): NativeChatMessage {
  return {
    id,
    role: 'assistant',
    assistantPhase: phase,
    blocks: [{ type: 'text', text }],
    timestamp: 1,
    source: 'stream'
  }
}

it.each(['commentary', 'final_answer', undefined])(
  'preserves Codex phase %s through streaming, journal replay and interrupted publication',
  (phase) => {
    const text = 'Waiting. <orca-room-recipients>["codex2"]</orca-room-recipients>'
    const item: CodexThreadItem = { type: 'agentMessage', id: 'reply', text, phase }
    const bounded = boundStreamItem({ ...item, padding: 'x'.repeat(70_000) })
    if (typeof bounded.type !== 'string' || typeof bounded.id !== 'string') {
      throw new Error('Bounded item lost its identity')
    }
    const bodies = [
      codexJournalItem(item).body,
      codexStreamingJournalItem(item, text).body,
      codexStreamingJournalItem({ ...bounded, type: bounded.type, id: bounded.id }, text).body
    ]
    for (const body of bodies) {
      const saved: AgentJournalRenderItem = {
        itemId: 'reply',
        revision: 2,
        sequence: 1,
        observedAt: 100,
        body: body!
      }
      const replayed = AgentJournalRenderItemSchema.parse(JSON.parse(JSON.stringify(saved)))
      expect(AgentJournalRenderItemSchema.safeParse(replayed).success).toBe(true)
      expect(replayed).toEqual(saved)
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Schema-validated JSON round-trip equals the typed saved item; the wire schema also admits future enum values.
      const messages = projectStructuredItemsToNativeChat([replayed as AgentJournalRenderItem])
      expect(messages[0]?.assistantPhase).toBe(phase === 'final_answer' ? 'final' : phase)
      const participant = roomParticipantFixture({
        id: 'participant',
        roomId: 'room',
        identity: 'codex',
        actorKind: 'agent'
      })
      const db = new RoomDatabase(':memory:')
      vi.spyOn(db.participants, 'list').mockReturnValue([
        participant,
        roomParticipantFixture({ identity: 'codex2', actorKind: 'agent' })
      ])
      vi.spyOn(db.messages, 'get').mockReturnValue(roomMessageFixture({ sequence: 1 }))
      const createReply = vi
        .spyOn(db.providerMessages, 'createReply')
        .mockReturnValue(roomMessageFixture({ id: 'published' }))
      vi.spyOn(db.providerMessages, 'ignore').mockImplementation(() => {})
      try {
        const state = new RoomTranscriptTurnState(db, vi.fn())
        const delivery = roomDeliveryFixture({
          id: 'delivery',
          messageId: 'user',
          deliveredAt: 50,
          state: 'delivered',
          error: null
        })
        state.rememberStart(participant, delivery, {
          type: 'activity',
          source: 'transcript',
          turnId: 'turn',
          timestamp: 50,
          messages: []
        })
        state.remember(participant.id, messages, true)
        state.publishInterrupted(
          participant,
          delivery,
          'session',
          { type: 'interrupted', source: 'transcript', turnId: 'turn', timestamp: 200, messages },
          vi.fn()
        )
        expect(createReply).toHaveBeenCalledWith(
          expect.objectContaining({
            body: phase === 'commentary' ? '' : 'Waiting.',
            mentions: [],
            enqueueDeliveries: false,
            activity: expect.objectContaining({
              state: 'interrupted',
              messages: phase === 'commentary' ? messages : [],
              completedAt: 200
            })
          })
        )
      } finally {
        db.close()
      }
    }
  }
)

describe('selectRoomTranscriptFinal', () => {
  it('publishes only an explicitly confirmed final when phases are available', () => {
    const commentary = {
      message: assistant('commentary', 'commentary', 'Checking'),
      publishable: true
    }
    expect(selectRoomTranscriptFinal([commentary], 'Checking')).toEqual({
      candidate: null,
      body: null
    })

    const final = { message: assistant('final', 'final', 'Done'), publishable: true }
    expect(selectRoomTranscriptFinal([commentary, final], null)).toEqual({
      candidate: final,
      body: 'Done'
    })
  })

  it('selects only a response after the last same-turn steer', () => {
    const earlyFinal = { message: assistant('early', 'final', 'Early'), publishable: true }
    const steer: NativeChatMessage = {
      id: 'steer',
      role: 'user',
      blocks: [{ type: 'text', text: 'Change course' }],
      timestamp: 2,
      source: 'stream'
    }
    const afterSteer: NativeChatMessage = {
      id: 'after',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'Changed' }],
      timestamp: 3,
      source: 'stream'
    }
    const pending = [
      earlyFinal,
      { message: steer, publishable: true },
      { message: afterSteer, publishable: true }
    ]

    expect(selectRoomTranscriptFinal(pending, 'Changed')).toEqual({
      candidate: pending[2],
      body: 'Changed'
    })
  })

  it('uses the terminal body instead of an unrelated unclassified response', () => {
    const checking = {
      message: {
        id: 'checking',
        role: 'assistant' as const,
        blocks: [{ type: 'text' as const, text: 'Checking' }],
        timestamp: 1,
        source: 'stream' as const
      },
      publishable: true
    }

    expect(selectRoomTranscriptFinal([checking], 'Done')).toEqual({
      candidate: null,
      body: 'Done'
    })
    expect(selectRoomTranscriptFinal([checking], null)).toEqual({
      candidate: checking,
      body: 'Checking'
    })
  })

  it('does not reuse a matching unclassified response from before a steer', () => {
    const early = {
      message: {
        id: 'early',
        role: 'assistant' as const,
        blocks: [{ type: 'text' as const, text: 'Done' }],
        timestamp: 1,
        source: 'stream' as const
      },
      publishable: true
    }
    const steer = {
      message: {
        id: 'steer',
        role: 'user' as const,
        blocks: [{ type: 'text' as const, text: 'Change course' }],
        timestamp: 2,
        source: 'stream' as const
      },
      publishable: true
    }

    expect(selectRoomTranscriptFinal([early, steer], 'Done')).toEqual({
      candidate: null,
      body: 'Done'
    })
  })
})

it('does not restore a settled activity as the next turn', () => {
  const database = new RoomDatabase(':memory:')
  try {
    const room = database.createRoom({ projectId: 'project', name: 'room' })
    const participant = database.participants.add({
      roomId: room.room.id,
      identity: 'codex',
      displayName: 'Codex',
      agent: 'codex'
    })
    database.activities.upsert({
      participantId: participant.id,
      identity: participant.identity,
      state: 'interrupted',
      kind: 'working',
      messages: [],
      startedAt: 100,
      updatedAt: 200,
      anchorSequence: null
    })
    const state = new RoomTranscriptTurnState(database, () => undefined)

    state.restore(participant)

    expect(state.entries(participant.id)).toEqual([])
    expect(database.activities.get(participant.id)).toBeNull()
  } finally {
    database.close()
  }
})
