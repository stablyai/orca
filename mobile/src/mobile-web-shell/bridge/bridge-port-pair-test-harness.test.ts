import { describe, expect, it } from 'vitest'
import type { RpcClient } from '../../transport/rpc-client'
import type { RpcResponse } from '../../transport/types'
import { createBridgePortPair, createFakeBridgePortPair } from './bridge-port-pair-test-harness'
import { BRIDGE_PAGE_CLIENT_IDENTITY_ACCEPT } from './bridge-page-client-identity'
import { BRIDGE_PAGE_PAINTED } from './bridge-page-painted'
import { BRIDGE_ROUTE_PARAM_CLEAR } from './bridge-route-update'

/** Every member of the contract, none of them a fake anything: the pair must carry a plain client. */
function plainShellClient(record: string[]): RpcClient {
  return {
    sendRequest: (method: string) => {
      record.push(method)
      return new Promise<RpcResponse>(() => {})
    },
    subscribe: () => () => undefined,
    updateTerminalSubscriptionViewport: () => {},
    getState: () => 'connected',
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => 0,
    onStateChange: () => () => undefined,
    notifyForeground: () => {},
    close: () => {}
  }
}

describe('the bridge port pair', () => {
  it('lands `init` on the page with no await, so a caller can mount in the same turn', () => {
    const pair = createFakeBridgePortPair()
    let rounds = 0
    while (pair.client.getShellSession() === null && rounds < 4) {
      pair.drainNow()
      rounds += 1
    }
    expect(pair.client.getShellSession()).toEqual({
      sessionId: 'session-a',
      buildId: 'build-a',
      grants: expect.anything(),
      // The screen the shell says this page stands in for, and the routes it keeps for itself; the
      // pair names both so the session it hands back is the shape a page on a route actually holds.
      route: expect.objectContaining({ pathname: expect.any(String) }),
      pageRoutes: expect.any(Array),
      pageRouteGrants: null,
      host: expect.objectContaining({ id: expect.any(String) }),
      storage: expect.any(Object),
      storageOversize: [],
      accepts: [BRIDGE_ROUTE_PARAM_CLEAR, BRIDGE_PAGE_CLIENT_IDENTITY_ACCEPT, BRIDGE_PAGE_PAINTED]
    })
  })

  it('reports how many frames it moved, and moves none once both lanes are empty', () => {
    const pair = createFakeBridgePortPair()
    expect(pair.drainNow()).toBeGreaterThan(0)
    while (pair.drainNow() > 0) {
      // the handshake is more than one frame; drain until it settles
    }
    expect(pair.drainNow()).toBe(0)
  })

  it('carries a shell client that is not the fake, which is what the golden recorder needs', async () => {
    const record: string[] = []
    const client = plainShellClient(record)
    const pair = createBridgePortPair({ rpc: client })
    expect(pair.rpc).toBe(client)
    await pair.flush()
    void pair.client.sendRequest('worktree.list')
    await pair.flush()
    expect(record).toEqual(['worktree.list'])
  })
})
