import { describe, expect, it } from 'vitest'
import { decodeCursorTranscriptLine } from './transcript-line-decoders-cursor'

describe('decodeCursorTranscriptLine', () => {
  it('decodes user and assistant text without inventing metadata', () => {
    expect(
      decodeCursorTranscriptLine(
        JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: 'Fix it' }] } }),
        'cursor:0'
      )
    ).toEqual({
      id: 'cursor:0',
      role: 'user',
      blocks: [{ type: 'text', text: 'Fix it' }],
      timestamp: null,
      source: 'transcript'
    })
  })

  it('keeps assistant text and tool_use blocks in transcript order', () => {
    expect(
      decodeCursorTranscriptLine(
        JSON.stringify({
          role: 'assistant',
          message: {
            content: [
              { type: 'text', text: 'Checking' },
              { type: 'tool_use', name: 'Read', input: { path: 'README.md' } }
            ]
          }
        }),
        'cursor:1'
      )
    ).toMatchObject({
      role: 'assistant',
      blocks: [
        { type: 'text', text: 'Checking' },
        { type: 'tool-call', name: 'Read', input: { path: 'README.md' } }
      ],
      timestamp: null
    })
  })

  it('skips lifecycle, malformed and empty message rows', () => {
    expect(
      decodeCursorTranscriptLine(JSON.stringify({ type: 'turn_ended', status: 'success' }), 'a')
    ).toBeNull()
    expect(decodeCursorTranscriptLine('{', 'b')).toBeNull()
    expect(
      decodeCursorTranscriptLine(
        JSON.stringify({ role: 'assistant', message: { content: [] } }),
        'c'
      )
    ).toBeNull()
  })
})
