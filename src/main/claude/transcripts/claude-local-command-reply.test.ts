import { describe, expect, it } from 'vitest'
import { claudeTranscriptRowFrame } from './claude-local-command-reply'
import { claudeTranscriptItemKeys } from './claude-transcript-item-reader'

const recapRow = {
  type: 'system',
  subtype: 'local_command',
  // The terminal UI saves styled output.
  content: '<local-command-stdout>\u001b[1mSession recap text\u001b[22m</local-command-stdout>',
  uuid: 'lc-uuid',
  sessionId: 'provider-session',
  timestamp: '2026-11-18T19:33:20.953Z',
  commandRun: { command: 'recap', args: '' }
}

describe('claudeTranscriptRowFrame', () => {
  it('replays a local command row in its live synthetic-assistant shape', () => {
    expect(claudeTranscriptRowFrame(recapRow)).toMatchObject({
      type: 'assistant',
      uuid: 'lc-uuid',
      session_id: 'provider-session',
      parent_tool_use_id: null,
      message: {
        role: 'assistant',
        model: '<synthetic>',
        content: [{ type: 'text', text: 'Session recap text' }]
      }
    })
  })

  it.each([
    {
      name: 'the command echo row',
      row: { ...recapRow, content: '<command-name>/recap</command-name>' }
    },
    {
      name: 'a command with empty stdout, like /clear',
      row: {
        ...recapRow,
        commandRun: { command: 'clear', args: '' },
        content: '<local-command-stdout></local-command-stdout>'
      }
    },
    {
      name: 'effect-only feedback, like /model',
      row: {
        ...recapRow,
        commandRun: { command: 'model', args: '' },
        content: '<local-command-stdout>Kept model as Opus</local-command-stdout>'
      }
    }
  ])('passes $name through unchanged', ({ row }) => {
    expect(claudeTranscriptRowFrame(row)).toEqual({
      ...row,
      session_id: row.sessionId,
      parent_tool_use_id: null
    })
  })

  it('keys the reply by its uuid so catch-up revises the live item', () => {
    expect(claudeTranscriptItemKeys(recapRow, 'provider-session')).toEqual([
      'claude:provider-session:lc-uuid'
    ])
  })
})
