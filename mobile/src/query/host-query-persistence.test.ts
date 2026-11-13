import { QueryClient } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcaQueryStoreBackend } from '../device-store/query-storage'
import {
  hostWorktreeCatalogKey,
  hostWorktreeCatalogQuery
} from '../host-screen/catalog/host-list-queries'
import { createHostQueryPersistence, persistedHostQueryKey } from './host-query-persistence'

vi.mock('react-native', () => ({ AppState: {} }))

const SAVED_AT = 1_794_000_000_000
const key = hostWorktreeCatalogKey('host-a')
const firstPaint = [persistedHostQueryKey(hostWorktreeCatalogQuery, key)!]

const liveRow = {
  worktreeId: 'repo-1::/w/mobile-redesign',
  repoId: 'repo-1',
  repo: 'orca',
  branch: 'kelvin/mobile-redesign',
  displayName: 'Mobile redesign',
  path: '/w/mobile-redesign',
  liveTerminalCount: 2,
  hasAttachedPty: true,
  unread: true,
  isPinned: false,
  linkedPR: { number: 38983, state: 'open' },
  status: 'permission' as const,
  sidebarStatus: 'permission',
  hasHostSidebarActivity: true,
  workingMode: 'default' as const,
  agents: []
}

function memoryStore(hostId: string) {
  const rows = new Map<string, string>()
  let readGate: Promise<void> = Promise.resolve()
  const backend: OrcaQueryStoreBackend = {
    hostId,
    read: async (keys) => {
      await readGate
      return { status: 'ok', values: keys.map((storeKey) => rows.get(storeKey) ?? null) }
    },
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
  return {
    backend,
    rows,
    holdReads: () => {
      let release = (): void => {}
      readGate = new Promise((resolve) => {
        release = resolve
      })
      return release
    }
  }
}

// What one document leaves on disk for the next: the catalog it last read, flushed.
async function storeFromEarlierLaunch(
  store: ReturnType<typeof memoryStore>,
  worktrees: readonly Record<string, unknown>[]
) {
  const earlier = new QueryClient()
  const persistence = createHostQueryPersistence(earlier, store.backend)
  // A fetch's success is what the write-behind sees; setQueryData lands the same way.
  earlier.getQueryCache().build(earlier, {
    queryKey: key,
    meta: { persist: hostWorktreeCatalogQuery.persist }
  })
  earlier.setQueryData(key, { snapshotId: 'snap-7', worktrees }, { updatedAt: SAVED_AT })
  await vi.runAllTimersAsync()
  await persistence.flush()
}

describe('createHostQueryPersistence', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: SAVED_AT + 60_000 })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('never shows a stored record that fails its data check, and removes it', async () => {
    const store = memoryStore('host-a')
    const { branch: _branch, ...rowWithoutBranch } = liveRow
    await storeFromEarlierLaunch(store, [rowWithoutBranch])
    expect(store.rows.size).toBe(1)

    const relaunched = new QueryClient()
    const persistence = createHostQueryPersistence(relaunched, store.backend)
    const restoring = persistence.restore(firstPaint)
    await vi.runAllTimersAsync()
    await restoring
    await persistence.flush()

    expect(relaunched.getQueryData(key)).toBeUndefined()
    expect(store.rows.size).toBe(0)
  })

  it('keeps the live rows when the stored ones arrive after the host answered', async () => {
    const store = memoryStore('host-a')
    await storeFromEarlierLaunch(store, [liveRow])

    const relaunched = new QueryClient()
    const release = store.holdReads()
    const restoring = createHostQueryPersistence(relaunched, store.backend).restore(firstPaint)
    const live = { snapshotId: 'snap-8', worktrees: [{ ...liveRow, unread: false }] }
    relaunched.setQueryData(key, live)
    release()
    await vi.runAllTimersAsync()
    await restoring

    expect(relaunched.getQueryData(key)).toBe(live)
  })
})
