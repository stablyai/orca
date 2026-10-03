import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AcpAuthRequiredError,
  AcpConnectionClosedError,
  AcpRequestTimeoutError
} from './acp-errors'
import { AcpSessionRuntime, type AcpSessionRuntimeOptions } from './acp-session-runtime'
import { AcpScriptedAgent, deferred, tick } from './acp-scripted-agent.test-support'
import type {
  AgentCapabilities,
  RequestPermissionResponse,
  SessionNotification
} from './generated/protocol.gen'
import { SetSessionConfigOptionRequestSchema } from './generated/protocol.gen'

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
  it('initializes once, starts a session, streams typed updates, and completes the turn', async () => {
    const { runtime, agent } = fixture()
    const events: SessionNotification[] = []
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
    expect(events.map((event) => event.update)).toEqual(updates)
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
          method === '_vendor/question' ? { answer: params } : undefined
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

  it('cancels open and late permissions and waits for the agent cancellation response', async () => {
    const requested = deferred<AbortSignal>()
    const decision = deferred<RequestPermissionResponse>()
    const responses: unknown[] = []
    const { runtime, agent } = fixture(
      {},
      {
        onPermission: (_request, context) => {
          requested.resolve(context.signal)
          return decision.promise
        }
      }
    )
    agent.on('session/prompt', (frame) => {
      void agent
        .request('permission', 'session/request_permission', permission)
        .then((response) => responses.push(response.result))
      agent.on('session/cancel', (cancel) => {
        expect(cancel.id).toBeUndefined()
        void agent
          .request('late-permission', 'session/request_permission', permission)
          .then((response) => {
            responses.push(response.result)
            agent.reply(frame, { stopReason: 'cancelled' })
          })
      })
    })
    await runtime.start(startOptions)
    const prompt = runtime.prompt([...textPrompt])
    const signal = await requested.promise
    const cancel = runtime.cancel()
    expect(runtime.cancel()).toBe(cancel)
    expect(await prompt).toEqual({ stopReason: 'cancelled' })
    await cancel
    expect(signal.aborted).toBe(true)
    expect(responses).toEqual([
      { outcome: { outcome: 'cancelled' } },
      { outcome: { outcome: 'cancelled' } }
    ])
    decision.resolve({ outcome: { outcome: 'selected', optionId: 'allow' } })
    await tick()
    expect(agent.frames.filter((frame) => frame.id === 'permission')).toHaveLength(1)
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

  it('chooses an advertised agent authentication method when login is required', async () => {
    const { runtime, agent } = fixture()
    let authenticated = false
    agent.on('initialize', (frame) =>
      agent.reply(frame, {
        protocolVersion: 1,
        authMethods: [
          { id: 'terminal', name: 'Interactive login', type: 'terminal' },
          { id: 'agent', name: 'Agent login' }
        ]
      })
    )
    agent.on('session/new', (frame) =>
      authenticated
        ? agent.reply(frame, { sessionId: 'session-1' })
        : agent.fail(frame, -32000, 'Login required')
    )
    agent.on('authenticate', (frame) => {
      expect(frame.params).toEqual({ methodId: 'agent' })
      authenticated = true
      agent.reply(frame, {})
    })
    await runtime.start(startOptions)
    expect(authenticated).toBe(true)
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
    await expect(retry.runtime.start(startOptions)).rejects.toBeInstanceOf(AcpAuthRequiredError)
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

  it('rejects invalid permission requests and fails closed on an unavailable selected option', async () => {
    const { runtime, agent } = fixture(
      {},
      {
        onPermission: () => ({ outcome: { outcome: 'selected', optionId: 'not-offered' } })
      }
    )
    agent.on('session/prompt', () => {})
    await runtime.start(startOptions)
    const prompt = runtime.prompt([...textPrompt])
    const rejected = expect(prompt).rejects.toBeInstanceOf(AcpConnectionClosedError)
    expect(await agent.request('invalid', 'session/request_permission', {})).toMatchObject({
      error: { code: -32602 }
    })
    expect(
      await agent.request('bad-selection', 'session/request_permission', permission)
    ).toMatchObject({ error: { code: -32603 } })
    await expect(runtime.prompt([...textPrompt])).rejects.toThrow('already in progress')
    runtime.close()
    await rejected
  })

  it('ignores invalid updates and isolates event listener failures', async () => {
    const diagnostics: string[] = []
    const { runtime, agent } = fixture({}, { onDiagnostic: (message) => diagnostics.push(message) })
    const updates: SessionNotification[] = []
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
    expect(updates).toHaveLength(1)
    expect(updates[0].update).toMatchObject({ content: { _meta: { vendor: true } } })
    expect(diagnostics).toContain('Ignored invalid ACP session update')
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

  it('closes an unconfirmed cancellation rather than allowing another prompt', async () => {
    vi.useFakeTimers()
    const { runtime, agent } = fixture({}, { cancelTimeoutMs: 100 })
    agent.on('session/prompt', () => {})
    await runtime.start(startOptions)
    const prompt = runtime.prompt([...textPrompt])
    const rejectedPrompt = expect(prompt).rejects.toBeInstanceOf(AcpRequestTimeoutError)
    const cancelled = expect(runtime.cancel()).rejects.toBeInstanceOf(AcpRequestTimeoutError)
    await vi.advanceTimersByTimeAsync(100)
    await Promise.all([rejectedPrompt, cancelled])
    await expect(runtime.prompt([...textPrompt])).rejects.toBeInstanceOf(AcpRequestTimeoutError)
  })
})
