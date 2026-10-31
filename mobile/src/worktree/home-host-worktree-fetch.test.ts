import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHostConnectRefetchGate } from '../transport/host-connect-refetch-gate'
import type { RpcClient } from '../transport/rpc-client'
import {
  createStableLogicalRpcClient,
  LogicalClientCutoverError
} from '../transport/stable-logical-rpc-client'
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
  it('keeps the last proven counts when the in-flight read rejects', async () => {
    const store = infoStore()
    const host = fakeSession()

    const loaded = fetchHomeHostWorktreeInfo(host.client, 'host-1', store.setInfo, notDisposed)
    host.settle(catalogResponse(12, 2))
    await loaded

    const failed = fetchHomeHostWorktreeInfo(host.client, 'host-1', store.setInfo, notDisposed)
    host.settle(new Error('socket closed mid-request'))
    await failed

    expect(store.current['host-1']).toEqual({
      hostId: 'host-1',
      totalWorktrees: 12,
      activeCount: 2,
      lastActiveWorktree: expect.objectContaining({ worktreeId: 'wt-0' }),
      attention: expect.any(Array),
      catalogUnavailable: true,
      staleCounts: true,
      countsProvenAt: expect.any(Number)
    })
  })

  it('counts only the rows the list shows, with its activity rule', async () => {
    const store = infoStore()
    const host = fakeSession()
    const row = { repo: 'orca', branch: 'b', displayName: 'w', liveTerminalCount: 0 }
    const worktrees = [
      { ...row, worktreeId: 'archived', isArchived: true, status: 'working' },
      { ...row, worktreeId: 'tab-only', status: 'inactive', hasHostSidebarActivity: true },
      { ...row, worktreeId: 'idle', status: 'inactive', hasHostSidebarActivity: false }
    ]

    const response: RpcResponse = { id: 'catalog', ok: true, result: { worktrees } }
    const loaded = fetchHomeHostWorktreeInfo(host.client, 'host-1', store.setInfo, notDisposed)
    host.settle(response)
    await loaded

    expect(store.current['host-1']).toMatchObject({ totalWorktrees: 2, activeCount: 1 })
  })

  it('stamps when the host proved the counts', async () => {
    const store = infoStore()
    const host = fakeSession()

    const loaded = fetchHomeHostWorktreeInfo(host.client, 'host-1', store.setInfo, notDisposed)
    host.settle(catalogResponse(3, 1))
    await loaded

    const provenAt = store.current['host-1'].countsProvenAt
    expect(provenAt).toBe(1_700_000_000_000)
  })

  it('marks a host whose catalog never loaded as unavailable, not empty', async () => {
    const store = infoStore()
    const host = fakeSession()

    const failed = fetchHomeHostWorktreeInfo(host.client, 'host-1', store.setInfo, notDisposed)
    host.settle({ ok: false, error: { code: 'internal' } } as RpcResponse)
    await failed

    expect(store.current['host-1']).toMatchObject({
      totalWorktrees: 0,
      catalogUnavailable: true
    })
    expect(store.current['host-1'].staleCounts).toBeUndefined()
  })

  it('re-reads the catalog on reconnect and clears the stale flag', async () => {
    const store = infoStore()
    const host = fakeSession()
    const gate = createHostConnectRefetchGate()

    const connect = async (response: RpcResponse | Error) => {
      if (!gate.observe('connected')) {
        return
      }
      const done = fetchHomeHostWorktreeInfo(host.client, 'host-1', store.setInfo, notDisposed)
      host.settle(response)
      await done
    }

    await connect(catalogResponse(12, 2))
    const dropped = fetchHomeHostWorktreeInfo(host.client, 'host-1', store.setInfo, notDisposed)
    host.settle(new Error('socket closed mid-request'))
    await dropped
    gate.observe('reconnecting')
    expect(store.current['host-1'].staleCounts).toBe(true)

    await connect(catalogResponse(13, 3))

    expect(store.current['host-1']).toMatchObject({
      totalWorktrees: 13,
      activeCount: 3
    })
    expect(store.current['host-1'].staleCounts).toBeUndefined()
    expect(store.current['host-1'].catalogUnavailable).toBeUndefined()
    // Keep the gate closed while connected, including after a failed poll.
    expect(host.calls).toBe(3)
    await connect(catalogResponse(13, 3))
    expect(host.calls).toBe(3)
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

  it('gives up on a host that keeps cutting over so the card still reports the failure', async () => {
    const store = infoStore()
    const host = fakeSession()

    const loaded = fetchHomeHostWorktreeInfo(host.client, 'host-1', store.setInfo, notDisposed)
    host.settle(catalogResponse(12, 2))
    await loaded

    const cutoverStorm = fetchHomeHostWorktreeInfo(
      host.client,
      'host-1',
      store.setInfo,
      notDisposed
    )
    for (let attempt = 0; attempt < 6; attempt += 1) {
      host.settle(new LogicalClientCutoverError())
      await flush()
    }
    await cutoverStorm

    expect(host.calls).toBe(4)
    expect(store.current['host-1'].staleCounts).toBe(true)
  })

  it('ignores a response that lands after the screen is disposed', async () => {
    const store = infoStore()
    const host = fakeSession()

    let disposed = false
    const done = fetchHomeHostWorktreeInfo(host.client, 'host-1', store.setInfo, () => disposed)
    disposed = true
    host.settle(new Error('socket closed mid-request'))
    await done
    expect(store.current['host-1']).toBeUndefined()

    disposed = false
    const successful = fetchHomeHostWorktreeInfo(
      host.client,
      'host-1',
      store.setInfo,
      () => disposed
    )
    disposed = true
    host.settle(catalogResponse(3, 1))
    await successful
    expect(store.current['host-1']).toBeUndefined()
  })
})
