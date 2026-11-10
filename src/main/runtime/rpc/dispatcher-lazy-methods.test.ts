import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { RpcDispatcher } from './dispatcher'
import { defineMethod, defineStreamingMethod, type RpcRequest, type RpcResponse } from './core'
import type { OrcaRuntimeService } from '../orca-runtime'
import type { RpcMethodLoader } from './rpc-method-source'

const request = (method: string, id = 'r1', params: unknown = {}): RpcRequest => ({
  id,
  authToken: 't',
  method,
  params
})

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the dispatcher reads only these runtime members for plain methods.
const runtime = {
  getRuntimeId: () => 'rt',
  recordFeatureInteraction: vi.fn()
} as unknown as OrcaRuntimeService

const echo = defineMethod({
  name: 'test.echo',
  permission: 'workspace',
  params: z.object({ value: z.string().optional() }),
  handler: (params) => ({ echoed: params.value ?? null })
})

const ticks = defineStreamingMethod({
  name: 'test.ticks',
  permission: 'workspace',
  params: z.object({}),
  handler: async (_params, _ctx, emit) => {
    emit({ tick: 1 })
  }
})

function deferredLoader(): {
  loader: RpcMethodLoader & ReturnType<typeof vi.fn>
  resolve: () => void
  reject: (error: Error) => void
} {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const loader = vi.fn(
    () =>
      new Promise<readonly (typeof echo | typeof ticks)[]>((res, rej) => {
        resolve = () => res([echo, ticks])
        reject = rej
      })
  )
  return {
    loader,
    resolve: () => resolve(),
    reject: (error) => reject(error)
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('RpcDispatcher with lazily loaded methods', () => {
  it('does not load methods until the first call', async () => {
    const loader = vi.fn(async () => [echo])
    const dispatcher = new RpcDispatcher({ runtime, methods: loader })
    expect(loader).not.toHaveBeenCalled()

    await expect(dispatcher.dispatch(request('test.echo', 'r1', { value: 'a' }))).resolves.toEqual(
      expect.objectContaining({ ok: true, result: { echoed: 'a' } })
    )
    await dispatcher.dispatch(request('test.echo', 'r2'))
    expect(loader).toHaveBeenCalledOnce()
  })

  it('answers an unknown method with method_not_found once methods load', async () => {
    const dispatcher = new RpcDispatcher({ runtime, methods: async () => [echo] })

    await expect(dispatcher.dispatch(request('test.missing'))).resolves.toMatchObject({
      ok: false,
      error: { code: 'method_not_found', message: 'Unknown method: test.missing' }
    })
  })

  it('surfaces an import failure as an RPC error, then retries on the next call', async () => {
    const loader = vi
      .fn<RpcMethodLoader>()
      .mockRejectedValueOnce(new Error('Cannot find module ./terminal'))
      .mockResolvedValue([echo])
    const dispatcher = new RpcDispatcher({ runtime, methods: loader })

    await expect(dispatcher.dispatch(request('test.echo', 'r1'))).resolves.toMatchObject({
      id: 'r1',
      ok: false,
      error: { message: 'RPC methods failed to load: Cannot find module ./terminal' }
    })
    await expect(dispatcher.dispatch(request('test.echo', 'r2'))).resolves.toMatchObject({
      id: 'r2',
      ok: true
    })
    expect(loader).toHaveBeenCalledTimes(2)
  })

  it('reports an import failure on the streaming path too', async () => {
    const dispatcher = new RpcDispatcher({
      runtime,
      methods: () => Promise.reject(new Error('boom'))
    })
    const replies: RpcResponse[] = []

    await dispatcher.dispatchStreamingObjects(request('test.ticks'), (reply) => replies.push(reply))

    expect(replies).toEqual([
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ message: 'RPC methods failed to load: boom' })
      })
    ])
  })

  it('shares one load across concurrent first calls', async () => {
    const { loader, resolve } = deferredLoader()
    const dispatcher = new RpcDispatcher({ runtime, methods: loader })
    let settled = 0
    const streamed: RpcResponse[] = []

    const first = dispatcher.dispatch(request('test.echo', 'a')).finally(() => settled++)
    const stream = dispatcher
      .dispatchStreamingObjects(request('test.ticks', 'b'), (reply) => streamed.push(reply))
      .finally(() => settled++)
    const unknown = dispatcher.dispatch(request('test.missing', 'c')).finally(() => settled++)
    await new Promise((r) => setTimeout(r, 0))
    expect(loader).toHaveBeenCalledOnce()
    expect(settled).toBe(0)

    resolve()

    await expect(first).resolves.toMatchObject({ id: 'a', ok: true })
    await stream
    expect(streamed).toEqual([expect.objectContaining({ id: 'b', result: { tick: 1 } })])
    await expect(unknown).resolves.toMatchObject({ id: 'c', error: { code: 'method_not_found' } })
    expect(loader).toHaveBeenCalledOnce()
  })

  it('preloads once, never rejects, and leaves a failed preload to the next call', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const loader = vi
      .fn<RpcMethodLoader>()
      .mockRejectedValueOnce(new Error('disk gone'))
      .mockResolvedValue([echo])
    const dispatcher = new RpcDispatcher({ runtime, methods: loader })

    await expect(dispatcher.preloadMethods()).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledWith('[runtime] RPC methods failed to load: disk gone')

    await dispatcher.preloadMethods()
    await dispatcher.dispatch(request('test.echo'))
    expect(loader).toHaveBeenCalledTimes(2)
  })

  it('keeps a method list synchronous: preload is a no-op', async () => {
    const dispatcher = new RpcDispatcher({ runtime, methods: [echo] })

    await expect(dispatcher.preloadMethods()).resolves.toBeUndefined()
    await expect(dispatcher.dispatch(request('test.echo'))).resolves.toMatchObject({ ok: true })
  })

  it('still rejects duplicate method names, when the methods load', async () => {
    const dispatcher = new RpcDispatcher({ runtime, methods: async () => [echo, echo] })

    await expect(dispatcher.dispatch(request('test.echo'))).resolves.toMatchObject({
      ok: false,
      error: { message: 'RPC methods failed to load: duplicate_rpc_method:test.echo' }
    })
  })
})
