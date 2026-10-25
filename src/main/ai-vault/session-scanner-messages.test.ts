import { expect, it, vi } from 'vitest'
import { createAccumulator } from './session-scanner-accumulator'
import { decodeSessionMessage } from './session-decoded-message'
import { withFullFirstUserPromptCapture } from './session-scanner-first-user-prompt-capture'
import {
  addDecodedSessionMessage,
  addPreviewMessage,
  addSessionContent
} from './session-scanner-messages'
import type { TranscriptMessage } from './session-transcript-consumers'

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

it('projects one decoded turn into visible preview text and the complete searchable transcript', () => {
  const { accumulator, messages } = recordingAccumulator()
  const text = 'visible '.repeat(100)
  const decoded = decodeSessionMessage(
    'assistant',
    [
      { type: 'thinking', text: 'private reasoning' },
      { type: 'text', text },
      { type: 'tool_use', name: 'Bash', input: { command: 'echo proof' } },
      { type: 'tool_result', content: 'proof' }
    ],
    AT
  )
  addDecodedSessionMessage(accumulator, decoded)

  expect(messages).toEqual([
    { role: 'assistant', text: `private reasoning\n${text}`, timestamp: AT },
    { role: 'tool', text: 'Bash: echo proof', timestamp: AT },
    { role: 'tool', text: 'proof', timestamp: AT }
  ])
  expect(accumulator.previewMessages).toEqual([
    { role: 'assistant', text: `${text.slice(0, 217)}...`, timestamp: AT }
  ])
})

it('keeps preview writes independent of transcript publication and first-prompt capture', async () => {
  const { accumulator, messages } = recordingAccumulator()
  await withFullFirstUserPromptCapture(async () => {
    addPreviewMessage(accumulator, { role: 'user', text: 'generated summary', timestamp: AT })
    expect(messages).toEqual([])
    expect(accumulator.firstUserPrompt).toBeNull()

    addSessionContent(
      accumulator,
      'user',
      [
        { type: 'thinking', text: 'not the ask' },
        { type: 'text', text: 'first line\nsecond line' },
        { type: 'tool_result', content: 'not the ask either' }
      ],
      AT
    )
    expect(accumulator.firstUserPrompt).toBe('first line\nsecond line')
    expect(messages.map((message) => message.text)).toEqual([
      'not the ask\nfirst line\nsecond line',
      'not the ask either'
    ])
  })
})

it('formats a preview without joining large source blocks when no transcript consumer is active', () => {
  const { accumulator } = recordingAccumulator()
  accumulator.messages = {
    active: false,
    push: () => {
      throw new Error('Unexpected transcript publication')
    }
  }
  const text = 'visible '.repeat(1024 * 1024)
  const join = vi.spyOn(Array.prototype, 'join')
  try {
    addSessionContent(
      accumulator,
      'assistant',
      [
        { type: 'reasoning', text },
        { type: 'text', text },
        { type: 'text', text }
      ],
      AT
    )
    expect(join).not.toHaveBeenCalled()
    expect(accumulator.previewMessages[0]?.text).toHaveLength(220)
  } finally {
    join.mockRestore()
  }
})

it('keeps every published turn after older previews leave the display window', () => {
  const { accumulator, messages } = recordingAccumulator()
  for (let index = 0; index < 8; index++) {
    addSessionContent(accumulator, 'user', `turn ${index}`, AT)
  }
  expect(messages.map((message) => message.text)).toEqual(
    Array.from({ length: 8 }, (_, index) => `turn ${index}`)
  )
  expect(accumulator.previewMessages.map((message) => message.text)).toEqual([
    'turn 3',
    'turn 4',
    'turn 5',
    'turn 6',
    'turn 7'
  ])
  expect(accumulator.previewMessagesTruncated).toBe(true)
})

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
