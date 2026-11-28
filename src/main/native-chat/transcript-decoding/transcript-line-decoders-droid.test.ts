import { describe, expect, it } from 'vitest'
import { decodeDroidTranscriptLine } from './transcript-line-decoders-droid'

// Record shapes from a droid 1.21.1 session file.
const LINES = [
  { type: 'session_start', id: 's1', cwd: '/w', title: 'hi' },
  {
    type: 'message',
    id: 'hook-1',
    message: { role: 'user', content: [], visibility: 'user_only', hookEventName: 'SessionStart' }
  },
  {
    type: 'message',
    id: 'notice-1',
    message: {
      role: 'user',
      content: [{ type: 'text', text: 'No active subscription found.' }],
      visibility: 'user_only',
      systemNotice: true
    }
  },
  {
    type: 'message',
    id: 'context-u1',
    message: {
      role: 'user',
      content: [{ type: 'text', text: '<system-reminder>tools</system-reminder>' }],
      visibility: 'llm_only'
    }
  },
  {
    type: 'message',
    id: 'u1',
    timestamp: '2026-11-26T22:31:00.000Z',
    message: { role: 'user', content: [{ type: 'text', text: 'show the folder' }] }
  },
  {
    type: 'message',
    id: 'a1',
    message: {
      role: 'assistant',
      modelId: 'claude-sonnet-5-5',
      content: [
        { type: 'thinking', thinking: 'I should run pwd' },
        { type: 'text', text: 'Let me check.' },
        { type: 'tool_use', id: 'c1', name: 'Execute', input: { command: 'pwd' } }
      ]
    }
  },
  {
    type: 'message',
    id: 'r1',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'c1',
          is_error: false,
          content: '/w\n\n\n[Process exited with code 0]'
        }
      ]
    }
  },
  { type: 'agent_turn_outcome', turnId: 'u1', reason: 'completed' }
].map((record) => JSON.stringify(record))

describe('decodeDroidTranscriptLine', () => {
  it('keeps the conversation and drops what Droid hides from the person', () => {
    const decoded = LINES.map(decodeDroidTranscriptLine).filter((entry) => entry !== null)
    expect(decoded).toEqual([
      {
        recordId: 'u1',
        message: {
          id: 'u1',
          role: 'user',
          blocks: [{ type: 'text', text: 'show the folder' }],
          timestamp: Date.parse('2026-11-26T22:31:00.000Z'),
          source: 'transcript'
        }
      },
      {
        recordId: 'a1',
        message: {
          id: 'a1',
          role: 'assistant',
          blocks: [
            { type: 'text', text: 'Let me check.' },
            { type: 'tool-call', name: 'Execute', input: { command: 'pwd' }, callId: 'c1' }
          ],
          timestamp: null,
          source: 'transcript',
          model: 'claude-sonnet-5-5'
        }
      },
      {
        recordId: 'r1',
        message: {
          id: 'r1',
          role: 'tool',
          blocks: [{ type: 'tool-result', output: '/w', callId: 'c1' }],
          timestamp: null,
          source: 'transcript'
        }
      }
    ])
  })
})
