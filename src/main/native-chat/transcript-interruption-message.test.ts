import { describe, expect, it } from 'vitest'
import {
  NATIVE_CHAT_INTERRUPTED_STATUS_TEXT,
  type NativeChatMessage
} from '../../shared/native-chat-types'
import { stripNoiseMessages } from '../../shared/native-chat-noise'
import { decodeClaudeTranscriptLine } from './transcript-line-decoders-claude'
import { decodeCodexTranscriptLine } from './transcript-line-decoders-codex'

function expectNormalizedInterruption(message: NativeChatMessage | null): void {
  expect(message).toMatchObject({
    role: 'system',
    blocks: [{ type: 'text', text: NATIVE_CHAT_INTERRUPTED_STATUS_TEXT }],
    source: 'transcript'
  })
  expect(stripNoiseMessages(message ? [message] : [])).toEqual([message])
}

describe('native chat transcript interruption messages', () => {
  it('normalizes Claude interruption boilerplate into one visible status row', () => {
    const message = decodeClaudeTranscriptLine(
      JSON.stringify({
        type: 'user',
        uuid: 'interrupt-row',
        interruptedMessageId: 'assistant-request-1',
        timestamp: '2026-07-16T23:46:01.000Z',
        message: {
          role: 'user',
          content: [{ type: 'text', text: '[Request interrupted by user]' }]
        }
      }),
      'fallback'
    )

    expectNormalizedInterruption(message)
    expect(message?.id).toBe('interrupt-row')
  })

  it('normalizes Codex turn_aborted into one visible status row', () => {
    const message = decodeCodexTranscriptLine(
      JSON.stringify({
        type: 'event_msg',
        timestamp: '2026-07-16T23:46:01.000Z',
        payload: { type: 'turn_aborted', reason: 'interrupted', turn_id: 'turn-2' }
      }),
      'fallback'
    )

    expectNormalizedInterruption(message)
    expect(message?.id).toBe('fallback')
  })
})
