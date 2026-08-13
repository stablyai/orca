import { describe, expect, it } from 'vitest'
import { NATIVE_CHAT_INTERRUPTED_STATUS_TEXT } from '../../shared/native-chat-types'
import { decodeDroidTranscriptLine } from './transcript-line-decoders'

const line = (record: unknown): string => JSON.stringify(record)

const message = (role: string, content: unknown, extra: Record<string, unknown> = {}): string =>
  line({
    type: 'message',
    id: 'rec-1',
    parentId: 'rec-0',
    timestamp: '2026-07-16T00:27:02.222Z',
    message: { role, content, ...extra }
  })

describe('decodeDroidTranscriptLine', () => {
  it('skips malformed lines, bookkeeping records, and unknown types', () => {
    expect(decodeDroidTranscriptLine('not json', 'f')).toBeNull()
    expect(decodeDroidTranscriptLine(line({ type: 'session_start', id: 'a' }), 'f')).toBeNull()
    expect(decodeDroidTranscriptLine(line({ type: 'session_end', id: 'a' }), 'f')).toBeNull()
    expect(decodeDroidTranscriptLine(line({ type: 'todo_state', todos: [] }), 'f')).toBeNull()
    expect(decodeDroidTranscriptLine(line({ type: 'compaction_state' }), 'f')).toBeNull()
    expect(
      decodeDroidTranscriptLine(line({ type: 'agent_turn_outcome', turnId: 't' }), 'f')
    ).toBeNull()
    expect(decodeDroidTranscriptLine(line({ type: 'a-type-from-the-future' }), 'f')).toBeNull()
    expect(decodeDroidTranscriptLine(line({ type: 'message' }), 'f')).toBeNull()
  })

  it('decodes a user turn', () => {
    expect(
      decodeDroidTranscriptLine(message('user', [{ type: 'text', text: 'ship it' }]), 'f')
    ).toEqual({
      id: 'rec-1',
      role: 'user',
      blocks: [{ type: 'text', text: 'ship it' }],
      timestamp: Date.parse('2026-07-16T00:27:02.222Z'),
      source: 'transcript'
    })
  })

  it('falls back to the offset id and a null timestamp when the record omits them', () => {
    const decoded = decodeDroidTranscriptLine(
      line({ type: 'message', message: { role: 'user', content: 'hi' } }),
      'fallback-id'
    )
    expect(decoded).toEqual({
      id: 'fallback-id',
      role: 'user',
      blocks: [{ type: 'text', text: 'hi' }],
      timestamp: null,
      source: 'transcript'
    })
  })

  it('keeps thinking, prose, and tool calls together on a mixed assistant turn', () => {
    const decoded = decodeDroidTranscriptLine(
      message('assistant', [
        { type: 'thinking', thinking: 'Weighing two options', signature: 'sig' },
        { type: 'text', text: 'Reading it now.' },
        { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/a' } }
      ]),
      'f'
    )
    expect(decoded?.role).toBe('assistant')
    expect(decoded?.blocks).toEqual([
      { type: 'text', text: 'Weighing two options' },
      { type: 'text', text: 'Reading it now.' },
      { type: 'tool-call', name: 'Read', input: { file_path: '/a' } }
    ])
  })

  it('attributes a tool-result-only user row to the tool, not the user', () => {
    const decoded = decodeDroidTranscriptLine(
      message('user', [
        { type: 'tool_result', tool_use_id: 'toolu_1', content: 'File created successfully' }
      ]),
      'f'
    )
    expect(decoded?.role).toBe('tool')
    expect(decoded?.blocks).toEqual([{ type: 'tool-result', output: 'File created successfully' }])
  })

  it('marks a failed tool result as an error', () => {
    const decoded = decodeDroidTranscriptLine(
      message('user', [{ type: 'tool_result', content: 'boom', is_error: true }]),
      'f'
    )
    expect(decoded?.blocks).toEqual([{ type: 'tool-result', output: 'boom', isError: true }])
  })

  // Droid appends injected context as extra text blocks inside the user's own
  // turn, unlike Claude which writes them as separate rows the noise filter drops.
  it('strips injected context blocks but keeps the prompt the user typed', () => {
    const decoded = decodeDroidTranscriptLine(
      message('user', [
        { type: 'text', text: '<system-reminder>\n\nUser system info…\n</system-reminder>' },
        { type: 'text', text: 'please read the skill' },
        { type: 'text', text: '<system-reminder>\nUser tagged file: /a\n</system-reminder>' }
      ]),
      'f'
    )
    expect(decoded?.role).toBe('user')
    expect(decoded?.blocks).toEqual([{ type: 'text', text: 'please read the skill' }])
  })

  it('drops a user row that is only injected context', () => {
    expect(
      decodeDroidTranscriptLine(
        message('user', [
          { type: 'text', text: '<system-reminder>only context</system-reminder>' }
        ]),
        'f'
      )
    ).toBeNull()
  })

  it('drops llm_only rows and hook bookkeeping rows', () => {
    expect(
      decodeDroidTranscriptLine(
        message('user', [{ type: 'text', text: 'file changed on disk' }], {
          visibility: 'llm_only'
        }),
        'f'
      )
    ).toBeNull()
    expect(
      decodeDroidTranscriptLine(
        message('user', [{ type: 'text', text: 'Hook execution: PreToolUse' }], {
          visibility: 'user_only',
          hookEventName: 'PreToolUse'
        }),
        'f'
      )
    ).toBeNull()
  })

  it('keeps a cancelled tool result from a user_only row but drops its prose', () => {
    const decoded = decodeDroidTranscriptLine(
      message(
        'user',
        [
          { type: 'text', text: 'Tool call cancelled by user' },
          { type: 'tool_result', tool_use_id: 'toolu_1', content: 'cancelled' }
        ],
        { visibility: 'user_only' }
      ),
      'f'
    )
    expect(decoded?.role).toBe('tool')
    expect(decoded?.blocks).toEqual([{ type: 'tool-result', output: 'cancelled' }])
  })

  it('renders an abort notice as the interrupted conversation marker', () => {
    for (const text of ['Error: Request was aborted.', 'Request cancelled by user']) {
      const decoded = decodeDroidTranscriptLine(
        message('user', [{ type: 'text', text }], { visibility: 'both' }),
        'f'
      )
      expect(decoded).toEqual({
        id: 'rec-1',
        role: 'system',
        blocks: [{ type: 'text', text: NATIVE_CHAT_INTERRUPTED_STATUS_TEXT }],
        timestamp: Date.parse('2026-07-16T00:27:02.222Z'),
        source: 'transcript'
      })
    }
  })

  it('keeps a `both` row that is not an abort notice as conversation', () => {
    const decoded = decodeDroidTranscriptLine(
      message('user', [{ type: 'text', text: 'Switched model to claude-opus-5' }], {
        visibility: 'both'
      }),
      'f'
    )
    expect(decoded?.role).toBe('user')
    expect(decoded?.blocks).toEqual([{ type: 'text', text: 'Switched model to claude-opus-5' }])
  })

  // Droid inlines images as base64 with no path or URL, so there is nothing the
  // renderer can point at — the row must not become an empty bubble.
  it('drops an inline base64 image with no other content', () => {
    expect(
      decodeDroidTranscriptLine(
        message('user', [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }
        ]),
        'f'
      )
    ).toBeNull()
  })
})
