import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { MobileWebBundleFetchResult } from '../transport/mobile-web-bundle-fetch'

const push = vi.hoisted(() => ({ attach: vi.fn(), detach: vi.fn() }))
vi.mock('../notifications/push-registration', () => ({ attachPushRegistration: push.attach }))

const connectMock = vi.hoisted(() => vi.fn())
const loadHostsMock = vi.hoisted(() => vi.fn())
const fetchMock = vi.hoisted(() => vi.fn())

vi.mock('../transport/rpc-client', () => ({
  connect: (...args: unknown[]) => connectMock(...args)
}))
vi.mock('../transport/host-logical-client', () => ({
  openHostLogicalClient: (...args: unknown[]) => connectMock(...args)
}))
vi.mock('../transport/host-store', () => ({ loadHosts: () => loadHostsMock() }))
vi.mock('../transport/connection-revival-triggers', () => ({
  subscribeConnectionRevivalTriggers: () => () => {}
}))
vi.mock('../transport/mobile-web-bundle-fetch', () => ({
  fetchMobileWebBundle: (...args: unknown[]) => fetchMock(...args)
}))

import { RpcClientProvider } from '../transport/client-context'
import {
  useMobileWebBundleProbe,
  type MobileWebBundleProbeState
} from './use-mobile-web-bundle-probe'

const HOST = {
  id: 'host-1',
  name: 'Host 1',
  endpoint: 'ws://127.0.0.1:1',
  deviceToken: 'token',
  publicKeyB64: 'key',
  lastConnected: 0
}

function fakeClient(): RpcClient {
  return {
    sendRequest: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    updateTerminalSubscriptionViewport: vi.fn(),
    getState: () => 'connected',
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => null,
    onStateChange: () => () => {},
    notifyForeground: vi.fn(),
    close: vi.fn()
  }
}

type ProbeHarness = {
  readonly state: MobileWebBundleProbeState
  readonly awaitingHost: boolean
  run: () => Promise<void>
  unmount: () => Promise<void>
}

async function renderProbe(hostId: string | null): Promise<ProbeHarness> {
  let latest: ReturnType<typeof useMobileWebBundleProbe> | null = null
  // A box, not a `let`: assigning inside the callback leaves a `let` narrowed to `null`.
  const rendered: { tree: ReactTestRenderer | null } = { tree: null }

  function Probe(): null {
    latest = useMobileWebBundleProbe(hostId)
    return null
  }

  await act(async () => {
    rendered.tree = create(createElement(RpcClientProvider, null, createElement(Probe)))
  })
  const read = () => {
    if (!latest) {
      throw new Error('probe did not render')
    }
    return latest
  }
  return {
    get state() {
      return read().state
    },
    get awaitingHost() {
      return read().awaitingHost
    },
    run: async () => {
      await act(async () => {
        read().run()
      })
    },
    unmount: async () => {
      await act(async () => {
        rendered.tree?.unmount()
      })
    }
  }
}

function fetchedBundle(): MobileWebBundleFetchResult {
  return {
    manifest: {
      schemaVersion: 1,
      buildId: 'a'.repeat(64),
      entrypoint: 'index.html',
      totalBytes: 3,
      assets: [
        { path: 'index.html', sha256: 'b'.repeat(64), byteLength: 3, contentType: 'text/html' }
      ]
    },
    assets: new Map([['index.html', new Uint8Array([1, 2, 3])]]),
    totalBytes: 3,
    elapsedMs: 12
  }
}

