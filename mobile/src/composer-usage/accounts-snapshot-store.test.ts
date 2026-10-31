import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import { subscribeAccountsSnapshot } from './accounts-snapshot-store'

const SNAPSHOT = {
  claude: { accounts: [], activeAccountId: null },
  codex: { accounts: [], activeAccountId: null },
  rateLimits: {
    claude: null,
    codex: null,
    inactiveClaudeAccounts: [],
    inactiveCodexAccounts: []
  }
}

function fakeClient() {
  let push: ((payload: unknown) => void) | null = null
  const unsubscribe = vi.fn()
  const subscribe = vi.fn((_method: string, _params: unknown, onData: (p: unknown) => void) => {
    push = onData
    return unsubscribe
  })
  const sendRequest = vi.fn(() => new Promise<RpcResponse>(() => undefined))
  const client: Pick<RpcClient, 'subscribe' | 'sendRequest'> = { subscribe, sendRequest }
  return { client, subscribe, unsubscribe, push: (payload: unknown) => push?.(payload) }
}

describe('subscribeAccountsSnapshot', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('shares one accounts stream across composers and closes it after the last leaves', () => {
    vi.useFakeTimers()
    const fake = fakeClient()
    // SAFETY: the store only calls subscribe and sendRequest, which the fake implements.
    const client = fake.client as RpcClient
    const first = vi.fn()
    const second = vi.fn()
    const stopFirst = subscribeAccountsSnapshot(client, first)
    const stopSecond = subscribeAccountsSnapshot(client, second)
    expect(fake.subscribe).toHaveBeenCalledTimes(1)

    fake.push({ type: 'ready', snapshot: SNAPSHOT })
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)

    stopFirst()
    stopSecond()
    vi.runAllTimers()
    expect(fake.unsubscribe).toHaveBeenCalledTimes(1)
  })
})
