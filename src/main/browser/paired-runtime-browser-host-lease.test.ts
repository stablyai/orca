import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PairingOffer } from '../../shared/pairing'
import type {
  BrowserClientHostedPageInventory,
  BrowserClientHostCommandEvent,
  BrowserClientHostCommandResult
} from '../../shared/browser-client-host-protocol'
import {
  BROWSER_CLIENT_HOST_PAGE_INVENTORY_MAX_BYTES,
  browserClientHostedPageInventoryByteLength
} from '../../shared/browser-client-host-protocol'
import {
  BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY,
  BROWSER_CLIENT_PAGE_METADATA_RUNTIME_CAPABILITY
} from '../../shared/protocol-version'
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
  it.each([
    [{ maxConcurrentCommandResults: 17 }, 'limit is invalid'],
    [{ maxUnsettledCommandResults: 257 }, 'limit is invalid'],
    [{ maxConcurrentCommandResults: 2, maxUnsettledCommandResults: 1 }, 'limits are inconsistent'],
    [{ getPageInventory: () => [] }, 'inventory negotiation is incomplete'],
    [{ pageInventoryProtocolVersion: 1 as const }, 'inventory negotiation is incomplete']
  ])('rejects unsafe command-result limits', (limits, expectedMessage) => {
    expect(() => createLease(limits)).toThrow(expectedMessage)
  })

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
      expect.any(Number),
      expect.any(Object),
      expect.objectContaining({
        // Metadata rides this same connection, and its handler gates on the capability being
        // declared by the connection the publish arrives on.
        clientCapabilities: [
          BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY,
          BROWSER_CLIENT_PAGE_METADATA_RUNTIME_CAPABILITY
        ]
      })
    )
    expectInitialAttachTimeout()
    await lease.close()
    expect(close).toHaveBeenCalledOnce()
  })

  // Why this is asserted on the lease and not just at the transport: the runtime accepts page
  // metadata only on the connection the lease attached on, so sending it anywhere else — the very
  // thing an ordinary runtime call does — is refused as a stale lease and the page's URL is frozen.
  it('sends page metadata over its own attached connection', async () => {
    const sendRequest = vi.fn().mockResolvedValue({
      ok: true,
      result: { accepted: true },
      _meta: { runtimeId: 'runtime-a' }
    })
    const { callbacks } = await subscribeLease({ sendRequest })
    const lease = createLease()
    const starting = lease.start()
    await vi.waitFor(() => expect(callbacks.current).toBeDefined())
    callbacks.current!.onResponse(readyResponse())
    await starting

    await expect(lease.sendPageMetadataRequest({ revision: 2 }, 1_000)).resolves.toMatchObject({
      ok: true
    })
    expect(sendRequest).toHaveBeenCalledWith(
      'browser.clientHost.pageMetadata',
      { revision: 2 },
      1_000
    )

    await lease.close()
    expect(() => lease.sendPageMetadataRequest({ revision: 3 }, 1_000)).toThrow(
      'Remote runtime browser host lease is unavailable.'
    )
  })

  it('uses page commands only after the host echoes the requested protocol', async () => {
    const { callbacks, close, sendRequest } = await subscribeLease()
    const onPageCommand = vi.fn(() => ({ status: 'completed' as const }))
    const lease = createLease({ pageCommandProtocolVersion: 1, onPageCommand })
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

    await expect(starting).resolves.toMatchObject({ pageCommandProtocolVersion: 1 })
    expect(subscribeRemoteRuntimeRequestMock).toHaveBeenCalledWith(
      pairing,
      'browser.clientHost.attach',
      expect.objectContaining({ pageCommandProtocolVersion: 1 }),
      expect.any(Number),
      expect.any(Object),
      expect.any(Object)
    )
    expectInitialAttachTimeout()
    callbacks.current!.onResponse(commandResponse())

    expect(onPageCommand).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(sendRequest).toHaveBeenCalledOnce())
    expect(sendRequest).toHaveBeenCalledWith(
      'browser.clientHost.commandResult',
      {
        pageCommandProtocolVersion: 1,
        authorityRuntimeId: 'runtime-a',
        authorityEpoch: 'epoch-a',
        browserHostClientId: 'host-a',
        browserHostGeneration: 4,
        browserPageId: 'page-a',
        pageHostGeneration: 1,
        commandSequence: 1,
        commandId: 'command-a',
        result: { status: 'completed' }
      },
      15_000
    )
    expect(close).not.toHaveBeenCalled()
    await lease.close()
  })

  it('sends one complete inventory snapshot and activates it only after the echo', async () => {
    const { callbacks } = await subscribeLease()
    const page = inventoryPage()
    const getPageInventory = vi.fn(() => [page])
    const lease = createLease({
      pageInventoryProtocolVersion: 1,
      getPageInventory
    })
    const starting = lease.start()
    await vi.waitFor(() => expect(callbacks.current).toBeDefined())

    expect(getPageInventory).toHaveBeenCalledOnce()
    expect(subscribeRemoteRuntimeRequestMock).toHaveBeenCalledWith(
      pairing,
      'browser.clientHost.attach',
      expect.objectContaining({
        pageInventoryProtocolVersion: 1,
        pageInventory: [page]
      }),
      expect.any(Number),
      expect.any(Object),
      expect.any(Object)
    )
    expectInitialAttachTimeout()
    callbacks.current!.onResponse(readyResponse({ pageInventoryProtocolVersion: 1 }))

    await expect(starting).resolves.toMatchObject({ pageInventoryProtocolVersion: 1 })
    await lease.close()
  })

  it('omits optional URLs deterministically to keep every page identity within budget', async () => {
    const { callbacks } = await subscribeLease()
    const inventory = Array.from({ length: 256 }, (_, index) => ({
      ...inventoryPage(),
      browserPageId: `page-${index.toString().padStart(3, '0')}`,
      currentUrl: `https://remote.internal/${index}/${'x'.repeat(4096)}`
    }))
    const lease = createLease({
      pageInventoryProtocolVersion: 1,
      getPageInventory: () => inventory
    })
    const starting = lease.start()
    await vi.waitFor(() => expect(callbacks.current).toBeDefined())
    const attach = subscribeRemoteRuntimeRequestMock.mock.calls[0]?.[2] as {
      pageInventory: BrowserClientHostedPageInventory[]
    }

    expect(attach.pageInventory).toHaveLength(256)
    expect(browserClientHostedPageInventoryByteLength(attach.pageInventory)).toBeLessThanOrEqual(
      BROWSER_CLIENT_HOST_PAGE_INVENTORY_MAX_BYTES
    )
    expect(attach.pageInventory.some((page) => page.currentUrl === undefined)).toBe(true)
    expect(new Set(attach.pageInventory.map((page) => page.browserPageId)).size).toBe(256)
    callbacks.current!.onResponse(readyResponse({ pageInventoryProtocolVersion: 1 }))
    await starting
    await lease.close()
  })

  it('treats a missing inventory echo as unsupported rather than accepted empty state', async () => {
    const { callbacks } = await subscribeLease()
    const lease = createLease({
      pageInventoryProtocolVersion: 1,
      getPageInventory: () => []
    })
    const starting = lease.start()
    await vi.waitFor(() => expect(callbacks.current).toBeDefined())
    callbacks.current!.onResponse(readyResponse())

    await expect(starting).resolves.not.toHaveProperty('pageInventoryProtocolVersion')
    expect(subscribeRemoteRuntimeRequestMock).toHaveBeenCalledWith(
      pairing,
      'browser.clientHost.attach',
      expect.objectContaining({ pageInventoryProtocolVersion: 1, pageInventory: [] }),
      expect.any(Number),
      expect.any(Object),
      expect.any(Object)
    )
    expectInitialAttachTimeout()
    await lease.close()
  })

  it('rejects an unsolicited inventory echo', async () => {
    const { callbacks } = await subscribeLease()
    const lease = createLease()
    const starting = lease.start()
    await vi.waitFor(() => expect(callbacks.current).toBeDefined())
    callbacks.current!.onResponse(readyResponse({ pageInventoryProtocolVersion: 1 }))

    await expect(starting).rejects.toThrow('Invalid browser host lease response')
    await lease.close()
  })

  it.each([
    ['completed', { status: 'completed' } as const],
    ['failed', { status: 'failed', errorCode: 'navigation_failed' } as const]
  ])('submits a validated %s page command result', async (_caseName, result) => {
    const { callbacks, close, sendRequest } = await subscribeLease()
    const lease = createLease({
      pageCommandProtocolVersion: 1,
      onPageCommand: () => result
    })
    const starting = lease.start()
    await vi.waitFor(() => expect(callbacks.current).toBeDefined())
    callbacks.current!.onResponse(readyResponse({ pageCommandProtocolVersion: 1 }))
    await starting

    callbacks.current!.onResponse(commandResponse())

    await vi.waitFor(() =>
      expect(sendRequest).toHaveBeenCalledWith(
        'browser.clientHost.commandResult',
        expect.objectContaining({ result }),
        15_000
      )
    )
    expect(close).not.toHaveBeenCalled()
    await lease.close()
  })

  it('accepts exact duplicate result acknowledgement without fencing the lease', async () => {
    const { callbacks, close, sendRequest } = await subscribeLease()
    sendRequest
      .mockResolvedValueOnce(commandResultAck(true))
      .mockResolvedValueOnce(commandResultAck(false))
    const lease = createLease({
      pageCommandProtocolVersion: 1,
      onPageCommand: () => ({ status: 'completed' })
    })
    const starting = lease.start()
    await vi.waitFor(() => expect(callbacks.current).toBeDefined())
    callbacks.current!.onResponse(readyResponse({ pageCommandProtocolVersion: 1 }))
    await starting

    callbacks.current!.onResponse(commandResponse())
    await vi.waitFor(() => expect(sendRequest).toHaveBeenCalledTimes(1))
    callbacks.current!.onResponse(commandResponse())

    await vi.waitFor(() => expect(sendRequest).toHaveBeenCalledTimes(2))
    expect(close).not.toHaveBeenCalled()
    await lease.close()
  })

  it('bounds concurrent command-result requests below the subscription request ceiling', async () => {
    const acknowledgements = Array.from({ length: 8 }, () => deferredCommandResultAck())
    let active = 0
    let peak = 0
    const sendRequest = vi.fn().mockImplementation(() => {
      const acknowledgement = acknowledgements[sendRequest.mock.calls.length - 1]
      active += 1
      peak = Math.max(peak, active)
      return acknowledgement.promise.finally(() => {
        active -= 1
      })
    })
    const { callbacks } = await subscribeLease({ sendRequest })
    const lease = createLease({
      maxConcurrentCommandResults: 4,
      pageCommandProtocolVersion: 1,
      onPageCommand: () => ({ status: 'completed' })
    })
    const starting = lease.start()
    await vi.waitFor(() => expect(callbacks.current).toBeDefined())
    callbacks.current!.onResponse(readyResponse({ pageCommandProtocolVersion: 1 }))
    await starting

    for (let index = 0; index < acknowledgements.length; index += 1) {
      callbacks.current!.onResponse(
        commandResponse({
          browserPageId: `page-${index}`,
          pageHostGeneration: index + 1,
          commandId: `command-${index}`
        })
      )
    }

    await vi.waitFor(() => expect(sendRequest).toHaveBeenCalledTimes(4))
    expect(peak).toBe(4)
    acknowledgements[0].resolve(commandResultAck(true))
    await vi.waitFor(() => expect(sendRequest).toHaveBeenCalledTimes(5))
    expect(peak).toBe(4)
    await lease.close()
  })

  it('fails closed when unsettled command results exceed the explicit lease bound', async () => {
    const never = new Promise<never>(() => {})
    const { callbacks, close } = await subscribeLease({
      sendRequest: vi.fn(() => never)
    })
    const onError = vi.fn()
    const lease = createLease({
      maxConcurrentCommandResults: 1,
      maxUnsettledCommandResults: 2,
      pageCommandProtocolVersion: 1,
      onPageCommand: () => ({ status: 'completed' }),
      onError
    })
    const starting = lease.start()
    await vi.waitFor(() => expect(callbacks.current).toBeDefined())
    callbacks.current!.onResponse(readyResponse({ pageCommandProtocolVersion: 1 }))
    await starting

    for (let index = 0; index < 3; index += 1) {
      callbacks.current!.onResponse(
        commandResponse({
          browserPageId: `page-${index}`,
          pageHostGeneration: index + 1,
          commandId: `command-${index}`
        })
      )
    }

    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce())
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Browser host command result capacity reached' })
    )
  })

  it.each([
    [
      'server rejection',
      vi.fn().mockResolvedValue({
        id: 'command-result',
        ok: false,
        error: { code: 'runtime_error', message: 'command result rejected' },
        _meta: { runtimeId: 'runtime-a' }
      }),
      'command result rejected'
    ],
    [
      'transport timeout',
      vi.fn().mockRejectedValue(new Error('command result timed out')),
      'command result timed out'
    ],
    [
      'malformed acknowledgement',
      vi.fn().mockResolvedValue({
        id: 'command-result',
        ok: true,
        result: { accepted: 'yes' },
        _meta: { runtimeId: 'runtime-a' }
      }),
      'Invalid browser host command result acknowledgement'
    ],
    [
      'wrong runtime acknowledgement',
      vi.fn().mockResolvedValue(commandResultAck(true, 'runtime-b')),
      'Invalid browser host command result acknowledgement'
    ]
  ])('fails closed on %s', async (_caseName, sendRequest, expectedMessage) => {
    const { callbacks, close } = await subscribeLease({ sendRequest })
    const onError = vi.fn()
    const lease = createLease({
      pageCommandProtocolVersion: 1,
      onPageCommand: () => ({ status: 'completed' }),
      onError
    })
    const starting = lease.start()
    await vi.waitFor(() => expect(callbacks.current).toBeDefined())
    callbacks.current!.onResponse(readyResponse({ pageCommandProtocolVersion: 1 }))
    await starting

    callbacks.current!.onResponse(commandResponse())

    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce())
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expectedMessage }))
  })

  it('fails closed when a v1 subscription lacks the same-socket request sender', async () => {
    const { callbacks, close } = await subscribeLease({ sendRequest: undefined })
    const onError = vi.fn()
    const lease = createLease({
      pageCommandProtocolVersion: 1,
      onPageCommand: () => ({ status: 'completed' }),
      onError
    })
    const starting = lease.start()
    await vi.waitFor(() => expect(callbacks.current).toBeDefined())
    callbacks.current!.onResponse(readyResponse({ pageCommandProtocolVersion: 1 }))

    await expect(starting).rejects.toThrow('Browser host command result transport unavailable')
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce())
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Browser host command result transport unavailable' })
    )
  })

  it.each([
    [
      'throws',
      'command handler threw',
      () => {
        throw new Error('command handler threw')
      }
    ],
    [
      'rejects',
      'command handler rejected',
      () => Promise.reject(new Error('command handler rejected'))
    ]
  ])('fails closed when the page command handler %s', async (_caseName, message, onPageCommand) => {
    const { callbacks, close, sendRequest } = await subscribeLease()
    const onError = vi.fn()
    const lease = createLease({ pageCommandProtocolVersion: 1, onPageCommand, onError })
    const starting = lease.start()
    await vi.waitFor(() => expect(callbacks.current).toBeDefined())
    callbacks.current!.onResponse(readyResponse({ pageCommandProtocolVersion: 1 }))
    await starting

    callbacks.current!.onResponse(commandResponse())

    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce())
    expect(sendRequest).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message }))
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

