import { createElement, type ReactElement } from 'react'
import { act, create } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BRIDGE_PROTOCOL_VERSION } from '../mobile-web-shell/bridge/bridge-envelope'
import type { RpcClientContextValue } from './rpc-client-context-contract'

// The web file re-exports the screen hooks, and reaching the real ones imports the Expo runtime
// this test does not have. Nothing below calls one.
vi.mock('./host-client-hooks', () => ({
  useDisconnectHostClient: () => () => {},
  useForceReconnect: () => () => Promise.resolve(),
  useForgetHostClient: () => () => {},
  useHostClient: () => ({ client: null, clientId: null, state: 'disconnected' }),
  usePrimeHosts: () => () => {},
  useRefreshHostClient: () => () => {}
}))

import { RpcClientProvider, useRpcClientContext } from './client-context.web'

const INIT = {
  v: BRIDGE_PROTOCOL_VERSION,
  type: 'init',
  sessionId: 'session-a',
  buildId: 'build-a',
  connection: {
    state: 'connected',
    reconnectAttempt: 2,
    lastConnectedAt: 1700,
    lastInboundAt: 1800,
    generation: 5
  },
  grants: { rpc: { maxPendingRequests: 64, maxSubscriptions: 32 }, native: [] }
}

/** What the page mounted, and what it holds — the two things the provider decides. */
const screen: { mounts: number; context: RpcClientContextValue | null } = {
  mounts: 0,
  context: null
}

function Screen(): null {
  screen.context = useRpcClientContext()
  screen.mounts += 1
  return null
}

function render(): ReactElement {
  return createElement(RpcClientProvider, null, createElement(Screen))
}

/** The channel the shell's document-start script installs, as a double. */
function installChannel(): { posted: string[]; deliver: (frame: unknown) => void } {
  const posted: string[] = []
  const channel: {
    postMessage: (json: string) => void
    onmessage: ((e: { data: string }) => void) | null
  } = {
    postMessage: (json) => {
      posted.push(json)
    },
    onmessage: null
  }
  Object.defineProperty(globalThis, 'orcaBridge', { value: channel, configurable: true })
  return {
    posted,
    deliver: (frame) => {
      channel.onmessage?.({ data: JSON.stringify(frame) })
    }
  }
}

function readContext(): RpcClientContextValue {
  const context = screen.context
  if (context === null) {
    throw new Error('no screen mounted')
  }
  return context
}

beforeEach(() => {
  vi.useFakeTimers()
  screen.mounts = 0
  screen.context = null
})

afterEach(() => {
  vi.useRealTimers()
  Reflect.deleteProperty(globalThis, 'orcaBridge')
})

describe('the page provider inside the shell', () => {
  it('mounts nothing until the shell answers with a session', () => {
    const channel = installChannel()
    act(() => {
      create(render())
    })
    expect(screen.mounts).toBe(0)
    expect(channel.posted.map((json: string) => JSON.parse(json).type)).toEqual(['ready'])
    act(() => {
      channel.deliver(INIT)
    })
    expect(screen.mounts).toBe(1)
  })

  it('answers every screen with the one client the page has', () => {
    const channel = installChannel()
    act(() => {
      create(render())
    })
    act(() => {
      channel.deliver(INIT)
    })
    const context = readContext()
    const client = context.acquire('host-a', {})
    expect(client).not.toBeNull()
    expect(context.getState('host-a')).toBe('connected')
    expect(context.getReconnectAttempt('host-a')).toBe(2)
    expect(context.getLastConnectedAt('host-a')).toBe(1700)
    expect(context.getAllClients()).toEqual([{ hostId: 'host-a', client }])
  })

  it('carries a state change from the shell to the screens watching it', () => {
    const channel = installChannel()
    act(() => {
      create(render())
    })
    act(() => {
      channel.deliver(INIT)
    })
    const listener = vi.fn()
    readContext().subscribeHostState('host-a', listener)
    act(() => {
      channel.deliver({
        v: BRIDGE_PROTOCOL_VERSION,
        type: 'state',
        connection: { ...INIT.connection, state: 'reconnecting' }
      })
    })
    expect(listener).toHaveBeenCalledWith('reconnecting')
    expect(readContext().getState('host-a')).toBe('reconnecting')
  })
})

describe('the page provider outside the shell', () => {
  it('mounts the route tree at once, because no session is ever coming', () => {
    act(() => {
      create(render())
    })
    expect(screen.mounts).toBe(1)
    expect(readContext().getState('host-a')).toBe('disconnected')
  })

  it('hands out a client that reaches nothing rather than none at all', async () => {
    act(() => {
      create(render())
    })
    const client = readContext().acquire('host-a', {})
    expect(client).not.toBeNull()
    await expect(client?.sendRequest('worktree.ps')).rejects.toThrow('bridge transport unavailable')
  })
})
