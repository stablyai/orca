import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { projectNativeChatTranscriptMessages } from '../../shared/native-chat-transcript-projection'
import { decodeAntigravityTranscriptLine } from './transcript-line-decoders-antigravity'

const lines = readFileSync(
  new URL('./__fixtures__/antigravity/tool-turn.jsonl', import.meta.url),
  'utf8'
)
  .trim()
  .split('\n')

function decode(record: unknown) {
  return decodeAntigravityTranscriptLine(JSON.stringify(record), 'line-1')
}

describe('Antigravity transcript records', () => {
  it('preserves the recorded prompt, tool arguments, output, and subsequent response', () => {
    const messages = lines.map((line, index) =>
      decodeAntigravityTranscriptLine(line, `line-${index}`)
    )
    expect(messages[0]).toMatchObject({
      role: 'user',
      blocks: [{ type: 'text', text: 'Inspect the sample file.' }]
    })
    expect(messages[1]?.blocks).toContainEqual({
      type: 'tool-call',
      name: 'run_command',
      input: {
        CommandLine: 'printf sample',
        Cwd: '/workspace',
        WaitMsBeforeAsync: 1000,
        toolAction: 'Inspect',
        toolSummary: 'Read sample'
      }
    })
    expect(messages[2]).toMatchObject({
      role: 'tool',
      blocks: [{ type: 'tool-result', output: 'sample' }]
    })
    expect(messages[3]).toBeNull()
    expect(messages[4]).toMatchObject({
      role: 'assistant',
      blocks: [{ type: 'text', text: 'The sample file contains sample.' }]
    })
  })

  it.each([
    'RUN_COMMAND',
    'VIEW_FILE',
    'LIST_DIRECTORY',
    'GREP_SEARCH',
    'CODE_ACTION',
    'GENERIC',
    'INVOKE_SUBAGENT'
  ])('keeps recorded %s output without treating step completion as turn completion', (type) => {
    expect(decode({ source: 'MODEL', type, status: 'DONE', content: 'output' })).toMatchObject({
      role: 'tool',
      blocks: [{ type: 'tool-result', output: 'output' }]
    })
  })

  it.each([{ status: 'ERROR' }, { status: 'DONE', exit_code: 1 }])(
    'marks failed tool results',
    (fields) => {
      expect(
        decode({ source: 'MODEL', type: 'RUN_COMMAND', content: 'failed', ...fields })?.blocks
      ).toEqual([{ type: 'tool-result', output: 'failed', isError: true }])
    }
  )

  it('ignores malformed, empty, and system bookkeeping records', () => {
    expect(decodeAntigravityTranscriptLine('{', 'line')).toBeNull()
    expect(decode({ source: 'MODEL', type: 'PLANNER_RESPONSE' })).toBeNull()
    expect(decode({ source: 'SYSTEM', type: 'CHECKPOINT', content: 'private context' })).toBeNull()
  })
})

it('keeps tool arguments on the observed MODEL/GENERIC shape, including outputless calls', () => {
  const tool_calls = [{ name: 'view_file', args: { path: '/workspace/sample.txt' } }]
  const record = { source: 'MODEL', type: 'GENERIC', tool_calls }
  const expected = {
    type: 'tool-call',
    name: 'view_file',
    input: { path: '/workspace/sample.txt' }
  }
  expect(decode(record)?.blocks).toEqual([expected])
  expect(decode({ ...record, content: 'sample' })?.blocks).toEqual([
    expected,
    { type: 'tool-result', output: 'sample' }
  ])
})

it('preserves user-before-response step order across a decimal boundary at the same second', () => {
  const [userLine, replyLine] = readFileSync(
    new URL('./__fixtures__/antigravity/live-timestamp-tie.jsonl', import.meta.url),
    'utf8'
  )
    .trim()
    .split('\n')
  if (!userLine || !replyLine) {
    throw new Error('Expected captured user and reply records')
  }
  const user = decodeAntigravityTranscriptLine(userLine, 'user-fallback')
  const reply = decodeAntigravityTranscriptLine(replyLine, 'reply-fallback')
  if (!user || !reply) {
    throw new Error('Expected captured message shapes to decode')
  }
  expect(user.id).toBe('9')
  expect(reply.id).toBe('10')
  expect(user.timestamp).toBe(reply.timestamp)
  expect(projectNativeChatTranscriptMessages([reply, user]).map((message) => message.id)).toEqual([
    '9',
    '10'
  ])
})

it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, 'opaque-id'])(
  'does not invent transcript order for invalid step %s',
  (step_index) => {
    expect(
      decode({ source: 'USER_EXPLICIT', type: 'USER_INPUT', step_index, content: 'hello' })
        ?.transcriptPosition
    ).toBeUndefined()
  }
)
