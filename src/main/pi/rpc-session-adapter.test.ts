import { afterEach, describe, expect, it } from 'vitest'
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
})
