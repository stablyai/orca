import { beforeEach, describe, expect, it, vi } from 'vitest'

const { handleMock, subscribeRuntimeEnvironmentMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  subscribeRuntimeEnvironmentMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/user-data') },
  ipcMain: {
    handle: handleMock,
    on: vi.fn(),
    removeHandler: vi.fn(),
    removeAllListeners: vi.fn()
  }
}))

vi.mock('../../shared/runtime-environment-store', () => ({
  resolveEnvironment: vi.fn(() => ({
    id: 'environment-a',
    createdAt: 1,
    pairingRevision: 1
  }))
}))

vi.mock('./runtime-environment-connectivity-handlers', () => ({
  isRuntimeEnvironmentManuallyDisconnected: vi.fn(() => false),
  registerRuntimeEnvironmentConnectivityHandlers: vi.fn(),
  registerRuntimeEnvironmentPassiveHandlers: vi.fn()
}))

vi.mock('./runtime-environment-recovery-handler', () => ({
  registerRuntimeEnvironmentRecoveryHandler: vi.fn()
}))

vi.mock('./runtime-environment-request-connections', () => ({
  closeRemoteRuntimeRequestConnection: vi.fn()
}))

vi.mock('./runtime-environment-transport-generation', () => ({
  advanceRuntimeEnvironmentTransportGeneration: vi.fn(),
  getRuntimeEnvironmentTransportGeneration: vi.fn(() => 0)
}))

vi.mock('./runtime-environment-transport-routing', () => ({
  clearSharedControlSupport: vi.fn(),
  resetSharedControlSupport: vi.fn(),
  subscribeRuntimeEnvironment: subscribeRuntimeEnvironmentMock
}))

import { registerRuntimeEnvironmentHandlers } from './runtime-environments'

function handler<TArgs, TResult>(
  channel: string
): (event: { sender: Record<string, unknown> }, args: TArgs) => TResult | Promise<TResult> {
  const match = handleMock.mock.calls.find((call) => call[0] === channel)
  if (!match) {
    throw new Error(`Missing IPC handler: ${channel}`)
  }
  return match[1]
}

beforeEach(() => {
  vi.clearAllMocks()
  registerRuntimeEnvironmentHandlers({} as never)
})

