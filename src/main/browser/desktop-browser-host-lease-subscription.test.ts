import { describe, expect, it, vi } from 'vitest'
import type { PairingOffer } from '../../shared/pairing'
import type { BrowserHostLeaseSubscriptionCallbacks } from '../../shared/browser-client-host/browser-host-lease-subscription'

const { subscribe } = vi.hoisted(() => ({ subscribe: vi.fn() }))
vi.mock('../../shared/remote-runtime-client', () => ({ subscribeRemoteRuntimeRequest: subscribe }))

import { createDesktopBrowserHostLeaseSubscription } from './desktop-browser-host-lease-subscription'

describe('desktop browser host lease subscription', () => {
  it('preserves transport resolution ordering and existing connection capabilities', () => {
    const pairing: PairingOffer = {
      v: 2,
      endpoint: 'ws://127.0.0.1:6768',
      deviceToken: 'device-token',
      publicKeyB64: 'public-key',
      pairedDeviceId: 'device-a',
      scope: 'runtime'
    }
    const callbacks: BrowserHostLeaseSubscriptionCallbacks = {
      onResponse: vi.fn(),
      onError: vi.fn(),
      onClose: vi.fn()
    }
    const sender = vi.fn()
    const pending = Promise.resolve({ close: vi.fn(), sendRequest: sender })
    subscribe.mockReturnValueOnce(pending)
    const attach = createDesktopBrowserHostLeaseSubscription(pairing, {
      clientCapabilities: ['existing.optional.v1'],
      connectTimeoutMs: 700
    })
    const params = {
      authorityRuntimeId: 'runtime-a',
      browserHostClientId: 'host-a',
      hostCapabilities: ['webview']
    }
    expect(attach(params, 900, callbacks)).toBe(pending)
    expect(subscribe).toHaveBeenCalledWith(
      pairing,
      'browser.clientHost.attach',
      params,
      900,
      callbacks,
      {
        connectTimeoutMs: 700,
        clientCapabilities: [
          'existing.optional.v1',
          'browser.clientHost.v1',
          'browser.clientHost.pageMetadata.v1'
        ]
      }
    )
  })
})
