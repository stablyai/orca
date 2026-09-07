import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const asyncStorage = vi.hoisted(() => ({
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn()
}))

vi.mock('@react-native-async-storage/async-storage', () => ({ default: asyncStorage }))

import {
  deleteCachedSessionTabStripForHost,
  getSessionTabStripCacheKey,
  loadCachedSessionTabStrip,
  readCachedSessionTabStrip,
  resetSessionTabStripCacheForTests,
  saveCachedSessionTabStrip
} from './session-tab-strip-cache'
import type { MobileSessionTabStripPreview } from '../session/mobile-session-tab-strip-entries'

const STORAGE_KEY = 'orca:session-tab-strip:v1'

function preview(...ids: string[]): MobileSessionTabStripPreview {
  return {
    tabs: ids.map((id) => ({ id, type: 'terminal' as const, title: id, agentId: null })),
    activeTabId: ids[0] ?? null
  }
}

function lastWrittenFile(): { workspaces: { key: string }[] } {
  const call = asyncStorage.setItem.mock.calls.at(-1)
  return JSON.parse(String(call?.[1]))
}

beforeEach(() => {
  vi.useFakeTimers()
  asyncStorage.getItem.mockReset().mockResolvedValue(null)
  asyncStorage.setItem.mockReset().mockResolvedValue(undefined)
  resetSessionTabStripCacheForTests()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('getSessionTabStripCacheKey', () => {
  it('digests the workspace id so no filesystem path reaches the key', () => {
    const path = '/Users/someone/private-client/worktrees/acquisition'
    const key = getSessionTabStripCacheKey('host-1', `repo::${path}`)

    expect(key).not.toContain(path)
    expect(key).not.toContain('someone')
    expect(key).toMatch(/^\["host-1","[0-9a-f]{32}"\]$/)
  })

  it('joins the two ids unambiguously, whatever a worktree path contains', () => {
    expect(getSessionTabStripCacheKey('host', 'a\nb')).not.toBe(
      getSessionTabStripCacheKey('host\na', 'b')
    )
    expect(getSessionTabStripCacheKey('host-1', 'wt-1')).not.toBe(
      getSessionTabStripCacheKey('host-1', 'wt-2')
    )
  })

  it('needs both a host and a workspace', () => {
    expect(getSessionTabStripCacheKey(undefined, 'wt-1')).toBeNull()
    expect(getSessionTabStripCacheKey('host-1', undefined)).toBeNull()
  })
})

describe('session tab strip cache', () => {
  it('serves a save back synchronously and persists it once the write settles', async () => {
    const key = getSessionTabStripCacheKey('host-1', 'wt-1')
    saveCachedSessionTabStrip(key, preview('tab-1', 'tab-2'))

    expect(readCachedSessionTabStrip(key)?.tabs.map((tab) => tab.id)).toEqual(['tab-1', 'tab-2'])
    expect(asyncStorage.setItem).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(300)

    expect(asyncStorage.setItem.mock.calls[0]?.[0]).toBe(STORAGE_KEY)
    expect(lastWrittenFile().workspaces.map((w) => w.key)).toEqual([key])
  })

  it('reads nothing synchronously before the stored file is loaded', async () => {
    const key = getSessionTabStripCacheKey('host-1', 'wt-1')
    asyncStorage.getItem.mockResolvedValue(
      JSON.stringify({ workspaces: [{ key, preview: preview('tab-1') }] })
    )

    expect(readCachedSessionTabStrip(key)).toBeNull()
    expect((await loadCachedSessionTabStrip(key))?.tabs.map((tab) => tab.id)).toEqual(['tab-1'])
    expect(readCachedSessionTabStrip(key)?.tabs).toHaveLength(1)
  })

  it('returns null for a workspace with no stored strip', async () => {
    expect(await loadCachedSessionTabStrip(getSessionTabStripCacheKey('host-1', 'wt-9'))).toBeNull()
    expect(await loadCachedSessionTabStrip(null)).toBeNull()
  })

  it('survives unreadable storage', async () => {
    asyncStorage.getItem.mockResolvedValue('{not json')

    expect(await loadCachedSessionTabStrip(getSessionTabStripCacheKey('host-1', 'wt-1'))).toBeNull()
  })

  it('evicts the least recently written workspace past the cap', async () => {
    for (let i = 0; i < 14; i++) {
      saveCachedSessionTabStrip(getSessionTabStripCacheKey('host-1', `wt-${i}`), preview('tab-1'))
    }
    await vi.advanceTimersByTimeAsync(300)

    const keys = lastWrittenFile().workspaces.map((w) => w.key)
    expect(keys).toHaveLength(12)
    expect(keys).not.toContain(getSessionTabStripCacheKey('host-1', 'wt-0'))
    expect(keys.at(-1)).toBe(getSessionTabStripCacheKey('host-1', 'wt-13'))
  })

  it('re-writing a workspace makes it the newest, not the oldest', async () => {
    for (let i = 0; i < 12; i++) {
      saveCachedSessionTabStrip(getSessionTabStripCacheKey('host-1', `wt-${i}`), preview('tab-1'))
    }
    saveCachedSessionTabStrip(getSessionTabStripCacheKey('host-1', 'wt-0'), preview('tab-2'))
    saveCachedSessionTabStrip(getSessionTabStripCacheKey('host-1', 'wt-99'), preview('tab-1'))
    await vi.advanceTimersByTimeAsync(300)

    const keys = lastWrittenFile().workspaces.map((w) => w.key)
    expect(keys).toContain(getSessionTabStripCacheKey('host-1', 'wt-0'))
    expect(keys).not.toContain(getSessionTabStripCacheKey('host-1', 'wt-1'))
  })

  it('records a workspace the host has emptied, so a stale strip cannot outlive it', async () => {
    const key = getSessionTabStripCacheKey('host-1', 'wt-1')
    saveCachedSessionTabStrip(key, preview('tab-1'))
    saveCachedSessionTabStrip(key, { tabs: [], activeTabId: null })

    expect(readCachedSessionTabStrip(key)).toEqual({ tabs: [], activeTabId: null })
  })

  it('caps tabs per workspace and title length, and drops an unmatched active id', async () => {
    const key = getSessionTabStripCacheKey('host-1', 'wt-1')
    saveCachedSessionTabStrip(key, {
      // A file tab, because the titles that survive redaction at all are the ones the cap has
      // to bound.
      tabs: Array.from({ length: 30 }, (_, i) => ({
        id: `tab-${i}`,
        type: 'file' as const,
        title: 'x'.repeat(200),
        agentId: null
      })),
      activeTabId: 'tab-29'
    })

    const stored = readCachedSessionTabStrip(key)
    expect(stored?.tabs).toHaveLength(24)
    expect(stored?.tabs[0]?.title).toHaveLength(64)
    expect(stored?.activeTabId).toBeNull()
  })

  it('drops fields a future tab type might smuggle into storage', async () => {
    const key = getSessionTabStripCacheKey('host-1', 'wt-1')
    saveCachedSessionTabStrip(key, {
      tabs: [
        {
          id: 'tab-1',
          type: 'file',
          title: 'notes.md',
          agentId: null,
          filePath: '/Users/someone/secret/notes.md'
        } as never
      ],
      activeTabId: 'tab-1'
    })
    await vi.advanceTimersByTimeAsync(300)

    expect(String(asyncStorage.setItem.mock.calls.at(-1)?.[1])).not.toContain('/Users/someone')
  })

  it('drops a stored entry naming a tab type this build cannot draw', async () => {
    const key = getSessionTabStripCacheKey('host-1', 'wt-1')
    saveCachedSessionTabStrip(key, {
      tabs: [
        { id: 'tab-1', type: 'from-a-newer-build', title: 'raw title', agentId: null } as never,
        { id: 'tab-2', type: 'file', title: 'notes.md', agentId: null }
      ],
      activeTabId: 'tab-2'
    })

    expect(readCachedSessionTabStrip(key)?.tabs.map((tab) => tab.id)).toEqual(['tab-2'])
  })

  it('never writes a shell-controlled terminal title, however it arrives', async () => {
    const secret = 'psql postgres://admin:hunter2@db.internal/prod'
    const key = getSessionTabStripCacheKey('host-1', 'wt-1')
    saveCachedSessionTabStrip(key, {
      tabs: [
        { id: 'tab-1', type: 'terminal', title: secret, agentId: null },
        { id: 'tab-2', type: 'terminal', title: secret, agentId: 'claude' },
        { id: 'tab-3', type: 'terminal', title: secret, agentId: 'not-a-known-agent' },
        { id: 'tab-4', type: 'browser', title: 'Acme Corp — Q3 layoffs memo', agentId: null }
      ],
      activeTabId: 'tab-1'
    })
    await vi.advanceTimersByTimeAsync(300)

    expect(readCachedSessionTabStrip(key)?.tabs.map((tab) => tab.title)).toEqual([
      'Terminal',
      'Claude',
      'Terminal',
      'Browser'
    ])
    const written = String(asyncStorage.setItem.mock.calls.at(-1)?.[1])
    expect(written).not.toContain('hunter2')
    expect(written).not.toContain('postgres://')
    expect(written).not.toContain('layoffs')
  })

  it('scrubs a stored title written by an older build on the way back out', async () => {
    const key = getSessionTabStripCacheKey('host-1', 'wt-1')
    asyncStorage.getItem.mockResolvedValue(
      JSON.stringify({
        workspaces: [
          {
            key,
            preview: {
              tabs: [{ id: 'tab-1', type: 'terminal', title: 'curl -H token', agentId: null }],
              activeTabId: 'tab-1'
            }
          }
        ]
      })
    )

    expect((await loadCachedSessionTabStrip(key))?.tabs[0]?.title).toBe('Terminal')
  })

  it('forgets an unpaired host and cannot resurrect it from a later save', async () => {
    const hostA = getSessionTabStripCacheKey('host-a', 'wt-1')
    const hostB = getSessionTabStripCacheKey('host-b', 'wt-1')
    saveCachedSessionTabStrip(hostA, preview('tab-a'))
    saveCachedSessionTabStrip(hostB, preview('tab-b'))
    await vi.advanceTimersByTimeAsync(300)

    await deleteCachedSessionTabStripForHost('host-a')

    expect(readCachedSessionTabStrip(hostA)).toBeNull()
    expect(readCachedSessionTabStrip(hostB)?.tabs).toHaveLength(1)
    expect(lastWrittenFile().workspaces.map((w) => w.key)).toEqual([hostB])

    saveCachedSessionTabStrip(hostB, preview('tab-b2'))
    await vi.advanceTimersByTimeAsync(300)

    expect(lastWrittenFile().workspaces.map((w) => w.key)).toEqual([hostB])
  })

  it('forgets a host whose rows are only on disk, never read this session', async () => {
    const hostA = getSessionTabStripCacheKey('host-a', 'wt-1')
    const hostB = getSessionTabStripCacheKey('host-b', 'wt-1')
    asyncStorage.getItem.mockResolvedValue(
      JSON.stringify({
        workspaces: [
          { key: hostA, preview: preview('tab-a') },
          { key: hostB, preview: preview('tab-b') }
        ]
      })
    )

    await deleteCachedSessionTabStripForHost('host-a')

    expect(lastWrittenFile().workspaces.map((w) => w.key)).toEqual([hostB])
  })

  it('drops a pending debounced write so it cannot restore the forgotten host', async () => {
    const hostA = getSessionTabStripCacheKey('host-a', 'wt-1')
    saveCachedSessionTabStrip(hostA, preview('tab-a'))

    await deleteCachedSessionTabStripForHost('host-a')
    await vi.advanceTimersByTimeAsync(300)

    expect(lastWrittenFile().workspaces).toEqual([])
  })
  it('rejects a deletion whose write never landed, rather than reporting it as done', async () => {
    // A resolved delete over a failed write leaves the forgotten host's tab titles in
    // plaintext on disk while every caller believes they are gone.
    const hostA = getSessionTabStripCacheKey('host-a', 'wt-1')
    saveCachedSessionTabStrip(hostA, preview('tab-a'))
    await vi.advanceTimersByTimeAsync(300)
    asyncStorage.setItem.mockRejectedValue(new Error('storage full'))

    await expect(deleteCachedSessionTabStripForHost('host-a')).rejects.toThrow('storage full')
  })

  it('keeps a debounced save best effort, so one failed write cannot reject unowned', async () => {
    asyncStorage.setItem.mockRejectedValue(new Error('storage full'))
    saveCachedSessionTabStrip(getSessionTabStripCacheKey('host-a', 'wt-1'), preview('tab-a'))

    // No throw and no unhandled rejection: the write is fire-and-forget by design.
    await vi.advanceTimersByTimeAsync(300)
    expect(asyncStorage.setItem).toHaveBeenCalledOnce()
  })

  it('refuses a save for the host it is in the middle of forgetting', async () => {
    const hostA = getSessionTabStripCacheKey('host-a', 'wt-1')
    saveCachedSessionTabStrip(hostA, preview('tab-a'))
    await vi.advanceTimersByTimeAsync(300)

    let releaseWrite!: () => void
    asyncStorage.setItem.mockImplementationOnce(
      async () =>
        new Promise<void>((resolve) => {
          releaseWrite = () => resolve()
        })
    )
    const deletion = deleteCachedSessionTabStripForHost('host-a')
    // The purge has run and its write is on the wire; a snapshot queued for the
    // workspace the user just unpaired now lands in that window.
    await vi.advanceTimersByTimeAsync(0)
    saveCachedSessionTabStrip(hostA, preview('tab-a2'))
    releaseWrite()
    await deletion
    await vi.advanceTimersByTimeAsync(300)

    expect(readCachedSessionTabStrip(hostA)).toBeNull()
    expect(lastWrittenFile().workspaces).toEqual([])
  })

  it('cannot be talked back into a host whose deletion write failed', async () => {
    const hostA = getSessionTabStripCacheKey('host-a', 'wt-1')
    saveCachedSessionTabStrip(hostA, preview('tab-a'))
    await vi.advanceTimersByTimeAsync(300)
    asyncStorage.setItem.mockRejectedValueOnce(new Error('storage full'))

    await expect(deleteCachedSessionTabStripForHost('host-a')).rejects.toThrow('storage full')
    const writesSoFar = asyncStorage.setItem.mock.calls.length

    saveCachedSessionTabStrip(hostA, preview('tab-a3'))
    await vi.advanceTimersByTimeAsync(300)

    expect(readCachedSessionTabStrip(hostA)).toBeNull()
    expect(asyncStorage.setItem).toHaveBeenCalledTimes(writesSoFar)
  })
  it('lets a debounced write that already snapshotted the removed host land first', async () => {
    // The tombstone stops new saves, but a debounced write that fired a moment earlier
    // built its blob from the map as it was and is still on the wire. Writing over it
    // concurrently leaves which blob lands last up to storage.
    const hostA = getSessionTabStripCacheKey('host-a', 'wt-1')
    const hostB = getSessionTabStripCacheKey('host-b', 'wt-1')
    saveCachedSessionTabStrip(hostA, preview('tab-a'))
    saveCachedSessionTabStrip(hostB, preview('tab-b'))

    let releaseDebounced!: () => void
    asyncStorage.setItem.mockImplementationOnce(
      async () =>
        new Promise<void>((resolve) => {
          releaseDebounced = () => resolve()
        })
    )
    await vi.advanceTimersByTimeAsync(300)

    const deletion = deleteCachedSessionTabStripForHost('host-a')
    await vi.advanceTimersByTimeAsync(0)
    expect(asyncStorage.setItem).toHaveBeenCalledOnce()

    releaseDebounced()
    await deletion

    expect(asyncStorage.setItem).toHaveBeenCalledTimes(2)
    expect(lastWrittenFile().workspaces.map((w) => w.key)).toEqual([hostB])
  })
  it('cannot let an older overlapping write commit after the purge', async () => {
    // Why: two debounced writes can sit on the bridge at once, and the second used to replace
    // the in-flight handle. The purge then awaited only the newer one, so the older blob --
    // snapshotted while the forgotten host was still in the map -- could commit last.
    const hostA = getSessionTabStripCacheKey('host-a', 'wt-1')
    const hostB = getSessionTabStripCacheKey('host-b', 'wt-1')
    let stored = ''
    const gates: Array<() => void> = []
    asyncStorage.setItem.mockImplementation(
      (_key: string, value: string) =>
        new Promise<void>((resolve) => {
          gates.push(() => {
            stored = value
            resolve()
          })
        })
    )

    saveCachedSessionTabStrip(hostA, preview('tab-a'))
    await vi.advanceTimersByTimeAsync(300)
    saveCachedSessionTabStrip(hostB, preview('tab-b'))
    await vi.advanceTimersByTimeAsync(300)

    const deletion = deleteCachedSessionTabStripForHost('host-a')
    // Newest released first: only writes that queue behind one another survive this.
    for (let step = 0; step < 6 && gates.length > 0; step += 1) {
      gates.pop()?.()
      await vi.advanceTimersByTimeAsync(0)
    }
    await deletion

    const keys = (JSON.parse(stored) as { workspaces: { key: string }[] }).workspaces.map(
      (workspace) => workspace.key
    )
    expect(keys).toEqual([hostB])
  })
})