describe('pending runtime environment subscription handler', () => {
  it('aborts only when the owning sender unsubscribes', async () => {
    let setupSignal: AbortSignal | undefined
    subscribeRuntimeEnvironmentMock.mockImplementation(
      (_userDataPath, _selector, _method, _params, _timeoutMs, _callbacks, signal: AbortSignal) => {
        setupSignal = signal
        return new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              const error = new Error('setup aborted')
              error.name = 'AbortError'
              reject(error)
            },
            { once: true }
          )
        })
      }
    )
    const subscribe = handler<
      { selector: string; method: string; subscriptionId: string },
      { subscriptionId: string; requestId: string }
    >('runtimeEnvironments:subscribe')
    const pending = subscribe(
      {
        sender: {
          id: 1,
          isDestroyed: () => false,
          send: vi.fn(),
          once: vi.fn(),
          removeListener: vi.fn()
        }
      },
      {
        selector: 'environment-a',
        method: 'files.watch',
        subscriptionId: 'pending-subscription'
      }
    )
    const unsubscribe = handler<{ subscriptionId: string }, { unsubscribed: boolean }>(
      'runtimeEnvironments:unsubscribe'
    )

    expect(setupSignal?.aborted).toBe(false)
    expect(unsubscribe({ sender: { id: 2 } }, { subscriptionId: 'pending-subscription' })).toEqual({
      unsubscribed: false
    })
    expect(setupSignal?.aborted).toBe(false)
    expect(unsubscribe({ sender: { id: 1 } }, { subscriptionId: 'pending-subscription' })).toEqual({
      unsubscribed: true
    })
    expect(setupSignal?.aborted).toBe(true)
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('ignores a delayed close from an unsubscribed id after it is reused', async () => {
    type SubscriptionEvent =
      | { type: 'close' }
      | {
          type: 'response'
          response: {
            id: string
            ok: true
            result: unknown
            _meta: { runtimeId: string }
          }
        }
    const callbacks: { onEvent: (payload: SubscriptionEvent) => void; onClose: () => void }[] = []
    const closeFirst = vi.fn()
    const closeReplacement = vi.fn()
    const handles = [
      { requestId: 'first-request', close: closeFirst, sendBinary: vi.fn() },
      { requestId: 'replacement-request', close: closeReplacement, sendBinary: vi.fn() }
    ]
    subscribeRuntimeEnvironmentMock.mockImplementation(
      async (_userDataPath, _selector, _method, _params, _timeoutMs, subscriptionCallbacks) => {
        callbacks.push(subscriptionCallbacks)
        return handles.shift()
      }
    )
    const subscribe = handler<
      { selector: string; method: string; subscriptionId: string },
      { subscriptionId: string; requestId: string }
    >('runtimeEnvironments:subscribe')
    const unsubscribe = handler<{ subscriptionId: string }, { unsubscribed: boolean }>(
      'runtimeEnvironments:unsubscribe'
    )
    const send = vi.fn()
    const sender = {
      id: 1,
      isDestroyed: () => false,
      send,
      once: vi.fn(),
      removeListener: vi.fn()
    }
    const event = { sender }
    const args = {
      selector: 'environment-a',
      method: 'files.watch',
      subscriptionId: 'reused-subscription'
    }

    await subscribe(event, args)
    expect(unsubscribe(event, { subscriptionId: args.subscriptionId })).toEqual({
      unsubscribed: true
    })
    await subscribe(event, args)

    callbacks[0]?.onEvent({
      type: 'response',
      response: {
        id: 'stale-response',
        ok: true,
        result: {},
        _meta: { runtimeId: 'old-runtime' }
      }
    })
    callbacks[0]?.onEvent({ type: 'close' })
    callbacks[0]?.onClose()

    expect(send).not.toHaveBeenCalled()
    expect(unsubscribe(event, { subscriptionId: args.subscriptionId })).toEqual({
      unsubscribed: true
    })
    expect(closeFirst).toHaveBeenCalledOnce()
    expect(closeReplacement).toHaveBeenCalledOnce()
  })

  it('keeps a reused id when the original pending sender is destroyed', async () => {
    const closeFirst = vi.fn()
    const closeReplacement = vi.fn()
    let resolveFirst: (value: {
      requestId: string
      close: () => void
      sendBinary: () => void
    }) => void = () => {}
    subscribeRuntimeEnvironmentMock
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve
          })
      )
      .mockResolvedValueOnce({
        requestId: 'replacement-request',
        close: closeReplacement,
        sendBinary: vi.fn()
      })
    const subscribe = handler<
      { selector: string; method: string; subscriptionId: string },
      { subscriptionId: string; requestId: string }
    >('runtimeEnvironments:subscribe')
    const unsubscribe = handler<{ subscriptionId: string }, { unsubscribed: boolean }>(
      'runtimeEnvironments:unsubscribe'
    )
    let destroyFirst = (): void => {}
    const firstEvent = {
      sender: {
        id: 1,
        isDestroyed: () => false,
        send: vi.fn(),
        once: vi.fn((_event: string, listener: () => void) => {
          destroyFirst = listener
        }),
        removeListener: vi.fn()
      }
    }
    const replacementEvent = {
      sender: {
        id: 2,
        isDestroyed: () => false,
        send: vi.fn(),
        once: vi.fn(),
        removeListener: vi.fn()
      }
    }
    const args = {
      selector: 'environment-a',
      method: 'files.watch',
      subscriptionId: 'reused-pending-subscription'
    }
    const first = subscribe(firstEvent, args)
    const firstRejection = expect(first).rejects.toMatchObject({ name: 'AbortError' })

    expect(unsubscribe(firstEvent, { subscriptionId: args.subscriptionId })).toEqual({
      unsubscribed: true
    })
    await subscribe(replacementEvent, args)
    destroyFirst()

    expect(unsubscribe(replacementEvent, { subscriptionId: args.subscriptionId })).toEqual({
      unsubscribed: true
    })
    resolveFirst({ requestId: 'first-request', close: closeFirst, sendBinary: vi.fn() })
    await firstRejection
    expect(closeFirst).toHaveBeenCalledOnce()
    expect(closeReplacement).toHaveBeenCalledOnce()
  })
})
