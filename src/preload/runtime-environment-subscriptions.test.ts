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

type SubscriptionEvent =
  | {
      subscriptionId: string
      type: 'response'
      response: { ok: true; id: string; result: unknown; _meta: { runtimeId: string } }
    }
  | { subscriptionId: string; type: 'binary'; bytes: Uint8Array<ArrayBufferLike> }
  | { subscriptionId: string; type: 'error'; code: string; message: string }
  | { subscriptionId: string; type: 'close' }

type SubscriptionEventListener = (_event: unknown, payload: SubscriptionEvent) => void

function createIpc() {
  const listeners = new Set<SubscriptionEventListener>()
  return {
    invoke: vi.fn((_channel: string, _args?: unknown) => Promise.resolve({}) as Promise<unknown>),
    send: vi.fn(),
    on: vi.fn((_channel: string, listener: SubscriptionEventListener) => {
      listeners.add(listener)
    }),
    removeListener: vi.fn((_channel: string, listener: SubscriptionEventListener) => {
      listeners.delete(listener)
    }),
    emitSubscriptionEvent: (event: SubscriptionEvent): void => {
      const currentListeners = Array.from(listeners)
      for (const listener of currentListeners) {
        listener(null, event)
      }
    },
    listenerCount: (): number => listeners.size
  }
}

function dispatch(ipc: ReturnType<typeof createIpc>, event: SubscriptionEvent): void {
  // A single shared channel listener is registered for the ipc instance; route
  // through it the same way the real ipcRenderer would deliver the frame.
  ipc.emitSubscriptionEvent(event)
}

