import { readFile } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AcpJsonRpcPeer } from './acp-json-rpc-peer'
import { AcpSessionRuntime, type AcpSessionRuntimeOptions } from './acp-session-runtime'
import { AcpScriptedAgent, deferred, tick } from './acp-scripted-agent.test-support'
import { AcpConnectionClosedError, AcpRequestTimeoutError } from './acp-errors'
import type { RequestPermissionResponse } from './generated/acp-protocol.generated'

const opened: { close: () => void }[] = []
const startOptions = { cwd: '/runtime/project', mcpServers: [] }
const prompt = [{ type: 'text', text: 'hello' }] as const
const permission = {
  sessionId: 'session-1',
  toolCall: { toolCallId: 'tool-1', title: 'Edit file' },
  options: [{ optionId: 'allow', name: 'Allow once', kind: 'allow_once' }]
}
function fixture(options: AcpSessionRuntimeOptions = {}) {
  const agent = new AcpScriptedAgent()
  const runtime = new AcpSessionRuntime(agent.stdout, agent.stdin, options)
  opened.push(agent, runtime)
  agent.on('initialize', (frame) => agent.reply(frame, { protocolVersion: 1 }))
  agent.on('session/new', (frame) => agent.reply(frame, { sessionId: 'session-1' }))
  return { agent, runtime }
}
afterEach(() => {
  opened
    .splice(0)
    .toReversed()
    .forEach((resource) => resource.close())
  vi.useRealTimers()
})

