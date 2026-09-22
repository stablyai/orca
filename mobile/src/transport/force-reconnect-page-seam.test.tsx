import { act, create } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BRIDGE_PROTOCOL_VERSION } from '../mobile-web-shell/bridge/bridge-envelope'
import type { ForceReconnect, RpcClientContextValue } from './rpc-client-context-contract'

const page = vi.hoisted(() => ({ read: (): RpcClientContextValue | null => null }))

// The page bundle resolves `./client-context` to its `.web` sibling. Forwarded lazily rather than
// re-exported, because the sibling imports these hooks back and an awaited mock of it deadlocks.
vi.mock('./client-context', () => ({ useRpcClientContext: () => page.read() }))

import { createShellPageClient } from '../mobile-web-shell/bridge/page-bootstrap'
import { RpcClientProvider, useRpcClientContext } from './client-context.web'
import { useForceReconnect } from './host-client-hooks'

page.read = useRpcClientContext

const INIT = {
  v: BRIDGE_PROTOCOL_VERSION,
  type: 'init',
  sessionId: 'session-a',
  buildId: 'build-a',
  connection: {
    state: 'reconnecting',
    reconnectAttempt: 4,
    lastConnectedAt: 1700,
    lastInboundAt: 1800,
    generation: 5
  },
  grants: { rpc: { maxPendingRequests: 64, maxSubscriptions: 32 }, native: [] },
  accepts: []
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'orcaBridge')
})

describe('useForceReconnect on the page', () => {
  it('answers null through the real hook, which is what every Retry reads', () => {
    const channel: {
      postMessage: (json: string) => void
      onmessage: ((e: { data: string }) => void) | null
    } = {
      postMessage: () => {},
      onmessage: null
    }
    Object.defineProperty(globalThis, 'orcaBridge', { value: channel, configurable: true })
    const client = createShellPageClient()
    if (client === null) {
      throw new Error('no channel installed')
    }
    channel.onmessage?.({ data: JSON.stringify(INIT) })
    const read: { value: ForceReconnect | undefined } = { value: undefined }
    function Probe(): null {
      read.value = useForceReconnect()
      return null
    }
    act(() => {
      create(
        <RpcClientProvider client={client}>
          <Probe />
        </RpcClientProvider>
      )
    })
    expect(read.value).toBeNull()
  })
})
