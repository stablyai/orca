import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
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
  let renderer: ReactTestRenderer | null = null

  function Probe(): null {
    latest = useMobileWebBundleProbe(hostId)
    return null
  }

  await act(async () => {
    renderer = create(createElement(RpcClientProvider, null, createElement(Probe)))
  })
  const mounted = renderer as ReactTestRenderer | null
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
        mounted?.unmount()
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

beforeEach(() => {
  push.attach.mockReset().mockReturnValue(push.detach)
  push.detach.mockReset()
  connectMock.mockReset().mockReturnValue(fakeClient())
  loadHostsMock.mockReset().mockResolvedValue([HOST])
  fetchMock.mockReset()
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

  it('aborts the run it started when the screen goes away', async () => {
    let captured: AbortSignal | null = null
    fetchMock.mockImplementation((args: { signal?: AbortSignal }) => {
      captured = args.signal ?? null
      return new Promise(() => {})
    })
    const probe = await renderProbe(HOST.id)
    await probe.run()

    const signal = captured as AbortSignal | null
    expect(signal?.aborted).toBe(false)
    await probe.unmount()

    expect(signal?.aborted).toBe(true)
  })
})