describe('ACP caller-owned waits', () => {
  it('keeps permission requests open beyond two minutes and delivers the late user decision', async () => {
    vi.useFakeTimers()
    const entered = deferred<AbortSignal>()
    const decision = deferred<RequestPermissionResponse>()
    const { agent, runtime } = fixture({
      onPermission: (_request, context) => {
        entered.resolve(context.signal)
        return decision.promise
      }
    })
    agent.on('session/prompt', () => {})
    await runtime.start(startOptions)
    const pending = runtime.prompt([...prompt])
    const rejected = expect(pending).rejects.toBeInstanceOf(AcpConnectionClosedError)
    let answered = false
    const response = agent.request('permission', 'session/request_permission', permission)
    void response.then(() => {
      answered = true
    })
    const signal = await entered.promise
    await vi.advanceTimersByTimeAsync(120_001)
    expect(signal.aborted).toBe(false)
    expect(answered).toBe(false)
    decision.resolve({ outcome: { outcome: 'selected', optionId: 'allow' } })
    expect(await response).toMatchObject({
      result: { outcome: { outcome: 'selected', optionId: 'allow' } }
    })
    runtime.close()
    await rejected
  })

  it('lets a streaming turn run beyond thirty minutes and keeps the session usable', async () => {
    vi.useFakeTimers()
    const onClose = vi.fn()
    const event = vi.fn()
    const { agent, runtime } = fixture({ onClose })
    runtime.subscribe(event)
    agent.on('session/prompt', () => {})
    agent.on('session/set_mode', (frame) => agent.reply(frame, {}))
    await runtime.start(startOptions)
    let finished = false
    const pending = runtime.prompt([...prompt])
    void pending.then(() => {
      finished = true
    })
    await vi.advanceTimersByTimeAsync(30 * 60_000 + 1)
    agent.notify('session/update', {
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Still working' }
      }
    })
    expect(event).toHaveBeenCalledTimes(1)
    expect(finished).toBe(false)
    expect(onClose).not.toHaveBeenCalled()
    expect(agent.frames.some((frame) => frame.method === 'session/cancel')).toBe(false)
    await expect(runtime.setMode('plan')).resolves.toEqual({})
    const frame = agent.frames.find((frame) => frame.method === 'session/prompt')
    expect(frame).toBeDefined()
    if (frame) {
      agent.reply(frame, { stopReason: 'end_turn' })
    }
    await expect(pending).resolves.toEqual({ stopReason: 'end_turn' })
  })

  it.each([
    { id: 'key', name: 'API key', type: 'env_var', vars: [{ name: 'X_API_KEY' }] },
    { id: 'browser', name: 'Browser login', type: 'agent' },
    { id: 'default', name: 'Default login' },
    { id: 'terminal', name: 'Terminal login', type: 'terminal' }
  ])('surfaces $id authentication without choosing it for the caller', async (method) => {
    const { agent, runtime } = fixture()
    agent.on('initialize', (frame) =>
      agent.reply(frame, { protocolVersion: 1, authMethods: [method] })
    )
    agent.on('session/new', (frame) => agent.fail(frame, -32000, 'Authentication required'))
    await expect(runtime.start(startOptions)).rejects.toMatchObject({
      name: 'AcpAuthRequiredError',
      authMethods: [method]
    })
    expect(agent.frames.map((frame) => frame.method)).toEqual(['initialize', 'session/new'])
  })

  it.each(['prompt', 'cancel', 'setMode', 'setModel', 'setConfigOption'] as const)(
    'rejects %s before start through its promise',
    async (method) => {
      const { runtime } = fixture()
      let pending: Promise<unknown> | undefined
      expect(() => {
        switch (method) {
          case 'prompt':
            pending = runtime.prompt([...prompt])
            break
          case 'cancel':
            pending = runtime.cancel()
            break
          case 'setMode':
            pending = runtime.setMode('plan')
            break
          case 'setModel':
            pending = runtime.setModel('model')
            break
          case 'setConfigOption':
            pending = runtime.setConfigOption('thinking', 'high')
            break
        }
      }).not.toThrow()
      await expect(pending).rejects.toThrow('ACP session has not started')
    }
  )

  it('answers a handled void vendor request with null', async () => {
    const handler = vi.fn()
    const { agent } = fixture({ onRequest: handler })
    expect(await agent.request(7, '_vendor/ack', {})).toMatchObject({ id: 7, result: null })
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('ignores duplicate incoming ids without answering the original request', async () => {
    const answer = deferred<unknown>()
    const handler = vi.fn(() => answer.promise)
    const diagnostics: string[] = []
    const { agent } = fixture({
      onRequest: handler,
      onDiagnostic: (message) => diagnostics.push(message)
    })
    const original = agent.request(5, '_vendor/question', {})
    agent.send({ jsonrpc: '2.0', id: 5, method: '_vendor/question', params: {} })
    await tick()
    expect(agent.frames).toEqual([])
    expect(handler).toHaveBeenCalledTimes(1)
    expect(diagnostics).toContain('Ignored duplicate ACP incoming request id')
    answer.resolve({ answer: true })
    expect(await original).toMatchObject({ id: 5, result: { answer: true } })
    expect(agent.frames).toHaveLength(1)
  })

  it.each([{ code: 'E1', message: 'boom' }, { code: -1, message: null }, null])(
    'rejects a malformed error reply immediately with its raw error: %j',
    async (error) => {
      const { agent, runtime } = fixture()
      agent.on('initialize', (frame) => {
        agent.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: frame.id, error })}\n`)
      })
      await expect(runtime.initialize()).rejects.toMatchObject({ code: -32603, data: error })
    }
  )

  it('maps authentication-required and retries only the explicitly chosen advertised method once', async () => {
    const { agent, runtime } = fixture()
    const authMethods = [{ id: 'login', name: 'Login' }]
    agent.on('initialize', (frame) => agent.reply(frame, { protocolVersion: 1, authMethods }))
    agent.on('session/new', (frame) => agent.fail(frame, -32000, 'Authentication required'))
    agent.on('authenticate', (frame) => agent.reply(frame, {}))
    await expect(runtime.start({ ...startOptions, authMethodId: 'login' })).rejects.toMatchObject({
      name: 'AcpAuthRequiredError',
      authMethods
    })
    expect(agent.frames.map((frame) => frame.method)).toEqual([
      'initialize',
      'session/new',
      'authenticate',
      'session/new'
    ])
  })

  it('rejects overflowing peer timeouts and supports an explicit unlimited wait', async () => {
    vi.useFakeTimers()
    const agent = new AcpScriptedAgent()
    opened.push(agent)
    expect(
      () => new AcpJsonRpcPeer(agent.stdout, agent.stdin, {}, { requestTimeoutMs: 3_000_000_000 })
    ).toThrow('timer durations')
    const peer = new AcpJsonRpcPeer(agent.stdout, agent.stdin, {}, { requestTimeoutMs: 20 })
    opened.push(peer)
    await expect(peer.request('overflow', {}, { timeoutMs: 3_000_000_000 })).rejects.toThrow(
      'timer durations'
    )
    const pending = peer.request('wait', {}, { timeoutMs: null })
    const rejected = expect(pending).rejects.toBeInstanceOf(AcpConnectionClosedError)
    await vi.advanceTimersByTimeAsync(3_000_000_000)
    expect(peer.closed).toBe(false)
    expect(agent.frames.map((frame) => frame.method)).toEqual(['wait'])
    peer.close()
    await rejected
  })

  it('clamps cancellation confirmation waits to the safe timer range', async () => {
    vi.useFakeTimers()
    const { agent, runtime } = fixture({ cancelTimeoutMs: 3_000_000_000 })
    agent.on('session/prompt', () => {})
    await runtime.start(startOptions)
    const rejected = expect(runtime.prompt([...prompt])).rejects.toBeInstanceOf(
      AcpRequestTimeoutError
    )
    const cancelled = expect(runtime.cancel()).rejects.toBeInstanceOf(AcpRequestTimeoutError)
    await vi.advanceTimersByTimeAsync(1)
    expect(agent.frames.at(-1)?.method).toBe('session/cancel')
    await vi.advanceTimersByTimeAsync(2_147_483_646)
    await Promise.all([rejected, cancelled])
  })

  it('lets initialize and explicit authentication wait for slow first-run startup and login', async () => {
    vi.useFakeTimers()
    const { agent, runtime } = fixture({ peer: { requestTimeoutMs: 20 } })
    agent.on('initialize', () => {})
    const initialized = runtime.initialize()
    await vi.advanceTimersByTimeAsync(120_001)
    agent.reply(agent.frames[0], { protocolVersion: 1 })
    await initialized
    const authenticated = runtime.authenticate('caller-chosen')
    await vi.advanceTimersByTimeAsync(120_001)
    agent.reply(agent.frames[1], {})
    await expect(authenticated).resolves.toEqual({})
  })

  it('lets cancel abort vendor hooks so each sends its own answer, or request-cancelled if it throws', async () => {
    const { agent, runtime } = fixture({
      onRequest: (method, _params, context) =>
        new Promise((resolve, reject) => {
          // '_vendor/silent' ignores the abort: the runtime never answers for it.
          if (method !== '_vendor/silent') {
            context.signal.addEventListener('abort', () =>
              method === '_vendor/plan'
                ? resolve({ outcome: 'abandoned' })
                : reject(new Error('stop'))
            )
          }
        })
    })
    agent.on('session/prompt', (frame) =>
      agent.on('session/cancel', () => agent.reply(frame, { stopReason: 'cancelled' }))
    )
    await runtime.start(startOptions)
    const pending = runtime.prompt([...prompt])
    const question = agent.request('question', '_vendor/question', {})
    const plan = agent.request('plan', '_vendor/plan', {})
    void agent.request('silent', '_vendor/silent', {})
    await tick()
    await runtime.cancel()
    expect(await question).toMatchObject({ error: { code: -32800 } })
    expect(await plan).toMatchObject({ result: { outcome: 'abandoned' } })
    await pending
    await tick()
    expect(agent.frames.filter((frame) => frame.id === 'plan')).toHaveLength(1)
    expect(agent.frames.some((frame) => frame.id === 'silent')).toBe(false)
  })

  it('keeps a handler answer that finishes saving after the cancel', async () => {
    // A real I/O hop, the shape of a journal write the handler commits before replying.
    const save = (): Promise<void> => readFile(import.meta.filename).then(() => undefined)
    const userAnswer = deferred<void>()
    const { agent, runtime } = fixture({
      onRequest: (method, _params, context) =>
        new Promise((resolve) => {
          if (method === '_vendor/plan') {
            // The user already approved; the save started before the stop and replies after it.
            void userAnswer.promise.then(save).then(() => resolve({ outcome: 'approved' }))
          } else {
            context.signal.addEventListener(
              'abort',
              () => void save().then(() => resolve({ outcome: 'abandoned' }))
            )
          }
        })
    })
    agent.on('session/prompt', (frame) =>
      agent.on('session/cancel', () => agent.reply(frame, { stopReason: 'cancelled' }))
    )
    await runtime.start(startOptions)
    const pending = runtime.prompt([...prompt])
    const plan = agent.request('plan', '_vendor/plan', {})
    const question = agent.request('question', '_vendor/question', {})
    await tick()
    userAnswer.resolve()
    await runtime.cancel()
    expect(await plan).toMatchObject({ result: { outcome: 'approved' } })
    expect(await question).toMatchObject({ result: { outcome: 'abandoned' } })
    await pending
    await tick()
    expect(agent.frames.filter((frame) => frame.id === 'plan')).toHaveLength(1)
    expect(agent.frames.filter((frame) => frame.id === 'question')).toHaveLength(1)
  })

  it('settles requests when the process owner closes on exit even if stdout stays open', async () => {
    const { agent, runtime } = fixture()
    agent.on('session/prompt', () => {})
    await runtime.start(startOptions)
    const rejected = expect(runtime.prompt([...prompt])).rejects.toThrow('Agent exited')
    expect(agent.stdout.readableEnded).toBe(false)
    runtime.close(new Error('Agent exited'))
    await rejected
    expect(agent.stdout.readableEnded).toBe(false)
  })
  it.each(['answer', 'cancel'] as const)(
    'keeps a permission pending after prompt completion until caller %s',
    async (action) => {
      const decision = deferred<RequestPermissionResponse>()
      const entered = deferred<AbortSignal>()
      const { agent, runtime } = fixture({
        onPermission: (_request, context) => {
          entered.resolve(context.signal)
          return decision.promise
        }
      })
      agent.on('session/prompt', () => {})
      await runtime.start(startOptions)
      const pending = runtime.prompt([...prompt])
      const response = agent.request('permission', 'session/request_permission', permission)
      const signal = await entered.promise
      const frame = agent.frames.find((candidate) => candidate.method === 'session/prompt')
      if (frame) {
        agent.reply(frame, { stopReason: 'end_turn' })
      }
      await pending
      expect(signal.aborted).toBe(false)
      if (action === 'answer') {
        decision.resolve({ outcome: { outcome: 'selected', optionId: 'allow' } })
        expect(await response).toMatchObject({
          result: { outcome: { outcome: 'selected', optionId: 'allow' } }
        })
      } else {
        await runtime.cancel()
        expect(await response).toMatchObject({ result: { outcome: { outcome: 'cancelled' } } })
      }
    }
  )

  it('confirms cancellation when the agent settles the prompt with an error', async () => {
    const { agent, runtime } = fixture()
    agent.on('session/prompt', (frame) => {
      agent.on('session/cancel', () => agent.fail(frame, -32800, 'Request cancelled'))
    })
    await runtime.start(startOptions)
    const rejected = expect(runtime.prompt([...prompt])).rejects.toMatchObject({ code: -32800 })
    await expect(runtime.cancel()).resolves.toBeUndefined()
    await rejected
  })
})
