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
    replies,
    dispose,
    states,
    accounts: () => accounts,
    push: (snapshot: unknown) => push({ type: 'snapshot', snapshot }),
    read: () => fetchMobileHomeAccounts(client, 'host', setAccounts, () => false)
  }
}

it.each(['removed', 'replaced', 'malformed'] as const)(
  'retires overlapping Home reads after a newer %s push and accepts a current refresh',
  async (kind) => {
    const f = fixture()
    try {
      f.read()
      f.read()
      f.read()
      const newer =
        kind === 'malformed'
          ? {}
          : deepSeekMobileSnapshot({
              deepseek: null,
              deepseekAccount: {
                supported: true,
                configured: kind === 'replaced',
                ownerId: 'new-owner',
                protection: kind === 'replaced' ? 'sealed' : null
              }
            })
      f.push(newer)
      f.replies[0]!({ id: 'old', ok: true, result: f.original })
      await vi.waitFor(() => expect(f.replies).toHaveLength(2))
      f.replies[1]!({ id: 'queued-old', ok: true, result: f.original })
      await vi.waitFor(() => expect(f.states.size).toBe(1))
      expect(f.accounts().host?.rateLimits.deepseek?.balance).toBeFalsy()
      expect(f.accounts().other).toEqual(f.original)
      f.read()
      f.replies[2]!({ id: 'current', ok: true, result: f.original })
      await vi.waitFor(() => expect(f.states.size).toBe(1))
      expect(f.accounts().host?.rateLimits.deepseek?.balance).toEqual(
        f.original.rateLimits.deepseek?.balance
      )
    } finally {
      f.dispose()
    }
    expect(f.states.size).toBe(0)
  }
)

it('preserves last-good Home money on an ordinary request failure', async () => {
  const f = fixture()
  f.read()
  f.replies[0]!({ id: 'failed', ok: false, error: { code: 'runtime_error', message: 'offline' } })
  await vi.waitFor(() => expect(f.states.size).toBe(1))
  expect(f.accounts().host).toEqual(f.original)
  f.dispose()
})

it.each([
  undefined,
  null,
  { error: 'refused' },
  { ok: false, error: 'inner refused' },
  { ok: false, error: { message: 'inner refused' } }
])('does not publish or retire Home money for an invalid result %j', async (result) => {
  const f = fixture()
  try {
    const before = f.accounts()
    f.read()
    f.replies[0]!({ id: 'invalid', ok: true, result })
    await vi.waitFor(() => expect(f.states.size).toBe(1))
    expect(f.accounts()).toBe(before)
    expect(f.accounts().other).toBe(f.original)
    f.read()
    f.replies[1]!({ id: 'recovery', ok: true, result: f.original })
    await vi.waitFor(() => expect(f.states.size).toBe(1))
    expect(f.accounts().host).toEqual(f.original)
  } finally {
    f.dispose()
  }
})
