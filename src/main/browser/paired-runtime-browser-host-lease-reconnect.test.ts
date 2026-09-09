import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PairingOffer } from '../../shared/pairing'
import type {
  RemoteRuntimeSubscription,
  RemoteRuntimeSubscriptionCallbacks
} from '../../shared/remote-runtime-client'
import { RemoteRuntimeClientError } from '../../shared/remote-runtime-client-error'
import type { BrowserClientHostCommandResult } from '../../shared/browser-client-host-protocol'

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
  vi.useRealTimers()
})

describe('PairedRuntimeBrowserHostLease reconnect', () => {
  it('retries initial runtime_busy admission and attaches when capacity returns', async () => {
    vi.useFakeTimers()
    const attempts = mockAttempts()
    const onError = vi.fn()
    const onReconnected = vi.fn()
    const onTransportLost = vi.fn()
    const lease = createReconnectLease({
      timeoutMs: 500,
      reconnectRetryDelayMs: 50,
      onError,
      onReconnected,
      onTransportLost
    })
    const starting = lease.start()
    void starting.catch(() => undefined)
    await Promise.resolve()

    attempts[0]!.callbacks.onError(capacityError())
    await vi.advanceTimersByTimeAsync(50)
    expect(attempts).toHaveLength(2)
    attempts[1]!.callbacks.onResponse(readyResponse(true))

    await expect(starting).resolves.toMatchObject({ browserHostGeneration: 4 })
    expect(attempts[0]!.close).toHaveBeenCalledOnce()
    expect(onTransportLost).not.toHaveBeenCalled()
    expect(onReconnected).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
    await lease.close()
    expect(attempts[1]!.close).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds initial runtime_busy retries and releases every attempt', async () => {
    vi.useFakeTimers()
    const closes: ReturnType<typeof vi.fn>[] = []
    subscribeRemoteRuntimeRequestMock.mockImplementation(
      async (...args: unknown[]): Promise<RemoteRuntimeSubscription> => {
        const callbacks = args[4] as RemoteRuntimeSubscriptionCallbacks
        const close = vi.fn()
        closes.push(close)
        queueMicrotask(() => callbacks.onError(capacityError()))
        return {
          requestId: `browser-host-${closes.length}`,
          close,
          sendBinary: () => false
        }
      }
    )
    const onError = vi.fn()
    const lease = createReconnectLease({
      timeoutMs: 250,
      reconnectRetryDelayMs: 50,
      onError
    })
    const starting = lease.start()
    void starting.catch(() => undefined)

    await vi.advanceTimersByTimeAsync(300)

    await expect(starting).rejects.toThrow('attach capacity retry expired')
    expect(closes.length).toBeGreaterThan(1)
    expect(closes.every((close) => close.mock.calls.length === 1)).toBe(true)
    expect(onError).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels initial admission backoff without retaining a subscription', async () => {
    vi.useFakeTimers()
    const attempts = mockAttempts()
    const onError = vi.fn()
    const lease = createReconnectLease({
      timeoutMs: 500,
      reconnectRetryDelayMs: 50,
      onError
    })
    const starting = lease.start()
    void starting.catch(() => undefined)
    await Promise.resolve()

    attempts[0]!.callbacks.onError(capacityError())
    await vi.advanceTimersByTimeAsync(0)
    await lease.close()

    await expect(starting).rejects.toThrow('Browser host lease is closed')
    await vi.advanceTimersByTimeAsync(500)
    expect(attempts).toHaveLength(1)
    expect(attempts[0]!.close).toHaveBeenCalledOnce()
    expect(onError).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('restores exact authority across repeated loss and ignores stale callbacks', async () => {
    const attempts = mockAttempts()
    const onTransportLost = vi.fn()
    const onReconnected = vi.fn()
    const onError = vi.fn()
    const lease = createReconnectLease({ onTransportLost, onReconnected, onError })
    const starting = lease.start()
    await vi.waitFor(() => expect(attempts).toHaveLength(1))
    attempts[0]!.callbacks.onResponse(readyResponse(true))
    const authority = await starting

    attempts[0]!.callbacks.onError(recoverableError())
    attempts[0]!.callbacks.onClose?.()
    await vi.waitFor(() => expect(attempts).toHaveLength(2))
    attempts[1]!.callbacks.onResponse(readyResponse(true))
    await vi.waitFor(() => expect(onReconnected).toHaveBeenCalledOnce())

    attempts[0]!.callbacks.onResponse(readyResponse(true, 9))
    attempts[0]!.callbacks.onError(recoverableError())
    attempts[1]!.callbacks.onError(recoverableError())
    await vi.waitFor(() => expect(attempts).toHaveLength(3))
    attempts[2]!.callbacks.onResponse(readyResponse(true))
    await vi.waitFor(() => expect(onReconnected).toHaveBeenCalledTimes(2))

    expect(onTransportLost).toHaveBeenCalledTimes(2)
    expect(onReconnected).toHaveBeenCalledWith(authority)
    expect(onError).not.toHaveBeenCalled()
    expect(attempts[0]!.close).toHaveBeenCalledOnce()
    await lease.close()
    expect(attempts[1]!.close).toHaveBeenCalledOnce()
    expect(attempts[2]!.close).toHaveBeenCalledOnce()
  })

  it('retries runtime_busy during reconnect grace without replacing authority', async () => {
    vi.useFakeTimers()
    const attempts = mockAttempts()
    const onError = vi.fn()
    const onReconnected = vi.fn()
    const lease = createReconnectLease({
      reconnectGraceMs: 500,
      reconnectRetryDelayMs: 50,
      timeoutMs: 100,
      onError,
      onReconnected
    })
    const starting = lease.start()
    await Promise.resolve()
    attempts[0]!.callbacks.onResponse(readyResponse(true))
    const authority = await starting

    attempts[0]!.callbacks.onError(recoverableError())
    await vi.advanceTimersByTimeAsync(50)
    expect(attempts).toHaveLength(2)
    attempts[1]!.callbacks.onError(capacityError())
    await vi.advanceTimersByTimeAsync(100)
    expect(attempts).toHaveLength(3)
    attempts[2]!.callbacks.onResponse(readyResponse(true))
    await vi.advanceTimersByTimeAsync(0)

    expect(onReconnected).toHaveBeenCalledWith(authority)
    expect(onError).not.toHaveBeenCalled()
    await lease.close()
    expect(attempts.every((attempt) => attempt.close.mock.calls.length === 1)).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not double-charge result capacity when outstanding commands replay', async () => {
    const attempts = mockAttempts()
    const results = new Map([
      ['page-a', deferredCommandResult()],
      ['page-b', deferredCommandResult()]
    ])
    const onPageCommand = vi.fn(
      (command) =>
        results.get(command.browserPageId)?.promise ?? Promise.reject(new Error('unknown'))
    )
    const onError = vi.fn()
    const lease = createReconnectLease({
      maxConcurrentCommandResults: 1,
      maxUnsettledCommandResults: 2,
      onPageCommand,
      onError
    })
    const starting = lease.start()
    await vi.waitFor(() => expect(attempts).toHaveLength(1))
    attempts[0]!.callbacks.onResponse(readyResponse(true))
    await starting

    const commands = [
      commandResponse({ browserPageId: 'page-a', commandId: 'shared-command' }),
      commandResponse({
        browserPageId: 'page-b',
        pageHostGeneration: 2,
        commandId: 'shared-command'
      })
    ]
    for (const command of commands) {
      attempts[0]!.callbacks.onResponse(command)
    }
    await vi.waitFor(() => expect(onPageCommand).toHaveBeenCalledTimes(2))

    attempts[0]!.callbacks.onError(recoverableError())
    await vi.waitFor(() => expect(attempts).toHaveLength(2))
    attempts[1]!.callbacks.onResponse(readyResponse(true))
    for (const command of commands) {
      attempts[1]!.callbacks.onResponse(command)
    }
    await vi.waitFor(() => expect(onPageCommand).toHaveBeenCalledTimes(4))
    expect(onError).not.toHaveBeenCalled()

    results.get('page-a')!.resolve({ status: 'completed' })
    results.get('page-b')!.resolve({ status: 'completed' })
    await vi.waitFor(() => expect(attempts[1]!.sendRequest).toHaveBeenCalledTimes(2))
    expect(onError).not.toHaveBeenCalled()
    await lease.close()
  })

  it('keeps missing reconnect echo on legacy immediate teardown semantics', async () => {
    const attempts = mockAttempts()
    const onTransportLost = vi.fn()
    const onError = vi.fn()
    const lease = createReconnectLease({ onTransportLost, onError })
    const starting = lease.start()
    await vi.waitFor(() => expect(attempts).toHaveLength(1))
    attempts[0]!.callbacks.onResponse(readyResponse(false))
    await starting

    attempts[0]!.callbacks.onError(recoverableError())
    attempts[0]!.callbacks.onClose?.()
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce())

    expect(onTransportLost).not.toHaveBeenCalled()
    expect(attempts).toHaveLength(1)
    expect(attempts[0]!.close).toHaveBeenCalledOnce()
  })

  it('rejects malformed or unsolicited reconnect echoes', async () => {
    const malformedAttempts = mockAttempts()
    const malformedError = vi.fn()
    const malformed = createReconnectLease({ onError: malformedError })
    const malformedStart = malformed.start()
    await vi.waitFor(() => expect(malformedAttempts).toHaveLength(1))
    malformedAttempts[0]!.callbacks.onResponse({
      ...readyResponse(true),
      result: {
        ...readyResponse(true).result,
        pageInventoryProtocolVersion: undefined
      }
    })
    await expect(malformedStart).rejects.toThrow('Invalid browser host lease response')

    subscribeRemoteRuntimeRequestMock.mockReset()
    const unsolicitedAttempts = mockAttempts()
    const unsolicited = new PairedRuntimeBrowserHostLease({
      pairing,
      authorityRuntimeId: 'runtime-a',
      browserHostClientId: 'host-a',
      hostCapabilities: ['webview']
    })
    const unsolicitedStart = unsolicited.start()
    await vi.waitFor(() => expect(unsolicitedAttempts).toHaveLength(1))
    unsolicitedAttempts[0]!.callbacks.onResponse(readyResponse(true))

    await expect(unsolicitedStart).rejects.toThrow('Invalid browser host lease response')
  })

  it('fails terminally when a reconnect cannot encode a complete inventory', async () => {
    const attempts = mockAttempts()
    const getPageInventory = vi
      .fn()
      .mockReturnValueOnce([])
      .mockReturnValueOnce([
        {
          authorityRuntimeId: 'runtime-a',
          authorityEpoch: 'epoch-a',
          browserHostClientId: 'host-a',
          browserHostGeneration: 4,
          browserPageId: 'page-a',
          pageHostGeneration: 1,
          browserProfileId: 'x'.repeat(400),
          executionHostKey: 'native:runtime-a:1',
          state: 'active'
        }
      ])
    const onError = vi.fn()
    const lease = createReconnectLease({ getPageInventory, onError })
    const starting = lease.start()
    await vi.waitFor(() => expect(attempts).toHaveLength(1))
    attempts[0]!.callbacks.onResponse(readyResponse(true))
    await starting

    attempts[0]!.callbacks.onError(recoverableError())
    await vi.waitFor(() => expect(attempts).toHaveLength(2))
    expect(attempts[1]!.params).not.toHaveProperty('pageInventoryProtocolVersion')
    expect(attempts[1]!.params).not.toHaveProperty('leaseReconnectProtocolVersion')
    attempts[1]!.callbacks.onResponse(readyResponse(false, 5))
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce())

    expect(attempts).toHaveLength(2)
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Invalid browser host lease response' })
    )
  })

  it('rejects a reconnect that changes the exact authority', async () => {
    const attempts = mockAttempts()
    const onError = vi.fn()
    const lease = createReconnectLease({ onError })
    const starting = lease.start()
    await vi.waitFor(() => expect(attempts).toHaveLength(1))
    attempts[0]!.callbacks.onResponse(readyResponse(true))
    await starting

    attempts[0]!.callbacks.onError(recoverableError())
    await vi.waitFor(() => expect(attempts).toHaveLength(2))
    attempts[1]!.callbacks.onResponse(readyResponse(true, 5))
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce())

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Browser host lease authority changed in place' })
    )
    expect(attempts[1]!.close).toHaveBeenCalledOnce()
  })

  it('treats an explicit revocation during reconnect as terminal', async () => {
    const attempts = mockAttempts()
    const onError = vi.fn()
    const lease = createReconnectLease({ onError })
    const starting = lease.start()
    await vi.waitFor(() => expect(attempts).toHaveLength(1))
    attempts[0]!.callbacks.onResponse(readyResponse(true))
    await starting

    attempts[0]!.callbacks.onError(recoverableError())
    await vi.waitFor(() => expect(attempts).toHaveLength(2))
    attempts[1]!.callbacks.onResponse({
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
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce())

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Browser host lease revoked: released' })
    )
    expect(attempts[1]!.close).toHaveBeenCalledOnce()
  })

  it('expires bounded reconnect attempts without retaining timers or subscriptions', async () => {
    vi.useFakeTimers()
    const attempts = mockAttempts()
    const onTransportLost = vi.fn()
    const onError = vi.fn()
    const lease = createReconnectLease({
      reconnectGraceMs: 250,
      reconnectRetryDelayMs: 50,
      timeoutMs: 100,
      onTransportLost,
      onError
    })
    const starting = lease.start()
    await Promise.resolve()
    attempts[0]!.callbacks.onResponse(readyResponse(true))
    await starting

    attempts[0]!.callbacks.onError(recoverableError())
    await vi.advanceTimersByTimeAsync(300)

    expect(attempts).toHaveLength(3)
    expect(onTransportLost).toHaveBeenCalledOnce()
    expect(onError).toHaveBeenCalledOnce()
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('reconnect grace expired') })
    )
    expect(attempts.every((attempt) => attempt.close.mock.calls.length === 1)).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })
})

