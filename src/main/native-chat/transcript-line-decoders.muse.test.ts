import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../shared/native-chat/native-chat-types'
import { decodeMuseTranscriptLine } from './transcript-line-decoders'

// Muse Code 1.4.14 TUI session: approved bash, request_user_input, denied bash, Esc interrupt.
// Reasoning ciphertext redacted and the workspace path scrubbed; everything else is verbatim.
const FIXTURE_LINES = readFileSync(
  join(__dirname, '__fixtures__', 'muse-1.4.14-session.jsonl'),
  'utf8'
)
  .split('\n')
  .filter((line) => line.trim() !== '')

function summary(message: NativeChatMessage): unknown[] {
  return [
    message.role,
    ...message.blocks.map((block) => {
      if (block.type === 'text') {
        return block.text
      }
      if (block.type === 'tool-call') {
        return { call: block.name, input: block.input, callId: block.callId }
      }
      if (block.type === 'tool-result') {
        return { output: block.output, isError: block.isError, callId: block.callId }
      }
      return block.type
    })
  ]
}

describe('decodeMuseTranscriptLine', () => {
  const messages = FIXTURE_LINES.flatMap(
    (line, index) => decodeMuseTranscriptLine(line, `f${index}`) ?? []
  )

  it('renders the conversation and skips runtime bookkeeping', () => {
    expect(messages.map(summary)).toEqual([
      ['user', 'Use the bash tool to run: touch approved.txt . Then reply ok.'],
      ['assistant', 'Running your touch command.'],
      [
        'assistant',
        {
          call: 'bash',
          input: { command: 'touch approved.txt', description: 'Create approved.txt marker file' },
          callId: 'call_01a1afb40aa6700c98639d87996a76d4'
        }
      ],
      ['tool', { output: '', isError: undefined, callId: 'call_01a1afb40aa6700c98639d87996a76d4' }],
      ['assistant', 'ok'],
      [
        'assistant',
        {
          call: 'request_user_input',
          input: {
            questions: [
              {
                header: 'Color',
                id: 'fav_color',
                options: [{ label: 'Red' }, { label: 'Blue' }, { label: 'Green' }],
                question: 'What is your favorite color?'
              }
            ]
          },
          callId: 'call_01a1afb4d0ba7273aa991ecd682d34a7'
        }
      ],
      [
        'tool',
        {
          output: '{"status":"answered","answers":[{"id":"fav_color","selected_label":"Blue"}]}',
          isError: undefined,
          callId: 'call_01a1afb4d0ba7273aa991ecd682d34a7'
        }
      ],
      [
        'assistant',
        {
          call: 'bash',
          input: {
            command: 'sleep 30 && echo slow',
            description: 'Run delayed echo command',
            yield_time_ms: 40000
          },
          callId: 'call_01a1afb672c47064a43a19902a669d47'
        }
      ],
      [
        'tool',
        {
          output:
            "tool denied: approval aborted\nThe user rejected this action. Don't retry it unless they ask.",
          isError: undefined,
          callId: 'call_01a1afb672c47064a43a19902a669d47'
        }
      ],
      ['system', 'Conversation interrupted']
    ])
  })

  it('stamps rows with recorded_at converted from microseconds', () => {
    expect(messages[0]?.timestamp).toBe(1793949171954)
  })
})
