import { afterEach, describe, expect, it, vi } from 'vitest'
import { AcpConnectionClosedError } from '../transport/acp-errors'
import { AcpSessionRuntime } from './acp-session-runtime'
import type { AcpSessionRuntimeOptions } from './acp-session-runtime-options'
import type { AcpSessionEvent } from './acp-session-events'
import {
  AcpScriptedAgent,
  deferred,
  tick
} from '../process/testing/acp-scripted-agent.test-support'
import type { AgentCapabilities } from '../generated/acp-protocol.generated'

const opened: { runtime: AcpSessionRuntime; agent: AcpScriptedAgent }[] = []
const startOptions = { cwd: '/runtime/project', mcpServers: [] }
const textPrompt = [{ type: 'text', text: 'hello' }] as const
const permission = {
  sessionId: 'session-1',
  toolCall: { toolCallId: 'tool-1', title: 'Edit file' },
  options: [{ optionId: 'allow', name: 'Allow once', kind: 'allow_once' }]
}
function fixture(capabilities: AgentCapabilities = {}, options: AcpSessionRuntimeOptions = {}) {
  const agent = new AcpScriptedAgent()
  agent.on('initialize', (frame) =>
    agent.reply(frame, { protocolVersion: 1, agentCapabilities: capabilities })
  )
  agent.on('session/new', (frame) => agent.reply(frame, { sessionId: 'session-1' }))
  agent.on('session/load', (frame) => agent.reply(frame, {}))
  agent.on('session/resume', (frame) => agent.reply(frame, {}))
  agent.on('session/prompt', (frame) => agent.reply(frame, { stopReason: 'end_turn' }))
  const runtime = new AcpSessionRuntime(agent.stdout, agent.stdin, options)
  opened.push({ runtime, agent })
  return { runtime, agent }
}
afterEach(() => {
  for (const { runtime, agent } of opened.splice(0)) {
    runtime.close()
    agent.close()
  }
  vi.useRealTimers()
})