function createReconnectLease(
  overrides: Partial<PairedRuntimeBrowserHostLeaseOptions>
): PairedRuntimeBrowserHostLease {
  return new PairedRuntimeBrowserHostLease({
    pairing,
    authorityRuntimeId: 'runtime-a',
    browserHostClientId: 'host-a',
    hostCapabilities: ['webview'],
    pageCommandProtocolVersion: 1,
    pageInventoryProtocolVersion: 1,
    leaseReconnectProtocolVersion: 1,
    getPageInventory: () => [],
    onPageCommand: () => ({ status: 'completed' }),
    ...overrides
  })
}

function mockAttempts(): {
  callbacks: RemoteRuntimeSubscriptionCallbacks
  close: ReturnType<typeof vi.fn>
  params: Record<string, unknown>
  sendRequest: ReturnType<typeof vi.fn>
}[] {
  const attempts: {
    callbacks: RemoteRuntimeSubscriptionCallbacks
    close: ReturnType<typeof vi.fn>
    params: Record<string, unknown>
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
        params: args[2] as Record<string, unknown>,
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

function readyResponse(reconnect: boolean, browserHostGeneration = 4) {
  return {
    id: 'browser-host',
    ok: true as const,
    result: {
      type: 'ready' as const,
      authorityEpoch: 'epoch-a',
      browserHostGeneration,
      pageCommandProtocolVersion: 1 as const,
      pageInventoryProtocolVersion: 1 as const,
      ...(reconnect ? { leaseReconnectProtocolVersion: 1 as const } : {})
    },
    _meta: { runtimeId: 'runtime-a' }
  }
}

function recoverableError(): RemoteRuntimeClientError {
  return new RemoteRuntimeClientError('remote_runtime_unavailable', 'transport failed')
}

function capacityError(): RemoteRuntimeClientError {
  return new RemoteRuntimeClientError(
    'runtime_busy',
    'browser-host capacity reached; retry with backoff'
  )
}

function deferredCommandResult(): {
  promise: Promise<BrowserClientHostCommandResult>
  resolve: (result: BrowserClientHostCommandResult) => void
} {
  let resolve = (_result: BrowserClientHostCommandResult): void => {}
  const promise = new Promise<BrowserClientHostCommandResult>((innerResolve) => {
    resolve = innerResolve
  })
  return { promise, resolve }
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
