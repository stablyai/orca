import { describe, expect, it } from 'vitest'
import { decodeClaudeTranscriptLine } from './transcript-decoding/transcript-line-decoders-claude'
import { summarizeTranscriptContextUsage } from '../../shared/native-chat/native-chat-context-usage-summary'
import type { NativeChatMessage } from '../../shared/native-chat/native-chat-types'

function transcript(records: unknown[]): NativeChatMessage[] {
  return records.flatMap((record, index) => {
    const message = decodeClaudeTranscriptLine(JSON.stringify(record), `row-${index}`)
    return message ? [message] : []
  })
}

function response(input: number, extra: Record<string, unknown> = {}) {
  return {
    type: 'assistant',
    message: {
      model: 'claude-sonnet-5-5',
      content: [{ type: 'text', text: 'Done' }],
      usage: {
        input_tokens: input,
        cache_creation_input_tokens: 8_000,
        cache_read_input_tokens: 30_000,
        output_tokens: 500
      }
    },
    ...extra
  }
}

describe('Claude terminal Chat context usage', () => {
  it('preserves the newest response accounting without inventing an unknown model window', () => {
    const messages = transcript([response(100_000), response(4_000)])

    expect(summarizeTranscriptContextUsage(messages, () => null)).toEqual({
      usedTokens: 42_000,
      windowTokens: null,
      percentage: null,
      estimated: true,
      rows: []
    })
    expect(
      summarizeTranscriptContextUsage(messages, (message) =>
        message.model === 'claude-sonnet-5-5' ? 200_000 : null
      )
    ).toMatchObject({ usedTokens: 42_000, windowTokens: 200_000, percentage: 21 })
  })

  it('invalidates the old context at compaction and accepts the next response', () => {
    const before = transcript([response(100_000), { type: 'system', subtype: 'compact_boundary' }])
    expect(summarizeTranscriptContextUsage(before, () => null)).toBeNull()
    expect(
      summarizeTranscriptContextUsage([...before, ...transcript([response(2_000)])], () => null)
    ).toMatchObject({ usedTokens: 40_000 })
  })

  it('keeps a sidechain response from replacing the main conversation measurement', () => {
    const messages = transcript([response(4_000), response(900_000, { isSidechain: true })])
    expect(summarizeTranscriptContextUsage(messages, () => null)?.usedTokens).toBe(42_000)
  })

  it('retains accounting on a thinking-only assistant response', () => {
    const row = response(4_000)
    const messages = transcript([
      {
        ...row,
        message: {
          ...row.message,
          content: [{ type: 'thinking', thinking: 'Checking the result' }]
        }
      }
    ])
    expect(summarizeTranscriptContextUsage(messages, () => null)?.usedTokens).toBe(42_000)
  })

  it('updates accounting when the newest response contains only redacted thinking', () => {
    const row = response(25_000)
    const messages = transcript([
      response(4_000),
      {
        ...row,
        message: {
          ...row.message,
          content: [{ type: 'redacted_thinking', data: 'opaque' }]
        }
      }
    ])
    expect(summarizeTranscriptContextUsage(messages, () => null)?.usedTokens).toBe(63_000)
  })
})
