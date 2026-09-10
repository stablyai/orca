import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../shared/native-chat-types'
import { decodeOmpTranscriptLine as decodeOmpTranscriptLineRaw } from './transcript-line-decoders'

// Why: every test below except the two reasoning-split ones expects (and
// always has) a single decoded message — asserting that once here keeps
// every other test's existing `decoded?.foo` assertions unchanged instead of
// threading a narrowing check through each of them. The two split tests
// import `decodeOmpTranscriptLineRaw` directly and handle the array case.
function decodeOmpTranscriptLine(line: string, fallbackId: string): NativeChatMessage | null {
  const decoded = decodeOmpTranscriptLineRaw(line, fallbackId)
  if (Array.isArray(decoded)) {
    throw new Error('expected a single message; use decodeOmpTranscriptLineRaw for split cases')
  }
  return decoded
}

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
    const decoded = decodeOmpTranscriptLine(
      message('user', [{ type: 'text', text: 'resume' }]),
      'f'
    )
    expect(decoded).toEqual({
      id: 'rec-1',
      role: 'user',
      blocks: [{ type: 'text', text: 'resume' }],
      timestamp: Date.parse('2026-07-16T00:27:02.222Z'),
      source: 'transcript'
    })
  })

  it('splits thinking into a separate reasoning message ahead of a mixed assistant turn', () => {
    const decoded = decodeOmpTranscriptLineRaw(
      message('assistant', [
        { type: 'thinking', thinking: 'Checking the goal' },
        { type: 'text', text: 'Reading it now.' },
        { type: 'toolCall', id: 'call-1', name: 'goal', arguments: { op: 'get' } }
      ]),
      'f'
    )
    expect(Array.isArray(decoded)).toBe(true)
    const messages = decoded as Exclude<typeof decoded, null>[]
    expect(messages).toHaveLength(2)
    // Reasoning must precede the reply it belongs to, and carry a distinct id
    // so it never collides with (or double-renders alongside) the reply.
    expect(messages[0]).toEqual({
      id: 'rec-1:reasoning',
      role: 'reasoning',
      blocks: [{ type: 'text', text: 'Checking the goal' }],
      timestamp: expect.any(Number),
      source: 'transcript'
    })
    expect(messages[1]).toEqual({
      id: 'rec-1',
      role: 'assistant',
      blocks: [
        { type: 'text', text: 'Reading it now.' },
        { type: 'tool-call', name: 'goal', input: { op: 'get' }, toolCallId: 'call-1' }
      ],
      timestamp: expect.any(Number),
      source: 'transcript'
    })
  })

  it('keeps a thinking-only assistant turn on the reasoning role, not assistant', () => {
    const decoded = decodeOmpTranscriptLineRaw(
      message('assistant', [{ type: 'thinking', thinking: 'Weighing two options' }]),
      'f'
    )
    // No non-reasoning content on this turn, so the decoder must return the
    // single reasoning message directly rather than a one-element array.
    if (decoded === null || Array.isArray(decoded)) {
      throw new Error('expected a single reasoning message')
    }
    expect(decoded.id).toBe('rec-1:reasoning')
    expect(decoded.role).toBe('reasoning')
    expect(decoded.blocks).toEqual([{ type: 'text', text: 'Weighing two options' }])
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
    expect(decoded?.blocks).toEqual([{ type: 'tool-result', output: 'ok', toolCallId: 'call-1' }])
  })

  it('flags an errored tool result', () => {
    const decoded = decodeOmpTranscriptLine(
      message('toolResult', [{ type: 'text', text: 'boom' }], {
        toolCallId: 'call-2',
        isError: true
      }),
      'f'
    )
    expect(decoded?.blocks[0]).toEqual({
      type: 'tool-result',
      output: 'boom',
      isError: true,
      toolCallId: 'call-2'
    })
  })

  it('surfaces a displayed custom_message, and hides a state-only one', () => {
    const custom = (display: boolean): string =>
      line({
        type: 'custom_message',
        id: 'rec-c',
        customType: 'rewind-report',
        display,
        content: [{ type: 'text', text: 'Investigation summary' }],
        timestamp: '2026-07-16T00:27:02.222Z'
      })
    expect(decodeOmpTranscriptLine(custom(true), 'f')).toEqual({
      id: 'rec-c',
      role: 'system',
      blocks: [{ type: 'text', text: 'Investigation summary' }],
      timestamp: Date.parse('2026-07-16T00:27:02.222Z'),
      source: 'transcript'
    })
    expect(decodeOmpTranscriptLine(custom(false), 'f')).toBeNull()
  })

  it('accepts string content on a custom_message', () => {
    const decoded = decodeOmpTranscriptLine(
      line({ type: 'custom_message', id: 'rec-s', display: true, content: 'peer said hi' }),
      'f'
    )
    expect(decoded?.blocks).toEqual([{ type: 'text', text: 'peer said hi' }])
  })

  it('renders an advisor card as an attributed advisor row, not raw advisory XML', () => {
    const decoded = decodeOmpTranscriptLine(
      line({
        type: 'custom_message',
        id: 'rec-adv',
        customType: 'advisor',
        display: true,
        attribution: 'agent',
        timestamp: '2026-07-16T00:27:02.222Z',
        content:
          '<advisory advisor="Architecture" severity="concern" guidance="weigh, don\'t blindly obey">\nWatch the coupling.\n</advisory>',
        details: {
          notes: [{ note: 'Watch the coupling.', severity: 'concern', advisor: 'Architecture' }]
        }
      }),
      'f'
    )
    expect(decoded).toEqual({
      id: 'rec-adv',
      role: 'system',
      blocks: [
        {
          type: 'text',
          text: '\u203b advisor \u00b7 Architecture \u00b7 concern\nWatch the coupling.'
        }
      ],
      timestamp: Date.parse('2026-07-16T00:27:02.222Z'),
      source: 'transcript',
      turnId: `omp-advisor:${Date.parse('2026-07-16T00:27:02.222Z')}:Architecture/concern/Watch the coupling.`
    })
  })

  it('decodes an advisor card that carries only the advisory XML', () => {
    const decoded = decodeOmpTranscriptLine(
      line({
        type: 'custom_message',
        id: 'rec-adv2',
        customType: 'advisor',
        display: true,
        content: '<advisory severity="nit" guidance="x">\nTrim the dead import.\n</advisory>'
      }),
      'f'
    )
    expect(decoded?.blocks).toEqual([
      { type: 'text', text: '\u203b advisor \u00b7 nit\nTrim the dead import.' }
    ])
    expect(decoded?.turnId).toBe('omp-advisor::/nit/Trim the dead import.')
  })

  it('hides a state-only advisor card exactly like any other custom_message', () => {
    expect(
      decodeOmpTranscriptLine(
        line({
          type: 'custom_message',
          id: 'rec-adv3',
          customType: 'advisor',
          display: false,
          details: { notes: [{ note: 'hidden' }] }
        }),
        'f'
      )
    ).toBeNull()
  })

  // The hydrated `get_messages_page` path re-wraps a bare AgentMessage as
  // `type:'message'`, so an advisor card reaches the decoder through this
  // branch and must resolve to the same turn identity as its on-disk twin.
  it('gives a bare-AgentMessage advisor card the same turn identity as the persisted row', () => {
    // SessionManager.appendCustomMessageEntry stamps the entry with the
    // CustomMessage's OWN timestamp, so the persisted envelope clock and the
    // bare message clock are the same instant in two encodings.
    const persisted = decodeOmpTranscriptLine(
      line({
        type: 'custom_message',
        id: 'rec-adv4',
        customType: 'advisor',
        display: true,
        timestamp: '2026-07-16T00:27:02.222Z',
        details: { notes: [{ note: 'Stay silent.', severity: 'nit' }] }
      }),
      'f'
    )
    const hydrated = decodeOmpTranscriptLine(
      line({
        type: 'message',
        id: 'hist-4',
        timestamp: Date.parse('2026-07-16T00:27:02.222Z'),
        message: {
          role: 'custom',
          customType: 'advisor',
          display: true,
          timestamp: Date.parse('2026-07-16T00:27:02.222Z'),
          content: '<advisory severity="nit" guidance="x">\nStay silent.\n</advisory>'
        }
      }),
      'f'
    )
    expect(hydrated?.turnId).toBe(persisted?.turnId)
    expect(hydrated?.blocks).toEqual(persisted?.blocks)
  })

  // Advisor cards carry no id, so two runs of identical advice would collide
  // on a content-only identity and the newer card would be suppressed by the
  // older card's transcript row.
  it('separates two identical advisor cards persisted at different instants', () => {
    const advisorRow = (id: string, timestamp: string): string =>
      line({
        type: 'custom_message',
        id,
        customType: 'advisor',
        display: true,
        timestamp,
        details: { notes: [{ note: 'Stay silent.', severity: 'nit' }] }
      })
    const first = decodeOmpTranscriptLine(advisorRow('rec-adv5', '2026-07-16T00:27:02.222Z'), 'f')
    const second = decodeOmpTranscriptLine(advisorRow('rec-adv6', '2026-07-16T01:02:03.000Z'), 'f')
    expect(first?.turnId).not.toBe(second?.turnId)
  })

  it('renders a bash execution cell as a tool turn', () => {
    const decoded = decodeOmpTranscriptLine(
      line({
        type: 'message',
        id: 'rec-b',
        timestamp: '2026-07-16T00:27:02.222Z',
        message: { role: 'bashExecution', command: 'ls -a', output: '.git\n', exitCode: 0 }
      }),
      'f'
    )
    expect(decoded?.role).toBe('tool')
    expect(decoded?.blocks).toEqual([
      { type: 'tool-call', name: 'bash', input: 'ls -a' },
      { type: 'tool-result', output: '.git\n' }
    ])
  })

  it('flags a nonzero exit code and reads python cells from `code`', () => {
    const decoded = decodeOmpTranscriptLine(
      line({
        type: 'message',
        id: 'rec-p',
        message: {
          role: 'pythonExecution',
          code: 'raise SystemExit(2)',
          output: 'boom',
          exitCode: 2
        }
      }),
      'f'
    )
    expect(decoded?.blocks).toEqual([
      { type: 'tool-call', name: 'python', input: 'raise SystemExit(2)' },
      { type: 'tool-result', output: 'boom', isError: true }
    ])
  })

  // Why: omp's cancel and timeout paths both return `exitCode: undefined`, which
  // JSON.stringify omits — so the record has no exitCode at all and only
  // `cancelled` distinguishes it from a clean run.
  it('marks a cancelled run, which carries no exitCode at all', () => {
    const decoded = decodeOmpTranscriptLine(
      line({
        type: 'message',
        id: 'rec-c1',
        message: { role: 'bashExecution', command: 'sleep 99', output: 'partial', cancelled: true }
      }),
      'f'
    )
    expect(decoded?.blocks[1]).toEqual({ type: 'tool-result', output: 'partial', isError: true })
  })

  it('lists file mention paths without dumping their auto-read contents', () => {
    const decoded = decodeOmpTranscriptLine(
      line({
        type: 'message',
        id: 'rec-f',
        message: {
          role: 'fileMention',
          files: [
            { path: 'src/a.ts', content: 'SECRET FILE BODY' },
            { path: 'src/b.ts' },
            { image: true }
          ]
        }
      }),
      'f'
    )
    expect(decoded?.role).toBe('system')
    expect(decoded?.blocks).toEqual([{ type: 'text', text: '@src/a.ts\n@src/b.ts' }])
    expect(JSON.stringify(decoded)).not.toContain('SECRET FILE BODY')
  })

  // Why: pre-v3 sessions stored extension turns as `type:'message'` with role
  // custom/hookMessage; the display flag gates them exactly as custom_message.
  it('honors the display gate on legacy custom / hookMessage message rows', () => {
    const legacy = (role: string, display: boolean): string =>
      line({
        type: 'message',
        id: 'rec-l',
        message: { role, customType: 'irc:incoming', display, content: 'peer note' }
      })
    expect(decodeOmpTranscriptLine(legacy('custom', false), 'f')).toBeNull()
    expect(decodeOmpTranscriptLine(legacy('hookMessage', false), 'f')).toBeNull()
    expect(decodeOmpTranscriptLine(legacy('custom', true), 'f')).toMatchObject({
      role: 'system',
      blocks: [{ type: 'text', text: 'peer note' }]
    })
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

  it('surfaces an aborted turn as the interrupted row, not silence', () => {
    // Why: omp stamps `stopReason: 'aborted'` on the assistant message itself and
    // leaves the content empty when nothing streamed, so the turn used to decode
    // to null and vanish. Claude and Codex both emit this row for their aborts.
    const decoded = decodeOmpTranscriptLine(
      message('assistant', [{ type: 'text', text: '' }], {
        stopReason: 'aborted',
        errorMessage: 'Stopped before model call'
      }),
      'f'
    )
    expect(decoded?.role).toBe('system')
    expect(decoded?.blocks).toEqual([{ type: 'text', text: 'Conversation interrupted' }])
  })

  it('keeps partial content when a turn aborted mid-stream', () => {
    // omp spreads the in-flight message and stamps the abort on it, so a partial
    // answer is real conversation and must not be replaced by the status row.
    const decoded = decodeOmpTranscriptLine(
      message('assistant', [{ type: 'text', text: 'Partial answer' }], { stopReason: 'aborted' }),
      'f'
    )
    expect(decoded?.role).toBe('assistant')
    expect(decoded?.blocks).toEqual([{ type: 'text', text: 'Partial answer' }])
  })

  it('still drops an empty non-aborted assistant turn', () => {
    expect(
      decodeOmpTranscriptLine(message('assistant', [{ type: 'text', text: '' }]), 'f')
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
