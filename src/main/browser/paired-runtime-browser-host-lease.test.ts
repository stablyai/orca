import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PairingOffer } from '../../shared/pairing'
import type {
  BrowserClientHostCommandEvent,
  BrowserClientHostCommandResult
} from '../../shared/browser-client-host-protocol'
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
      15_000,
      expect.any(Object),
      expect.any(Object)
    )
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

  it('rejects page commands when an old host did not negotiate them', async () => {
    const { callbacks, close } = await subscribeLease({ sendRequest: undefined })
    const onError = vi.fn()
    const onPageCommand = vi.fn()
    const lease = createLease({ pageCommandProtocolVersion: 1, onPageCommand, onError })
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

  it('rejects a negotiated command from a stale authority before delivery', async () => {
    const { callbacks, close } = await subscribeLease()
    const onError = vi.fn()
    const onPageCommand = vi.fn()
    const lease = createLease({ pageCommandProtocolVersion: 1, onPageCommand, onError })
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
        authorityEpoch: 'epoch-b',
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
      expect.objectContaining({ message: 'Stale browser host page command' })
    )
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
    onError?: (error: Error) => void
    onPageCommand?: (
      command: BrowserClientHostCommandEvent
    ) => BrowserClientHostCommandResult | Promise<BrowserClientHostCommandResult>
    pageCommandProtocolVersion?: 1
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

function readyResponse(overrides: { pageCommandProtocolVersion?: 1 } = {}) {
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

function commandResultAck(accepted: boolean, runtimeId = 'runtime-a') {
  return {
    id: 'command-result',
    ok: true as const,
    result: { accepted },
    _meta: { runtimeId }
  }
}
