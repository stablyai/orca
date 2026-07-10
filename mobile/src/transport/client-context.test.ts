import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionState } from './types'
import type { RpcClient } from './rpc-client'

const connectMock = vi.fn()
const loadHostsMock = vi.fn()

vi.mock('./rpc-client', () => ({
  connect: (...args: unknown[]) => connectMock(...args)
}))
vi.mock('./host-store', () => ({
  loadHosts: () => loadHostsMock()
}))
vi.mock('./connection-revival-triggers', () => ({
  subscribeConnectionRevivalTriggers: () => () => {}
}))

import { RpcClientProvider, useCloseHost, useHostClient } from './client-context'

type FakeClient = RpcClient & {
  emitState: (state: ConnectionState) => void
  closeMock: ReturnType<typeof vi.fn>
}

function makeFakeClient(initialState: ConnectionState): FakeClient {
  let state = initialState
  const listeners = new Set<(state: ConnectionState) => void>()
  const closeMock = vi.fn()
  return {
    sendRequest: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    updateTerminalSubscriptionViewport: vi.fn(),
    getState: () => state,
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => null,
    onStateChange: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    notifyForeground: vi.fn(),
    close: closeMock,
    closeMock,
    emitState: (next) => {
      state = next
      for (const listener of listeners) {
        listener(next)
      }
    }
  } as FakeClient
}

const HOST = {
  id: 'host-1',
  name: 'Host 1',
  endpoint: 'ws://127.0.0.1:1',
  deviceToken: 'token',
  publicKeyB64: 'key',
  lastConnected: 0
}

type Harness = {
  readonly hook: ReturnType<typeof useHostClient>
  readonly closeHost: (hostId: string) => void
  readonly unmount: () => void
}

function suppressReactTestRendererDeprecationWarning(): () => void {
  const originalConsoleError = console.error
  const spy = vi.spyOn(console, 'error').mockImplementation((...args) => {
    const firstArg = args[0]
    if (typeof firstArg === 'string' && firstArg.includes('react-test-renderer is deprecated')) {
      return
    }
    originalConsoleError(...args)
  })
  return () => spy.mockRestore()
}

async function renderHarness(hostId: string): Promise<Harness> {
  let hook: ReturnType<typeof useHostClient> | null = null
  let closeHost: ((hostId: string) => void) | null = null
  let renderer: ReactTestRenderer | null = null

  function Probe(): null {
    hook = useHostClient(hostId)
    closeHost = useCloseHost()
    return null
  }

  const restore = suppressReactTestRendererDeprecationWarning()
  try {
    await act(async () => {
      renderer = create(createElement(RpcClientProvider, null, createElement(Probe)))
    })
  } finally {
    restore()
  }
  if (!hook || !closeHost || !renderer) {
    throw new Error('harness did not render')
  }
  const mounted = renderer as ReactTestRenderer
  return {
    get hook() {
      if (!hook) {
        throw new Error('hook not rendered')
      }
      return hook
    },
    closeHost: (id) => {
      if (!closeHost) {
        throw new Error('closeHost not rendered')
      }
      closeHost(id)
    },
    unmount: () => mounted.unmount()
  }
}

beforeEach(() => {
  connectMock.mockReset()
  loadHostsMock.mockReset()
})

describe('useHostClient', () => {
  it('drops the closed client when the host entry is removed', async () => {
    const fake = makeFakeClient('connected')
    connectMock.mockReturnValue(fake)
    loadHostsMock.mockResolvedValue([HOST])

    const harness = await renderHarness(HOST.id)
    expect(harness.hook.client).toBe(fake)
    expect(harness.hook.state).toBe('connected')

    // Regression (STA-1511): closeHost deletes the entry; before the fix the
    // hook kept handing out the closed client, so mounted screens kept
    // driving requests that could never resolve.
    await act(async () => {
      harness.closeHost(HOST.id)
    })
    expect(fake.closeMock).toHaveBeenCalled()
    expect(harness.hook.client).toBeNull()
    expect(harness.hook.state).toBe('disconnected')

    harness.unmount()
  })

  it('reports disconnected instead of hanging when the host id is unknown', async () => {
    loadHostsMock.mockResolvedValue([])

    const harness = await renderHarness('missing-host')
    expect(connectMock).not.toHaveBeenCalled()
    expect(harness.hook.client).toBeNull()
    expect(harness.hook.state).toBe('disconnected')

    harness.unmount()
  })
})
