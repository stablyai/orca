import { createElement } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

// The catalog read's wire operation, replaced by a faucet this test opens and closes read by read.
const wire = vi.hoisted(() => {
  const requests: { afterSnapshotId: string | null }[] = []
  const waiting: Array<(step: { ok: true; value: unknown } | { ok: false; error: Error }) => void> =
    []
  return {
    requests,
    /** Resolves the oldest read still out with a full catalog. */
    serve(snapshotId: string, worktrees: unknown[]): void {
      waiting.shift()?.({ ok: true, value: { snapshotId, worktrees } })
    },
    /** Fails the oldest read still out. */
    fail(): void {
      waiting.shift()?.({ ok: false, error: new Error('host unreachable') })
    },
    reply(params: { afterSnapshotId: string | null }): Promise<{ value: unknown }> {
      requests.push(params)
      return new Promise((resolve, reject) => {
        waiting.push((step) => (step.ok ? resolve({ value: step.value }) : reject(step.error)))
      })
    },
    reset(): void {
      requests.length = 0
      waiting.length = 0
    }
  }
})

vi.mock('../../worktree/worktree-catalog-operations', () => ({
  worktreeCatalogRead: {
    request: (_client: unknown, params: { afterSnapshotId: string | null }) => wire.reply(params),
    interpret: (reply: { value: unknown }) => ({ accepted: true, value: reply.value })
  },
  retiredWorktreeNamesRead: {
    request: () => Promise.resolve({}),
    interpret: () => ({ accepted: false, code: 'skip' })
  }
}))

// The hook's lifecycle reaches RN's AppState and expo-router focus; this test drives reads itself.
vi.mock('react-native', () => ({ AppState: {} }))
vi.mock('expo-router', () => ({ useFocusEffect: () => {} }))
vi.mock('../../storage/preferences', () => ({ savePinnedIds: async () => {} }))
// The first-page read would race the catalog this test schedules read by read.
vi.mock('../../worktree/worktree-catalog-first-page', () => ({
  readWorktreeFirstPage: () => Promise.resolve(null)
}))

import type { ConnectionState } from '../../transport/connection/connection-state'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import type { Worktree } from '../../worktree/workspace-list-sections'
import type { HostScreenState } from '../use-host-screen-state'
import { useHostWorktreeCatalog } from './use-host-worktree-catalog'

type FetchWorktrees = (options?: { allowDuringModal?: boolean }) => Promise<Worktree[] | undefined>

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the catalog query's read goes through the wire mock above, so no member past the connection surface this graph touches is ever called.
const client = {
  close: () => {},
  getGeneration: () => 0,
  getLastConnectedAt: () => 1234,
  getReconnectAttempt: () => 0,
  getState: (): ConnectionState => 'connected',
  notifyForeground: () => {},
  onStateChange: () => () => {},
  sendRequest: () => Promise.resolve({ ok: true }),
  subscribe: () => () => {},
  updateTerminalSubscriptionViewport: () => {}
} as unknown as RpcClient

function row(worktreeId: string, repoId: string, isMainWorktree = false): Worktree {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the catalog admits any row with a string worktreeId; the handoff reads repoId/isMainWorktree only.
  return {
    worktreeId,
    repoId,
    repo: repoId,
    displayName: repoId,
    isMainWorktree
  } as unknown as Worktree
}

const heldRows = [row('wt-old', 'repo-old', true)]
const freshRows = [row('wt-old', 'repo-old', true), row('wt-new', 'repo-added', true)]

let root: ReactTestRenderer | null = null
let queryClient: QueryClient | null = null

function mountCatalog(connState: ConnectionState): FetchWorktrees {
  const held: { fetch: FetchWorktrees | null } = { fetch: null }
  function Probe(): null {
    const { fetchWorktrees } = useHostWorktreeCatalog({
      client,
      connState,
      embedded: false,
      hostCapabilities: [],
      hostStatusReadable: false,
      hostId: 'host-a',
      sidebarFeed: null,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every state member the hook touches on this path is a no-op or a value below; the rest of HostScreenState is unreachable from fetchWorktrees.
      state: {
        catalogError: null,
        clientRef: { current: null },
        setActionError: () => {},
        setCatalogError: () => {},
        setLastKnownWorktrees: () => {},
        setOptimisticActiveWorktreeIdentity: () => {},
        setPinnedIds: () => {},
        setServerWorkspaces: () => {},
        setSleptIds: () => {},
        setWorktrees: () => {},
        setWorktreesLoaded: () => {},
        showNewWorktree: false,
        worktrees: [],
        worktreesLoaded: false
      } as unknown as HostScreenState,
      syncViewSettingsFromDesktop: () => Promise.resolve()
    })
    held.fetch = fetchWorktrees
    return null
  }
  const mounted = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  queryClient = mounted
  act(() => {
    root = create(createElement(QueryClientProvider, { client: mounted }, createElement(Probe)))
  })
  if (held.fetch === null) {
    throw new Error('the catalog hook did not mount')
  }
  return held.fetch
}

// NotifyManager's scheduler runs on the macrotask queue; reads settle a tick after the faucet opens.
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

afterEach(() => {
  act(() => {
    root?.unmount()
  })
  root = null
  queryClient?.clear()
  queryClient = null
  wire.reset()
})

describe('the catalog read the Add project handoff awaits', () => {
  it('joins a read already out, then reads again so the rows cannot predate the call', async () => {
    const fetch = mountCatalog('connected')
    // The mount's own read is still out when the handoff calls.
    expect(wire.requests.length).toBe(1)
    let landing: Promise<Worktree[] | undefined> | undefined
    await act(async () => {
      landing = fetch({ allowDuringModal: true })
      // The joined read answers without the added repo; only the follow-up read may carry it.
      wire.serve('s1', heldRows)
      await flush()
    })
    expect(wire.requests.length).toBe(2)
    await act(async () => {
      wire.serve('s2', freshRows)
      await flush()
    })
    expect(await landing).toEqual(freshRows)
  })

  it('answers one read from an idle catalog', async () => {
    const fetch = mountCatalog('connected')
    await act(async () => {
      wire.serve('s1', heldRows)
      await flush()
    })
    expect(wire.requests.length).toBe(1)
    let landing: Promise<Worktree[] | undefined> | undefined
    await act(async () => {
      landing = fetch()
      wire.serve('s2', freshRows)
      await flush()
    })
    expect(wire.requests.length).toBe(2)
    expect(await landing).toEqual(freshRows)
  })

  it('answers undefined when the read fails, not the last good rows', async () => {
    const fetch = mountCatalog('connected')
    await act(async () => {
      wire.serve('s1', heldRows)
      await flush()
    })
    let landing: Promise<Worktree[] | undefined> | undefined
    await act(async () => {
      landing = fetch()
      wire.fail()
      await flush()
    })
    await expect(landing).resolves.toBeUndefined()
  })

  it('does not read while the host is not connected', async () => {
    const fetch = mountCatalog('connecting')
    // Only the mount's own read, still out; the handoff's read never leaves.
    expect(wire.requests.length).toBe(1)
    await expect(fetch()).resolves.toBeUndefined()
    expect(wire.requests.length).toBe(1)
  })
})
