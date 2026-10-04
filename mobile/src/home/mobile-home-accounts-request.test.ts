import { describe, expect, it, vi } from 'vitest'
import { fetchMobileHomeAccounts } from './mobile-home-host-requests'
import { deepSeekMobileSnapshot } from '../test-support/deepseek-balance-snapshot'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse, ConnectionState } from '../transport/types'
vi.mock('../components/AccountUsage', async () => import('../components/accounts-snapshot'))

it.each(['disconnected', 'cutover', 'disposed'] as const)(
  'ignores a late Home monetary list after %s and releases its state listener',
  async (change) => {
    let generation = 1
    let disposed = false
    let onState: (state: ConnectionState) => void = () => {}
    let finish: (reply: RpcResponse) => void = () => {}
    const pending = new Promise<RpcResponse>((resolve) => {
      finish = resolve
    })
    const cleanup = vi.fn()
    const setAccounts = vi.fn()
    const client: RpcClient = {
      sendRequest: () => pending,
      subscribe: () => () => {},
      onStateChange: (listener) => {
        onState = listener
        return cleanup
      },
      getGeneration: () => generation,
      getState: () => 'connected',
      getReconnectAttempt: () => 0,
      getLastConnectedAt: () => 1,
      notifyForeground() {},
      updateTerminalSubscriptionViewport() {},
      close() {}
    }
    fetchMobileHomeAccounts(client, 'host', setAccounts, () => disposed)
    if (change === 'disposed') {
      disposed = true
    } else if (change === 'cutover') {
      generation += 1
      onState('connected')
    } else {
      onState('disconnected')
      onState('connected')
    }
    finish({ id: 'fixture', ok: true, result: deepSeekMobileSnapshot() })
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledOnce())
    expect(setAccounts).not.toHaveBeenCalled()
  }
)

describe('Home accepted monetary account reply', () => {
  it('retains healthy original host fields and releases the request listener', async () => {
    const setAccounts = vi.fn()
    const cleanup = vi.fn()
    const client: RpcClient = {
      sendRequest: async () => ({ id: 'fixture', ok: true, result: deepSeekMobileSnapshot() }),
      subscribe: () => () => {},
      onStateChange: () => cleanup,
      getState: () => 'connected',
      getReconnectAttempt: () => 0,
      getLastConnectedAt: () => 1,
      notifyForeground() {},
      updateTerminalSubscriptionViewport() {},
      close() {}
    }
    fetchMobileHomeAccounts(client, 'host', setAccounts, () => false)
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledOnce())
    expect(setAccounts).toHaveBeenCalledOnce()
  })
})
