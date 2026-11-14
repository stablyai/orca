import { afterEach, describe, expect, it, onTestFinished } from 'vitest'

import { AcpSessionRuntime } from './acp-session-runtime'
import type { AcpSessionRuntimeOptions } from './acp-session-runtime-options'
import {
  AcpScriptedAgent,
  deferred,
  tick
} from '../process/testing/acp-scripted-agent.test-support'

const opened: { close: () => void }[] = []
const startOptions = { cwd: '/runtime/project', mcpServers: [] }
const prompt = [{ type: 'text', text: 'hello' }] as const
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
})

describe('ACP caller-owned waits', () => {
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
