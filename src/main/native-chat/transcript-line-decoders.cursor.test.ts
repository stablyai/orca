import { describe, expect, it } from 'vitest'
import { decodeCursorTranscriptLine } from './transcript-line-decoders'

describe('decodeCursorTranscriptLine', () => {
  it('skips malformed lines and non-conversation records', () => {
    expect(decodeCursorTranscriptLine('not json', 'f')).toBeNull()
    expect(decodeCursorTranscriptLine(JSON.stringify({ role: 'system' }), 'f')).toBeNull()
    expect(decodeCursorTranscriptLine(JSON.stringify({ role: 'assistant' }), 'f')).toBeNull()
  })

  it('strips Cursor timestamp and user_query envelopes from user turns', () => {
    const line = JSON.stringify({
      role: 'user',
      message: {
        content: [
          {
            type: 'text',
            text: '<timestamp>Friday, Aug 28, 2026, 10:20 AM (UTC-4)</timestamp>\n<user_query>\nplease rebase\n</user_query>'
          }
        ]
      },
      timestamp: '2026-08-28T14:20:00.000Z'
    })
    expect(decodeCursorTranscriptLine(line, 'fb-1')).toEqual({
      id: 'fb-1',
      role: 'user',
      blocks: [{ type: 'text', text: 'please rebase' }],
      timestamp: Date.parse('2026-08-28T14:20:00.000Z'),
      source: 'transcript'
    })
  })

  it('decodes assistant text and tool_use on the same row', () => {
    const line = JSON.stringify({
      role: 'assistant',
      uuid: 'asst-1',
      message: {
        content: [
          { type: 'text', text: 'Checking git status.' },
          { type: 'tool_use', name: 'Shell', input: { command: 'git status' } }
        ]
      }
    })
    expect(decodeCursorTranscriptLine(line, 'fb-2')).toEqual({
      id: 'asst-1',
      role: 'assistant',
      blocks: [
        { type: 'text', text: 'Checking git status.' },
        { type: 'tool-call', name: 'Shell', input: { command: 'git status' } }
      ],
      timestamp: null,
      source: 'transcript'
    })
  })

  it('accepts the vault fixture message.content string shape', () => {
    const line = JSON.stringify({
      role: 'assistant',
      message: { content: 'cursor seed answer' },
      timestamp: '2026-05-01T10:01:00.000Z'
    })
    expect(decodeCursorTranscriptLine(line, 'fb-3')).toMatchObject({
      role: 'assistant',
      blocks: [{ type: 'text', text: 'cursor seed answer' }]
    })
  })
})
