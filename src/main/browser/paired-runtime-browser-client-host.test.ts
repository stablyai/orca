import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PairingOffer } from '../../shared/pairing'
import type {
  BrowserClientHostedPageInventory,
  BrowserClientHostCommandEvent,
  BrowserClientHostCommandResult
} from '../../shared/browser-client-host-protocol'
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

describe('PairedRuntimeBrowserClientHost', () => {
  it('forwards a complete inventory provider to the lease attach', async () => {
    const { callbacks } = subscribeHost()
    const getPageInventory = vi.fn(() => [] as readonly BrowserClientHostedPageInventory[])
    const host = createHost(() => ({ status: 'completed' }), undefined, undefined, getPageInventory)
    const starting = host.start()
    await vi.waitFor(() => expect(callbacks.current).toBeDefined())

    expect(getPageInventory).toHaveBeenCalledOnce()
    expect(subscribeRemoteRuntimeRequestMock).toHaveBeenCalledWith(
      pairing,
      'browser.clientHost.attach',
      expect.objectContaining({
        pageInventoryProtocolVersion: 1,
        pageInventory: [],
        leaseReconnectProtocolVersion: 1
      }),
      expect.any(Number),
      expect.any(Object),
      expect.any(Object)
    )
    // Why a range: retries share one deadline, so the first attach gets whatever is
    // left of the 15s budget — a clock tick between capturing it and reading it
    // shaves a millisecond, which an exact 15_000 would fail on.
    const attachTimeoutMs = subscribeRemoteRuntimeRequestMock.mock.calls[0]?.[3]
    expect(attachTimeoutMs).toBeLessThanOrEqual(15_000)
    expect(attachTimeoutMs).toBeGreaterThan(14_000)
    expect(subscribeRemoteRuntimeRequestMock.mock.calls[0]?.[2]).not.toHaveProperty(
      'pageReconciliationProtocolVersion'
    )
    callbacks.current!.onResponse(readyResponse())
    await starting
    await host.close()
  })

  it('advertises reconciliation only when the composed host enables it', async () => {
    const { callbacks } = subscribeHost()
    const host = createHost(
      () => ({ status: 'completed' }),
      undefined,
      undefined,
      () => [],
      1
    )
    const starting = host.start()
    await vi.waitFor(() => expect(callbacks.current).toBeDefined())

    expect(subscribeRemoteRuntimeRequestMock.mock.calls[0]?.[2]).toMatchObject({
      pageCommandProtocolVersion: 1,
      pageInventoryProtocolVersion: 1,
      pageReconciliationProtocolVersion: 1
    })
    callbacks.current!.onResponse({
      ...readyResponse(),
      result: {
        ...readyResponse().result,
        pageInventoryProtocolVersion: 1,
        pageReconciliationProtocolVersion: 1
      }
    })
    await expect(starting).resolves.toMatchObject({ pageReconciliationProtocolVersion: 1 })
    await host.close()
  })

  it('constructs command authority before the first command can arrive', async () => {
    const { callbacks, sendRequest } = subscribeHost()
    const handler = vi.fn((_command: BrowserClientHostCommandEvent, _signal: AbortSignal) => ({
      status: 'completed' as const
    }))
    const host = createHost(handler)
    const starting = host.start()
    await vi.waitFor(() => expect(callbacks.current).toBeDefined())

    callbacks.current!.onResponse(readyResponse())
    callbacks.current!.onResponse(commandResponse())

    await expect(starting).resolves.toMatchObject({
      authorityRuntimeId: 'runtime-a',
      authorityEpoch: 'epoch-a',
      browserHostGeneration: 4,
      pageCommandProtocolVersion: 1
    })
    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce())
    expect(handler.mock.calls[0][0]).toMatchObject({
      browserPageId: 'page-a',
      pageHostGeneration: 1
    })
    await vi.waitFor(() => expect(sendRequest).toHaveBeenCalledOnce())
    await host.close()
  })

  it('closes transport first and aborts every owned page handler', async () => {
    const { callbacks, close } = subscribeHost()
    const order: string[] = []
    close.mockImplementation(() => {
      order.push('transport-close')
    })
    const observed: { signal: AbortSignal | null } = { signal: null }
    const handler = vi.fn(
      (_command: BrowserClientHostCommandEvent, signal: AbortSignal) =>
        new Promise<BrowserClientHostCommandResult>((resolve) => {
          observed.signal = signal
          signal.addEventListener(
            'abort',
            () => {
              order.push('handler-abort')
              resolve({ status: 'failed', errorCode: 'browser_host_command_cancelled' })
            },
            { once: true }
          )
        })
    )
    const host = createHost(handler)
    const starting = host.start()
    await vi.waitFor(() => expect(callbacks.current).toBeDefined())
    callbacks.current!.onResponse(readyResponse())
    await starting
    callbacks.current!.onResponse(commandResponse())
    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce())

    await expect(host.close()).resolves.toBe(true)

    expect(close).toHaveBeenCalledOnce()
    expect(observed.signal?.aborted).toBe(true)
    expect(order).toEqual(['transport-close', 'handler-abort'])
  })

  it('aborts owned handlers even when lease cleanup rejects', async () => {
    const { callbacks } = subscribeHost()
    let aborted = false
    const host = createHost(
      (_command, signal) =>
        new Promise<BrowserClientHostCommandResult>((resolve) => {
          signal.addEventListener(
            'abort',
            () => {
              aborted = true
              resolve({ status: 'failed', errorCode: 'browser_host_command_cancelled' })
            },
            { once: true }
          )
        })
    )
    const starting = host.start()
    await vi.waitFor(() => expect(callbacks.current).toBeDefined())
    callbacks.current!.onResponse(readyResponse())
    await starting
    callbacks.current!.onResponse(commandResponse())
    await vi.waitFor(() => expect(aborted).toBe(false))
    vi.spyOn(PairedRuntimeBrowserHostLease.prototype, 'close').mockRejectedValueOnce(
      new Error('lease cleanup failed')
    )

    await expect(host.close()).rejects.toThrow('lease cleanup failed')
    expect(aborted).toBe(true)
  })

  it('preserves a falsy lease cleanup rejection across cached close calls', async () => {
    const host = createHost(() => ({ status: 'completed' }))
    vi.spyOn(PairedRuntimeBrowserHostLease.prototype, 'close').mockRejectedValueOnce(undefined)

    await expect(host.close()).rejects.toThrow('undefined')
    await expect(host.close()).rejects.toThrow('undefined')
  })

  it('aborts owned handlers when the lease transport fails', async () => {
    const { callbacks } = subscribeHost()
    const onError = vi.fn()
    let aborted = false
    const host = createHost(
      (_command, signal) =>
        new Promise<BrowserClientHostCommandResult>((resolve) => {
          signal.addEventListener(
            'abort',
            () => {
              aborted = true
              resolve({ status: 'failed', errorCode: 'browser_host_command_cancelled' })
            },
            { once: true }
          )
        }),
      onError
    )
    const starting = host.start()
    await vi.waitFor(() => expect(callbacks.current).toBeDefined())
    callbacks.current!.onResponse(readyResponse())
    await starting
    callbacks.current!.onResponse(commandResponse())
    await vi.waitFor(() => expect(aborted).toBe(false))

    callbacks.current!.onError(
      new RemoteRuntimeClientError('remote_runtime_unavailable', 'transport failed')
    )

    await vi.waitFor(() => expect(aborted).toBe(true))
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'transport failed' }))
  })

  it('retires and forgets only the exact page generation', async () => {
    const { callbacks } = subscribeHost()
    const handler = vi.fn(
      (_command: BrowserClientHostCommandEvent, signal: AbortSignal) =>
        new Promise<BrowserClientHostCommandResult>((resolve) => {
          signal.addEventListener(
            'abort',
            () => resolve({ status: 'failed', errorCode: 'browser_host_command_cancelled' }),
            { once: true }
          )
        })
    )
    const host = createHost(handler)
    const starting = host.start()
    await vi.waitFor(() => expect(callbacks.current).toBeDefined())
    callbacks.current!.onResponse(readyResponse())
    await starting
    callbacks.current!.onResponse(commandResponse())
    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce())

    await expect(host.retirePage('page-a', 2)).rejects.toThrow('browser_host_page_generation_stale')
    await expect(host.retirePage('page-a', 1)).resolves.toBe(true)
    expect(host.forgetPage('page-a', 2)).toBe(false)
    expect(host.forgetPage('page-a', 1)).toBe(true)
    await host.close()
  })

  it('keeps timed-out retirement fenced until the exact late handler settles', async () => {
    const { callbacks } = subscribeHost()
    const stuck = deferredCommandResult()
    const host = createHost(() => stuck.promise, undefined, { joinTimeoutMs: 10 })
    const starting = host.start()
    await vi.waitFor(() => expect(callbacks.current).toBeDefined())
    callbacks.current!.onResponse(readyResponse())
    await starting
    callbacks.current!.onResponse(commandResponse())

    await expect(host.retirePage('page-a', 1)).resolves.toBe(false)
    expect(host.forgetPage('page-a', 1)).toBe(false)
    stuck.resolve({ status: 'completed' })
    await expect(host.retirePage('page-a', 1)).resolves.toBe(true)
    expect(host.forgetPage('page-a', 1)).toBe(true)
    await host.close()
  })

  it('exposes exact late handler settlement after bounded close', async () => {
    const { callbacks } = subscribeHost()
    const stuck = deferredCommandResult()
    const host = createHost(() => stuck.promise, undefined, { joinTimeoutMs: 10 })
    const starting = host.start()
    await vi.waitFor(() => expect(callbacks.current).toBeDefined())
    callbacks.current!.onResponse(readyResponse())
    await starting
    callbacks.current!.onResponse(commandResponse())

    await expect(host.close()).resolves.toBe(false)
    let handlersSettled = false
    void host.whenHandlersSettled().then(() => {
      handlersSettled = true
    })
    await Promise.resolve()
    expect(handlersSettled).toBe(false)

    stuck.resolve({ status: 'completed' })
    await expect(host.whenHandlersSettled()).resolves.toBeUndefined()
  })
})