function expectInitialAttachTimeout(): void {
  const timeoutMs = subscribeRemoteRuntimeRequestMock.mock.calls[0]?.[3]
  expect(timeoutMs).toEqual(expect.any(Number))
  expect(timeoutMs).toBeGreaterThan(0)
  expect(timeoutMs).toBeLessThanOrEqual(15_000)
}

async function subscribeLease(options?: { sendRequest?: ReturnType<typeof vi.fn> }): Promise<{
  callbacks: { current?: RemoteRuntimeSubscriptionCallbacks }
  close: ReturnType<typeof vi.fn>
  sendRequest: ReturnType<typeof vi.fn>
}> {
  const callbacks: { current?: RemoteRuntimeSubscriptionCallbacks } = {}
  const close = vi.fn()
  const sendRequest =
    options && 'sendRequest' in options
      ? options.sendRequest
      : vi.fn().mockResolvedValue(commandResultAck(true))
  subscribeRemoteRuntimeRequestMock.mockImplementationOnce(
    async (...args: unknown[]): Promise<RemoteRuntimeSubscription> => {
      callbacks.current = args[4] as RemoteRuntimeSubscriptionCallbacks
      const subscription: RemoteRuntimeSubscription = {
        requestId: 'browser-host',
        close,
        sendBinary: () => false,
        ...(sendRequest
          ? {
              sendRequest: sendRequest as unknown as RemoteRuntimeSubscription['sendRequest']
            }
          : {})
      }
      return subscription
    }
  )
  return { callbacks, close, sendRequest: sendRequest ?? vi.fn() }
}

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
    pairing,
    authorityRuntimeId: 'runtime-a',
    browserHostClientId: 'host-a',
    hostCapabilities: ['webview'],
    ...overrides
  })
}

