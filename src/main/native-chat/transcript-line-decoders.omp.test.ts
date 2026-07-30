import { describe, expect, it } from 'vitest'
import { decodeOmpTranscriptLine } from './transcript-line-decoders'

const line = (record: unknown): string => JSON.stringify(record)

const message = (role: string, content: unknown, extra: Record<string, unknown> = {}): string =>
  line({
    type: 'message',
    id: 'rec-1',
    parentId: 'rec-0',
    timestamp: '2026-07-16T00:27:02.222Z',
    message: { role, content, ...extra }
  })

describe('decodeOmpTranscriptLine', () => {
  it('skips malformed lines and non-conversation records', () => {
    expect(decodeOmpTranscriptLine('not json', 'f')).toBeNull()
    expect(decodeOmpTranscriptLine(line({ type: 'session_init', id: 'a' }), 'f')).toBeNull()
    expect(decodeOmpTranscriptLine(line({ type: 'mode_change', id: 'a' }), 'f')).toBeNull()
    expect(
      decodeOmpTranscriptLine(line({ type: 'custom', customType: 'tool_execution_start' }), 'f')
    ).toBeNull()
    expect(decodeOmpTranscriptLine(line({ type: 'compaction', shortSummary: 's' }), 'f')).toBeNull()
    expect(decodeOmpTranscriptLine(line({ type: 'a-type-from-the-future' }), 'f')).toBeNull()
  })

  it('decodes a user turn', () => {
    const decoded = decodeOmpTranscriptLine(message('user', [{ type: 'text', text: 'resume' }]), 'f')
    expect(decoded).toEqual({
      id: 'rec-1',
      role: 'user',
      blocks: [{ type: 'text', text: 'resume' }],
      timestamp: Date.parse('2026-07-16T00:27:02.222Z'),
      source: 'transcript'
    })
  })

  it('keeps thinking and tool calls together on a mixed assistant turn', () => {
    const decoded = decodeOmpTranscriptLine(
      message('assistant', [
        { type: 'thinking', thinking: 'Checking the goal' },
        { type: 'text', text: 'Reading it now.' },
        { type: 'toolCall', id: 'call-1', name: 'goal', arguments: { op: 'get' } }
      ]),
      'f'
    )
    expect(decoded?.role).toBe('assistant')
    expect(decoded?.blocks).toEqual([
      { type: 'text', text: 'Checking the goal' },
      { type: 'text', text: 'Reading it now.' },
      { type: 'tool-call', name: 'goal', input: { op: 'get' } }
    ])
  })

  it('keeps a thinking-only assistant turn on the assistant role', () => {
    const decoded = decodeOmpTranscriptLine(
      message('assistant', [{ type: 'thinking', thinking: 'Weighing two options' }]),
      'f'
    )
    expect(decoded?.role).toBe('assistant')
    expect(decoded?.blocks).toEqual([{ type: 'text', text: 'Weighing two options' }])
  })

  it('passes tool arguments through unchanged', () => {
    const decoded = decodeOmpTranscriptLine(
      message('assistant', [
        { type: 'toolCall', name: 'goal', arguments: { op: 'get', objective: null } }
      ]),
      'f'
    )
    expect(decoded?.blocks[0]).toEqual({
      type: 'tool-call',
      name: 'goal',
      input: { op: 'get', objective: null }
    })
  })

  it('decodes a tool result', () => {
    const decoded = decodeOmpTranscriptLine(
      message('toolResult', [{ type: 'text', text: 'ok' }], {
        toolCallId: 'call-1',
        toolName: 'goal',
        isError: false
      }),
      'f'
    )
    expect(decoded?.role).toBe('tool')
    expect(decoded?.blocks).toEqual([{ type: 'tool-result', output: 'ok' }])
  })

  it('flags an errored tool result', () => {
    const decoded = decodeOmpTranscriptLine(
      message('toolResult', [{ type: 'text', text: 'boom' }], {
        toolCallId: 'call-2',
        isError: true
      }),
      'f'
    )
    expect(decoded?.blocks[0]).toEqual({ type: 'tool-result', output: 'boom', isError: true })
  })

  it('surfaces the developer channel as system', () => {
    const decoded = decodeOmpTranscriptLine(
      message('developer', [{ type: 'text', text: 'context note' }]),
      'f'
    )
    expect(decoded?.role).toBe('system')
  })

  it('drops blob-handle images, which the renderer cannot load', () => {
    expect(
      decodeOmpTranscriptLine(
        message('user', [{ type: 'image', data: 'blob:sha256:abc', mimeType: 'image/webp' }]),
        'f'
      )
    ).toBeNull()
  })

  it('falls back to the supplied id when the record carries none', () => {
    const decoded = decodeOmpTranscriptLine(
      line({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }),
      'fallback-9'
    )
    expect(decoded?.id).toBe('fallback-9')
    expect(decoded?.timestamp).toBeNull()
  })
})
