import { createElement } from 'react'
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
// Also tells TanStack observers on a microtask, so act() sees replies.
import '../test-support/query-client-test-renderer'
import { settleQueryNotifications } from '../test-support/rpc-recording/hook-mount'
import type { OrcaQueryStoreBackend } from '../device-store/query-storage'
import { createOrcaQueryClient } from '../query/orca-query-client'
import { createHostQueryPersistence, persistedHostQueryKey } from '../query/host-query-persistence'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import {
  accountsSnapshotFamily,
  accountsSnapshotKey,
  accountsSnapshotOptions
} from './accounts-snapshot-stream'
import { useMobileAccountsSnapshot } from './use-mobile-accounts-snapshot'

const HOST = 'host-1'
const CONNECTED_AT = 1_794_000_000_000

const SNAPSHOT = {
  claude: {
    accounts: [{ id: 'claude-1', email: 'claude@example.test', updatedAt: 100 }],
    activeAccountId: 'claude-1'
  },
  codex: { accounts: [], activeAccountId: null },
  rateLimits: {
    claude: {
      provider: 'claude',
      session: { usedPercent: 42, windowMinutes: 300, resetsAt: null, resetDescription: null },
      weekly: null,
      updatedAt: 100,
      error: null,
      status: 'ok'
    },
    codex: null,
    inactiveClaudeAccounts: [],
    inactiveCodexAccounts: []
  }
}

function accountsClient(listReply: unknown) {
  let stream: (payload: unknown) => void = () => {}
  const sendRequest = vi.fn(async () => ({ id: 'reply', ok: true as const, result: listReply }))
  const client: RpcClient = {
    sendRequest,
    subscribe: (_method, _params, listener) => {
      stream = listener
      return () => {}
    },
    updateTerminalSubscriptionViewport: () => {},
    getState: () => 'connected',
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => CONNECTED_AT,
    getGeneration: () => 1,
    onStateChange: () => () => {},
    notifyForeground: () => {},
    close: () => {}
  }
  return { client, sendRequest, frame: (payload: unknown) => stream(payload) }
}

let tree: ReactTestRenderer | null = null
afterEach(() => {
  act(() => tree?.unmount())
  tree = null
})

async function mountAccounts(queryClient: QueryClient, client: RpcClient) {
  let state: ReturnType<typeof useMobileAccountsSnapshot> | null = null
  function Probe() {
    state = useMobileAccountsSnapshot({
      hostId: HOST,
      client,
      connState: 'connected',
      lastConnectedAt: CONNECTED_AT
    })
    return null
  }
  await act(async () => {
    tree = create(createElement(QueryClientProvider, { client: queryClient }, createElement(Probe)))
  })
  return () => {
    if (!state) {
      throw new Error('Not mounted')
    }
    return state
  }
}

function memoryStore(): OrcaQueryStoreBackend {
  const rows = new Map<string, string>()
  return {
    hostId: HOST,
    read: async (keys) => ({ status: 'ok', values: keys.map((key) => rows.get(key) ?? null) }),
    write: async (ops) => {
      for (const op of ops) {
        if (op.value === null) {
          rows.delete(op.key)
        } else {
          rows.set(op.key, op.value)
        }
      }
      return { written: true }
    }
  }
}

describe('accounts snapshot', () => {
  it('still shows usage when the stream fails and accounts.list answers', async () => {
    const port = accountsClient(SNAPSHOT)
    const read = await mountAccounts(createOrcaQueryClient(), port.client)
    await act(async () => port.frame({ type: 'error' }))
    await settleQueryNotifications()
    expect(port.sendRequest).toHaveBeenCalledWith('accounts.list')
    expect(read().live).toBe(true)
    expect(read().snapshot?.rateLimits.claude?.session?.usedPercent).toBe(42)
  })

  it('hides usage this screen did not read on the current connection, keeping the accounts', async () => {
    const queryClient = createOrcaQueryClient()
    queryClient.setQueryData(accountsSnapshotKey(HOST), SNAPSHOT, { updatedAt: CONNECTED_AT - 1 })
    const read = await mountAccounts(queryClient, accountsClient(SNAPSHOT).client)
    expect(read().live).toBe(false)
    expect(read().snapshot?.rateLimits.claude).toBeNull()
    expect(read().snapshot?.claude.accounts.map((account) => account.email)).toEqual([
      'claude@example.test'
    ])
  })

  it('never counts a stored snapshot as live, even one written after the connect', async () => {
    const store = memoryStore()
    // Native Home's own stream stores the snapshot after the connect the page then reads.
    const home = createOrcaQueryClient()
    const homePersistence = createHostQueryPersistence(home, store)
    home.getQueryCache().build(home, accountsSnapshotOptions(HOST))
    home.setQueryData(accountsSnapshotKey(HOST), SNAPSHOT, { updatedAt: CONNECTED_AT + 1 })
    await settleQueryNotifications()
    await homePersistence.flush()
    home.clear()

    const page = createOrcaQueryClient()
    await createHostQueryPersistence(page, store).restore([
      persistedHostQueryKey(accountsSnapshotFamily, accountsSnapshotKey(HOST))!
    ])
    const read = await mountAccounts(page, accountsClient(SNAPSHOT).client)
    expect(read().snapshot?.claude.accounts.map((account) => account.id)).toEqual(['claude-1'])
    expect(read().live).toBe(false)
  })
})
