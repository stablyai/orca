vi.mock('../../notifications/push-registration', () => ({
  attachPushRegistration: () => () => {}
}))
import { createElement, type ReactElement } from 'react'
import { act, create } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../rpc/rpc-client-contract'
import type { ConnectionState } from '../connection/connection-state'

const openHostLogicalClientMock = vi.fn()
const loadHostsMock = vi.fn()
const revival = vi.hoisted(() => ({ callback: null as null | ((reason: 'focus') => void) }))

// Descriptor probes need RPC methods these clients do not provide.
const descriptorProbe = vi.hoisted(() => ({ start: vi.fn((..._args: unknown[]) => vi.fn()) }))
vi.mock('../connection/runtime-status-probe', () => ({
  startRuntimeStatusProbe: (...args: unknown[]) => descriptorProbe.start(...args)
}))

vi.mock('../connection/host-logical-client', () => ({
  openHostLogicalClient: (...args: unknown[]) => openHostLogicalClientMock(...args)
}))
vi.mock('./host-store', () => ({
  loadHosts: () => loadHostsMock()
}))
vi.mock('../../diagnostics/connection/connection-revival-triggers', () => ({
  subscribeConnectionRevivalTriggers: (callback: (reason: 'focus') => void) => {
    revival.callback = callback
    return () => {
      revival.callback = null
    }
  }
}))
vi.mock('../../diagnostics/connection/connection-log-background-flush', () => ({
  subscribeConnectionLogBackgroundFlush: () => () => {}
}))

import { RpcClientProvider } from '../connection/client-context'
import { useHostClient, useRefreshHostClient } from '../connection/host-client-hooks'

const HOST = {
  id: 'host-1',
  name: 'Host 1',
  endpoint: 'ws://127.0.0.1:1',
  deviceToken: 'token',
  publicKeyB64: 'key',
  lastConnected: 0
}

type MountedRenderer = {
  unmount(): void
  update(element: ReactElement): void
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

beforeEach(() => {
  vi.useFakeTimers()
  openHostLogicalClientMock.mockReset()
  loadHostsMock.mockReset()
  revival.callback = null
})

afterEach(() => vi.useRealTimers())

describe('wanted host open recovery', () => {
  it('ignores a canceled failure after a replacement client succeeds', async () => {
    let rejectStale: ((error: Error) => void) | null = null
    const staleLookup = new Promise<(typeof HOST)[]>((_, reject) => {
      rejectStale = reject
    })
    loadHostsMock.mockReturnValueOnce(staleLookup).mockResolvedValueOnce([HOST])
    const client = fakeClient()
    openHostLogicalClientMock.mockReturnValue(client)

    let refreshHostClient: ((hostId: string) => void) | null = null
    let replacement: { client: RpcClient | null; state: ConnectionState } | null = null
    function Primary(): null {
      useHostClient(HOST.id)
      refreshHostClient = useRefreshHostClient()
      return null
    }
    function Replacement(): null {
      replacement = useHostClient(HOST.id)
      return null
    }
    function App({ showReplacement }: { showReplacement: boolean }) {
      return createElement(
        RpcClientProvider,
        null,
        createElement(Primary),
        showReplacement ? createElement(Replacement) : null
      )
    }

    let renderer: MountedRenderer | null = null
    try {
      act(() => {
        renderer = create(createElement(App, { showReplacement: false }))
      })
      act(() => refreshHostClient?.(HOST.id))
      await act(async () => {
        renderer?.update(createElement(App, { showReplacement: true }))
        await Promise.resolve()
      })
      expect(replacement).toMatchObject({ client, state: 'connected' })

      await act(async () => {
        rejectStale?.(new Error('stale catalog failure'))
        await Promise.resolve()
      })

      expect(replacement).toMatchObject({ client, state: 'connected' })
    } finally {
      act(() => renderer?.unmount())
    }
  })
})
