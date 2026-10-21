import { afterEach, describe, expect, it, vi } from 'vitest'
import { AcpAuthRequiredError, AcpConnectionClosedError, AcpRpcError } from './acp-errors'
import {
  AcpSessionRuntime,
  type AcpSessionRuntimeOptions,
  type AcpSessionEvent
} from './acp-session-runtime'
import { AcpScriptedAgent, deferred } from './acp-scripted-agent.test-support'
import type {
  AgentCapabilities,
  RequestPermissionResponse
} from './generated/acp-protocol.generated'
import { SetSessionConfigOptionRequestSchema } from './generated/acp-protocol.generated'

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
  it('initializes once, starts a session, streams typed updates, and completes the turn', async () => {
    const { runtime, agent } = fixture()
    const events: AcpSessionEvent[] = []
    const unsubscribe = runtime.subscribe((event) => events.push(event))
    const updates = [
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello' } },
      { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Thinking' } },
      { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'hello' } },
      { sessionUpdate: 'tool_call', toolCallId: 'tool-1', title: 'Read file' },
      { sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: 'completed' },
      {
        sessionUpdate: 'plan',
        entries: [{ content: 'Read', priority: 'medium', status: 'completed' }]
      },
      { sessionUpdate: 'usage_update', used: 12, size: 100 },
      { sessionUpdate: 'available_commands_update', availableCommands: [] },
      { sessionUpdate: 'current_mode_update', currentModeId: 'plan' },
      { sessionUpdate: 'config_option_update', configOptions: [] },
      { sessionUpdate: 'session_info_update', title: 'Test session' }
    ]
    agent.on('session/prompt', (frame) => {
      for (const update of updates) {
        agent.notify('session/update', { sessionId: 'session-1', update })
      }
      agent.reply(frame, { stopReason: 'end_turn' })
    })
    await Promise.all([runtime.initialize(), runtime.initialize()])
    expect(await runtime.start(startOptions)).toMatchObject({ kind: 'new', sessionId: 'session-1' })
    expect(await runtime.prompt([...textPrompt])).toEqual({ stopReason: 'end_turn' })
    expect(
      events.map((event) => (event.kind === 'known' ? event.notification.update : event.raw.update))
    ).toEqual(updates)
    expect(agent.frames.filter((frame) => frame.method === 'initialize')).toHaveLength(1)
    expect(agent.frames[0].params).toEqual({
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }
    })
    expect(agent.frames.find((frame) => frame.method === 'session/new')?.params).toEqual(
      startOptions
    )
    unsubscribe()
    agent.notify('session/update', { sessionId: 'session-1', update: updates[0] })
    expect(events).toHaveLength(updates.length)
  })

  it.each([
    [{ loadSession: true }, undefined, 'load'],
    [{ sessionCapabilities: { resume: {} } }, undefined, 'resume'],
    [{ loadSession: true, sessionCapabilities: { resume: {} } }, undefined, 'load'],
    [{ loadSession: true, sessionCapabilities: { resume: {} } }, 'resume', 'resume'],
    [{ loadSession: true, sessionCapabilities: { resume: null } }, 'resume', 'load']
  ] as const)(
    'selects supported activation (%j, %s)',
    async (capabilities, preference, expected) => {
      const { runtime, agent } = fixture(capabilities)
      const result = await runtime.start({
        ...startOptions,
        sessionId: 'old',
        resumePreference: preference
      })
      expect(result).toMatchObject({ kind: expected, sessionId: 'old' })
      expect(agent.frames.at(-1)).toMatchObject({
        method: `session/${expected}`,
        params: { ...startOptions, sessionId: 'old' }
      })
    }
  )

  it('refuses unsupported restoration without silently creating a different session', async () => {
    const { runtime, agent } = fixture({ sessionCapabilities: { resume: null } })
    await expect(runtime.start({ ...startOptions, sessionId: 'old' })).rejects.toMatchObject({
      code: -32601
    })
    expect(agent.frames.map((frame) => frame.method)).toEqual(['initialize'])
  })

  it('round-trips permission and vendor requests while prompt is pending', async () => {
    const permitted = deferred<unknown>()
    const { runtime, agent } = fixture(
      {},
      {
        onPermission: (request) => {
          expect(request.toolCall.toolCallId).toBe('tool-1')
          return { outcome: { outcome: 'selected', optionId: 'allow' } }
        },
        onRequest: (method, params) =>
          method === '_vendor/question'
            ? { answer: params }
            : (() => {
                throw new AcpRpcError(-32601, 'Unknown method')
              })()
      }
    )
    agent.on('session/prompt', (frame) => {
      void agent.request('agent-id', 'session/request_permission', permission).then((response) => {
        permitted.resolve(response.result)
        agent.reply(frame, { stopReason: 'end_turn' })
      })
    })
    await runtime.start(startOptions)
    const prompt = runtime.prompt([...textPrompt])
    expect(await permitted.promise).toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } })
    await prompt
    expect(await agent.request(1, '_vendor/question', 'yes')).toMatchObject({
      id: 1,
      result: { answer: 'yes' }
    })
    expect(await agent.request('unknown', '_vendor/unknown', {})).toMatchObject({
      error: { code: -32601 }
    })
    expect(await agent.request('fs', 'fs/read_text_file', {})).toMatchObject({
      error: { code: -32601 }
    })
  })

  it('leaves open and late permission decisions with their owner after cancel', async () => {
    const requested = deferred<AbortSignal>()
    const decision = deferred<RequestPermissionResponse>()
    const { runtime, agent } = fixture(
      {},
      {
        onPermission: (_request, context) => {
          requested.resolve(context.signal)
          return decision.promise
        }
      }
    )
    agent.on('session/prompt', () => {})
    await runtime.start(startOptions)
    const prompt = runtime.prompt([...textPrompt])
    const open = agent.request('open', 'session/request_permission', permission)
    const signal = await requested.promise
    await runtime.cancel()
    expect(signal.aborted).toBe(false)
    const late = agent.request('late', 'session/request_permission', permission)
    decision.resolve({ outcome: { outcome: 'cancelled' } })
    expect(await open).toMatchObject({ result: { outcome: { outcome: 'cancelled' } } })
    expect(await late).toMatchObject({ result: { outcome: { outcome: 'cancelled' } } })
    const frame = agent.frames.find((frame) => frame.method === 'session/prompt')
    if (!frame) {
      throw new Error('missing prompt')
    }
    agent.reply(frame, { stopReason: 'cancelled' })
    await prompt
  })

  it('surfaces authentication-required errors with code and data', async () => {
    const { runtime, agent } = fixture()
    agent.on('session/new', (frame) =>
      agent.fail(frame, -32000, 'Login required', { detail: 'Sign in' })
    )
    await expect(runtime.start(startOptions)).rejects.toBeInstanceOf(AcpAuthRequiredError)
    await expect(runtime.start(startOptions)).rejects.toMatchObject({
      code: -32000,
      data: { detail: 'Sign in' }
    })
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

  it('leaves advertised authentication methods for the caller to choose', async () => {
    const { runtime, agent } = fixture()
    const authMethods = [
      { id: 'terminal', name: 'Interactive login', type: 'terminal' },
      { id: 'agent', name: 'Agent login' }
    ]
    agent.on('initialize', (frame) => agent.reply(frame, { protocolVersion: 1, authMethods }))
    agent.on('session/new', (frame) => agent.fail(frame, -32000, 'Login required'))
    await expect(runtime.start(startOptions)).rejects.toMatchObject({ authMethods })
    expect(agent.frames.map((frame) => frame.method)).toEqual(['initialize', 'session/new'])
  })

  it('does not retry authentication indefinitely or start an interactive login', async () => {
    const { runtime, agent } = fixture()
    agent.on('initialize', (frame) =>
      agent.reply(frame, {
        protocolVersion: 1,
        authMethods: [{ id: 'terminal', name: 'Interactive login', type: 'terminal' }]
      })
    )
    agent.on('session/new', (frame) => agent.fail(frame, -32000, 'Login required'))
    await expect(runtime.start(startOptions)).rejects.toBeInstanceOf(AcpAuthRequiredError)
    expect(agent.frames.map((frame) => frame.method)).toEqual(['initialize', 'session/new'])
    const retry = fixture()
    retry.agent.on('initialize', (frame) =>
      retry.agent.reply(frame, {
        protocolVersion: 1,
        authMethods: [{ id: 'agent', name: 'Agent login' }]
      })
    )
    retry.agent.on('authenticate', (frame) => retry.agent.reply(frame, {}))
    retry.agent.on('session/new', (frame) =>
      retry.agent.fail(frame, -32000, 'Still requires login')
    )
    await expect(
      retry.runtime.start({ ...startOptions, authMethodId: 'agent' })
    ).rejects.toBeInstanceOf(AcpAuthRequiredError)
    expect(retry.agent.frames.map((frame) => frame.method)).toEqual([
      'initialize',
      'session/new',
      'authenticate',
      'session/new'
    ])
  })

  it('sends mode, model, and config changes to the active session', async () => {
    const { runtime, agent } = fixture()
    agent.on('session/set_mode', (frame) => agent.reply(frame, {}))
    agent.on('session/set_model', (frame) => agent.reply(frame, {}))
    agent.on('session/set_config_option', (frame) => {
      SetSessionConfigOptionRequestSchema.parse(frame.params)
      agent.reply(frame, { configOptions: [] })
    })
    await runtime.start(startOptions)
    await runtime.setMode('plan')
    await runtime.setModel('model-1')
    await runtime.setConfigOption('thinking', 'high')
    expect(agent.frames.slice(-3).map((frame) => frame.params)).toEqual([
      { sessionId: 'session-1', modeId: 'plan' },
      { sessionId: 'session-1', modelId: 'model-1' },
      { sessionId: 'session-1', configId: 'thinking', value: 'high' }
    ])
    await runtime.setConfigOption('enabled', true)
    expect(agent.frames.at(-1)?.params).toEqual({
      sessionId: 'session-1',
      configId: 'enabled',
      value: true,
      type: 'boolean'
    })
  })

  it('rejects an unsupported protocol and malformed session responses', async () => {
    const { runtime, agent } = fixture()
    agent.on('initialize', (frame) => agent.reply(frame, { protocolVersion: 2 }))
    await expect(runtime.start(startOptions)).rejects.toMatchObject({ code: -32602 })
    expect(agent.frames.map((frame) => frame.method)).toEqual(['initialize'])
    const malformed = fixture()
    malformed.agent.on('session/new', (frame) => malformed.agent.reply(frame, {}))
    await expect(malformed.runtime.start(startOptions)).rejects.toMatchObject({ code: -32603 })
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
    // The session stays usable: a local permission failure is not a protocol failure.
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

  it('rejects pending calls and aborts permission hooks when the agent exits', async () => {
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

  it('writes cancel immediately without waiting, coalescing, timing out, or closing', async () => {
    vi.useFakeTimers()
    const { runtime, agent } = fixture()
    const frame = deferred<Parameters<AcpScriptedAgent['reply']>[0]>()
    agent.on('session/prompt', (prompt) => frame.resolve(prompt))
    await runtime.start(startOptions)
    const prompt = runtime.prompt([...textPrompt])
    const sent = await frame.promise
    await runtime.cancel()
    await runtime.cancel()
    expect(agent.frames.filter((frame) => frame.method === 'session/cancel')).toHaveLength(2)
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(runtime.closed).toBe(false)
    await expect(runtime.prompt([...textPrompt])).rejects.toThrow('already in progress')
    agent.reply(sent, { stopReason: 'cancelled' })
    expect(await prompt).toEqual({ stopReason: 'cancelled' })
    agent.on('session/prompt', (next) => agent.reply(next, { stopReason: 'end_turn' }))
    expect(await runtime.prompt([...textPrompt])).toEqual({ stopReason: 'end_turn' })
  })
})