describe('ACP session runtime', () => {
  it('lets the agent ask from its own turn while a busy refusal holds the prompt', async () => {
    const asked: string[] = []
    const { runtime, agent } = fixture(
      {},
      {
        retryBusyPrompts: true,
        onPermission: (request) => {
          asked.push(request.toolCall.toolCallId)
          return { outcome: { outcome: 'selected', optionId: 'allow' } }
        }
      }
    )
    await runtime.start(startOptions)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    agent.on('session/prompt', (frame) => {
      const refusal = {
        jsonrpc: '2.0',
        id: frame.id,
        error: { code: -32003, message: 'busy', data: { reason: 'session_busy' } }
      }
      const autonomous = {
        jsonrpc: '2.0',
        id: 'same-chunk',
        method: 'session/request_permission',
        params: permission
      }
      agent.stdout.write(`${JSON.stringify(refusal)}\n${JSON.stringify(autonomous)}\n`)
    })
    const pending = runtime.prompt([...textPrompt])
    await tick()
    expect(agent.frames.find((frame) => frame.id === 'same-chunk')).toMatchObject({
      result: { outcome: { outcome: 'selected', optionId: 'allow' } }
    })
    agent.on('session/prompt', (frame) => {
      void agent.request('admitted', 'session/request_permission', permission).then(() => {
        agent.reply(frame, { stopReason: 'end_turn' })
      })
    })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(await pending).toEqual({ stopReason: 'end_turn' })
    expect(asked).toHaveLength(2)
  })

  it.each([
    ['code alone', true, { code: -32003, message: 'busy' }, -32003],
    [
      'reason alone',
      true,
      { code: -32603, message: 'busy', data: { reason: 'session_busy' } },
      -32603
    ],
    ['prose', true, { code: -32603, message: 'Agent is already processing.' }, -32603],
    [
      'sign-in',
      true,
      { code: -32000, message: 'Sign in', data: { reason: 'session_busy' } },
      -32000
    ],
    [
      'malformed refusal',
      true,
      { code: '-32003', message: 'busy', data: { reason: 'session_busy' } },
      -32603
    ],
    [
      'no opt-in',
      false,
      { code: -32003, message: 'busy', data: { reason: 'session_busy' } },
      -32003
    ]
  ] as const)('never replays %s', async (_label, retryBusyPrompts, error, code) => {
    const { runtime, agent } = fixture({}, { retryBusyPrompts })
    await runtime.start(startOptions)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    agent.on('session/prompt', (frame) =>
      agent.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: frame.id, error })}\n`)
    )
    await expect(runtime.prompt([...textPrompt])).rejects.toMatchObject({ code })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(agent.frames.filter((frame) => frame.method === 'session/prompt')).toHaveLength(1)
  })

  it('uses raw underscored extension methods and bounds control requests without closing the session', async () => {
    const { runtime, agent } = fixture()
    await runtime.initialize()
    await runtime.start(startOptions)
    agent.on('_x.ai/subagent/cancel', (frame) => {
      expect(frame.params).toEqual({ subagentId: 'child' })
    })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const call = runtime.requestExtension('_x.ai/subagent/cancel', { subagentId: 'child' })
    const rejected = expect(call).rejects.toThrow(/timed out|timeout/i)
    await vi.advanceTimersByTimeAsync(30_000)
    await rejected
    expect(runtime.closed).toBe(false)
    expect(() => runtime.requestExtension('x.ai/subagent/cancel', {})).toThrow('underscore')
  })

  it('refuses unsupported restoration without silently creating a different session', async () => {
    const { runtime, agent } = fixture({ sessionCapabilities: { resume: null } })
    await expect(runtime.start({ ...startOptions, sessionId: 'old' })).rejects.toMatchObject({
      code: -32601
    })
    expect(agent.frames.map((frame) => frame.method)).toEqual(['initialize'])
  })

  it('authenticates once with a configured agent method and retries session setup', async () => {
    const { runtime, agent } = fixture()
    let authenticated = false
    agent.on('initialize', (frame) =>
      agent.reply(frame, { protocolVersion: 1, authMethods: [{ id: 'login', name: 'Login' }] })
    )
    agent.on('session/new', (frame) =>
      authenticated
        ? agent.reply(frame, { sessionId: 'session-1' })
        : agent.fail(frame, -32000, 'Login required')
    )
    agent.on('authenticate', (frame) => {
      authenticated = true
      agent.reply(frame, {})
    })
    await runtime.start({ ...startOptions, authMethodId: 'login' })
    expect(agent.frames.map((frame) => frame.method)).toEqual([
      'initialize',
      'session/new',
      'authenticate',
      'session/new'
    ])
    expect(agent.frames[2].params).toEqual({ methodId: 'login' })
  })

  it('rejects unroutable permission requests and answers an unavailable selection cancelled', async () => {
    const diagnostics: string[] = []
    const { runtime, agent } = fixture(
      {},
      {
        onPermission: () => ({ outcome: { outcome: 'selected', optionId: 'not-offered' } }),
        onDiagnostic: (message) => diagnostics.push(message)
      }
    )
    agent.on('session/prompt', () => {})
    await runtime.start(startOptions)
    void runtime.prompt([...textPrompt]).catch(() => {})
    expect(await agent.request('invalid', 'session/request_permission', {})).toMatchObject({
      error: { code: -32602 }
    })
    expect(
      await agent.request('no-options', 'session/request_permission', {
        ...permission,
        options: [{ name: 'No id', kind: 'allow_once' }]
      })
    ).toMatchObject({ error: { code: -32602 } })
    expect(
      await agent.request('bad-selection', 'session/request_permission', permission)
    ).toMatchObject({ result: { outcome: { outcome: 'cancelled' } } })
    expect(diagnostics).toContain(
      'Answered ACP permission request cancelled: handler selected an unavailable option'
    )
    // A local permission failure must leave the session usable.
    await expect(runtime.prompt([...textPrompt])).rejects.toThrow('already in progress')
  })

  it('preserves unrecognized updates and isolates event listener failures', async () => {
    const diagnostics: string[] = []
    const { runtime, agent } = fixture({}, { onDiagnostic: (message) => diagnostics.push(message) })
    const updates: AcpSessionEvent[] = []
    runtime.subscribe(() => {
      throw new Error('Consumer failed')
    })
    runtime.subscribe((event) => updates.push(event))
    await runtime.start(startOptions)
    agent.notify('session/update', {
      sessionId: 'session-1',
      update: { sessionUpdate: 'agent_message_chunk', content: {} }
    })
    agent.notify('session/update', {
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'valid', _meta: { vendor: true } }
      }
    })
    expect(updates).toHaveLength(2)
    expect(updates[0]).toMatchObject({ kind: 'unrecognized' })
    expect(updates[1]).toMatchObject({
      kind: 'known',
      notification: { update: { content: { _meta: { vendor: true } } } }
    })
    expect(diagnostics).toContain('Forwarded unrecognized ACP session update')
    expect(diagnostics.some((message) => message.includes('Consumer failed'))).toBe(true)
  })

  it('rejects pending calls and aborts permission hooks when protocol input ends', async () => {
    const requested = deferred<AbortSignal>()
    const { runtime, agent } = fixture(
      {},
      {
        onPermission: (_request, context) => {
          requested.resolve(context.signal)
          return new Promise(() => {})
        }
      }
    )
    agent.on('session/prompt', () => {
      void agent.request('permission', 'session/request_permission', permission)
    })
    await runtime.start(startOptions)
    const pending = runtime.prompt([...textPrompt])
    const rejected = expect(pending).rejects.toBeInstanceOf(AcpConnectionClosedError)
    const signal = await requested.promise
    agent.stdout.end()
    await rejected
    expect(signal.aborted).toBe(true)
    await expect(runtime.setMode('plan')).rejects.toBeInstanceOf(AcpConnectionClosedError)
  })
})
