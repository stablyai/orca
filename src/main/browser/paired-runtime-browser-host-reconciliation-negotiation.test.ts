import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PairingOffer } from '../../shared/pairing'
import type {
  RemoteRuntimeSubscription,
  RemoteRuntimeSubscriptionCallbacks
} from '../../shared/remote-runtime-client'
import { RemoteRuntimeClientError } from '../../shared/remote-runtime-client-error'

const { subscribeRemoteRuntimeRequestMock } = vi.hoisted(() => ({
  subscribeRemoteRuntimeRequestMock: vi.fn()
}))

vi.mock('../../shared/remote-runtime-client', () => ({
  subscribeRemoteRuntimeRequest: subscribeRemoteRuntimeRequestMock
}))

import { PairedRuntimeBrowserHostLease } from './paired-runtime-browser-host-lease'
import type { PairedRuntimeBrowserHostLeaseOptions } from './paired-runtime-browser-host-lease-options'

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
})

describe('paired runtime browser-host reconciliation negotiation', () => {
  it('requests and retains an exact echoed reconciliation protocol', async () => {
    const callbacks: { current?: RemoteRuntimeSubscriptionCallbacks } = {}
    const close = vi.fn()
    subscribeRemoteRuntimeRequestMock.mockImplementationOnce(
      async (...args: unknown[]): Promise<RemoteRuntimeSubscription> => {
        callbacks.current = args[4] as RemoteRuntimeSubscriptionCallbacks
        return {
          requestId: 'browser-host',
          close,
          sendBinary: () => false,
          sendRequest: vi.fn()
        }
      }
    )
    const lease = createLease()
    const starting = lease.start()
    await vi.waitFor(() => expect(callbacks.current).toBeDefined())

    expect(subscribeRemoteRuntimeRequestMock.mock.calls[0]?.[2]).toMatchObject({
      pageCommandProtocolVersion: 1,
      pageInventoryProtocolVersion: 1,
      pageInventory: [],
      pageReconciliationProtocolVersion: 1
    })
    callbacks.current!.onResponse(readyResponse({ pageReconciliationProtocolVersion: 1 }))
    await expect(starting).resolves.toMatchObject({ pageReconciliationProtocolVersion: 1 })
    await lease.close()
    expect(close).toHaveBeenCalledOnce()
  })

  it('falls back without enabling reconciliation when an older host omits the echo', async () => {
    const callbacks: { current?: RemoteRuntimeSubscriptionCallbacks } = {}
    subscribeRemoteRuntimeRequestMock.mockImplementationOnce(
      async (...args: unknown[]): Promise<RemoteRuntimeSubscription> => {
        callbacks.current = args[4] as RemoteRuntimeSubscriptionCallbacks
        return {
          requestId: 'browser-host',
          close: vi.fn(),
          sendBinary: () => false,
          sendRequest: vi.fn()
        }
      }
    )
    const lease = createLease()
    const starting = lease.start()
    await vi.waitFor(() => expect(callbacks.current).toBeDefined())
    callbacks.current!.onResponse(readyResponse())

    await expect(starting).resolves.not.toHaveProperty('pageReconciliationProtocolVersion')
    await lease.close()
  })

  it('rejects an unsolicited or dependency-inconsistent reconciliation echo', async () => {
    const callbacks: { current?: RemoteRuntimeSubscriptionCallbacks } = {}
    subscribeRemoteRuntimeRequestMock.mockImplementation(
      async (...args: unknown[]): Promise<RemoteRuntimeSubscription> => {
        callbacks.current = args[4] as RemoteRuntimeSubscriptionCallbacks
        return {
          requestId: 'browser-host',
          close: vi.fn(),
          sendBinary: () => false,
          sendRequest: vi.fn()
        }
      }
    )
    const unsolicited = createLease({ pageReconciliationProtocolVersion: undefined })
    const unsolicitedStart = unsolicited.start()
    await vi.waitFor(() => expect(callbacks.current).toBeDefined())
    callbacks.current!.onResponse(readyResponse({ pageReconciliationProtocolVersion: 1 }))
    await expect(unsolicitedStart).rejects.toThrow('Invalid browser host lease response')

    subscribeRemoteRuntimeRequestMock.mockReset()
    callbacks.current = undefined
    subscribeRemoteRuntimeRequestMock.mockImplementation(
      async (...args: unknown[]): Promise<RemoteRuntimeSubscription> => {
        callbacks.current = args[4] as RemoteRuntimeSubscriptionCallbacks
        return {
          requestId: 'browser-host',
          close: vi.fn(),
          sendBinary: () => false,
          sendRequest: vi.fn()
        }
      }
    )
    const inconsistent = createLease()
    const inconsistentStart = inconsistent.start()
    await vi.waitFor(() => expect(callbacks.current).toBeDefined())
    callbacks.current!.onResponse({
      ...readyResponse({ pageReconciliationProtocolVersion: 1 }),
      result: {
        ...readyResponse({ pageReconciliationProtocolVersion: 1 }).result,
        pageInventoryProtocolVersion: undefined
      }
    })
    await expect(inconsistentStart).rejects.toThrow('Invalid browser host lease response')
  })

  it('rejects reconciliation downgrade during exact reconnect', async () => {
    const callbacks: RemoteRuntimeSubscriptionCallbacks[] = []
    const onError = vi.fn()
    subscribeRemoteRuntimeRequestMock.mockImplementation(
      async (...args: unknown[]): Promise<RemoteRuntimeSubscription> => {
        callbacks.push(args[4] as RemoteRuntimeSubscriptionCallbacks)
        return {
          requestId: `browser-host-${callbacks.length}`,
          close: vi.fn(),
          sendBinary: () => false,
          sendRequest: vi.fn()
        }
      }
    )
    const lease = createLease({ reconnectRetryDelayMs: 1, onError })
    const starting = lease.start()
    await vi.waitFor(() => expect(callbacks).toHaveLength(1))
    callbacks[0]!.onResponse(readyResponse({ pageReconciliationProtocolVersion: 1 }))
    await starting

    callbacks[0]!.onError(
      new RemoteRuntimeClientError('remote_runtime_unavailable', 'transport closed')
    )
    await vi.waitFor(() => expect(callbacks).toHaveLength(2))
    callbacks[1]!.onResponse(readyResponse())
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce())

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Browser host lease authority changed in place' })
    )
    await lease.close()
  })

  it('refuses a page command that drops the negotiated reconciliation protocol', async () => {
    const callbacks: { current?: RemoteRuntimeSubscriptionCallbacks } = {}
    const close = vi.fn()
    subscribeRemoteRuntimeRequestMock.mockImplementationOnce(
      async (...args: unknown[]): Promise<RemoteRuntimeSubscription> => {
        callbacks.current = args[4] as RemoteRuntimeSubscriptionCallbacks
        return { requestId: 'browser-host', close, sendBinary: () => false, sendRequest: vi.fn() }
      }
    )
    const onError = vi.fn()
    const onPageCommand = vi.fn()
    const lease = createLease({ onError, onPageCommand })
    const starting = lease.start()
    await vi.waitFor(() => expect(callbacks.current).toBeDefined())
    callbacks.current!.onResponse(readyResponse({ pageReconciliationProtocolVersion: 1 }))
    await starting

    // Why: a host that negotiated reconciliation must never issue a command that omits it.
    callbacks.current!.onResponse({
      id: 'browser-host',
      ok: true,
      result: {
        type: 'command',
        pageCommandProtocolVersion: 1,
        authorityRuntimeId: 'runtime-a',
        authorityEpoch: 'epoch-a',
        browserHostClientId: 'host-a',
        browserHostGeneration: 4,
        browserPageId: 'page-a',
        pageHostGeneration: 1,
        commandSequence: 1,
        commandId: 'command-a',
        command: {
          type: 'createPage',
          browserProfileId: 'default',
          executionHostKey: 'native:runtime-a:1'
        }
      },
      _meta: { runtimeId: 'runtime-a' }
    })

    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce())
    expect(onPageCommand).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Unnegotiated browser host page command' })
    )
  })
})

function createLease(
  overrides: Partial<PairedRuntimeBrowserHostLeaseOptions> = {}
): PairedRuntimeBrowserHostLease {
  return new PairedRuntimeBrowserHostLease({
    pairing,
    authorityRuntimeId: 'runtime-a',
    browserHostClientId: 'host-a',
    hostCapabilities: ['webview'],
    pageCommandProtocolVersion: 1,
    pageInventoryProtocolVersion: 1,
    pageReconciliationProtocolVersion: 1,
    leaseReconnectProtocolVersion: 1,
    getPageInventory: () => [],
    onPageCommand: async () => ({ status: 'completed' }),
    ...overrides
  })
}

function readyResponse(overrides: { pageReconciliationProtocolVersion?: 1 } = {}) {
  return {
    id: 'browser-host',
    ok: true as const,
    result: {
      type: 'ready' as const,
      authorityEpoch: 'epoch-a',
      browserHostGeneration: 4,
      pageCommandProtocolVersion: 1 as const,
      pageInventoryProtocolVersion: 1 as const,
      leaseReconnectProtocolVersion: 1 as const,
      ...overrides
    },
    _meta: { runtimeId: 'runtime-a' }
  }
}
