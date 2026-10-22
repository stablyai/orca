import { describe, expect, it } from 'vitest'
import { NATIVE_CHAT_INTERRUPTED_STATUS_TEXT } from '../../shared/native-chat-types'
import { decodeMuseTranscriptLine } from './transcript-line-decoders'

const line = (record: unknown): string => JSON.stringify(record)

// Why: `recorded_at` is microseconds; 1790357073429109 -> 1790357073429 ms.
const RECORDED_AT = 1790357073429109
const RECORDED_AT_MS = 1790357073429

const envelope = (extra: Record<string, unknown>): string =>
  line({
    schema_version: 1,
    id: 'rec-1',
    stream: { kind: 'session', id: 'sess-1' },
    sequence: 40,
    recorded_at: RECORDED_AT,
    record_type: 'event',
    ...extra
  })

const runEvent = (event: Record<string, unknown>): string =>
  envelope({ payload_type: 'runtime.session', payload: { event } })

describe('decodeMuseTranscriptLine', () => {
  it('skips malformed lines and engine bookkeeping', () => {
    expect(decodeMuseTranscriptLine('not json', 'f')).toBeNull()
    expect(decodeMuseTranscriptLine(line({}), 'f')).toBeNull()
    // Retention envelopes carry permission records, never conversation.
    expect(
      decodeMuseTranscriptLine(
        line({ retained_frame: 'session_permission_transaction', children: [] }),
        'f'
      )
    ).toBeNull()
    // Task lifecycle, reasoning, usage, and reminder events are not turns.
    expect(decodeMuseTranscriptLine(runEvent({ kind: 'status' }), 'f')).toBeNull()
    expect(decodeMuseTranscriptLine(runEvent({ kind: 'reasoning_committed' }), 'f')).toBeNull()
    expect(decodeMuseTranscriptLine(runEvent({ kind: 'model_completed' }), 'f')).toBeNull()
    expect(
      decodeMuseTranscriptLine(envelope({ payload_type: 'run.model.configured', payload: {} }), 'f')
    ).toBeNull()
    // A detached task failure names only the task; without a tool link the
    // stateless decoder cannot attribute it, so it skips.
    expect(decodeMuseTranscriptLine(runEvent({ kind: 'failed' }), 'f')).toBeNull()
  })

  it('decodes a user turn from refill blocks', () => {
    const decoded = decodeMuseTranscriptLine(
      envelope({
        payload_type: 'runtime.user_intent.accepted',
        payload: { refill_blocks: [{ kind: 'text', text: 'ship it' }] }
      }),
      'f'
    )
    expect(decoded).toEqual({
      id: 'rec-1',
      role: 'user',
      blocks: [{ type: 'text', text: 'ship it' }],
      timestamp: RECORDED_AT_MS,
      source: 'transcript'
    })
  })

  it('falls back to model_messages content for a user turn', () => {
    const decoded = decodeMuseTranscriptLine(
      envelope({
        payload_type: 'runtime.user_intent.accepted',
        payload: { model_messages: [{ content: [{ text: 'via model messages' }] }] }
      }),
      'f'
    )
    expect(decoded?.role).toBe('user')
    expect(decoded?.blocks).toEqual([{ type: 'text', text: 'via model messages' }])
  })

  it('decodes an assistant message', () => {
    const decoded = decodeMuseTranscriptLine(
      runEvent({ kind: 'assistant_message_committed', text: 'done' }),
      'f'
    )
    expect(decoded).toEqual({
      id: 'rec-1',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'done' }],
      timestamp: RECORDED_AT_MS,
      source: 'transcript'
    })
  })

  it('decodes tool calls with parsed args and call ids', () => {
    const decoded = decodeMuseTranscriptLine(
      runEvent({
        kind: 'assistant_tool_calls_committed',
        tool_calls: [
          { name: 'bash', args: '{"command":"ls"}', call_id: 'call-1' },
          { name: 'read', args: 'not json', call_id: 'call-2' }
        ]
      }),
      'f'
    )
    expect(decoded?.role).toBe('assistant')
    expect(decoded?.blocks).toEqual([
      { type: 'tool-call', name: 'bash', input: { command: 'ls' }, callId: 'call-1' },
      { type: 'tool-call', name: 'read', input: 'not json', callId: 'call-2' }
    ])
  })

  it('decodes a tool result batch keeping output raw', () => {
    const decoded = decodeMuseTranscriptLine(
      runEvent({
        kind: 'tool_result_batch_committed',
        results: [{ text: '  ok\n', tool_call_id: 'call-1' }]
      }),
      'f'
    )
    expect(decoded?.role).toBe('tool')
    expect(decoded?.blocks).toEqual([{ type: 'tool-result', output: '  ok\n', callId: 'call-1' }])
  })

  it('renders a question prompt as an assistant card', () => {
    const decoded = decodeMuseTranscriptLine(
      runEvent({
        kind: 'user_input_prompt_requested',
        questions: [
          {
            header: 'Color',
            question: 'Pick one',
            options: [{ label: 'Blue' }, { label: 'Green' }]
          }
        ]
      }),
      'f'
    )
    expect(decoded?.role).toBe('assistant')
    expect(decoded?.blocks).toEqual([{ type: 'text', text: 'Color: Pick one\n- Blue\n- Green' }])
  })

  it('renders settled answers as the user reply', () => {
    const decoded = decodeMuseTranscriptLine(
      runEvent({
        kind: 'user_input_prompt_settled',
        answers: [{ id: 'color', selected_label: 'Blue' }]
      }),
      'f'
    )
    expect(decoded?.role).toBe('user')
    expect(decoded?.blocks).toEqual([{ type: 'text', text: 'Blue' }])
  })

  it('surfaces a cancelled terminal as the interrupted row', () => {
    const decoded = decodeMuseTranscriptLine(
      runEvent({ kind: 'terminal', terminal: 'cancelled' }),
      'f'
    )
    expect(decoded?.role).toBe('system')
    expect(decoded?.blocks).toEqual([{ type: 'text', text: NATIVE_CHAT_INTERRUPTED_STATUS_TEXT }])
    expect(
      decodeMuseTranscriptLine(runEvent({ kind: 'terminal', terminal: 'completed' }), 'f')
    ).toBeNull()
  })

  it('uses the fallback id when the record carries none', () => {
    const decoded = decodeMuseTranscriptLine(
      line({
        recorded_at: RECORDED_AT,
        payload_type: 'runtime.session',
        payload: { event: { kind: 'assistant_message_committed', text: 'hi' } }
      }),
      'fallback-7'
    )
    expect(decoded?.id).toBe('fallback-7')
  })
})
