import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../shared/native-chat-types'
import { selectRoomTranscriptFinal } from './transcript-turn-state'

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
})
