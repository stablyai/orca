import { describe, expect, it } from 'vitest'
import { decodeHermesTranscriptLine } from './transcript-line-decoders-hermes'

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
    expect(decodeHermesTranscriptLine(JSON.stringify({ type: 'tool.started' }), 'fallback')).toBeNull()
    expect(
      decodeHermesTranscriptLine(JSON.stringify({ message: { role: 'future', content: 'x' } }), 'fallback')
    ).toBeNull()
  })
})