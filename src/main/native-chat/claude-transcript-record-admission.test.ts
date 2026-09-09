import { describe, expect, it } from 'vitest'
import { decodeClaudeTranscriptLine } from './transcript-line-decoders-claude'

const decode = (record: unknown) => decodeClaudeTranscriptLine(JSON.stringify(record), 'fallback')
const queued = (attachment: unknown) => ({ type: 'attachment', uuid: 'q1', attachment })

describe('Claude semantic record admission', () => {
  it('admits the persisted queued prompt with its provider identity and enqueue timestamp', () => {
    expect(
      decode({
        ...queued({ type: 'queued_command', commandMode: 'prompt', prompt: 'check the config' }),
        timestamp: '2026-06-01T10:00:02.000Z'
      })
    ).toEqual({
      id: 'q1',
      role: 'user',
      blocks: [{ type: 'text', text: 'check the config' }],
      timestamp: Date.parse('2026-06-01T10:00:02.000Z'),
      source: 'transcript'
    })
  })

  it.each([
    null,
    {},
    { type: 'queued_command', prompt: 'missing mode' },
    { type: 'queued_command', commandMode: 'task-notification', prompt: '<task-notification />' },
    { type: 'queued_command', commandMode: 'prompt', prompt: '  ' },
    { type: 'queued_command', commandMode: 'prompt', prompt: { text: 'not a prompt' } },
    { type: 'other', commandMode: 'prompt', prompt: 'other attachment' }
  ])('does not impersonate a human for a non-prompt attachment: %j', (attachment) => {
    expect(decode(queued(attachment))).toBeNull()
  })

  it('admits informational login copy as a notice, never assistant speech', () => {
    const text =
      'Remote Control disconnected — Please run `/login` in Claude Code to enroll this device.'
    expect(
      decode({ type: 'system', subtype: 'informational', uuid: 'notice', content: text })
    ).toEqual({
      id: 'notice',
      role: 'system',
      blocks: [{ type: 'text', text, tone: 'notice' }],
      timestamp: null,
      source: 'transcript'
    })
  })

  it.each(['warning', 'error'])('preserves provider %s severity', (level) => {
    expect(decode({ type: 'system', level, message: 'Check your account' })?.blocks).toEqual([
      { type: 'text', text: 'Check your account', tone: level }
    ])
  })

  it.each([
    { content: [{ type: 'text', text: 'Future notice' }] },
    { message: { content: [{ type: 'text', text: 'Future notice' }] } },
    { message: { text: 'Future notice' } },
    { text: 'Future notice' }
  ])('keeps extractable copy on an unknown subtype: %j', (copy) => {
    expect(decode({ type: 'system', subtype: 'future_notice', ...copy })?.blocks).toEqual([
      { type: 'text', text: 'Future notice', tone: 'notice' }
    ])
  })

  it.each([
    'stop_hook_summary',
    'turn_duration',
    'away_summary',
    'local_command',
    'hook_callback',
    'init',
    'compact_boundary'
  ])('keeps %s bookkeeping out of the conversation', (subtype) => {
    expect(decode({ type: 'system', subtype, content: 'Bookkeeping copy' })).toBeNull()
  })

  it('never dumps unknown payloads or turns tool payloads into system prose', () => {
    expect(
      decode({ type: 'system', subtype: 'future', payload: { opaque: 'not display copy' } })
    ).toBeNull()
    expect(
      decode({ type: 'system', content: [{ type: 'tool_result', content: 'not a notice' }] })
    ).toBeNull()
    expect(decode({ type: 'telemetry', message: 'not display copy' })).toBeNull()
  })

  it('preserves synthetic tool results and interruption ownership', () => {
    expect(
      decode({
        type: 'user',
        isSynthetic: true,
        message: {
          content: [
            { type: 'text', text: 'Injected context' },
            { type: 'tool_result', content: 'Actual output' }
          ]
        }
      })
    ).toMatchObject({ role: 'tool', blocks: [{ type: 'tool-result', output: 'Actual output' }] })
    expect(
      decode({ type: 'user', interruptedMessageId: 'a1', message: { content: 'boilerplate' } })
    ).toMatchObject({
      role: 'system',
      blocks: [{ type: 'text', text: 'Conversation interrupted' }]
    })
  })
})
