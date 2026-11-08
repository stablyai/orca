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
})
