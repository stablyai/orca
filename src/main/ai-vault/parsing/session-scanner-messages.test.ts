import { expect, it } from 'vitest'
import { createAccumulator } from './session-scanner-accumulator'
import { addSessionContent } from './session-scanner-messages'
import type { TranscriptMessage } from '../transcripts/session-transcript-consumers'

const AT = '2026-05-01T00:00:00.000Z'

function recordingAccumulator() {
  const messages: TranscriptMessage[] = []
  const accumulator = createAccumulator({
    agent: 'claude',
    sessionId: 'session',
    file: { path: 'session.jsonl', mtimeMs: 1, modifiedAt: AT },
    messages: { active: true, push: (message) => messages.push(message) }
  })
  return { accumulator, messages }
}

it('does not read tool inputs or result bodies during a preview-only scan', () => {
  const { accumulator, messages } = recordingAccumulator()
  accumulator.messages = { active: false, push: (message) => messages.push(message) }
  const content = [
    {
      type: 'tool_use',
      name: 'Bash',
      get input() {
        throw new Error('Preview read a tool input')
      }
    },
    {
      type: 'tool_result',
      get content() {
        throw new Error('Preview read a tool result')
      }
    },
    { type: 'text', text: 'Visible reply' }
  ]

  addSessionContent(accumulator, 'assistant', content, AT)

  expect(accumulator.previewMessages).toEqual([
    { role: 'assistant', text: 'Visible reply', timestamp: AT }
  ])
  expect(messages).toEqual([])
})
