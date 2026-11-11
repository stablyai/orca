import { pairedRuntimeConnectionFromOffer } from '../../../../shared/remote-runtime/pairing/paired-runtime-connection'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { BrowserClientAutomationResult as BrowserClientHostCommandResult } from '../../../../shared/browser/client-hosting/browser-client-automation-protocol'
import type {
  BrowserClientHostedPageInventory,
  BrowserClientHostCommandEvent
} from '../../../../shared/browser/client-hosting/browser-client-host-protocol'
import type { RemoteRuntimeTransportSubscription } from '../../../../shared/remote-runtime/requests/remote-runtime-subscription-contract'

const { subscribeRemoteRuntimeRequestMock } = vi.hoisted(() => ({
  subscribeRemoteRuntimeRequestMock: vi.fn()
}))

vi.mock('../../../../shared/remote-runtime/requests/remote-runtime-subscription-transport', () => ({
  subscribeRemoteRuntimeTransport: subscribeRemoteRuntimeRequestMock
}))

import { PairedRuntimeBrowserHostLease } from './paired-runtime-browser-host-lease'

const pairing = pairedRuntimeConnectionFromOffer({
  endpoint: 'ws://127.0.0.1:6768',
  deviceToken: 'device-token',
  publicKeyB64: 'public-key',
  pairedDeviceId: 'device-a'
})

afterEach(() => {
  subscribeRemoteRuntimeRequestMock.mockReset()
  vi.restoreAllMocks()
})

describe('PairedRuntimeBrowserHostLease', () => {
  it('closes a subscription acquired after local teardown', async () => {
    let resolveSubscription = (_subscription: RemoteRuntimeTransportSubscription): void => {}
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
})

function createLease(
  overrides: {
    getPageInventory?: () => readonly BrowserClientHostedPageInventory[]
    maxConcurrentCommandResults?: number
    maxUnsettledCommandResults?: number
    onError?: (error: Error) => void
    onPageCommand?: (
      command: BrowserClientHostCommandEvent
    ) => BrowserClientHostCommandResult | Promise<BrowserClientHostCommandResult>
    pageCommandProtocolVersion?: 1
    pageInventoryProtocolVersion?: 1
  } = {}
): PairedRuntimeBrowserHostLease {
  return new PairedRuntimeBrowserHostLease({
    connection: pairing,
    authorityRuntimeId: 'runtime-a',
    browserHostClientId: 'host-a',
    hostCapabilities: ['webview'],
    ...overrides
  })
}
