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
  it('drops only Claude synthetic no-response markers', () => {
    const record = {
      type: 'assistant',
      uuid: 'synthetic-no-response',
      timestamp: '2026-07-16T23:46:01.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'No response requested.' }]
      }
    }

    expect(
      decodeClaudeTranscriptLine(
        JSON.stringify({ ...record, message: { ...record.message, model: '<synthetic>' } }),
        'fallback'
      )
    ).toBeNull()
    expect(
      decodeClaudeTranscriptLine(
        JSON.stringify({ ...record, message: { ...record.message, model: 'claude-opus-5' } }),
        'fallback'
      )
    ).toMatchObject({ role: 'assistant', blocks: record.message.content })
  })

  it('marks Claude API failures as provider errors instead of assistant speech', () => {
    expect(
      decodeClaudeTranscriptLine(
        JSON.stringify({
          type: 'assistant',
          uuid: 'api-error',
          isApiErrorMessage: true,
          timestamp: '2026-08-10T00:32:45.261Z',
          message: {
            role: 'assistant',
            model: '<synthetic>',
            stop_reason: 'stop_sequence',
            content: [
              { type: 'text', text: 'API Error: 400 speed: Extra inputs are not permitted' }
            ]
          }
        }),
        'fallback'
      )
    ).toMatchObject({ role: 'assistant', providerError: true })
  })

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
