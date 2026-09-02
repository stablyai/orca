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

import { PairedRuntimeBrowserClientHost } from './paired-runtime-browser-client-host'

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

describe('PairedRuntimeBrowserClientHost reconnect', () => {
  it('reattaches once with the refreshed unavailable-page inventory', async () => {
    const attempts = mockAttempts()
    let state: 'active' | 'outcomeUnknown' = 'active'
    const host = new PairedRuntimeBrowserClientHost({
      pairing,
      authorityRuntimeId: 'runtime-a',
      browserHostClientId: 'host-a',
      hostCapabilities: ['webview'],
      handler: vi.fn(() => ({ status: 'completed' as const })),
      getPageInventory: () => [inventoryPage(state)],
      pageReconciliationProtocolVersion: 1,
      reconnectRetryDelayMs: 1
    })
    const starting = host.start()
    await vi.waitFor(() => expect(attempts).toHaveLength(1))
    expect(subscribeRemoteRuntimeRequestMock.mock.calls[0]?.[2]).toMatchObject({
      pageInventory: [expect.objectContaining({ state: 'active' })]
    })
    attempts[0]!.callbacks.onResponse(readyResponse({ reconciliation: true }))
    await starting

    state = 'outcomeUnknown'
    const refreshing = host.refreshPageInventory()
    await vi.waitFor(() => expect(attempts).toHaveLength(2))
    expect(attempts[0]!.close).toHaveBeenCalledOnce()
    expect(subscribeRemoteRuntimeRequestMock.mock.calls[1]?.[2]).toMatchObject({
      pageInventory: [expect.objectContaining({ state: 'outcomeUnknown' })]
    })
    attempts[1]!.callbacks.onResponse(readyResponse({ reconciliation: true }))

    await expect(refreshing).resolves.toBeUndefined()
    expect(attempts).toHaveLength(2)
    await host.close()
  })

  it('replays a completed mutation without executing its handler twice', async () => {
    const attempts = mockAttempts()
    const handler = vi.fn(() => ({ status: 'completed' as const }))
    const onError = vi.fn()
    const host = new PairedRuntimeBrowserClientHost({
      pairing,
      authorityRuntimeId: 'runtime-a',
      browserHostClientId: 'host-a',
      hostCapabilities: ['webview'],
      handler,
      getPageInventory: () => [],
      onError
    })
    const starting = host.start()
    await vi.waitFor(() => expect(attempts).toHaveLength(1))
    attempts[0]!.callbacks.onResponse(readyResponse())
    await starting
    attempts[0]!.callbacks.onResponse(commandResponse())
    await vi.waitFor(() => expect(attempts[0]!.sendRequest).toHaveBeenCalledOnce())

    attempts[0]!.callbacks.onError(
      new RemoteRuntimeClientError('remote_runtime_unavailable', 'transport failed')
    )
    await vi.waitFor(() => expect(attempts).toHaveLength(2))
    attempts[1]!.callbacks.onResponse(readyResponse())
    attempts[1]!.callbacks.onResponse(commandResponse())
    await vi.waitFor(() => expect(attempts[1]!.sendRequest).toHaveBeenCalledOnce())

    expect(handler).toHaveBeenCalledOnce()
    expect(onError).not.toHaveBeenCalled()
    await host.close()
  })
})

function mockAttempts(): {
  callbacks: RemoteRuntimeSubscriptionCallbacks
  close: ReturnType<typeof vi.fn>
  sendRequest: ReturnType<typeof vi.fn>
}[] {
  const attempts: {
    callbacks: RemoteRuntimeSubscriptionCallbacks
    close: ReturnType<typeof vi.fn>
    sendRequest: ReturnType<typeof vi.fn>
  }[] = []
  subscribeRemoteRuntimeRequestMock.mockImplementation(
    async (...args: unknown[]): Promise<RemoteRuntimeSubscription> => {
      const close = vi.fn()
      const sendRequest = vi.fn().mockResolvedValue({
        id: 'command-result',
        ok: true,
        result: { accepted: true },
        _meta: { runtimeId: 'runtime-a' }
      })
      attempts.push({
        callbacks: args[4] as RemoteRuntimeSubscriptionCallbacks,
        close,
        sendRequest
      })
      return {
        requestId: `browser-host-${attempts.length}`,
        close,
        sendBinary: () => false,
        sendRequest
      }
    }
  )
  return attempts
}

function readyResponse(options: { reconciliation?: boolean } = {}) {
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
      ...(options.reconciliation ? { pageReconciliationProtocolVersion: 1 as const } : {})
    },
    _meta: { runtimeId: 'runtime-a' }
  }
}

function inventoryPage(state: 'active' | 'outcomeUnknown') {
  return {
    authorityRuntimeId: 'runtime-a',
    authorityEpoch: 'epoch-a',
    browserHostClientId: 'host-a',
    browserHostGeneration: 4,
    browserPageId: 'page-a',
    pageHostGeneration: 1,
    browserProfileId: 'default',
    executionHostKey: 'native:runtime-a:1',
    state
  } as const
}

function commandResponse() {
  return {
    id: 'browser-host',
    ok: true as const,
    result: {
      type: 'command' as const,
      pageCommandProtocolVersion: 1 as const,
      authorityRuntimeId: 'runtime-a',
      authorityEpoch: 'epoch-a',
      browserHostClientId: 'host-a',
      browserHostGeneration: 4,
      browserPageId: 'page-a',
      pageHostGeneration: 1,
      commandSequence: 1,
      commandId: 'command-a',
      command: {
        type: 'createPage' as const,
        browserProfileId: 'default',
        executionHostKey: 'native:runtime-a:1'
      }
    },
    _meta: { runtimeId: 'runtime-a' }
  }
}
