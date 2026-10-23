import { onTestFinished, describe, expect, it } from 'vitest'
import type { RpcClient } from '../../transport/rpc-client'
import type { RpcResponse } from '../../transport/types'
import { createBridgePortPair, createFakeBridgePortPair } from './bridge-port-pair-test-harness'

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
  it('delivers init synchronously so a caller can mount in the same turn', () => {
    const pair = createFakeBridgePortPair()
    try {
      for (let rounds = 0; pair.client.getShellSession() === null && rounds < 4; rounds += 1) {
        pair.drainNow()
      }
      expect(pair.client.getShellSession()).toMatchObject({
        sessionId: 'session-a',
        buildId: 'build-a',
        route: { pathname: '/h/host-a' }
      })
      expect(pair.client.getState()).toBe('connected')
    } finally {
      pair.client.close()
      pair.host.dispose()
    }
  })

  it('reports movement and reaches a quiet handshake in a bounded drain', () => {
    const pair = createFakeBridgePortPair()
    try {
      expect(pair.drainNow()).toBeGreaterThan(0)
      let moved = 1
      for (let rounds = 0; moved > 0 && rounds < 8; rounds += 1) {
        moved = pair.drainNow()
      }
      expect(moved).toBe(0)
      expect(pair.drainNow()).toBe(0)
    } finally {
      pair.client.close()
      pair.host.dispose()
    }
  })

  it('carries a shell client that is not the fake, which is what the golden recorder needs', async () => {
    const record: string[] = []
    const client = plainShellClient(record)
    const pair = createBridgePortPair({ rpc: client })
    onTestFinished(() => {
      pair.client.close()
      pair.host.dispose()
    })
    expect(pair.rpc).toBe(client)
    await pair.flush()
    void pair.client.sendRequest('worktree.list').catch(() => undefined)
    await pair.flush()
    expect(record).toEqual(['worktree.list'])
    pair.client.close()
    pair.host.dispose()
  })
})
