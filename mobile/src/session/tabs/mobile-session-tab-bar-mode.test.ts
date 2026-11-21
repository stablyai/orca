import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { persistMirrored, retainMirroredStorage } from '../../storage/mirrored-storage-keys'
import { writeLastVisitedWorktree } from '../../worktree/navigation/last-visited-worktree-by-host'
import { LAST_VISITED_WORKTREE_STORAGE_KEY } from '../../worktree/navigation/last-visited-worktree-repo'
import {
  DEFAULT_MOBILE_SESSION_TAB_BAR_MODE,
  DEFAULT_MOBILE_SESSION_TABS_SHEET_SCOPE,
  RECENT_SESSION_CARDS_STORAGE_KEY,
  clearRecentSessionCardsForTests,
  getMobileSessionTabBarModeSync,
  getMobileSessionTabsSheetScopeSync,
  hydrateRecentSessionCards,
  recordRecentSessionCardVisit,
  setMobileSessionTabBarMode,
  setMobileSessionTabsSheetScope
} from '../recent-session-cards'
import {
  parseMobileSessionTabBarMode,
  parseMobileSessionTabsSheetScope,
  serializeRecentSessionCardsPayload
} from './mobile-session-tab-bar-mode'

const storage = vi.hoisted(() => ({ items: new Map<string, string>() }))

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => storage.items.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      storage.items.set(key, value)
    },
    removeItem: async (key: string) => {
      storage.items.delete(key)
    },
    multiGet: async (keys: readonly string[]) =>
      keys.map((key) => [key, storage.items.get(key) ?? null] as const)
  }
}))

async function settleWrites(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
  await new Promise<void>((resolve) => setImmediate(resolve))
}

let releaseStorage: (() => void) | null = null

beforeEach(async () => {
  await settleWrites()
  releaseStorage?.()
  releaseStorage = retainMirroredStorage([
    RECENT_SESSION_CARDS_STORAGE_KEY,
    LAST_VISITED_WORKTREE_STORAGE_KEY
  ])
  storage.items.clear()
  clearRecentSessionCardsForTests()
})

afterEach(async () => {
  await settleWrites()
  clearRecentSessionCardsForTests()
  releaseStorage?.()
  releaseStorage = null
})

describe('mobile session tab bar mode preference', () => {
  it('defaults to single-tab and persists compact-strip opt-in via dedicated storage', async () => {
    expect(getMobileSessionTabBarModeSync()).toBe(DEFAULT_MOBILE_SESSION_TAB_BAR_MODE)
    expect(DEFAULT_MOBILE_SESSION_TAB_BAR_MODE).toBe('single-tab')

    recordRecentSessionCardVisit({
      hostId: 'host-1',
      worktreeId: 'wt-1',
      worktreeName: 'orca',
      tabId: 'tab-1',
      title: 'Terminal 1',
      tabType: 'terminal',
      lastVisitedAt: 10
    })
    await settleWrites()

    expect(setMobileSessionTabBarMode('classic-strip')).toBe('classic-strip')
    expect(getMobileSessionTabBarModeSync()).toBe('classic-strip')
    await settleWrites()

    clearRecentSessionCardsForTests()
    releaseStorage?.()
    releaseStorage = retainMirroredStorage([
      RECENT_SESSION_CARDS_STORAGE_KEY,
      LAST_VISITED_WORKTREE_STORAGE_KEY
    ])

    await hydrateRecentSessionCards()
    expect(getMobileSessionTabBarModeSync()).toBe('classic-strip')
  })

  it('recovers tabBarMode and tabsSheetScope from last-visited-worktree fallback', async () => {
    expect(getMobileSessionTabsSheetScopeSync()).toBe(DEFAULT_MOBILE_SESSION_TABS_SHEET_SCOPE)
    expect(DEFAULT_MOBILE_SESSION_TABS_SHEET_SCOPE).toBe('recent')

    await writeLastVisitedWorktree({ hostId: 'host-1', worktreeId: 'wt-1' })
    setMobileSessionTabBarMode('classic-strip')
    expect(setMobileSessionTabsSheetScope('workspace')).toBe('workspace')
    await settleWrites()

    storage.items.delete(RECENT_SESSION_CARDS_STORAGE_KEY)
    clearRecentSessionCardsForTests()
    releaseStorage?.()
    releaseStorage = retainMirroredStorage([
      RECENT_SESSION_CARDS_STORAGE_KEY,
      LAST_VISITED_WORKTREE_STORAGE_KEY
    ])

    await hydrateRecentSessionCards()
    expect(getMobileSessionTabBarModeSync()).toBe('classic-strip')
    expect(getMobileSessionTabsSheetScopeSync()).toBe('workspace')

    await persistMirrored(RECENT_SESSION_CARDS_STORAGE_KEY, '[]')
    expect(setMobileSessionTabBarMode('single-tab')).toBe('single-tab')
  })

  it('ignores invalid stored mode/scope values and preserves array format for defaults', () => {
    expect(parseMobileSessionTabBarMode('{"tabBarMode":"unknown"}')).toBeNull()
    expect(parseMobileSessionTabsSheetScope('{"tabsSheetScope":"all"}')).toBeNull()
    expect(parseMobileSessionTabBarMode('not-json')).toBeNull()

    expect(serializeRecentSessionCardsPayload([], 7, 7, 'single-tab', 'recent')).toBe('[]')
    expect(
      JSON.parse(serializeRecentSessionCardsPayload([], 7, 7, 'classic-strip', 'workspace'))
    ).toEqual({
      recentCards: [],
      tabBarMode: 'classic-strip',
      tabsSheetScope: 'workspace'
    })
  })
})
