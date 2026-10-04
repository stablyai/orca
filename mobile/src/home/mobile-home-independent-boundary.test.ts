import { expect, it, vi } from 'vitest'
import { fetchMobileHomeAccounts } from './mobile-home-host-requests'
import { wireMobileHomeHostSubscriptions } from './mobile-home-host-subscriptions'
import { decodeAccountsSnapshot, type AccountsSnapshot } from '../components/accounts-snapshot'
import { deepSeekMobileSnapshot } from '../test-support/deepseek-balance-snapshot'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse, ConnectionState } from '../transport/types'

vi.mock('../components/AccountUsage', async () => import('../components/accounts-snapshot'))
vi.mock('../notifications/mobile-notifications', () => ({
  subscribeToDesktopNotifications: () => () => {}
}))

function boundary() {
  const snapshot = decodeAccountsSnapshot(deepSeekMobileSnapshot())
  let accounts: Record<string, AccountsSnapshot> = { host: snapshot, other: snapshot }
  let finish: (reply: RpcResponse) => void = () => {}
  const pending = new Promise<RpcResponse>((resolve) => {
    finish = resolve
  })
  const states = new Set<(state: ConnectionState) => void>()
  const streams = new Set<(value: unknown) => void>()
  let lastStream: (value: unknown) => void = () => {}
  const client: RpcClient = {
    sendRequest: (method) =>
      method === 'accounts.list'
        ? pending
        : Promise.resolve({
            id: 'other',
            ok: false,
            error: { code: 'runtime_error', message: 'fixture' }
          }),
    subscribe: (_method, _params, listener) => {
      streams.add(listener)
      lastStream = listener
      return () => {
        streams.delete(listener)
      }
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
    update: (value: Record<string, AccountsSnapshot>) => Record<string, AccountsSnapshot>
  ) => {
    accounts = update(accounts)
  }
  return {
    client,
    states,
    streams,
    setAccounts,
    accounts: () => accounts,
    finish,
    snapshot,
    emit: (value: unknown) => lastStream(value)
  }
}

it('clears protected monetary evidence when the current Home list reply is malformed', async () => {
  const b = boundary()
  fetchMobileHomeAccounts(b.client, 'host', b.setAccounts, () => false)
  b.finish({ id: 'bad', ok: true, result: {} })
  await vi.waitFor(() => expect(b.states.size).toBe(0))
  expect(b.accounts().other).toBeDefined()
  expect(b.accounts().host?.rateLimits.deepseek?.balance).toBeFalsy()
})

it('does not revive removed monetary evidence from a list started before a newer account push', async () => {
  const b = boundary()
  const dispose = wireMobileHomeHostSubscriptions(
    { hostId: 'host', client: b.client, state: 'connected' },
    {
      setAccounts: b.setAccounts,
      setStats() {},
      setWorktreeInfo() {},
      setTaskProviders() {}
    }
  )
  b.emit({ type: 'snapshot', snapshot: b.snapshot })
  fetchMobileHomeAccounts(b.client, 'host', b.setAccounts, () => false)
  b.emit({
    type: 'snapshot',
    snapshot: deepSeekMobileSnapshot({
      deepseek: null,
      deepseekAccount: {
        supported: true,
        configured: false,
        ownerId: 'removed-owner',
        protection: null
      }
    })
  })
  b.finish({ id: 'older', ok: true, result: b.snapshot })
  await vi.waitFor(() => expect(b.states.size).toBe(1))
  try {
    expect(b.accounts().host?.rateLimits.deepseekAccount?.configured).toBe(false)
    expect(b.accounts().host?.rateLimits.deepseek?.balance).toBeFalsy()
  } finally {
    dispose()
  }
})

it('releases real registered subscription and state listeners on disposal, including legacy clients', () => {
  const b = boundary()
  const dispose = wireMobileHomeHostSubscriptions(
    { hostId: 'host', client: b.client, state: 'connected' },
    {
      setAccounts: b.setAccounts,
      setStats() {},
      setWorktreeInfo() {},
      setTaskProviders() {}
    }
  )
  b.emit({ type: 'snapshot', snapshot: b.snapshot })
  expect(b.streams.size).toBe(1)
  expect(b.states.size).toBe(1)
  dispose()
  expect(b.streams.size).toBe(0)
  expect(b.states.size).toBe(0)
  b.emit({ type: 'snapshot', snapshot: b.snapshot })
  expect(b.accounts().host).toBeUndefined()
  expect(b.accounts().other).toBeDefined()
})
