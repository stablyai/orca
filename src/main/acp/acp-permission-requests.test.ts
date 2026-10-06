import { afterEach, describe, expect, it, vi } from 'vitest'
import { AcpSessionRuntime, type AcpSessionRuntimeOptions } from './acp-session-runtime'
import { AcpScriptedAgent, deferred, tick } from './acp-scripted-agent.test-support'
import type { AcpPermissionHandler } from './acp-permission-requests'
import type { RequestPermissionRequest } from './generated/acp-protocol.generated'

const opened: { close: () => void }[] = []
const startOptions = { cwd: '/runtime/project', mcpServers: [] }
const allow = { optionId: 'allow', name: 'Allow', kind: 'allow_once' }
const toolCall = { toolCallId: 'tool-1', title: 'Edit file' }
function fixture(options: AcpSessionRuntimeOptions = {}) {
  const agent = new AcpScriptedAgent()
  const diagnostics: string[] = []
  const runtime = new AcpSessionRuntime(agent.stdout, agent.stdin, {
    onDiagnostic: (message) => diagnostics.push(message),
    ...options
  })
  opened.push(agent, runtime)
  agent.on('initialize', (frame) => agent.reply(frame, { protocolVersion: 1 }))
  agent.on('session/new', (frame) => agent.reply(frame, { sessionId: 'session-1' }))
  agent.on('session/prompt', () => {})
  return { agent, runtime, diagnostics }
}
afterEach(() =>
  opened
    .splice(0)
    .toReversed()
    .forEach((resource) => resource.close())
)

describe('ACP permission requests', () => {
  it.each([
    ['a newer tool kind', { ...toolCall, kind: 'web_search' }, allow],
    ['a newer tool status', { ...toolCall, status: 'cancelled' }, allow],
    ['a newer option kind', toolCall, { ...allow, kind: 'allow_for_session' }]
  ])('delivers a permission with %s to the caller unchanged', async (_label, call, option) => {
    const asked = vi.fn((_request: RequestPermissionRequest) => ({
      outcome: { outcome: 'selected' as const, optionId: option.optionId }
    }))
    const { agent, runtime, diagnostics } = fixture({ onPermission: asked })
    await runtime.start(startOptions)
    void runtime.prompt([{ type: 'text', text: 'hi' }]).catch(() => {})
    const params = { sessionId: 'session-1', toolCall: call, options: [option] }
    expect(await agent.request('p', 'session/request_permission', params)).toMatchObject({
      result: { outcome: { outcome: 'selected', optionId: option.optionId } }
    })
    expect(asked.mock.calls[0][0]).toEqual(params)
    expect(diagnostics).toEqual([])
  })

  it('delivers a permission whose other fields are unreadable, dropping only those fields', async () => {
    const asked = vi.fn((_request: RequestPermissionRequest) => ({
      outcome: { outcome: 'cancelled' as const }
    }))
    const { agent, runtime, diagnostics } = fixture({ onPermission: asked })
    await runtime.start(startOptions)
    void runtime.prompt([{ type: 'text', text: 'hi' }]).catch(() => {})
    const content = [{ type: 'content', content: { type: 'reasoning_summary', text: 'x' } }]
    await agent.request('p', 'session/request_permission', {
      sessionId: 'session-1',
      toolCall: { ...toolCall, content, vendor: 'kept' },
      options: [{ optionId: 'allow', kind: 'allow_once' }, { name: 'No id' }]
    })
    expect(asked.mock.calls[0][0]).toEqual({
      sessionId: 'session-1',
      toolCall: { ...toolCall, vendor: 'kept' },
      options: [{ optionId: 'allow', name: 'allow', kind: 'allow_once' }]
    })
    expect(diagnostics).toEqual([
      'Delivered ACP permission request without unreadable fields: options.0.name, options.1, toolCall.content'
    ])
  })

  it.each<[string, AcpPermissionHandler, string]>([
    [
      'the handler throws',
      () => {
        throw new Error('renderer gone')
      },
      'handler failed: Error: renderer gone'
    ],
    // JSON.parse yields an untyped value, so a deliberately malformed reply needs no assertion.
    [
      'the handler answers nonsense',
      () => JSON.parse('{"outcome":"yes"}'),
      'invalid handler response'
    ]
  ])('answers cancelled with a diagnostic when %s', async (_label, onPermission, problem) => {
    const { agent, runtime, diagnostics } = fixture({ onPermission })
    await runtime.start(startOptions)
    void runtime.prompt([{ type: 'text', text: 'hi' }]).catch(() => {})
    expect(
      await agent.request('p', 'session/request_permission', {
        sessionId: 'session-1',
        toolCall,
        options: [allow]
      })
    ).toMatchObject({ result: { outcome: { outcome: 'cancelled' } } })
    expect(diagnostics).toEqual([`Answered ACP permission request cancelled: ${problem}`])
  })

  it('answers cancelled when the cancel lands before the permission handler starts', async () => {
    const asked = vi.fn((_request: RequestPermissionRequest) => new Promise<never>(() => {}))
    const { agent, runtime } = fixture({ onPermission: asked })
    await runtime.start(startOptions)
    runtime.subscribe(() => void runtime.cancel())
    const answer = new Promise<unknown>((resolve) => {
      agent.stdin.on('data', (chunk: string) => {
        if (chunk.includes('"id":5')) {
          resolve(JSON.parse(chunk))
        }
      })
    })
    // One chunk: the permission, then an update whose listener cancels before the handler runs.
    agent.stdout.write(
      [
        {
          jsonrpc: '2.0',
          id: 5,
          method: 'session/request_permission',
          params: { sessionId: 'session-1', toolCall, options: [allow] }
        },
        {
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'session-1',
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x' } }
          }
        }
      ]
        .map((frame) => `${JSON.stringify(frame)}\n`)
        .join('')
    )
    expect(await answer).toMatchObject({ id: 5, result: { outcome: { outcome: 'cancelled' } } })
    expect(asked).not.toHaveBeenCalled()
  })

  it('lets a turn the agent began itself ask for permission and cancels it with session/cancel', async () => {
    const asked = deferred<AbortSignal>()
    const { agent, runtime } = fixture({
      onPermission: (_request, context) => {
        asked.resolve(context.signal)
        return new Promise(() => {})
      }
    })
    await runtime.start(startOptions)
    const answer = agent.request('p', 'session/request_permission', {
      sessionId: 'session-1',
      toolCall,
      options: [allow]
    })
    const signal = await asked.promise
    await runtime.cancel()
    expect(signal.aborted).toBe(true)
    expect(await answer).toMatchObject({ result: { outcome: { outcome: 'cancelled' } } })
    await tick()
    expect(agent.frames.filter((frame) => frame.method === 'session/cancel')).toHaveLength(1)
  })
})
