import { describe, expect, it, vi } from 'vitest'
import { subscribeRuntimeEnvironmentFromPreload } from './runtime-environment-subscriptions'

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, resolve, reject }
}

describe('subscribeRuntimeEnvironmentFromPreload', () => {
  it('registers the subscription event listener before invoking main', async () => {
    const subscription = deferred<{ subscriptionId: string; requestId: string }>()
    const invoke = vi.fn(() => subscription.promise as Promise<unknown>)
    const send = vi.fn()
    const on = vi.fn()
    const removeListener = vi.fn()
    const onResponse = vi.fn()

    const cleanupPromise = subscribeRuntimeEnvironmentFromPreload(
      { invoke, send, on, removeListener },
      { selector: 'desk', method: 'terminal.subscribe' },
      { onResponse },
      () => 'sub-1'
    )

    expect(on).toHaveBeenCalledWith('runtimeEnvironments:subscriptionEvent', expect.any(Function))
    expect(invoke).toHaveBeenCalledWith('runtimeEnvironments:subscribe', {
      selector: 'desk',
      method: 'terminal.subscribe',
      subscriptionId: 'sub-1'
    })

    const listener = on.mock.calls[0][1] as (
      _event: unknown,
      payload: {
        subscriptionId: string
        type: 'response'
        response: { ok: true; id: string; result: unknown; _meta: { runtimeId: string } }
      }
    ) => void
    listener(null, {
      subscriptionId: 'sub-1',
      type: 'response',
      response: {
        id: 'rpc-1',
        ok: true,
        result: { type: 'subscribed' },
        _meta: { runtimeId: 'rt' }
      }
    })
    expect(onResponse).toHaveBeenCalledWith({
      id: 'rpc-1',
      ok: true,
      result: { type: 'subscribed' },
      _meta: { runtimeId: 'rt' }
    })

    subscription.resolve({ subscriptionId: 'sub-1', requestId: 'rpc-1' })
    const cleanup = await cleanupPromise
    const bytes = new Uint8Array([1, 2, 3])
    cleanup.sendBinary(bytes)
    expect(send).toHaveBeenCalledWith('runtimeEnvironments:subscriptionBinary', {
      subscriptionId: 'sub-1',
      bytes
    })
    cleanup.unsubscribe()
    expect(removeListener).toHaveBeenCalledWith('runtimeEnvironments:subscriptionEvent', listener)
    expect(invoke).toHaveBeenCalledWith('runtimeEnvironments:unsubscribe', {
      subscriptionId: 'sub-1'
    })
  })

  it('removes the listener when main rejects the subscribe call', async () => {
    const subscription = deferred<{ subscriptionId: string; requestId: string }>()
    const invoke = vi.fn(() => subscription.promise as Promise<unknown>)
    const send = vi.fn()
    const on = vi.fn()
    const removeListener = vi.fn()

    const cleanupPromise = subscribeRuntimeEnvironmentFromPreload(
      { invoke, send, on, removeListener },
      { selector: 'desk', method: 'terminal.subscribe' },
      { onResponse: vi.fn() },
      () => 'sub-2'
    )

    const error = new Error('subscribe failed')
    subscription.reject(error)
    await expect(cleanupPromise).rejects.toThrow(error)
    expect(removeListener).toHaveBeenCalledWith(
      'runtimeEnvironments:subscriptionEvent',
      on.mock.calls[0][1]
    )
  })
})
