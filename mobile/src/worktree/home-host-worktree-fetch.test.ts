import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHostConnectRefetchGate } from '../transport/host-connect-refetch-gate'
import type { RpcClient } from '../transport/rpc-client'
import { createStableLogicalRpcClient } from '../transport/stable-logical-rpc-client'
import type { ConnectionState, RpcResponse } from '../transport/types'
import { fetchHomeHostWorktreeInfo } from './home-host-worktree-fetch'
import type { HostWorktreeInfo } from './home-worktree-info'

type FakeSession = {
  client: RpcClient
  calls: number
  settle: (response: RpcResponse | Error) => void
}

function fakeSession(): FakeSession {
  const pending: Array<(response: RpcResponse | Error) => void> = []
  const fake: FakeSession = {
    calls: 0,
    settle(response: RpcResponse | Error) {
      const next = pending.shift()
      next?.(response)
    },
    client: {
      sendRequest: () => {
        fake.calls += 1
        return new Promise<RpcResponse>((resolve, reject) => {
          pending.push((response) =>
            response instanceof Error ? reject(response) : resolve(response)
          )
        })
      },
      subscribe: () => () => {},
      updateTerminalSubscriptionViewport: () => {},
      getState: (): ConnectionState => 'connected',
      getReconnectAttempt: () => 0,
      getLastConnectedAt: () => null,
      onStateChange: () => () => {},
      notifyForeground: () => {},
      close: () => {
        for (const settle of pending.splice(0)) {
          settle(new Error('Client closed'))
        }
      }
    }
  }
  return fake
}

// Drains the promise chain so a retry queued in a .catch has reached the transport.
const flush = () => vi.advanceTimersByTimeAsync(0)

function catalogResponse(count: number, active: number): RpcResponse {
  const worktrees = Array.from({ length: count }, (_, index) => ({
    worktreeId: `wt-${index}`,
    repo: 'orca',
    branch: `branch-${index}`,
    displayName: `Workspace ${index}`,
    liveTerminalCount: 0,
    status: index < active ? ('working' as const) : ('inactive' as const)
  }))
  return { ok: true, result: { worktrees } } as RpcResponse
}

function infoStore() {
  let state: Record<string, HostWorktreeInfo> = {}
  return {
    get current() {
      return state
    },
    setInfo(updater: (prev: Record<string, HostWorktreeInfo>) => Record<string, HostWorktreeInfo>) {
      state = updater(state)
    }
  }
}

const notDisposed = () => false

describe('fetchHomeHostWorktreeInfo', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    vi.setSystemTime(1_700_000_000_000)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('re-reads through a relay→direct cutover, which never leaves connected', async () => {
    const store = infoStore()
    const relay = fakeSession()
    const direct = fakeSession()
    const logical = createStableLogicalRpcClient(relay.client, 'relay')
    const gate = createHostConnectRefetchGate()
    const gateFires: ConnectionState[] = []
    logical.onStateChange((state) => {
      if (gate.observe(state)) {
        gateFires.push(state)
      }
    })
    gate.observe(logical.getState())

    const loaded = fetchHomeHostWorktreeInfo(logical, 'host-1', store.setInfo, notDisposed)
    relay.settle(catalogResponse(12, 2))
    await loaded

    const interrupted = fetchHomeHostWorktreeInfo(logical, 'host-1', store.setInfo, notDisposed)
    await logical.migrateTo(direct.client, 'lan')
    await flush()

    expect(direct.calls).toBe(1)
    direct.settle(catalogResponse(13, 3))
    await interrupted

    // Migration republishes connected without an edge to re-arm the gate.
    expect(gateFires).toEqual([])
    expect(store.current['host-1']).toMatchObject({ totalWorktrees: 13, activeCount: 3 })
    expect(store.current['host-1'].staleCounts).toBeUndefined()
    expect(store.current['host-1'].catalogUnavailable).toBeUndefined()
  })

  it('answers a refresh asked mid-read with one trailing read, not the older reply', async () => {
    const store = infoStore()
    const host = fakeSession()

    const first = fetchHomeHostWorktreeInfo(host.client, 'host-1', store.setInfo, notDisposed)
    const second = fetchHomeHostWorktreeInfo(host.client, 'host-1', store.setInfo, notDisposed)
    const third = fetchHomeHostWorktreeInfo(host.client, 'host-1', store.setInfo, notDisposed)
    host.settle(catalogResponse(12, 2))
    await first
    await flush()
    host.settle(catalogResponse(13, 3))
    await Promise.all([second, third])

    expect(host.calls).toBe(2)
    expect(store.current['host-1']).toMatchObject({ totalWorktrees: 13, activeCount: 3 })
  })
})
