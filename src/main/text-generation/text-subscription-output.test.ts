import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseClaudeSubscriptionOutput } from './claude-subscription-output'
import { parseCodexSubscriptionOutput } from './codex-subscription-output'
import { parseOpenCodeSubscriptionOutput } from './opencode-subscription-output'

const captured = (name: string) =>
  readFileSync(join(import.meta.dirname, '__fixtures__', name), 'utf8')

describe('settled quota verdicts at the text collector', () => {
  const cases = [
    ['Claude', captured('claude-2.1.317-quota-refusal.jsonl'), parseClaudeSubscriptionOutput],
    ['Codex', captured('codex-0.166.0-quota-refusal.jsonl'), parseCodexSubscriptionOutput],
    ['OpenCode', captured('opencode-1.19.4-quota-refusal.jsonl'), parseOpenCodeSubscriptionOutput]
  ] as const
  for (const [name, stdout, parse] of cases) {
    it(`${name}: accepts the pinned CLI's settled quota refusal`, () => {
      expect(parse(stdout, 1, true)).toMatchObject({
        ok: false,
        quota: true,
        message: expect.stringMatching(/^(?:You.ve hit your|Subscription quota exceeded)/)
      })
      expect(parse(stdout, null, true)).toMatchObject({ ok: false, quota: false })
      expect(parse(stdout, 0, true)).toMatchObject({ ok: false, quota: false })
      expect(parse(`${stdout}{"type":`, 1, true)).toMatchObject({ ok: false, quota: false })
    })
  }
  it('does not equate a generic 429 or assistant text with a quota verdict', () => {
    const untyped = captured('claude-2.1.317-quota-refusal.jsonl')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const frame = JSON.parse(line)
        delete frame.api_error
        return JSON.stringify(frame)
      })
      .join('\n')
    expect(parseClaudeSubscriptionOutput(untyped, 1)).toMatchObject({ ok: false, quota: false })
    expect(
      parseClaudeSubscriptionOutput(
        JSON.stringify({
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: "You've hit your limit"
        }),
        0
      )
    ).toMatchObject({ ok: true, text: "You've hit your limit" })
    const auth = `${JSON.stringify({ type: 'assistant', error: 'authentication_failed', api_error: 'authentication_failed' })}\n${JSON.stringify({ type: 'result', is_error: true })}`
    expect(parseClaudeSubscriptionOutput(auth, 1)).toMatchObject({ ok: false, quota: false })
  })
  it('requires a fresh same-account spent window for CLI compatibility verdicts', () => {
    expect(
      parseCodexSubscriptionOutput(captured('codex-0.166.0-quota-refusal.jsonl'), 1, false)
    ).toMatchObject({ ok: false, quota: false })
    expect(
      parseOpenCodeSubscriptionOutput(captured('opencode-1.19.4-quota-refusal.jsonl'), 1)
    ).toMatchObject({ ok: false, quota: true })
  })

  it('does not replay a quota refusal after the pinned Codex completed MCP call frame', () => {
    const action = {
      type: 'item.completed',
      item: {
        id: 'item_0',
        type: 'mcp_tool_call',
        server: 'search service',
        tool: 'web_run',
        arguments: { search_query: [{ q: 'OpenAI Codex CLI documentation' }] },
        result: { content: [{ type: 'text', text: 'search result' }] },
        error: null,
        status: 'completed'
      }
    }
    const stdout = `${JSON.stringify(action)}\n${captured('codex-0.166.0-quota-refusal.jsonl')}`
    expect(parseCodexSubscriptionOutput(stdout, 1, true)).toMatchObject({
      ok: false,
      quota: false,
      diagnostic: false
    })
  })

  it.each([
    [
      'item.started',
      { id: 'item_0', type: 'command_execution', command: 'git status', status: 'in_progress' }
    ],
    ['item.updated', { id: 'item_0', type: 'collab_tool_call' }],
    ['item.completed', { id: 'item_0', type: 'file_change', changes: [], status: 'completed' }],
    ['item.started', { id: 'item_0', type: 'future_action' }],
    ['item.completed', null],
    ['item.updated', { id: 'item_0', type: 'reasoning', text: 42 }],
    ['item.started', { type: 'reasoning', text: '' }],
    ['item.updated', { id: 'item_0', type: 'agent_message', text: 'Partial answer' }]
  ])('refuses Codex recovery after unsafe or malformed %s progress: %j', (type, item) => {
    const stdout = `${JSON.stringify({ type, item })}\n${captured('codex-0.166.0-quota-refusal.jsonl')}`
    expect(parseCodexSubscriptionOutput(stdout, 1, true)).toMatchObject({
      ok: false,
      quota: false,
      diagnostic: false
    })
  })

  it('retains Codex recovery after typed reasoning progress', () => {
    const progress = ['item.started', 'item.updated', 'item.completed']
      .map((type) =>
        JSON.stringify({
          type,
          item: { id: 'item_0', type: 'reasoning', text: 'Considering context' }
        })
      )
      .join('\n')
    expect(
      parseCodexSubscriptionOutput(
        `${progress}\n${captured('codex-0.166.0-quota-refusal.jsonl')}`,
        1,
        true
      )
    ).toMatchObject({
      ok: false,
      quota: true,
      diagnostic: true
    })
  })

  it('does not replay OpenCode after its completed tool_use event', () => {
    const tool = {
      type: 'tool_use',
      timestamp: 1793784373979,
      sessionID: 'ses_fixture',
      part: {
        id: 'prt_fixture',
        sessionID: 'ses_fixture',
        messageID: 'msg_fixture',
        type: 'tool',
        callID: 'call_fixture',
        tool: 'read',
        state: {
          status: 'completed',
          input: { filePath: '/fixture/README.md' },
          output: 'fixture context',
          title: 'README.md',
          metadata: {},
          time: { start: 1793784373970, end: 1793784373979 }
        }
      }
    }
    expect(
      parseOpenCodeSubscriptionOutput(
        `${JSON.stringify(tool)}\n${captured('opencode-1.19.4-quota-refusal.jsonl')}`,
        1
      )
    ).toMatchObject({ ok: false, quota: false })
  })

  it.each([
    { type: 'future_action', part: { id: 'part' } },
    { type: 'step_finish', part: { id: 'part', reason: 'tool-calls' } },
    { type: 'reasoning', part: { id: 'part', text: 42 } },
    { type: 'step_start', part: null }
  ])('fails closed for unsupported OpenCode progress: %j', (frame) => {
    expect(
      parseOpenCodeSubscriptionOutput(
        `${JSON.stringify(frame)}\n${captured('opencode-1.19.4-quota-refusal.jsonl')}`,
        1
      )
    ).toMatchObject({ ok: false, quota: false })
  })

  it('keeps the OpenCode provider message when an error body is not JSON', () => {
    const frame = {
      type: 'error',
      error: {
        name: 'APIError',
        data: { message: 'Gateway unavailable', statusCode: 429, responseBody: '<html>' }
      }
    }
    expect(parseOpenCodeSubscriptionOutput(JSON.stringify(frame), 1)).toMatchObject({
      ok: false,
      quota: false,
      message: 'Gateway unavailable'
    })
  })

  it('retains OpenCode recovery after typed tool-free step and reasoning metadata', () => {
    const progress = [
      { type: 'step_start', part: { id: 'start', type: 'step-start' } },
      {
        type: 'reasoning',
        part: { id: 'reasoning', type: 'reasoning', text: 'Considering context' }
      },
      { type: 'step_finish', part: { id: 'finish', type: 'step-finish', reason: 'stop' } }
    ]
      .map((frame) => JSON.stringify(frame))
      .join('\n')
    expect(
      parseOpenCodeSubscriptionOutput(
        `${progress}\n${captured('opencode-1.19.4-quota-refusal.jsonl')}`,
        1
      )
    ).toMatchObject({ ok: false, quota: true })
  })
})
