import { expect, it, vi } from 'vitest'
import { fetchMobileHomeAccounts } from './mobile-home-host-requests'
import { wireMobileHomeHostSubscriptions } from './mobile-home-host-subscriptions'
import { decodeAccountsSnapshot, type AccountsSnapshot } from '../components/accounts-snapshot'
import { deepSeekMobileSnapshot } from '../test-support/deepseek-balance-snapshot'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'

vi.mock('../components/AccountUsage', async () => import('../components/accounts-snapshot'))
vi.mock('../notifications/mobile-notifications', () => ({
  subscribeToDesktopNotifications: () => () => {}
}))

function fixture() {
  const original = decodeAccountsSnapshot(deepSeekMobileSnapshot())
  let accounts: Record<string, AccountsSnapshot> = { host: original, other: original }
  const replies: Array<(reply: RpcResponse) => void> = []
  let push: (payload: unknown) => void = () => {}
  const states = new Set<unknown>()
  const client: RpcClient = {
    sendRequest: (method) =>
      method === 'accounts.list'
        ? new Promise<RpcResponse>((resolve) => replies.push(resolve))
        : Promise.resolve({
            id: 'other',
            ok: false,
            error: { code: 'runtime_error', message: 'fixture' }
          }),
    subscribe: (_method, _params, listener) => {
      push = listener
      return () => {}
    },
    onStateChange: (listener) => {
      states.add(listener)
      return () => {
        states.delete(listener)
      }
    },
    getState: () => 'connected',
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => 1,
    notifyForeground() {},
    updateTerminalSubscriptionViewport() {},
    close() {}
  }
  const setAccounts = (
    update: (previous: Record<string, AccountsSnapshot>) => Record<string, AccountsSnapshot>
  ) => {
    accounts = update(accounts)
  }
  const dispose = wireMobileHomeHostSubscriptions(
    { hostId: 'host', client, state: 'connected' },
    {
      setAccounts,
      setStats() {},
      setWorktreeInfo() {},
      setTaskProviders() {}
    }
  )
  push({ type: 'ready', snapshot: original })
  return {
    original,
    client,
    setAccounts,
    replies,
    dispose,
    states,
    accounts: () => accounts,
    push: (snapshot: unknown) => push({ type: 'snapshot', snapshot }),
    read: () => fetchMobileHomeAccounts(client, 'host', setAccounts, () => false)
  }
}

it('does not re-stamp a queued Home reply for a caller arriving after removal', async () => {
  const f = fixture()
  try {
    f.read()
    f.read()
    f.push(deepSeekMobileSnapshot({ deepseek: null }))
    f.read()
    f.replies[0]!({ id: 'old', ok: true, result: f.original })
    await vi.waitFor(() => expect(f.replies).toHaveLength(2))
    f.replies[1]!({ id: 'coalesced', ok: true, result: f.original })
    await vi.waitFor(() => expect(f.states.size).toBe(1))
    expect(f.accounts().host?.rateLimits.deepseek?.balance).toBeFalsy()
    f.read()
    f.replies[2]!({ id: 'fresh', ok: true, result: f.original })
    await vi.waitFor(() => expect(f.states.size).toBe(1))
    expect(f.accounts().host?.rateLimits.deepseek?.balance).toEqual(
      f.original.rateLimits.deepseek?.balance
    )
  } finally {
    f.dispose()
  }
})
it('does not let a retired malformed Home reply clear newer money', async () => {
  const f = fixture()
  try {
    f.read()
    f.push(f.original)
    f.replies[0]!({ id: 'malformed-old', ok: true, result: {} })
    await vi.waitFor(() => expect(f.states.size).toBe(1))
    expect(f.accounts().host).toEqual(f.original)
    expect(f.accounts().other).toEqual(f.original)
  } finally {
    f.dispose()
  }
})

it('keeps retirement host-scoped when one client serves two host IDs', async () => {
  const f = fixture()
  let otherPush: (payload: unknown) => void = () => {}
  f.client.subscribe = (_method, _params, listener) => {
    otherPush = listener
    return () => {}
  }
  const disposeOther = wireMobileHomeHostSubscriptions(
    { hostId: 'other', client: f.client, state: 'connected' },
    { setAccounts: f.setAccounts, setStats() {}, setWorktreeInfo() {}, setTaskProviders() {} }
  )
  try {
    otherPush({ type: 'ready', snapshot: f.original })
    f.read()
    fetchMobileHomeAccounts(f.client, 'other', f.setAccounts, () => false)
    f.push(deepSeekMobileSnapshot({ deepseek: null }))
    f.replies[0]!({ id: 'retired-host', ok: true, result: f.original })
    f.replies[1]!({ id: 'current-other', ok: true, result: f.original })
    await vi.waitFor(() => expect(f.states.size).toBe(2))
    expect(f.accounts().host?.rateLimits.deepseek?.balance).toBeFalsy()
    expect(f.accounts().other).toEqual(f.original)
  } finally {
    disposeOther()
    f.dispose()
  }
})
it('does not let a retired client clear the replacement client snapshot for the same host', async () => {
  const old = fixture()
  const replacement = fixture()
  old.read()
  old.dispose()
  let push: (payload: unknown) => void = () => {}
  replacement.client.subscribe = (_method, _params, listener) => {
    push = listener
    return () => {}
  }
  const dispose = wireMobileHomeHostSubscriptions(
    { hostId: 'host', client: replacement.client, state: 'connected' },
    { setAccounts: old.setAccounts, setStats() {}, setWorktreeInfo() {}, setTaskProviders() {} }
  )
  try {
    push({ type: 'ready', snapshot: replacement.original })
    old.replies[0]!({ id: 'retired-client-malformed', ok: true, result: {} })
    await vi.waitFor(() => expect(old.states.size).toBe(0))
    expect(old.accounts().host).toEqual(replacement.original)
  } finally {
    dispose()
    replacement.dispose()
  }
})
