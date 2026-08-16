import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PairingOffer } from '../../shared/pairing'
import { BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY } from '../../shared/protocol-version'
import type {
  RemoteRuntimeSubscription,
  RemoteRuntimeSubscriptionCallbacks
} from '../../shared/remote-runtime-client'

const { subscribeRemoteRuntimeRequestMock } = vi.hoisted(() => ({
  subscribeRemoteRuntimeRequestMock: vi.fn()
}))

vi.mock('../../shared/remote-runtime-client', () => ({
  subscribeRemoteRuntimeRequest: subscribeRemoteRuntimeRequestMock
}))

import { PairedRuntimeBrowserHostLease } from './paired-runtime-browser-host-lease'

const pairing = {
  v: 2,
  endpoint: 'ws://127.0.0.1:6768',
  deviceToken: 'device-token',
  publicKeyB64: 'public-key',
  pairedDeviceId: 'device-a',
  scope: 'runtime'
} as PairingOffer

afterEach(() => {
  subscribeRemoteRuntimeRequestMock.mockReset()
  vi.restoreAllMocks()
})

describe('PairedRuntimeBrowserHostLease', () => {
  it('returns only the runtime-issued epoch and generation', async () => {
    let callbacks: RemoteRuntimeSubscriptionCallbacks | undefined
    const close = vi.fn()
    subscribeRemoteRuntimeRequestMock.mockImplementationOnce(
      async (...args: unknown[]): Promise<RemoteRuntimeSubscription> => {
        callbacks = args[4] as RemoteRuntimeSubscriptionCallbacks
        return { requestId: 'browser-host', close, sendBinary: () => false }
      }
    )
    const lease = createLease()
    const starting = lease.start()
    await vi.waitFor(() => expect(callbacks).toBeDefined())
    callbacks!.onResponse({
      id: 'browser-host',
      ok: true,
      result: { type: 'ready', authorityEpoch: 'epoch-a', browserHostGeneration: 4 },
      _meta: { runtimeId: 'runtime-a' }
    })

    await expect(starting).resolves.toEqual({
      authorityRuntimeId: 'runtime-a',
      authorityEpoch: 'epoch-a',
      browserHostClientId: 'host-a',
      browserHostGeneration: 4
    })
    expect(subscribeRemoteRuntimeRequestMock).toHaveBeenCalledWith(
      pairing,
      'browser.clientHost.attach',
      {
        authorityRuntimeId: 'runtime-a',
        browserHostClientId: 'host-a',
        hostCapabilities: ['webview']
      },
      15_000,
      expect.any(Object),
      expect.objectContaining({
        clientCapabilities: [BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY]
      })
    )
    await lease.close()
    expect(close).toHaveBeenCalledOnce()
  })

  it('rejects malformed lease authority instead of adopting it', async () => {
    let callbacks: RemoteRuntimeSubscriptionCallbacks | undefined
    const close = vi.fn()
    subscribeRemoteRuntimeRequestMock.mockImplementationOnce(
      async (...args: unknown[]): Promise<RemoteRuntimeSubscription> => {
        callbacks = args[4] as RemoteRuntimeSubscriptionCallbacks
        return { requestId: 'browser-host', close, sendBinary: () => false }
      }
    )
    const lease = createLease()
    const starting = lease.start()
    await vi.waitFor(() => expect(callbacks).toBeDefined())
    callbacks!.onResponse({
      id: 'browser-host',
      ok: true,
      result: { type: 'ready', authorityEpoch: '', browserHostGeneration: 0 },
      _meta: { runtimeId: 'runtime-a' }
    })

    await expect(starting).rejects.toThrow('Invalid browser host lease response')
    expect(close).toHaveBeenCalledOnce()
  })

  it('closes a subscription acquired after local teardown', async () => {
    let resolveSubscription = (_subscription: RemoteRuntimeSubscription): void => {}
    const close = vi.fn()
    subscribeRemoteRuntimeRequestMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSubscription = resolve
      })
    )
    const lease = createLease()
    const starting = lease.start()
    await lease.close()
    resolveSubscription({ requestId: 'late-host', close, sendBinary: () => false })

    await expect(starting).rejects.toThrow('closed during startup')
    expect(close).toHaveBeenCalledOnce()
  })

  it('closes and reports an exact server revocation after readiness', async () => {
    let callbacks: RemoteRuntimeSubscriptionCallbacks | undefined
    const close = vi.fn()
    const onError = vi.fn()
    subscribeRemoteRuntimeRequestMock.mockImplementationOnce(
      async (...args: unknown[]): Promise<RemoteRuntimeSubscription> => {
        callbacks = args[4] as RemoteRuntimeSubscriptionCallbacks
        return { requestId: 'browser-host', close, sendBinary: () => false }
      }
    )
    const lease = createLease({ onError })
    const starting = lease.start()
    await vi.waitFor(() => expect(callbacks).toBeDefined())
    callbacks!.onResponse({
      id: 'browser-host',
      ok: true,
      result: { type: 'ready', authorityEpoch: 'epoch-a', browserHostGeneration: 4 },
      _meta: { runtimeId: 'runtime-a' }
    })
    await starting

    callbacks!.onResponse({
      id: 'browser-host',
      ok: true,
      result: {
        type: 'revoked',
        authorityEpoch: 'epoch-a',
        browserHostGeneration: 4,
        reason: 'replaced'
      },
      _meta: { runtimeId: 'runtime-a' }
    })

    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce())
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Browser host lease revoked: replaced' })
    )
  })

  it('rejects revocation before adopting lease authority', async () => {
    const { callbacks, close } = await subscribeLease()
    const lease = createLease()
    const starting = lease.start()
    await vi.waitFor(() => expect(callbacks.current).toBeDefined())

    callbacks.current!.onResponse({
      id: 'browser-host',
      ok: true,
      result: {
        type: 'revoked',
        authorityEpoch: 'epoch-a',
        browserHostGeneration: 4,
        reason: 'released'
      },
      _meta: { runtimeId: 'runtime-a' }
    })

    await expect(starting).rejects.toThrow('Invalid browser host lease revocation')
    expect(close).toHaveBeenCalledOnce()
  })

  it.each([
    ['wrong epoch', 'epoch-b', 4, 'replaced', 'Invalid browser host lease revocation'],
    ['wrong generation', 'epoch-a', 5, 'released', 'Invalid browser host lease revocation'],
    ['malformed reason', 'epoch-a', 4, 'unknown', 'Invalid browser host lease response']
  ])(
    'fails closed on %s after readiness',
    async (_caseName, authorityEpoch, browserHostGeneration, reason, expectedError) => {
      const { callbacks, close } = await subscribeLease()
      const onError = vi.fn()
      const lease = createLease({ onError })
      const starting = lease.start()
      await vi.waitFor(() => expect(callbacks.current).toBeDefined())
      callbacks.current!.onResponse({
        id: 'browser-host',
        ok: true,
        result: { type: 'ready', authorityEpoch: 'epoch-a', browserHostGeneration: 4 },
        _meta: { runtimeId: 'runtime-a' }
      })
      await starting

      callbacks.current!.onResponse({
        id: 'browser-host',
        ok: true,
        result: { type: 'revoked', authorityEpoch, browserHostGeneration, reason },
        _meta: { runtimeId: 'runtime-a' }
      })

      await vi.waitFor(() => expect(close).toHaveBeenCalledOnce())
      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expectedError }))
    }
  )

  it('keeps duplicate readiness and events after local close idempotent', async () => {
    const { callbacks, close } = await subscribeLease()
    const onError = vi.fn()
    const lease = createLease({ onError })
    const starting = lease.start()
    await vi.waitFor(() => expect(callbacks.current).toBeDefined())
    const ready = {
      id: 'browser-host',
      ok: true as const,
      result: { type: 'ready', authorityEpoch: 'epoch-a', browserHostGeneration: 4 },
      _meta: { runtimeId: 'runtime-a' }
    }
    callbacks.current!.onResponse(ready)
    await starting
    callbacks.current!.onResponse(ready)
    await lease.close()
    callbacks.current!.onClose?.()

    expect(close).toHaveBeenCalledOnce()
    expect(onError).not.toHaveBeenCalled()
  })
})

async function subscribeLease(): Promise<{
  callbacks: { current?: RemoteRuntimeSubscriptionCallbacks }
  close: ReturnType<typeof vi.fn>
}> {
  const callbacks: { current?: RemoteRuntimeSubscriptionCallbacks } = {}
  const close = vi.fn()
  subscribeRemoteRuntimeRequestMock.mockImplementationOnce(
    async (...args: unknown[]): Promise<RemoteRuntimeSubscription> => {
      callbacks.current = args[4] as RemoteRuntimeSubscriptionCallbacks
      return { requestId: 'browser-host', close, sendBinary: () => false }
    }
  )
  return { callbacks, close }
}

function createLease(
  overrides: { onError?: (error: Error) => void } = {}
): PairedRuntimeBrowserHostLease {
  return new PairedRuntimeBrowserHostLease({
    pairing,
    authorityRuntimeId: 'runtime-a',
    browserHostClientId: 'host-a',
    hostCapabilities: ['webview'],
    ...overrides
  })
}
