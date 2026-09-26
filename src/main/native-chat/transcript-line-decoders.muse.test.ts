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
    payload_type: 'runtime.session',
    payload_schema_version: 1,
    ...extra
  })

const runEvent = (event: Record<string, unknown>): string =>
  envelope({ payload: { kind: 'run', run_id: 'run-1', event } })

describe('decodeMuseTranscriptLine', () => {
  it('skips malformed lines and non-conversation records', () => {
    expect(decodeMuseTranscriptLine('not json', 'f')).toBeNull()
    expect(decodeMuseTranscriptLine(line({ retained_marker: 'omitted_live_only' }), 'f')).toBeNull()
    expect(
      decodeMuseTranscriptLine(line({ retained_frame: 'session_permission_transaction' }), 'f')
    ).toBeNull()
    expect(decodeMuseTranscriptLine(runEvent({ kind: 'status', message: 'x' }), 'f')).toBeNull()
    expect(
      decodeMuseTranscriptLine(runEvent({ kind: 'model_completed', usage: {} }), 'f')
    ).toBeNull()
    expect(
      decodeMuseTranscriptLine(runEvent({ kind: 'reasoning_summary_committed', text: 't' }), 'f')
    ).toBeNull()
    expect(decodeMuseTranscriptLine(runEvent({ kind: 'a-kind-from-the-future' }), 'f')).toBeNull()
    expect(decodeMuseTranscriptLine(envelope({ payload: { kind: 'run' } }), 'f')).toBeNull()
  })

  it('decodes a user turn from refill blocks', () => {
    const decoded = decodeMuseTranscriptLine(
      envelope({
        payload_type: 'runtime.user_intent.accepted',
        payload: {
          intent_id: 'in-1',
          surface: 'main',
          refill_blocks: [{ kind: 'text', text: 'ship it' }]
        }
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

  it('falls back to model messages when refill blocks are missing', () => {
    const decoded = decodeMuseTranscriptLine(
      envelope({
        payload_type: 'runtime.user_intent.accepted',
        payload: { model_messages: [{ content: [{ kind: 'text', text: 'from model' }] }] }
      }),
      'f'
    )
    expect(decoded?.role).toBe('user')
    expect(decoded?.blocks).toEqual([{ type: 'text', text: 'from model' }])
  })

  it('decodes assistant text', () => {
    const decoded = decodeMuseTranscriptLine(
      runEvent({ kind: 'assistant_message_committed', text: 'Done.' }),
      'f'
    )
    expect(decoded?.role).toBe('assistant')
    expect(decoded?.blocks).toEqual([{ type: 'text', text: 'Done.' }])
    expect(decoded?.timestamp).toBe(RECORDED_AT_MS)
  })

  it('decodes tool calls with parsed args and call ids', () => {
    const decoded = decodeMuseTranscriptLine(
      runEvent({
        kind: 'assistant_tool_calls_committed',
        tool_calls: [
          { id: 'fc-1', call_id: 'call-1', name: 'bash', args: '{"command":"ls"}' },
          { name: 'read' }
        ]
      }),
      'f'
    )
    expect(decoded?.role).toBe('assistant')
    expect(decoded?.blocks).toEqual([
      { type: 'tool-call', name: 'bash', input: { command: 'ls' }, callId: 'call-1' },
      { type: 'tool-call', name: 'read', input: '' }
    ])
  })

  it('keeps unparseable tool args as the raw string', () => {
    const decoded = decodeMuseTranscriptLine(
      runEvent({
        kind: 'assistant_tool_calls_committed',
        tool_calls: [{ name: 'bash', args: '{oops' }]
      }),
      'f'
    )
    expect(decoded?.blocks).toEqual([{ type: 'tool-call', name: 'bash', input: '{oops' }])
  })

  it('decodes tool results as a tool turn without trimming output', () => {
    const decoded = decodeMuseTranscriptLine(
      runEvent({
        kind: 'tool_result_batch_committed',
        batch_id: 'b-1',
        results: [
          { tool_call_index: 0, tool_call_id: 'call-1', text: '  ok\n' },
          { tool_call_index: 1, tool_call_id: 'call-2', text: 'more' }
        ]
      }),
      'f'
    )
    expect(decoded?.role).toBe('tool')
    expect(decoded?.blocks).toEqual([
      { type: 'tool-result', output: '  ok\n' },
      { type: 'tool-result', output: 'more' }
    ])
  })

  it('renders a question card as an assistant turn and answers as the user reply', () => {
    const requested = decodeMuseTranscriptLine(
      runEvent({
        kind: 'user_input_prompt_requested',
        prompt_id: 'p-1',
        questions: [
          {
            id: 'q-1',
            header: 'Next',
            question: 'Which way?',
            options: [{ label: 'Left' }, { label: 'Right' }]
          }
        ]
      }),
      'f'
    )
    expect(requested?.role).toBe('assistant')
    expect(requested?.blocks).toEqual([{ type: 'text', text: 'Next: Which way?\n- Left\n- Right' }])
    const settled = decodeMuseTranscriptLine(
      runEvent({
        kind: 'user_input_prompt_settled',
        prompt_id: 'p-1',
        outcome: 'answered',
        answers: [{ id: 'q-1', selected_label: 'Left' }]
      }),
      'f'
    )
    expect(settled?.role).toBe('user')
    expect(settled?.blocks).toEqual([{ type: 'text', text: 'Left' }])
  })

  it('surfaces a cancelled terminal as the interrupted row', () => {
    const decoded = decodeMuseTranscriptLine(
      runEvent({ kind: 'terminal', terminal: 'cancelled', reason: 'ctrl-c' }),
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
