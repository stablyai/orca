import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { OrcaRuntimeService } from '../orca-runtime'
import { defineMethod, type RpcRequest } from './core'
import { RpcDispatcher } from './dispatcher'

const handler = vi.fn(() => ({ source: 'server' }))
const methods = [
  defineMethod({
    name: 'browser.click',
    params: z.object({ page: z.string(), x: z.number() }),
    handler
  })
]

function request(params: unknown): RpcRequest {
  return { id: 'request-a', authToken: 'token-a', method: 'browser.click', params }
}

function runtime(routeClientHostedBrowserRpc?: OrcaRuntimeService['routeClientHostedBrowserRpc']) {
  return {
    getRuntimeId: () => 'runtime-a',
    routeClientHostedBrowserRpc
  } as OrcaRuntimeService
}

describe('RpcDispatcher client-hosted browser automation', () => {
  beforeEach(() => {
    handler.mockClear()
  })

  it('routes parsed client page params without invoking the server handler', async () => {
    const route = vi.fn(async () => ({ handled: true as const, result: { source: 'client' } }))
    const dispatcher = new RpcDispatcher({ runtime: runtime(route), methods })

    await expect(dispatcher.dispatch(request({ page: 'page-a', x: 10 }))).resolves.toMatchObject({
      ok: true,
      result: { source: 'client' }
    })
    expect(route).toHaveBeenCalledWith('browser.click', { page: 'page-a', x: 10 })
    expect(handler).not.toHaveBeenCalled()
  })

  it('keeps server pages on the ordinary handler', async () => {
    const route = vi.fn(async () => ({ handled: false as const }))
    const dispatcher = new RpcDispatcher({ runtime: runtime(route), methods })

    await expect(
      dispatcher.dispatch(request({ page: 'page-server', x: 11 }))
    ).resolves.toMatchObject({ ok: true, result: { source: 'server' } })
    expect(handler).toHaveBeenCalledOnce()
  })

  it('routes non-streaming methods received through the streaming transport', async () => {
    const route = vi.fn(async () => ({ handled: true as const, result: { source: 'client' } }))
    const dispatcher = new RpcDispatcher({ runtime: runtime(route), methods })
    const replies: string[] = []

    await dispatcher.dispatchStreaming(request({ page: 'page-a', x: 12 }), (reply) =>
      replies.push(reply)
    )

    expect(JSON.parse(replies[0]!)).toMatchObject({
      ok: true,
      result: { source: 'client' }
    })
    expect(handler).not.toHaveBeenCalled()
  })

  it('rejects invalid params before attempting client routing', async () => {
    const route = vi.fn(async () => ({ handled: true as const, result: {} }))
    const dispatcher = new RpcDispatcher({ runtime: runtime(route), methods })

    await expect(dispatcher.dispatch(request({ page: 'page-a' }))).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_argument' }
    })
    expect(route).not.toHaveBeenCalled()
  })

  it('supports narrowed test runtimes without a routing method', async () => {
    const dispatcher = new RpcDispatcher({ runtime: runtime(), methods })

    await expect(
      dispatcher.dispatch(request({ page: 'page-server', x: 13 }))
    ).resolves.toMatchObject({ ok: true, result: { source: 'server' } })
  })
})
