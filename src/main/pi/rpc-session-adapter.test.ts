import { afterEach, describe, expect, it } from 'vitest'
import { AgentSessionAcquisitionRootExitObservedError } from '../native-chat/agent-session-wire/acquisition/structured-agent-session-acquisition-errors'
import { retryableAgentSessionAcquisition } from '../native-chat/agent-session-wire/startup/structured-agent-session-start-failure'
import { closePiRpcAdapterFixtures, sessionId, setup } from './rpc-session-adapter.test-fixture'

afterEach(closePiRpcAdapterFixtures)

describe('Pi RPC session ownership and delivery', () => {
  it('does not spawn a start cancelled while resolving its workspace', async () => {
    const h = await setup()
    await h.adapter.closeSession(sessionId)
    const launch = await h.resolveLaunch.mock.results[0]?.value
    const resolving = Promise.withResolvers<NonNullable<typeof launch>>()
    h.resolveLaunch.mockImplementationOnce(() => resolving.promise)
    const controller = new AbortController()
    const started = h.adapter.acquire({ ...h.input, fence: 8, signal: controller.signal })
    await Promise.resolve()
    controller.abort(new Error('Pi closed while starting'))
    await expect(started).rejects.toMatchObject({
      message: 'Pi closed while starting',
      reason: undefined
    })
    expect(h.connections).toHaveLength(1)
    await expect(h.adapter.acquire({ ...h.input, fence: 9 })).resolves.toMatchObject({
      process: { pid: 4123 }
    })
    resolving.resolve(launch!)
    await Promise.resolve()
    expect(h.connections).toHaveLength(2)
  })

  it('keeps the unanswered exit verdict while process identity recording is held', async () => {
    const h = await setup()
    const entered = Promise.withResolvers<void>()
    const recorded = Promise.withResolvers<void>()
    await h.adapter.closeSession(sessionId)
    await h.adapter.drainObservedExits()
    const acquiring = h.adapter
      .acquire({
        ...h.input,
        fence: 8,
        onSpawned: () => {
          entered.resolve()
          return recorded.promise
        }
      })
      .catch((error: unknown) => error)
    await entered.promise
    const child = h.connections.at(-1)
    if (!child) {
      throw new Error('held acquisition has no child')
    }
    child.exit()
    recorded.resolve()
    const error = await acquiring
    expect(error).toBeInstanceOf(AgentSessionAcquisitionRootExitObservedError)
    expect(retryableAgentSessionAcquisition(error)).toBe(true)
    expect(error).toMatchObject({ cause: { retry: 'safe', fact: { kind: 'providerStartFailed' } } })
  })

  it('keeps cancellation authoritative after an exit during held identity recording', async () => {
    const h = await setup()
    const controller = new AbortController()
    const entered = Promise.withResolvers<void>()
    const recorded = Promise.withResolvers<void>()
    await h.adapter.closeSession(sessionId)
    await h.adapter.drainObservedExits()
    const acquiring = h.adapter
      .acquire({
        ...h.input,
        fence: 8,
        signal: controller.signal,
        onSpawned: () => {
          entered.resolve()
          return recorded.promise
        }
      })
      .catch((error: unknown) => error)
    await entered.promise
    const child = h.connections.at(-1)
    if (!child) {
      throw new Error('held acquisition has no child')
    }
    child.exit()
    controller.abort(new Error('person cancelled the held start'))
    recorded.resolve()
    const error = await acquiring
    expect(error).toBeInstanceOf(AgentSessionAcquisitionRootExitObservedError)
    expect(retryableAgentSessionAcquisition(error)).toBe(false)
  })
})
