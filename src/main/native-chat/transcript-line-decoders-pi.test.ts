import { describe, expect, it } from 'vitest'
import { decodePiTranscriptLine } from './transcript-line-decoders-pi'

describe('decodePiTranscriptLine', () => {
  it('maps Pi user, assistant, tool call, and tool result messages', () => {
    const user = decodePiTranscriptLine(
      JSON.stringify({
        type: 'message',
        id: 'user-1',
        timestamp: '2026-08-03T14:00:00.000Z',
        message: { role: 'user', content: 'Inspect this file', timestamp: 1 }
      }),
      'fallback'
    )
    expect(user).toMatchObject({
      id: 'user-1',
      role: 'user',
      blocks: [{ type: 'text', text: 'Inspect this file' }],
      source: 'transcript'
    })

    const assistant = decodePiTranscriptLine(
      JSON.stringify({
        type: 'message',
        id: 'assistant-1',
        timestamp: '2026-08-03T14:00:01.000Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Checking the file' },
            { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'a.ts' } }
          ]
        }
      }),
      'fallback'
    )
    expect(assistant).toMatchObject({
      id: 'assistant-1',
      role: 'assistant',
      blocks: [
        { type: 'text', text: 'Checking the file' },
        { type: 'tool-call', name: 'read', input: { path: 'a.ts' } }
      ]
    })

    const toolResult = decodePiTranscriptLine(
      JSON.stringify({
        type: 'message',
        id: 'tool-1',
        timestamp: '2026-08-03T14:00:02.000Z',
        message: {
          role: 'toolResult',
          toolCallId: 'call-1',
          toolName: 'read',
          content: [{ type: 'text', text: 'file contents' }],
          isError: false
        }
      }),
      'fallback'
    )
    expect(toolResult).toMatchObject({
      id: 'tool-1',
      role: 'tool',
      blocks: [{ type: 'tool-result', output: 'file contents' }]
    })
  })

  it('skips non-message records and unknown roles', () => {
    expect(decodePiTranscriptLine('{"type":"session","id":"session-1"}', 'fallback')).toBeNull()
    expect(
      decodePiTranscriptLine(
        JSON.stringify({
          type: 'message',
          id: 'system-1',
          message: { role: 'system', content: 'x' }
        }),
        'fallback'
      )
    ).toBeNull()
  })
})
