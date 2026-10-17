import { describe, expect, it } from 'vitest'
import { decodeClaudeTranscriptLine } from './transcript-line-decoders-claude'

// Shape captured from Claude Code 2.1.292 for a prompt absorbed mid-turn.
function queuedCommand(attachment: Record<string, unknown>): string {
  return JSON.stringify({
    parentUuid: 'tool-result-row',
    isSidechain: false,
    attachment: {
      type: 'queued_command',
      source_uuid: 'cmd-1',
      delivery_id: 'delivery-1',
      timestamp: '2026-10-06T21:49:54.910Z',
      ...attachment
    },
    type: 'attachment',
    uuid: 'queued-row',
    timestamp: '2026-10-06T21:49:54.910Z',
    rendered: [{ content: '<system-reminder>\nThe user sent a new message…</system-reminder>' }]
  })
}

describe('Claude queued_command attachment', () => {
  it('decodes a prompt absorbed mid-turn as the user row Claude never writes', () => {
    const line = queuedCommand({
      prompt: 'or you know what, use fable as orchestrator',
      commandMode: 'prompt',
      origin: { kind: 'human' },
      humanTurn: true
    })
    expect(decodeClaudeTranscriptLine(line, 'fallback')).toEqual({
      id: 'queued-row',
      role: 'user',
      blocks: [{ type: 'text', text: 'or you know what, use fable as orchestrator' }],
      timestamp: Date.parse('2026-10-06T21:49:54.910Z'),
      source: 'transcript',
      parentId: 'tool-result-row'
    })
  })

  it('decodes legacy entries without an origin and content-block prompts', () => {
    const decoded = decodeClaudeTranscriptLine(
      queuedCommand({
        prompt: [{ type: 'text', text: 'is this true?' }],
        commandMode: 'prompt'
      }),
      'fallback'
    )
    expect(decoded?.role).toBe('user')
    expect(decoded?.blocks).toEqual([{ type: 'text', text: 'is this true?' }])
  })

  it.each([
    { prompt: '<task-notification>done</task-notification>', commandMode: 'task-notification' },
    {
      prompt: '<task-notification>done</task-notification>',
      commandMode: 'task-notification',
      origin: { kind: 'task-notification' }
    },
    { prompt: 'from another agent', commandMode: 'prompt', origin: { kind: 'peer' } },
    { commandMode: 'prompt', origin: { kind: 'human' } }
  ])('drops queue entries the user did not type (%o)', (attachment) => {
    expect(decodeClaudeTranscriptLine(queuedCommand(attachment), 'fallback')).toBeNull()
  })

  it('still drops other attachment records', () => {
    const line = JSON.stringify({
      type: 'attachment',
      uuid: 'a',
      attachment: { type: 'edited_text_file', filename: 'x.ts' }
    })
    expect(decodeClaudeTranscriptLine(line, 'fallback')).toBeNull()
  })
})

describe('Claude `!` shell command row', () => {
  it('decodes as the line the user typed so its echo can match', () => {
    const line = JSON.stringify({
      type: 'user',
      uuid: 'bash-row',
      timestamp: '2026-10-06T10:00:00.000Z',
      message: { role: 'user', content: '<bash-input> gcloud auth login</bash-input>' }
    })
    expect(decodeClaudeTranscriptLine(line, 'fallback')?.blocks).toEqual([
      { type: 'text', text: '! gcloud auth login' }
    ])
  })
})