describe('subscribeRuntimeEnvironmentFromPreload', () => {
  it('registers the subscription event listener before invoking main', async () => {
    const subscription = deferred<{ subscriptionId: string; requestId: string }>()
    const ipc = createIpc()
    ipc.invoke.mockImplementation((channel: string) =>
      channel === 'runtimeEnvironments:subscribe'
        ? (subscription.promise as Promise<unknown>)
        : (Promise.resolve({}) as Promise<unknown>)
    )
    const onResponse = vi.fn()
    const onBinary = vi.fn()

    const cleanupPromise = subscribeRuntimeEnvironmentFromPreload(
      ipc,
      { selector: 'desk', method: 'terminal.subscribe' },
      { onResponse, onBinary },
      () => 'sub-1'
    )

    expect(ipc.on).toHaveBeenCalledWith(
      'runtimeEnvironments:subscriptionEvent',
      expect.any(Function)
    )
    expect(ipc.invoke).toHaveBeenCalledWith('runtimeEnvironments:subscribe', {
      selector: 'desk',
      method: 'terminal.subscribe',
      subscriptionId: 'sub-1'
    })

    dispatch(ipc, {
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
    const inboundBytes = new Uint8Array([4, 5, 6])
    dispatch(ipc, {
      subscriptionId: 'sub-1',
      type: 'binary',
      bytes: inboundBytes
    })
    expect(onBinary).toHaveBeenCalledWith(inboundBytes)

    subscription.resolve({ subscriptionId: 'sub-1', requestId: 'rpc-1' })
    const cleanup = await cleanupPromise
    const bytes = new Uint8Array([1, 2, 3])
    cleanup.sendBinary(bytes)
    expect(ipc.send).toHaveBeenCalledWith('runtimeEnvironments:subscriptionBinary', {
      subscriptionId: 'sub-1',
      bytes
    })
    cleanup.unsubscribe()
    expect(ipc.invoke).toHaveBeenCalledWith('runtimeEnvironments:unsubscribe', {
      subscriptionId: 'sub-1'
    })
    expect(ipc.removeListener).toHaveBeenCalledWith(
      'runtimeEnvironments:subscriptionEvent',
      ipc.on.mock.calls[0][1]
    )
    expect(ipc.listenerCount()).toBe(0)

    // After unsubscribe, frames for the released id must no longer reach the
    // consumer (the dispatcher dropped its closure).
    onResponse.mockClear()
    dispatch(ipc, {
      subscriptionId: 'sub-1',
      type: 'response',
      response: { id: 'rpc-2', ok: true, result: {}, _meta: { runtimeId: 'rt' } }
    })
    expect(onResponse).not.toHaveBeenCalled()
  })

  it('shares a single channel listener across many subscriptions on one ipc', async () => {
    const ipc = createIpc()
    ipc.invoke.mockImplementation((channel: string, args: unknown) =>
      channel === 'runtimeEnvironments:subscribe'
        ? Promise.resolve({
            subscriptionId: (args as { subscriptionId: string }).subscriptionId,
            requestId: 'rpc'
          })
        : (Promise.resolve({}) as Promise<unknown>)
    )

    let counter = 0
    const onResponses = Array.from({ length: 25 }, () => vi.fn())
    const handles = await Promise.all(
      onResponses.map((onResponse) =>
        subscribeRuntimeEnvironmentFromPreload(
          ipc,
          { selector: 'desk', method: 'session.tabs.subscribe' },
          { onResponse },
          () => `sub-${counter++}`
        )
      )
    )

    // O(1) attached listeners regardless of subscription count - the leak guard.
    expect(ipc.on).toHaveBeenCalledTimes(1)
    expect(ipc.removeListener).not.toHaveBeenCalled()
    expect(handles).toHaveLength(25)

    handles[0].unsubscribe()
    dispatch(ipc, {
      subscriptionId: 'sub-0',
      type: 'response',
      response: { id: 'rpc', ok: true, result: {}, _meta: { runtimeId: 'rt' } }
    })
    dispatch(ipc, {
      subscriptionId: 'sub-1',
      type: 'response',
      response: { id: 'rpc', ok: true, result: {}, _meta: { runtimeId: 'rt' } }
    })
    expect(onResponses[0]).not.toHaveBeenCalled()
    expect(onResponses[1]).toHaveBeenCalledTimes(1)
    expect(ipc.removeListener).not.toHaveBeenCalled()
    expect(ipc.listenerCount()).toBe(1)

    for (const handle of handles.slice(1)) {
      handle.unsubscribe()
    }
    expect(ipc.removeListener).toHaveBeenCalledTimes(1)
    expect(ipc.listenerCount()).toBe(0)
  })

  it('keeps the subscription mapped on error frames but releases it on unsubscribe', async () => {
    const ipc = createIpc()
    ipc.invoke.mockImplementation((channel: string) =>
      channel === 'runtimeEnvironments:subscribe'
        ? Promise.resolve({ subscriptionId: 'sub-err', requestId: 'rpc-err' })
        : (Promise.resolve({}) as Promise<unknown>)
    )
    const onResponse = vi.fn()
    const onError = vi.fn()

    const cleanup = await subscribeRuntimeEnvironmentFromPreload(
      ipc,
      { selector: 'desk', method: 'runtime.clientEvents.subscribe' },
      { onResponse, onError },
      () => 'sub-err'
    )

    // Error frames are non-terminal: shared-control subscriptions survive
    // reconnects, so repeated errors must NOT detach the dispatcher and must keep
    // delivering to the live consumer rather than leaking a zombie listener.
    for (let i = 0; i < 50; i++) {
      dispatch(ipc, {
        subscriptionId: 'sub-err',
        type: 'error',
        code: 'TIMEOUT',
        message: 'Timed out waiting for the remote Orca runtime to respond.'
      })
    }
    expect(onError).toHaveBeenCalledTimes(50)
    expect(ipc.removeListener).not.toHaveBeenCalled()
    expect(ipc.listenerCount()).toBe(1)

    // The consumer's unsubscribe is the single release path. After it, error
    // frames for the same id no longer reach the consumer - no retained closure.
    cleanup.unsubscribe()
    expect(ipc.invoke).toHaveBeenCalledWith('runtimeEnvironments:unsubscribe', {
      subscriptionId: 'sub-err'
    })
    expect(ipc.removeListener).toHaveBeenCalledTimes(1)
    expect(ipc.listenerCount()).toBe(0)
    onError.mockClear()
    dispatch(ipc, {
      subscriptionId: 'sub-err',
      type: 'error',
      code: 'TIMEOUT',
      message: 'still erroring'
    })
    expect(onError).not.toHaveBeenCalled()
  })

  it('removes the subscription from dispatch when main rejects the subscribe call', async () => {
    const subscription = deferred<{ subscriptionId: string; requestId: string }>()
    const ipc = createIpc()
    ipc.invoke.mockImplementation((channel: string) =>
      channel === 'runtimeEnvironments:subscribe'
        ? (subscription.promise as Promise<unknown>)
        : (Promise.resolve({}) as Promise<unknown>)
    )
    const onResponse = vi.fn()

    const cleanupPromise = subscribeRuntimeEnvironmentFromPreload(
      ipc,
      { selector: 'desk', method: 'terminal.subscribe' },
      { onResponse },
      () => 'sub-2'
    )

    const error = new Error('subscribe failed')
    subscription.reject(error)
    await expect(cleanupPromise).rejects.toThrow(error)
    expect(ipc.removeListener).toHaveBeenCalledTimes(1)
    expect(ipc.listenerCount()).toBe(0)

    // A rejected subscribe must not leave a routable entry behind.
    dispatch(ipc, {
      subscriptionId: 'sub-2',
      type: 'response',
      response: { id: 'rpc', ok: true, result: {}, _meta: { runtimeId: 'rt' } }
    })
    expect(onResponse).not.toHaveBeenCalled()
  })

  it('releases the subscription from dispatch when main resolves a different id', async () => {
    const ipc = createIpc()
    ipc.invoke.mockImplementation((channel: string) =>
      channel === 'runtimeEnvironments:subscribe'
        ? Promise.resolve({ subscriptionId: 'sub-other', requestId: 'rpc' })
        : (Promise.resolve({}) as Promise<unknown>)
    )
    const onResponse = vi.fn()

    await expect(
      subscribeRuntimeEnvironmentFromPreload(
        ipc,
        { selector: 'desk', method: 'terminal.subscribe' },
        { onResponse },
        () => 'sub-expected'
      )
    ).rejects.toThrow('Runtime environment subscription id mismatch')
    expect(ipc.removeListener).toHaveBeenCalledTimes(1)
    expect(ipc.listenerCount()).toBe(0)

    dispatch(ipc, {
      subscriptionId: 'sub-expected',
      type: 'response',
      response: { id: 'rpc', ok: true, result: {}, _meta: { runtimeId: 'rt' } }
    })
    expect(onResponse).not.toHaveBeenCalled()
  })

  it('releases the subscription when main reports the remote subscription closed', async () => {
    const ipc = createIpc()
    ipc.invoke.mockImplementation((channel: string) =>
      channel === 'runtimeEnvironments:subscribe'
        ? Promise.resolve({ subscriptionId: 'sub-closed', requestId: 'rpc-closed' })
        : (Promise.resolve({}) as Promise<unknown>)
    )
    const onClose = vi.fn()

    const cleanup = await subscribeRuntimeEnvironmentFromPreload(
      ipc,
      { selector: 'desk', method: 'terminal.subscribe' },
      { onResponse: vi.fn(), onClose },
      () => 'sub-closed'
    )

    dispatch(ipc, { subscriptionId: 'other-sub', type: 'close' })
    expect(onClose).not.toHaveBeenCalled()

    dispatch(ipc, { subscriptionId: 'sub-closed', type: 'close' })
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(ipc.removeListener).toHaveBeenCalledTimes(1)
    expect(ipc.listenerCount()).toBe(0)

    // The entry is already gone. A redundant unsubscribe is still safe.
    onClose.mockClear()
    cleanup.unsubscribe()
    dispatch(ipc, { subscriptionId: 'sub-closed', type: 'close' })
    expect(onClose).not.toHaveBeenCalled()
    expect(ipc.invoke).toHaveBeenCalledWith('runtimeEnvironments:unsubscribe', {
      subscriptionId: 'sub-closed'
    })
    expect(ipc.removeListener).toHaveBeenCalledTimes(1)
  })

  it('releases close frames before calling onClose', async () => {
    const ipc = createIpc()
    ipc.invoke.mockImplementation((channel: string) =>
      channel === 'runtimeEnvironments:subscribe'
        ? Promise.resolve({ subscriptionId: 'sub-throw', requestId: 'rpc-throw' })
        : (Promise.resolve({}) as Promise<unknown>)
    )
    const onClose = vi.fn(() => {
      throw new Error('close failed')
    })

    await subscribeRuntimeEnvironmentFromPreload(
      ipc,
      { selector: 'desk', method: 'terminal.subscribe' },
      { onResponse: vi.fn(), onClose },
      () => 'sub-throw'
    )

    expect(() => dispatch(ipc, { subscriptionId: 'sub-throw', type: 'close' })).toThrow(
      'close failed'
    )
    expect(ipc.removeListener).toHaveBeenCalledTimes(1)
    expect(ipc.listenerCount()).toBe(0)
  })
})
