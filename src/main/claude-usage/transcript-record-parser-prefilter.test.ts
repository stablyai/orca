import { describe, expect, it } from 'vitest'
import { parseClaudeUsageRecord } from './transcript-record-parser'

function assistantLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'assistant',
    sessionId: 'session-1',
    timestamp: '2026-01-01T00:00:00.000Z',
    message: { usage: { input_tokens: 3, output_tokens: 5 } },
    ...overrides
  })
}

describe('assistant-record prefilter', () => {
  it('still parses an ordinary assistant record', () => {
    expect(parseClaudeUsageRecord(assistantLine())?.inputTokens).toBe(3)
  })

  it('rejects a user record that never mentions assistant', () => {
    const userLine = JSON.stringify({
      type: 'user',
      sessionId: 'session-1',
      timestamp: '2026-01-01T00:00:00.000Z',
      message: { content: 'x'.repeat(200) }
    })

    expect(parseClaudeUsageRecord(userLine)).toBeNull()
  })

  it('rejects a non-assistant record that happens to contain the word assistant', () => {
    const userLine = JSON.stringify({
      type: 'user',
      sessionId: 'session-1',
      timestamp: '2026-01-01T00:00:00.000Z',
      message: { content: 'ask the assistant about this' }
    })

    expect(parseClaudeUsageRecord(userLine)).toBeNull()
  })
})
