import { describe, expect, it } from 'vitest'
import { parseClaudeUsageRecord } from './transcript-record-parser'

describe('assistant-record prefilter', () => {
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
