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

describe('browser file channel reconnect degradation', () => {
  it('keeps pages alive and refuses transfers when a reconnect drops the file channel', async () => {
    const attempts = mockAttempts()
    const onError = vi.fn()
    const onReconnected = vi.fn()
    const lease = createLease({ onError, onReconnected })
    const starting = lease.start()
    await vi.waitFor(() => expect(attempts).toHaveLength(1))
    attempts[0]!.callbacks.onResponse(readyResponse({ fileChannel: true }))
    const authority = await starting
    expect(lease.fileChannelNegotiated).toBe(true)

    attempts[0]!.callbacks.onError(recoverableError())
    await vi.waitFor(() => expect(attempts).toHaveLength(2))
    attempts[1]!.callbacks.onResponse(readyResponse({ fileChannel: false }))
    await vi.waitFor(() => expect(onReconnected).toHaveBeenCalledOnce())

    const { fileChannelProtocolVersion, ...composition } = authority
    expect(fileChannelProtocolVersion).toBe(1)
    expect(onReconnected).toHaveBeenCalledWith(composition)
    expect(onError).not.toHaveBeenCalled()
    expect(lease.fileChannelNegotiated).toBe(false)
    expect(() =>
      lease.sendFileChannelRequest('browser.clientHost.fileChannel.read', {}, 10)
    ).toThrow('Remote runtime browser file channel is unavailable.')
    await lease.close()
  })

  it('enables transfers when a reconnect gains the file channel', async () => {
    const attempts = mockAttempts()
    const onError = vi.fn()
    const lease = createLease({ onError })
    const starting = lease.start()
    await vi.waitFor(() => expect(attempts).toHaveLength(1))
    attempts[0]!.callbacks.onResponse(readyResponse({ fileChannel: false }))
    await starting
    expect(lease.fileChannelNegotiated).toBe(false)

    attempts[0]!.callbacks.onError(recoverableError())
    await vi.waitFor(() => expect(attempts).toHaveLength(2))
    attempts[1]!.callbacks.onResponse(readyResponse({ fileChannel: true }))
    await vi.waitFor(() => expect(lease.fileChannelNegotiated).toBe(true))

    expect(onError).not.toHaveBeenCalled()
    await lease.sendFileChannelRequest('browser.clientHost.fileChannel.abort', {}, 10)
    expect(attempts[1]!.sendRequest).toHaveBeenCalledOnce()
    await lease.close()
  })

  it('ignores a superseded connection failure and reports no channel once closed', async () => {
    const attempts = mockAttempts()
    const onError = vi.fn()
    const lease = createLease({ onError })
    const starting = lease.start()
    await vi.waitFor(() => expect(attempts).toHaveLength(1))
    attempts[0]!.callbacks.onResponse(readyResponse({ fileChannel: true }))
    await starting
    attempts[0]!.callbacks.onError(recoverableError())
    await vi.waitFor(() => expect(attempts).toHaveLength(2))
    attempts[1]!.callbacks.onResponse(readyResponse({ fileChannel: true }))
    await vi.waitFor(() => expect(lease.fileChannelNegotiated).toBe(true))

    // Why: the superseded connection's late failure must never fence the lease that replaced it.
    attempts[0]!.callbacks.onError(new RemoteRuntimeClientError('bad_request', 'superseded'))
    await flushMicrotasks()

    expect(onError).not.toHaveBeenCalled()
    expect(lease.fileChannelNegotiated).toBe(true)

    await lease.close()
    expect(lease.fileChannelNegotiated).toBe(false)
    expect(() =>
      lease.sendFileChannelRequest('browser.clientHost.fileChannel.read', {}, 10)
    ).toThrow('Remote runtime browser file channel is unavailable.')
  })
})

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve()
  }
}

function createLease(overrides: {
  onError?: (error: Error) => void
  onReconnected?: (authority: unknown) => void
}): PairedRuntimeBrowserHostLease {
  return new PairedRuntimeBrowserHostLease({
    pairing,
    authorityRuntimeId: 'runtime-a',
    browserHostClientId: 'host-a',
    hostCapabilities: ['webview'],
    pageCommandProtocolVersion: 1,
    pageInventoryProtocolVersion: 1,
    leaseReconnectProtocolVersion: 1,
    fileChannelProtocolVersion: 1,
    getPageInventory: () => [],
    onPageCommand: () => ({ status: 'completed' }),
    ...overrides
  })
}

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
        id: 'file-channel',
        ok: true,
        result: { released: true },
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

function readyResponse(options: { fileChannel: boolean }) {
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
      ...(options.fileChannel ? { fileChannelProtocolVersion: 1 as const } : {})
    },
    _meta: { runtimeId: 'runtime-a' }
  }
}

function recoverableError(): RemoteRuntimeClientError {
  return new RemoteRuntimeClientError('remote_runtime_unavailable', 'transport failed')
}
