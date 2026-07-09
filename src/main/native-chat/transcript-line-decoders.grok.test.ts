import { describe, expect, it } from 'vitest'
import { decodeGrokTranscriptLine } from './transcript-line-decoders'

describe('decodeGrokTranscriptLine', () => {
  it('decodes user text and strips <user_query> wrappers', () => {
    const line = JSON.stringify({
      type: 'user',
      content: [{ type: 'text', text: '<user_query>\nFix the bug\n</user_query>' }],
      timestamp: '2026-06-18T00:00:00.000Z'
    })
    expect(decodeGrokTranscriptLine(line, 'fb-1')).toEqual({
      id: 'fb-1',
      role: 'user',
      blocks: [{ type: 'text', text: 'Fix the bug' }],
      timestamp: Date.parse('2026-06-18T00:00:00.000Z'),
      source: 'transcript'
    })
  })

  it('decodes assistant tool calls on empty content rows', () => {
    const line = JSON.stringify({
      type: 'assistant',
      content: '',
      tool_calls: [{ id: 'c1', name: 'grep', arguments: '{"pattern":"foo"}' }],
      id: 'asst-1'
    })
    expect(decodeGrokTranscriptLine(line, 'fb-2')).toEqual({
      id: 'asst-1',
      role: 'assistant',
      blocks: [{ type: 'tool-call', name: 'grep', input: { pattern: 'foo' } }],
      timestamp: null,
      source: 'transcript'
    })
  })

  it('decodes reasoning summaries', () => {
    const line = JSON.stringify({
      type: 'reasoning',
      id: 'rs-1',
      summary: [{ type: 'summary_text', text: 'Planning the change' }]
    })
    expect(decodeGrokTranscriptLine(line, 'fb-3')).toMatchObject({
      id: 'rs-1',
      role: 'reasoning',
      blocks: [{ type: 'text', text: 'Planning the change' }],
      source: 'transcript'
    })
  })

  it('skips system prompts', () => {
    const line = JSON.stringify({ type: 'system', content: 'You are Grok' })
    expect(decodeGrokTranscriptLine(line, 'fb-4')).toBeNull()
  })
})