function subscribeHost(): {
  callbacks: { current?: RemoteRuntimeSubscriptionCallbacks }
  close: ReturnType<typeof vi.fn>
  sendRequest: ReturnType<typeof vi.fn>
} {
  const callbacks: { current?: RemoteRuntimeSubscriptionCallbacks } = {}
  const close = vi.fn()
  const sendRequest = vi.fn().mockResolvedValue({
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
        sendRequest
      }
    }
  )
  return { callbacks, close, sendRequest }
}

function createHost(
  handler: (
    command: BrowserClientHostCommandEvent,
    signal: AbortSignal
  ) => BrowserClientHostCommandResult | Promise<BrowserClientHostCommandResult>,
  onError?: (error: Error) => void,
  dispatcher?: { joinTimeoutMs?: number },
  getPageInventory?: () => readonly BrowserClientHostedPageInventory[],
  pageReconciliationProtocolVersion?: 1
): PairedRuntimeBrowserClientHost {
  return new PairedRuntimeBrowserClientHost({
    pairing,
    authorityRuntimeId: 'runtime-a',
    browserHostClientId: 'host-a',
    hostCapabilities: ['webview'],
    handler,
    getPageInventory,
    ...(pageReconciliationProtocolVersion ? { pageReconciliationProtocolVersion } : {}),
    onError,
    dispatcher
  })
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

function readyResponse() {
  return {
    id: 'browser-host',
    ok: true as const,
    result: {
      type: 'ready' as const,
      authorityEpoch: 'epoch-a',
      browserHostGeneration: 4,
      pageCommandProtocolVersion: 1 as const
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
