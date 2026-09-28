import { describe, expect, it, vi } from 'vitest'

type StorageDouble = { rejection: unknown; written: string[] }

const storage = vi.hoisted((): StorageDouble => ({ rejection: null, written: [] }))

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    setItem: async (_key: string, value: string) => {
      if (storage.rejection !== null) {
        throw storage.rejection
      }
      storage.written.push(value)
    },
    removeItem: async () => undefined
  }
}))

import {
  readLastVisitedWorktreeRecord,
  readLastVisitedWorktreeRepoId,
  writeLastVisitedWorktree
} from './last-visited-worktree-repo'

/** Node reports an unhandled rejection at the end of a microtask checkpoint, so one macrotask is
 *  long enough to see it, and a listener is the only way to observe one from inside a test. */
async function unhandledRejectionsWhile(run: () => void): Promise<unknown[]> {
  const seen: unknown[] = []
  const listener = (reason: unknown) => seen.push(reason)
  process.on('unhandledRejection', listener)
  try {
    run()
    await new Promise<void>((resolve) => setImmediate(resolve))
    await new Promise<void>((resolve) => setImmediate(resolve))
  } finally {
    process.off('unhandledRejection', listener)
  }
  return seen
}

// Why: the mirror reports this key as written the moment it is noted, so a store write that
// rejects must be handled where it is made. Nothing above it is holding a catch.
describe('writeLastVisitedWorktree', () => {
  it('handles a store that refuses the write instead of leaving the rejection loose', async () => {
    storage.rejection = new Error('quota exceeded')
    const loose = await unhandledRejectionsWhile(() => {
      writeLastVisitedWorktree({ hostId: 'host-1', worktreeId: 'repo-2::/tmp/worktree' })
    })
    storage.rejection = null
    expect(loose).toEqual([])
  })

  it('still persists the record when the store takes it', async () => {
    storage.written.length = 0
    writeLastVisitedWorktree({ hostId: 'host-1', worktreeId: 'repo-2::/tmp/worktree' })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(storage.written).toEqual([
      JSON.stringify({ hostId: 'host-1', worktreeId: 'repo-2::/tmp/worktree' })
    ])
  })
})

describe('last visited worktree repo', () => {
  it('extracts the repo id for the current host', () => {
    const raw = JSON.stringify({ hostId: 'host-1', worktreeId: 'repo-2::/tmp/worktree' })

    expect(readLastVisitedWorktreeRepoId(raw, 'host-1')).toBe('repo-2')
  })

  it('ignores records for another host', () => {
    const raw = JSON.stringify({ hostId: 'host-2', worktreeId: 'repo-2::/tmp/worktree' })

    expect(readLastVisitedWorktreeRepoId(raw, 'host-1')).toBeNull()
  })

  it('ignores malformed stored values', () => {
    expect(readLastVisitedWorktreeRepoId('{', 'host-1')).toBeNull()
    expect(readLastVisitedWorktreeRepoId(JSON.stringify({ hostId: 'host-1' }), 'host-1')).toBeNull()
  })
})

// Why (F7): home's Resume card navigates off this record, so anything it accepts becomes a route.
describe('readLastVisitedWorktreeRecord', () => {
  it('reads a well-formed record', () => {
    const raw = JSON.stringify({ hostId: 'host-1', worktreeId: 'repo-2::/tmp/worktree' })

    expect(readLastVisitedWorktreeRecord(raw)).toEqual({
      hostId: 'host-1',
      worktreeId: 'repo-2::/tmp/worktree'
    })
  })

  it('reads absent, truncated, and wrong-shaped payloads as no history', () => {
    expect(readLastVisitedWorktreeRecord(null)).toBeNull()
    expect(readLastVisitedWorktreeRecord('')).toBeNull()
    expect(readLastVisitedWorktreeRecord('{"hostId":"host-1"')).toBeNull()
    expect(readLastVisitedWorktreeRecord('null')).toBeNull()
    expect(readLastVisitedWorktreeRecord('"a string"')).toBeNull()
    expect(readLastVisitedWorktreeRecord(JSON.stringify({ hostId: 'host-1' }))).toBeNull()
    expect(
      readLastVisitedWorktreeRecord(JSON.stringify({ hostId: 'host-1', worktreeId: 42 }))
    ).toBeNull()
  })

  it('rejects empty ids that would build a route to nowhere', () => {
    expect(
      readLastVisitedWorktreeRecord(JSON.stringify({ hostId: '', worktreeId: 'repo::/wt' }))
    ).toBeNull()
    expect(
      readLastVisitedWorktreeRecord(JSON.stringify({ hostId: 'host-1', worktreeId: '' }))
    ).toBeNull()
  })
})
