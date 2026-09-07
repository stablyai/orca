import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const asyncStorage = vi.hoisted(() => ({
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn()
}))

vi.mock('@react-native-async-storage/async-storage', () => ({ default: asyncStorage }))

import {
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
  it('joins the two ids unambiguously, whatever a worktree path contains', () => {
    expect(getSessionTabStripCacheKey('host', 'a\nb')).not.toBe(
      getSessionTabStripCacheKey('host\na', 'b')
    )
  })

  it('needs both a host and a workspace', () => {
    expect(getSessionTabStripCacheKey('host-1', 'wt-1')).toBe('["host-1","wt-1"]')
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
    expect(lastWrittenFile().workspaces.map((w) => w.key)).toEqual(['["host-1","wt-1"]'])
  })

  it('reads nothing synchronously before the stored file is loaded', async () => {
    asyncStorage.getItem.mockResolvedValue(
      JSON.stringify({ workspaces: [{ key: '["host-1","wt-1"]', preview: preview('tab-1') }] })
    )
    const key = getSessionTabStripCacheKey('host-1', 'wt-1')

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
    expect(keys).not.toContain('["host-1","wt-0"]')
    expect(keys.at(-1)).toBe('["host-1","wt-13"]')
  })

  it('re-writing a workspace makes it the newest, not the oldest', async () => {
    for (let i = 0; i < 12; i++) {
      saveCachedSessionTabStrip(getSessionTabStripCacheKey('host-1', `wt-${i}`), preview('tab-1'))
    }
    saveCachedSessionTabStrip(getSessionTabStripCacheKey('host-1', 'wt-0'), preview('tab-2'))
    saveCachedSessionTabStrip(getSessionTabStripCacheKey('host-1', 'wt-99'), preview('tab-1'))
    await vi.advanceTimersByTimeAsync(300)

    const keys = lastWrittenFile().workspaces.map((w) => w.key)
    expect(keys).toContain('["host-1","wt-0"]')
    expect(keys).not.toContain('["host-1","wt-1"]')
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
      tabs: Array.from({ length: 30 }, (_, i) => ({
        id: `tab-${i}`,
        type: 'terminal' as const,
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
})
