import { describe, expect, it, vi } from 'vitest'
import { wireMobileHomeHostSubscriptions } from './mobile-home-host-subscriptions'
import { decodeAccountsSnapshot, type AccountsSnapshot } from '../components/accounts-snapshot'
import { deepSeekMobileSnapshot } from '../test-support/deepseek-balance-snapshot'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'

vi.mock('../notifications/mobile-notifications', () => ({
  subscribeToDesktopNotifications: () => () => {}
}))
vi.mock('../components/AccountUsage', async () => import('../components/accounts-snapshot'))
vi.mock('./mobile-home-host-requests', () => ({
  fetchMobileHomeStats: vi.fn(),
  fetchMobileHomeTaskProviders: vi.fn()
}))
vi.mock('../worktree/home-host-worktree-fetch', () => ({ fetchHomeHostWorktreeInfo: vi.fn() }))

function fixture() {
  let generation = 1
  let state: ConnectionState = 'connected'
  const streams: Array<(payload: unknown) => void> = []
  let onState: (value: ConnectionState) => void = () => {}
  const snapshot = decodeAccountsSnapshot(deepSeekMobileSnapshot())
  let accounts: Record<string, AccountsSnapshot> = { host: snapshot, other: snapshot }
  const client: RpcClient = {
    sendRequest: async () => ({ id: 'fixture', ok: true, result: {} }),
    subscribe: (_method, _params, listener) => {
      streams.push(listener)
      return () => {}
    },
    onStateChange: (listener) => {
      onState = listener
      return () => {}
    },
    getGeneration: () => generation,
    getState: () => state,
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => 1,
    notifyForeground() {},
    updateTerminalSubscriptionViewport() {},
    close() {}
  }
  const dispose = wireMobileHomeHostSubscriptions(
    { hostId: 'host', client, state },
    {
      setAccounts: (update) => {
        accounts = update(accounts)
      },
      setStats() {},
      setTaskProviders() {},
      setWorktreeInfo() {}
    }
  )
  return {
    accounts: () => accounts,
    streams,
    dispose,
    snapshot: () => ({ type: 'snapshot', snapshot }),
    change(next: ConnectionState, cutover = false) {
      state = next
      if (cutover) {
        generation += 1
      }
      onState(next)
    }
  }
}

describe('Home monetary snapshot retirement', () => {
  it('waits for fresh host evidence instead of painting a persisted balance after connect', () => {
    const f = fixture()
    expect(f.accounts().host).toBeUndefined()
    expect(f.accounts().other).toBeDefined()
    f.streams[0]!(f.snapshot())
    expect(f.accounts().host?.rateLimits.deepseek?.balance).toBeDefined()
    f.dispose()
  })
  it('drops a disconnected balance and rejects callbacks from that subscription after reconnect', () => {
    const f = fixture()
    f.streams[0]!(f.snapshot())
    f.change('disconnected')
    expect(f.accounts().host).toBeUndefined()
    f.change('connected')
    f.streams[0]!(f.snapshot())
    expect(f.accounts().host).toBeUndefined()
    f.streams[1]!(f.snapshot())
    expect(f.accounts().host).toBeDefined()
    f.dispose()
  })
  it('retires on connected-to-connected generation cutover, malformed snapshots and disposal', () => {
    const f = fixture()
    f.streams[0]!(f.snapshot())
    f.change('connected', true)
    expect(f.accounts().host).toBeUndefined()
    f.streams[0]!(f.snapshot())
    expect(f.accounts().host).toBeUndefined()
    f.streams[1]!(f.snapshot())
    expect(f.accounts().host).toBeDefined()
    f.streams[1]!({ type: 'snapshot', snapshot: {} })
    expect(f.accounts().host).toBeUndefined()
    f.dispose()
    f.streams[1]!(f.snapshot())
    expect(f.accounts().host).toBeUndefined()
    expect(f.accounts().other).toBeDefined()
  })
})
