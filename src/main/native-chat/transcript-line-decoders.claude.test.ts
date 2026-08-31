import { describe, expect, it } from 'vitest'
import { decodeClaudeTranscriptLine } from './transcript-line-decoders-claude'

function attachment(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'attachment',
    uuid: 'queued-1',
    timestamp: '2026-06-01T10:00:05.000Z',
    attachment: {
      type: 'queued_command',
      commandMode: 'prompt',
      prompt: 'queued prompt',
      ...overrides
    }
  })
}

describe('decodeClaudeTranscriptLine queued prompts', () => {
  it('decodes a queued prompt with provider identity and enqueue time', () => {
    expect(decodeClaudeTranscriptLine(attachment(), 'fallback')).toEqual({
      id: 'queued-1',
      role: 'user',
      blocks: [{ type: 'text', text: 'queued prompt' }],
      timestamp: Date.parse('2026-06-01T10:00:05.000Z'),
      source: 'transcript',
      queued: true
    })
  })

  it.each([
    { commandMode: 'task-notification' },
    { commandMode: 'command' },
    { type: 'other' },
    { prompt: '' },
    { prompt: { unexpected: true } }
  ])('rejects non-prompt attachment content %#', (overrides) => {
    expect(decodeClaudeTranscriptLine(attachment(overrides), 'fallback')).toBeNull()
  })
})
