import { describe, expect, it, vi } from 'vitest'
import { AgentJournalRenderItemSchema } from '../../../shared/agent-session-journal-schemas'
import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import type { NativeChatMessage } from '../../../shared/native-chat-types'
import type { RoomDelivery, RoomParticipant } from '../../../shared/rooms'
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
    const bounded = boundStreamItem({ ...item, padding: 'x'.repeat(70_000) }) as CodexThreadItem
    const bodies = [
      codexJournalItem(item).body,
      codexStreamingJournalItem(item, text).body,
      codexStreamingJournalItem(bounded, text).body
    ]
    for (const body of bodies) {
      const saved: AgentJournalRenderItem = {
        itemId: 'reply',
        revision: 2,
        sequence: 1,
        observedAt: 100,
        body: body!
      }
      const replayed = JSON.parse(JSON.stringify(saved)) as AgentJournalRenderItem
      expect(AgentJournalRenderItemSchema.safeParse(replayed).success).toBe(true)
      const messages = projectStructuredItemsToNativeChat([replayed])
      expect(messages[0]?.assistantPhase).toBe(phase === 'final_answer' ? 'final' : phase)
      const createReply = vi.fn(() => ({ id: 'published' }))
      const participant = {
        id: 'participant',
        roomId: 'room',
        identity: 'codex',
        actorKind: 'agent'
      } as RoomParticipant
      const db = {
        transaction: <T>(action: () => T) => action(),
        participants: { list: () => [participant, { identity: 'codex2', actorKind: 'agent' }] },
        messages: { get: () => ({ sequence: 1 }) },
        providerMessages: { createReply, ignore: vi.fn() }
      } as unknown as RoomDatabase
      const state = new RoomTranscriptTurnState(db, vi.fn())
      const delivery = {
        id: 'delivery',
        messageId: 'user',
        deliveredAt: 50,
        state: 'delivered',
        error: null
      } as RoomDelivery
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
