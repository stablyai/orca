import { describe, expect, it } from 'vitest'
import { decodeAntigravityTranscriptLine } from './transcript-line-decoders'

describe('decodeAntigravityTranscriptLine', () => {
  it('decodes user text and extracts <USER_REQUEST> tags', () => {
    const line = JSON.stringify({
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      content: '<USER_REQUEST>\nFix the login issue\n</USER_REQUEST>',
      created_at: '2026-08-21T03:00:00.000Z',
      step_index: 1
    })
    expect(decodeAntigravityTranscriptLine(line, 'fb-1')).toEqual({
      id: '1',
      role: 'user',
      blocks: [{ type: 'text', text: 'Fix the login issue' }],
      timestamp: Date.parse('2026-08-21T03:00:00.000Z'),
      source: 'transcript'
    })
  })

  it('decodes assistant response with text, thinking, and tool calls', () => {
    const line = JSON.stringify({
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      thinking: 'Analyzing the codebase...',
      content: 'Here is the mermaid diagram:\n```mermaid\ngraph TD\nA-->B\n```',
      tool_calls: [{ name: 'run_command', arguments: { CommandLine: 'ls -la' } }],
      created_at: '2026-08-21T03:00:05.000Z',
      step_index: 2
    })
    expect(decodeAntigravityTranscriptLine(line, 'fb-2')).toEqual({
      id: '2',
      role: 'assistant',
      blocks: [
        { type: 'text', text: '> *Thinking:*\nAnalyzing the codebase...' },
        { type: 'text', text: 'Here is the mermaid diagram:\n```mermaid\ngraph TD\nA-->B\n```' },
        { type: 'tool-call', name: 'run_command', input: { CommandLine: 'ls -la' } }
      ],
      timestamp: Date.parse('2026-08-21T03:00:05.000Z'),
      source: 'transcript'
    })
  })

  it('decodes tool results', () => {
    const line = JSON.stringify({
      source: 'SYSTEM',
      type: 'TOOL_RESULT',
      status: 'DONE',
      content: 'Files listed successfully',
      created_at: '2026-08-21T03:00:10.000Z',
      step_index: 3
    })
    expect(decodeAntigravityTranscriptLine(line, 'fb-3')).toEqual({
      id: '3',
      role: 'tool',
      blocks: [{ type: 'tool-result', output: 'Files listed successfully' }],
      timestamp: Date.parse('2026-08-21T03:00:10.000Z'),
      source: 'transcript'
    })
  })

  it('marks error tool results', () => {
    const line = JSON.stringify({
      source: 'SYSTEM',
      type: 'TOOL_RESULT',
      status: 'ERROR',
      content: 'Command failed with exit code 1',
      created_at: '2026-08-21T03:00:12.000Z',
      step_index: 4
    })
    expect(decodeAntigravityTranscriptLine(line, 'fb-4')).toEqual({
      id: '4',
      role: 'tool',
      blocks: [{ type: 'tool-result', output: 'Command failed with exit code 1', isError: true }],
      timestamp: Date.parse('2026-08-21T03:00:12.000Z'),
      source: 'transcript'
    })
  })

  it('skips non-message records or invalid JSON', () => {
    expect(decodeAntigravityTranscriptLine('invalid json', 'fb-5')).toBeNull()
    expect(decodeAntigravityTranscriptLine(JSON.stringify({ source: 'INTERNAL', type: 'NOOP' }), 'fb-6')).toBeNull()
  })
})
