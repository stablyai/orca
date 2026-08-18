import { describe, expect, it } from 'vitest'
import {
  decodeHermesDatabaseMessage,
  decodeHermesTranscriptLine
} from './transcript-line-decoders-hermes'

describe('decodeHermesTranscriptLine', () => {
  it('decodes message envelopes and preserves tool blocks', () => {
    const message = decodeHermesTranscriptLine(
      JSON.stringify({
        id: 'turn-1',
        timestamp: '2026-08-18T12:00:00Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Done.' },
            { type: 'tool-call', name: 'read_file', input: { path: 'README.md' } },
            { type: 'tool-result', output: 'contents' }
          ]
        }
      }),
      'fallback'
    )

    expect(message).toMatchObject({
      id: 'turn-1',
      role: 'assistant',
      source: 'transcript',
      blocks: [
        { type: 'text', text: 'Done.' },
        { type: 'tool-call', name: 'read_file', input: { path: 'README.md' } },
        { type: 'tool-result', output: 'contents' }
      ]
    })
  })

  it('decodes flat Hermes tool-call and tool-result rows', () => {
    expect(
      decodeHermesDatabaseMessage(
        {
          id: 10,
          role: 'assistant',
          content: '',
          tool_name: 'read_file',
          tool_calls: '{"path":"README.md"}'
        },
        'fallback'
      )
    ).toMatchObject({
      blocks: [{ type: 'tool-call', name: 'read_file', input: { path: 'README.md' } }]
    })
    expect(
      decodeHermesDatabaseMessage(
        {
          id: 11,
          role: 'tool',
          content: 'contents',
          tool_name: 'read_file',
          tool_call_id: 'call-1'
        },
        'fallback'
      )
    ).toMatchObject({ blocks: [{ type: 'tool-result', output: 'contents' }] })
  })

  it('decodes Hermes state.db message columns, including tool calls and results', async () => {
    const message = decodeHermesDatabaseMessage(
      {
        id: 42,
        role: 'assistant',
        content: 'I will inspect it.',
        tool_calls: JSON.stringify([
          { id: 'call-1', function: { name: 'read_file', arguments: '{"path":"README.md"}' } }
        ]),
        timestamp: 1787052000
      },
      'fallback'
    )
    expect(message).toMatchObject({
      id: '42',
      blocks: [
        { type: 'text', text: 'I will inspect it.' },
        { type: 'tool-call', name: 'read_file', input: { path: 'README.md' } }
      ],
      timestamp: 1787052000000
    })
    expect(
      decodeHermesDatabaseMessage(
        {
          id: 43,
          role: 'tool',
          content: 'contents',
          tool_name: 'read_file',
          tool_call_id: 'call-1'
        },
        'fallback'
      )
    ).toMatchObject({
      role: 'tool',
      blocks: [{ type: 'tool-result', output: 'contents' }]
    })
  })

  it('normalizes common Hermes role aliases and top-level content', () => {
    expect(
      decodeHermesTranscriptLine(
        JSON.stringify({ id: 'human-1', role: 'human', content: 'hello' }),
        'fallback'
      )
    ).toMatchObject({ role: 'user', blocks: [{ type: 'text', text: 'hello' }] })
    expect(
      decodeHermesTranscriptLine(
        JSON.stringify({ id: 'model-1', role: 'model', content: 'hi' }),
        'fallback'
      )
    ).toMatchObject({ role: 'assistant' })
  })

  it('skips malformed, operational, and unknown records', () => {
    expect(decodeHermesTranscriptLine('not json', 'fallback')).toBeNull()
    expect(
      decodeHermesTranscriptLine(JSON.stringify({ type: 'tool.started' }), 'fallback')
    ).toBeNull()
    expect(
      decodeHermesTranscriptLine(
        JSON.stringify({ message: { role: 'future', content: 'x' } }),
        'fallback'
      )
    ).toBeNull()
  })
})
