import { expect, it } from 'vitest'
import { createCodexSessionResumeState } from './session-scanner-codex-parser'
import type { TranscriptMessage } from './session-transcript-consumers'
import { readCodexTimelineOnlyRecord } from './session-scanner-codex-record-fast-path'

const timestamp = '2026-05-01T10:00:00.000Z'
const file = {
  path: '/fixture/rollout.jsonl',
  mtimeMs: Date.parse(timestamp),
  modifiedAt: timestamp
}
const record = (type: string, payload: Record<string, unknown>): Buffer =>
  Buffer.from(JSON.stringify({ timestamp, type, payload }))

it.each(['function_call_output', 'custom_tool_call_output'])(
  'reads large %s records only when a consumer needs them',
  (type) => {
    const line = record('response_item', { type, output: 'outputonly '.repeat(300) })
    expect(readCodexTimelineOnlyRecord(line)).toEqual({ timestamp })
    expect(readCodexTimelineOnlyRecord(line, true)).toBeNull()
    const messages: TranscriptMessage[] = []
    const state = createCodexSessionResumeState(file, null, {
      active: true,
      push: (message) => messages.push(message)
    })
    state.consumeLineBytes!(line)
    expect(messages).toEqual([{ role: 'tool', text: 'outputonly '.repeat(300), timestamp }])
  }
)

it.each([false, true])(
  'uses one tool representation across append when paginated=%s',
  async (paginated) => {
    const messages: TranscriptMessage[] = []
    let state = createCodexSessionResumeState(file, null, {
      active: true,
      push: (message) => messages.push(message)
    })
    const consume = (type: string, payload: Record<string, unknown>) =>
      state.consumeLineBytes!(record(type, payload))
    consume('session_meta', { id: 'session-1', history_mode: paginated ? 'paginated' : 'full' })
    consume('response_item', { type: 'message', role: 'user', content: 'promptonly' })
    consume('event_msg', {
      type: 'item_completed',
      item: { type: 'UserMessage', content: [{ type: 'text', text: 'promptonly' }] }
    })
    consume('response_item', {
      type: 'function_call',
      name: 'shell',
      arguments: '{"command":"commandonly"}'
    })
    // The next scan resumes between the call and its output.
    state = state.clone()
    consume('response_item', { type: 'function_call_output', output: 'outputonly' })
    consume('event_msg', {
      type: 'item_completed',
      item: { type: 'CommandExecution', command: ['commandonly'], aggregated_output: 'outputonly' }
    })
    expect(messages.filter((message) => message.text.includes('commandonly'))).toHaveLength(1)
    expect(messages.filter((message) => message.text === 'outputonly')).toEqual([
      { role: 'tool', text: 'outputonly', timestamp }
    ])
    expect(messages.filter((message) => message.role === 'user')).toHaveLength(1)
    expect(await state.finalize(process.platform)).toMatchObject({ messageCount: 1 })
  }
)

it.each([
  { type: 'add', content: '+ addedneedle' },
  { type: 'delete', content: '+ addedneedle' },
  { type: 'update', unified_diff: '+ addedneedle', move_path: null }
])('publishes paginated $type file changes', (change) => {
  const messages: TranscriptMessage[] = []
  const state = createCodexSessionResumeState(file, null, {
    active: true,
    push: (message) => messages.push(message)
  })
  state.consumeLineBytes!(record('session_meta', { id: 'session-1', history_mode: 'paginated' }))
  state.consumeLineBytes!(
    record('event_msg', {
      type: 'item_completed',
      item: { type: 'FileChange', changes: { 'src/changed.ts': change } }
    })
  )
  expect(messages.map((message) => [message.role, message.text])).toEqual([
    ['tool', 'apply_patch: src/changed.ts'],
    ['tool', '+ addedneedle']
  ])
})

it('normalizes custom calls and structured results through the existing content reader', () => {
  const messages: TranscriptMessage[] = []
  const state = createCodexSessionResumeState(file, null, {
    active: true,
    push: (message) => messages.push(message)
  })
  state.consumeLineBytes!(
    record('response_item', { type: 'custom_tool_call', name: 'apply_patch', input: 'patchneedle' })
  )
  state.consumeLineBytes!(
    record('response_item', {
      type: 'custom_tool_call_output',
      output: { content: [{ type: 'text', text: 'resultneedle' }] }
    })
  )
  expect(messages.map((message) => message.text)).toEqual([
    'apply_patch: patchneedle',
    'resultneedle'
  ])
})

it('keeps local shell argv searchable', () => {
  const messages: TranscriptMessage[] = []
  const state = createCodexSessionResumeState(file, null, {
    active: true,
    push: (message) => messages.push(message)
  })
  state.consumeLineBytes!(
    record('response_item', {
      type: 'local_shell_call',
      action: { type: 'exec', command: ['rg', 'argvneedle'] }
    })
  )
  expect(messages.map((message) => message.text)).toEqual(['tool: rg argvneedle'])
})
