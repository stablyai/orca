import type { ReactElement } from 'react'
import { act, create } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BRIDGE_PROTOCOL_VERSION } from '../mobile-web-shell/bridge/bridge-envelope'
import { createShellPageClient } from '../mobile-web-shell/bridge/page-bootstrap'
import type { BridgeRpcClient } from '../mobile-web-shell/bridge/bridge-rpc-client'
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

function render(client: BridgeRpcClient): ReactElement {
  return (
    <RpcClientProvider client={client}>
      <Screen />
    </RpcClientProvider>
  )
}

/** The channel the shell's document-start script installs, as a double. */
function installChannel(): { deliver: (frame: unknown) => void } {
  const channel: {
    postMessage: (json: string) => void
    onmessage: ((e: { data: string }) => void) | null
  } = {
    postMessage: () => {},
    onmessage: null
  }
  Object.defineProperty(globalThis, 'orcaBridge', { value: channel, configurable: true })
  return {
    deliver: (frame) => {
      channel.onmessage?.({ data: JSON.stringify(frame) })
    }
  }
}

/** What the entry hands the provider: one client, already holding a session. */
function createReadyClient(deliver: (frame: unknown) => void): BridgeRpcClient {
  const client = createShellPageClient()
  if (client === null) {
    throw new Error('no channel installed')
  }
  deliver(INIT)
  return client
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

describe('the page provider', () => {
  it('answers every screen with the one client the page has', () => {
    const channel = installChannel()
    const client = createReadyClient(channel.deliver)
    act(() => {
      create(render(client))
    })

    expect(screen.mounts).toBe(1)
    const context = readContext()
    expect(context.acquire('host-a', {})).toBe(client)
    // No host is named anywhere in the protocol, so a second route's host gets the same client.
    expect(context.acquire('host-b', {})).toBe(client)
    expect(context.getAllClients()).toEqual([
      { hostId: 'host-a', client },
      { hostId: 'host-b', client }
    ])
  })

  it('reads the connection the shell primed rather than a state of its own', () => {
    const channel = installChannel()
    const client = createReadyClient(channel.deliver)
    act(() => {
      create(render(client))
    })

    const context = readContext()
    expect(context.getState('host-a')).toBe('connected')
    expect(context.getKnownState('host-a')).toBe('connected')
    expect(context.getReconnectAttempt('host-a')).toBe(2)
    expect(context.getLastConnectedAt('host-a')).toBe(1700)
  })

  it('carries a state change from the shell to the screens watching it', () => {
    const channel = installChannel()
    const client = createReadyClient(channel.deliver)
    act(() => {
      create(render(client))
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

  it('wakes a screen watching every host on the same change', () => {
    const channel = installChannel()
    const client = createReadyClient(channel.deliver)
    act(() => {
      create(render(client))
    })
    const listener = vi.fn()
    readContext().subscribeAllHosts(listener)

    act(() => {
      channel.deliver({
        v: BRIDGE_PROTOCOL_VERSION,
        type: 'state',
        connection: { ...INIT.connection, state: 'reconnecting' }
      })
    })

    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('stops listening when the screen that asked goes away', () => {
    const channel = installChannel()
    const client = createReadyClient(channel.deliver)
    act(() => {
      create(render(client))
    })
    const listener = vi.fn()
    const unsubscribe = readContext().subscribeHostState('host-a', listener)
    unsubscribe()

    act(() => {
      channel.deliver({
        v: BRIDGE_PROTOCOL_VERSION,
        type: 'state',
        connection: { ...INIT.connection, state: 'reconnecting' }
      })
    })

    expect(listener).not.toHaveBeenCalled()
  })

  it('never closes, drops or re-dials the connection the shell owns', async () => {
    const channel = installChannel()
    const client = createReadyClient(channel.deliver)
    const close = vi.spyOn(client, 'close')
    act(() => {
      create(render(client))
    })

    const context = readContext()
    context.release('host-a', {})
    context.releaseAndCloseIfUnused('host-a', {})
    context.closeIfUnused('host-a')
    context.disconnectHostClient('host-a')
    context.forgetHostClient('host-a')
    context.refreshHostClient('host-a')
    await context.forceReconnect('host-a')

    expect(close).not.toHaveBeenCalled()
    expect(context.acquire('host-a', {})).toBe(client)
  })
})