function inventoryPage(): BrowserClientHostedPageInventory {
  return {
    authorityRuntimeId: 'runtime-a',
    authorityEpoch: 'epoch-old',
    browserHostClientId: 'host-a',
    browserHostGeneration: 2,
    browserPageId: 'page-a',
    pageHostGeneration: 3,
    browserProfileId: 'profile-a',
    executionHostKey: 'native:runtime-a:1',
    state: 'active',
    currentUrl: 'https://remote.internal/'
  }
}

function readyResponse(
  overrides: { pageCommandProtocolVersion?: 1; pageInventoryProtocolVersion?: 1 } = {}
) {
  return {
    id: 'browser-host',
    ok: true as const,
    result: {
      type: 'ready' as const,
      authorityEpoch: 'epoch-a',
      browserHostGeneration: 4,
      ...overrides
    },
    _meta: { runtimeId: 'runtime-a' }
  }
}

function commandResponse(
  overrides: {
    browserPageId?: string
    pageHostGeneration?: number
    commandId?: string
  } = {}
) {
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
      },
      ...overrides
    },
    _meta: { runtimeId: 'runtime-a' }
  }
}

function deferredCommandResultAck(): {
  promise: Promise<ReturnType<typeof commandResultAck>>
  resolve: (value: ReturnType<typeof commandResultAck>) => void
} {
  let resolve = (_value: ReturnType<typeof commandResultAck>): void => {}
  const promise = new Promise<ReturnType<typeof commandResultAck>>((innerResolve) => {
    resolve = innerResolve
  })
  return { promise, resolve }
}

function commandResultAck(accepted: boolean, runtimeId = 'runtime-a') {
  return {
    id: 'command-result',
    ok: true as const,
    result: { accepted },
    _meta: { runtimeId }
  }
}
