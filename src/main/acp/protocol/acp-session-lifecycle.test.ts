import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'

import { AcpSessionRuntime } from './acp-session-runtime'
import type { AcpSessionRuntimeOptions } from './acp-session-runtime-options'
import {
  AcpScriptedAgent,
  deferred,
  tick
} from '../process/testing/acp-scripted-agent.test-support'
import { AcpConnectionClosedError } from '../transport/acp-errors'
import type { RequestPermissionResponse } from '../generated/acp-protocol.generated'

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
    { kind: 'new', expected: { kind: 'new', sessionId: 'session-1' } },
    { kind: 'load', expected: { kind: 'load', sessionId: 'saved-session' } },
    { kind: 'resume', expected: { kind: 'resume', sessionId: 'saved-session' } }
  ] as const)(
    'opens a slow $kind session on its real answers, regardless of the peer default',
    async ({ kind, expected }) => {
      vi.useFakeTimers()
      const { agent, runtime } = fixture({ peer: { requestTimeoutMs: 20 } })
      agent.on('initialize', (frame) => {
        setTimeout(
          () =>
            agent.reply(frame, {
              protocolVersion: 1,
              agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } }
            }),
          75_000
        )
      })
      agent.on(`session/${kind}`, (frame) => {
        setTimeout(
          () => agent.reply(frame, kind === 'new' ? { sessionId: 'session-1' } : {}),
          310_000
        )
      })
      const started = expect(
        runtime.start({
          ...startOptions,
          ...(kind === 'new' ? {} : { sessionId: 'saved-session', resumePreference: kind })
        })
      ).resolves.toMatchObject(expected)
      await vi.advanceTimersByTimeAsync(385_000)
      await started
      agent.on('session/prompt', (frame) => agent.reply(frame, { stopReason: 'end_turn' }))
      await expect(runtime.prompt([...prompt])).resolves.toEqual({ stopReason: 'end_turn' })
    }
  )

  it('keeps a handler answer that finishes saving after its owner withdraws requests', async () => {
    const withdrawal = new AbortController()
    const planEntered = deferred<void>()
    const questionEntered = deferred<void>()
    const savePlan = deferred<void>()
    const saveQuestion = deferred<void>()
    onTestFinished(() => {
      withdrawal.abort()
      savePlan.resolve()
      saveQuestion.resolve()
    })
    const { agent, runtime } = fixture({
      onRequest: async (method) => {
        if (method === '_vendor/plan') {
          planEntered.resolve()
          await savePlan.promise
          return { outcome: 'approved' }
        }
        await new Promise<void>((resolve) =>
          withdrawal.signal.addEventListener('abort', () => resolve(), { once: true })
        )
        questionEntered.resolve()
        await saveQuestion.promise
        return { outcome: 'abandoned' }
      }
    })
    agent.on('session/prompt', (frame) =>
      agent.on('session/cancel', () => agent.reply(frame, { stopReason: 'cancelled' }))
    )
    await runtime.start(startOptions)
    const pending = runtime.prompt([...prompt])
    const plan = agent.request('plan', '_vendor/plan', {})
    const question = agent.request('question', '_vendor/question', {})
    await planEntered.promise
    await runtime.cancel()
    withdrawal.abort()
    await questionEntered.promise
    expect(agent.frames.filter((frame) => frame.id === 'plan' || frame.id === 'question')).toEqual(
      []
    )
    savePlan.resolve()
    saveQuestion.resolve()
    expect(await plan).toMatchObject({ result: { outcome: 'approved' } })
    expect(await question).toMatchObject({ result: { outcome: 'abandoned' } })
    await pending
    await tick()
    expect(agent.frames.filter((frame) => frame.id === 'plan')).toHaveLength(1)
    expect(agent.frames.filter((frame) => frame.id === 'question')).toHaveLength(1)
  })

  it('settles stream-level requests on close even if stdout stays open', async () => {
    const { agent, runtime } = fixture()
    agent.on('session/prompt', () => {})
    await runtime.start(startOptions)
    const rejected = expect(runtime.prompt([...prompt])).rejects.toThrow('Agent exited')
    expect(agent.stdout.readableEnded).toBe(false)
    runtime.close(new Error('Agent exited'))
    await rejected
    expect(agent.stdout.readableEnded).toBe(false)
  })

  it('writes cancel independently of the agent settling the prompt with an error', async () => {
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
