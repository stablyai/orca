import { describe, expect, it, vi } from 'vitest'

type StorageDouble = { rejection: unknown; values: Map<string, string> }

const storage = vi.hoisted((): StorageDouble => ({ rejection: null, values: new Map() }))

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => storage.values.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      if (storage.rejection !== null) {
        throw storage.rejection
      }
      storage.values.set(key, value)
    },
    removeItem: async (key: string) => {
      storage.values.delete(key)
    }
  }
}))

import { isLastVisitedWorktreeRow } from './host-list-highlight'
import {
  readLastVisitedWorktreeOnHost,
  subscribeLastVisitedWorktree,
  withLastVisitedWorktree,
  writeLastVisitedWorktree
} from './last-visited-worktree-by-host'
import {
  LAST_VISITED_WORKTREE_STORAGE_KEY,
  readLastVisitedWorktreeRecord
} from './last-visited-worktree-repo'

const stored = () => storage.values.get(LAST_VISITED_WORKTREE_STORAGE_KEY) ?? null

describe('readLastVisitedWorktreeOnHost', () => {
  it('reads nothing for a host this phone never opened a workspace on', () => {
    expect(readLastVisitedWorktreeOnHost(null, 'host-1')).toBeNull()
    const raw = withLastVisitedWorktree(null, { hostId: 'host-2', worktreeId: 'repo::/w/a' })
    expect(readLastVisitedWorktreeOnHost(raw, 'host-1')).toBeNull()
  })

  it('remembers each host’s own visit, whichever host was visited last', () => {
    let raw = withLastVisitedWorktree(null, { hostId: 'host-1', worktreeId: 'repo::/w/a' })
    raw = withLastVisitedWorktree(raw, {
      hostId: 'host-2',
      worktreeId: 'repo::/w/b',
      executionHost: 'runtime:env-1'
    })
    expect(readLastVisitedWorktreeOnHost(raw, 'host-1')).toEqual({ worktreeId: 'repo::/w/a' })
    expect(readLastVisitedWorktreeOnHost(raw, 'host-2')).toEqual({
      worktreeId: 'repo::/w/b',
      executionHost: 'runtime:env-1'
    })
    // Home's Resume card still reads the latest visit off the same record.
    expect(readLastVisitedWorktreeRecord(raw)).toEqual({
      hostId: 'host-2',
      worktreeId: 'repo::/w/b'
    })
  })

  it('reads a record stored before per-host visits for its own host, and keeps it on the next write', () => {
    const legacy = JSON.stringify({ hostId: 'host-1', worktreeId: 'repo::/w/a' })
    expect(readLastVisitedWorktreeOnHost(legacy, 'host-1')).toEqual({ worktreeId: 'repo::/w/a' })
    expect(readLastVisitedWorktreeOnHost(legacy, 'host-2')).toBeNull()
    const raw = withLastVisitedWorktree(legacy, { hostId: 'host-2', worktreeId: 'repo::/w/b' })
    expect(readLastVisitedWorktreeOnHost(raw, 'host-1')).toEqual({ worktreeId: 'repo::/w/a' })
  })

  it('drops the oldest hosts past the cap rather than the store refusing the value', () => {
    let raw: string | null = null
    for (let index = 0; index < 20; index++) {
      raw = withLastVisitedWorktree(raw, { hostId: `host-${index}`, worktreeId: 'repo::/w/a' })
    }
    expect(readLastVisitedWorktreeOnHost(raw, 'host-0')).toBeNull()
    expect(readLastVisitedWorktreeOnHost(raw, 'host-19')).toEqual({ worktreeId: 'repo::/w/a' })
  })
})

describe('isLastVisitedWorktreeRow', () => {
  it('matches a desktop row (local or SSH) by id, and a server row by its server too', () => {
    const visit = { worktreeId: 'repo::/w/a' }
    expect(isLastVisitedWorktreeRow({ worktreeId: 'repo::/w/a', hostId: 'local' }, visit)).toBe(
      true
    )
    expect(isLastVisitedWorktreeRow({ worktreeId: 'repo::/w/a', hostId: 'ssh:gpu' }, visit)).toBe(
      true
    )
    expect(
      isLastVisitedWorktreeRow({ worktreeId: 'repo::/w/a', hostId: 'runtime:env-1' }, visit)
    ).toBe(false)
    const serverVisit = { worktreeId: 'repo::/w/a', executionHost: 'runtime:env-1' as const }
    expect(
      isLastVisitedWorktreeRow({ worktreeId: 'repo::/w/a', hostId: 'runtime:env-1' }, serverVisit)
    ).toBe(true)
    expect(isLastVisitedWorktreeRow({ worktreeId: 'repo::/w/a', hostId: 'local' }, null)).toBe(
      false
    )
  })
})

describe('writeLastVisitedWorktree', () => {
  it('tells listeners at once and stores the visit beside other hosts’ visits', async () => {
    storage.values.clear()
    const told: unknown[] = []
    const unsubscribe = subscribeLastVisitedWorktree((hostId, visit) => told.push([hostId, visit]))
    void writeLastVisitedWorktree({ hostId: 'host-1', worktreeId: 'repo::/w/a' })
    expect(told).toEqual([['host-1', { worktreeId: 'repo::/w/a' }]])
    await writeLastVisitedWorktree({
      hostId: 'host-2',
      worktreeId: 'repo::/w/b',
      executionHost: 'runtime:env-1'
    })
    unsubscribe()
    expect(readLastVisitedWorktreeOnHost(stored(), 'host-1')).toEqual({ worktreeId: 'repo::/w/a' })
    expect(readLastVisitedWorktreeOnHost(stored(), 'host-2')).toEqual({
      worktreeId: 'repo::/w/b',
      executionHost: 'runtime:env-1'
    })
  })

  it('handles a store that refuses the write instead of leaving the rejection loose', async () => {
    storage.rejection = new Error('quota exceeded')
    const seen: unknown[] = []
    const listener = (reason: unknown) => seen.push(reason)
    process.on('unhandledRejection', listener)
    try {
      await writeLastVisitedWorktree({ hostId: 'host-1', worktreeId: 'repo::/w/c' })
      await new Promise<void>((resolve) => setImmediate(resolve))
    } finally {
      process.off('unhandledRejection', listener)
      storage.rejection = null
    }
    expect(seen).toEqual([])
  })
})