type Deferred<T> = {
  readonly promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

function deferred<T>(): Deferred<T> {
  const box: { resolve: (value: T) => void; reject: (error: unknown) => void } = {
    resolve: () => {},
    reject: () => {}
  }
  const promise = new Promise<T>((resolve, reject) => {
    box.resolve = resolve
    box.reject = reject
  })
  return { promise, resolve: box.resolve, reject: box.reject }
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}

beforeEach(() => {
  push.attach.mockReset().mockReturnValue(push.detach)
  push.detach.mockReset()
  connectMock.mockReset().mockReturnValue(fakeClient())
  loadHostsMock.mockReset().mockResolvedValue([HOST])
  fetchMock.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useMobileWebBundleProbe', () => {
  it('dials no host until the row is tapped', async () => {
    const probe = await renderProbe(HOST.id)

    expect(connectMock).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(probe.state).toEqual({ status: 'idle' })

    fetchMock.mockResolvedValue(fetchedBundle())
    await probe.run()

    expect(connectMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(probe.state).toEqual({
      status: 'done',
      buildId: 'a'.repeat(64),
      assetCount: 1,
      totalBytes: 3,
      elapsedMs: 12
    })
    expect(probe.awaitingHost).toBe(false)
  })

  it('reports the host code when the desktop refused', async () => {
    fetchMock.mockRejectedValue(new Error('invalid_argument: mobile_web_bundle_unavailable'))
    const probe = await renderProbe(HOST.id)

    await probe.run()

    expect(probe.state).toEqual({ status: 'failed', detail: 'mobile_web_bundle_unavailable' })
  })

  it('reports a schema refusal, which carries no code, as its message', async () => {
    fetchMock.mockRejectedValue(
      new Error('invalid_argument: Invalid input: expected string, received number')
    )
    const probe = await renderProbe(HOST.id)

    await probe.run()

    expect(probe.state).toEqual({
      status: 'failed',
      detail: 'invalid_argument: Invalid input: expected string, received number'
    })
  })

  it('fails without dialling when no host is paired', async () => {
    const probe = await renderProbe(null)

    await probe.run()

    expect(connectMock).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(probe.state).toEqual({ status: 'failed', detail: 'no paired host to fetch from' })
  })

  it('gives up on a host whose client never arrives instead of waiting forever', async () => {
    vi.useFakeTimers()
    // The host is not in the store, so no client is ever acquired for it and `awaitingHost` would
    // otherwise stay true with the row's button disabled for the life of the screen.
    loadHostsMock.mockResolvedValue([])
    const probe = await renderProbe(HOST.id)

    await probe.run()
    expect(probe.state).toEqual({ status: 'running' })
    expect(probe.awaitingHost).toBe(true)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(9_999)
    })
    expect(probe.state).toEqual({ status: 'running' })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(probe.state).toEqual({ status: 'failed', detail: 'no client for the host within 10s' })
    // The row re-enables its button off `running`, and nothing is left dialling the host.
    expect(probe.awaitingHost).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not clear the deadline for a host that did arrive', async () => {
    vi.useFakeTimers()
    fetchMock.mockReturnValue(new Promise(() => {}))
    const probe = await renderProbe(HOST.id)

    await probe.run()
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })

    // A slow fetch is not a host that never opened: the deadline covers acquiring the client only.
    expect(probe.state).toEqual({ status: 'running' })
  })

  it('ignores a result from a run the screen already moved on from', async () => {
    const first = deferred<MobileWebBundleFetchResult>()
    const second = deferred<MobileWebBundleFetchResult>()
    fetchMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const probe = await renderProbe(HOST.id)

    await probe.run()
    await probe.run()
    first.resolve({ ...fetchedBundle(), elapsedMs: 999 })
    await settle()

    expect(probe.state).toEqual({ status: 'running' })

    second.resolve(fetchedBundle())
    await settle()

    expect(probe.state).toMatchObject({ status: 'done', elapsedMs: 12 })
  })

  it('ignores a failure from a run the screen already moved on from', async () => {
    const first = deferred<MobileWebBundleFetchResult>()
    const second = deferred<MobileWebBundleFetchResult>()
    fetchMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const probe = await renderProbe(HOST.id)

    await probe.run()
    await probe.run()
    first.reject(new Error('invalid_argument: mobile_web_bundle_unavailable'))
    await settle()

    expect(probe.state).toEqual({ status: 'running' })

    second.resolve(fetchedBundle())
    await settle()

    expect(probe.state).toMatchObject({ status: 'done', elapsedMs: 12 })
  })

  it('aborts the run it started when the screen goes away', async () => {
    const captured: { signal: AbortSignal | null } = { signal: null }
    fetchMock.mockImplementation((args: { signal?: AbortSignal }) => {
      captured.signal = args.signal ?? null
      return new Promise(() => {})
    })
    const probe = await renderProbe(HOST.id)
    await probe.run()

    expect(captured.signal?.aborted).toBe(false)
    await probe.unmount()

    expect(captured.signal?.aborted).toBe(true)
  })
})
