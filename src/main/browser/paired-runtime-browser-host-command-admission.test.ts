import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PairingOffer } from '../../shared/pairing'
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
  vi.restoreAllMocks()
})

describe('paired runtime browser host command admission', () => {
  it('rejects page commands when an old host did not negotiate them', async () => {
    const { callbacks, close } = await subscribeLease({
      sendRequest: undefined
    })
    const onError = vi.fn()
    const onPageCommand = vi.fn()
    const lease = createLease({
      pageCommandProtocolVersion: 1,
      onPageCommand,
      onError
    })
    const starting = lease.start()
    await vi.waitFor(() => expect(callbacks.current).toBeDefined())
    callbacks.current!.onResponse({
      id: 'browser-host',
      ok: true,
      result: {
        type: 'ready',
        authorityEpoch: 'epoch-a',
        browserHostGeneration: 4
      },
      _meta: { runtimeId: 'runtime-a' }
    })
    await starting

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
      expect.objectContaining({
        message: 'Unnegotiated browser host page command'
      })
    )
  })

  it.each([
    ['authorityEpoch', { authorityEpoch: 'epoch-b' }],
    ['authorityRuntimeId', { authorityRuntimeId: 'runtime-b' }],
    ['browserHostClientId', { browserHostClientId: 'host-b' }],
    ['browserHostGeneration', { browserHostGeneration: 5 }]
  ])(
    'rejects a negotiated command whose %s is stale before delivery',
    async (_field, staleness) => {
      const { callbacks, close } = await subscribeLease()
      const onError = vi.fn()
      const onPageCommand = vi.fn()
      const lease = createLease({
        pageCommandProtocolVersion: 1,
        onPageCommand,
        onError
      })
      const starting = lease.start()
      await vi.waitFor(() => expect(callbacks.current).toBeDefined())
      callbacks.current!.onResponse({
        id: 'browser-host',
        ok: true,
        result: {
          type: 'ready',
          authorityEpoch: 'epoch-a',
          browserHostGeneration: 4,
          pageCommandProtocolVersion: 1
        },
        _meta: { runtimeId: 'runtime-a' }
      })
      await starting

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
          },
          ...staleness
        },
        _meta: { runtimeId: 'runtime-a' }
      })

      await vi.waitFor(() => expect(close).toHaveBeenCalledOnce())
      expect(onPageCommand).not.toHaveBeenCalled()
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Stale browser host page command' })
      )
    }
  )

  it('refuses an inventory refresh on a lease that never negotiated reconnect', async () => {
    const { callbacks, close } = await subscribeLease()
    const lease = createLease({
      pageInventoryProtocolVersion: 1,
      getPageInventory: () => []
    })
    const starting = lease.start()
    await vi.waitFor(() => expect(callbacks.current).toBeDefined())
    callbacks.current!.onResponse({
      id: 'browser-host',
      ok: true,
      result: {
        type: 'ready',
        authorityEpoch: 'epoch-a',
        browserHostGeneration: 4,
        pageInventoryProtocolVersion: 1
      },
      _meta: { runtimeId: 'runtime-a' }
    })
    await starting

    // Why: the refresh is a deliberate transport failure, which without reconnect fences every page.
    await expect(lease.refreshPageInventory()).rejects.toThrow(
      'Browser host inventory refresh is unavailable'
    )
    expect(close).not.toHaveBeenCalled()
    await lease.close()
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
    ...overrides
  })
}

async function subscribeLease(options?: { sendRequest?: ReturnType<typeof vi.fn> }): Promise<{
  callbacks: { current?: RemoteRuntimeSubscriptionCallbacks }
  close: ReturnType<typeof vi.fn>
}> {
  const callbacks: { current?: RemoteRuntimeSubscriptionCallbacks } = {}
  const close = vi.fn()
  const sendRequest =
    options && 'sendRequest' in options
      ? options.sendRequest
      : vi.fn().mockResolvedValue({
          id: 'command-result',
          ok: true,
          result: { accepted: true },
          _meta: { runtimeId: 'runtime-a' }
        })
  subscribeRemoteRuntimeRequestMock.mockImplementationOnce(
    async (...args: unknown[]): Promise<RemoteRuntimeSubscription> => {
      callbacks.current = args[4] as RemoteRuntimeSubscriptionCallbacks
      return {
        requestId: 'browser-host',
        close,
        sendBinary: () => false,
        ...(sendRequest
          ? {
              sendRequest: sendRequest as unknown as RemoteRuntimeSubscription['sendRequest']
            }
          : {})
      }
    }
  )
  return { callbacks, close }
}
