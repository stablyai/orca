import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { persistMirrored, retainMirroredStorage } from '../storage/mirrored-storage-keys'
import { writeLastVisitedWorktree } from '../worktree/navigation/last-visited-worktree-by-host'
import { LAST_VISITED_WORKTREE_STORAGE_KEY } from '../worktree/navigation/last-visited-worktree-repo'
import { PAGE_STORAGE_MAX_VALUE_CHARS } from '../mobile-web-shell/page-storage/page-storage-keys'
import {
  consumePendingCrossWorktreeTabTarget,
  resolveCrossWorktreePendingSelection,
  setPendingCrossWorktreeTabTarget
} from './tabs/mobile-session-tab-activation'
import { recentCardSnapshotTabs } from './recent-session-card-snapshot'
import {
  MAX_RECENT_SESSION_CARDS_DISPLAY,
  MAX_RECENT_SESSION_CARDS_LIMIT,
  MAX_RECENT_SESSION_CARDS_STORED,
  RECENT_SESSION_CARDS_STORAGE_KEY,
  clearRecentSessionCardsForTests,
  getRecentSessionCardsMaxDisplaySync,
  getVisibleRecentSessionCards,
  hydrateRecentSessionCards,
  parseRecentSessionCards,
  readAllRecentSessionCardsSync,
  reconcileRecentSessionCardsForWorktree,
  recordRecentSessionCardVisit,
  removeRecentSessionCard,
  setRecentSessionCardsMaxDisplay,
  type RecentSessionCardRecord
} from './recent-session-cards'

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

function card(
  overrides: Partial<RecentSessionCardRecord> & Pick<RecentSessionCardRecord, 'tabId'>
): RecentSessionCardRecord {
  return {
    hostId: 'host-1',
    worktreeId: 'wt-1',
    worktreeName: 'orca',
    title: overrides.tabId,
    tabType: 'terminal',
    lastVisitedAt: 1,
    ...overrides
  }
}

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
  await persistMirrored(RECENT_SESSION_CARDS_STORAGE_KEY, null)
  await persistMirrored(LAST_VISITED_WORKTREE_STORAGE_KEY, null)
  clearRecentSessionCardsForTests()
  setPendingCrossWorktreeTabTarget(null)
})

afterEach(() => {
  releaseStorage?.()
  releaseStorage = null
})

describe('parseRecentSessionCards', () => {
  it('reads an array or a last-visited payload and skips malformed entries', () => {
    const valid = card({ tabId: 'tab-1', lastVisitedAt: 3, leafId: 'leaf-1' })
    const wrapped = JSON.stringify({
      hostId: 'host-1',
      worktreeId: 'wt-1',
      recentCards: [valid, { tabId: 'missing' }, null]
    })

    expect(parseRecentSessionCards(wrapped)).toEqual([valid])
    expect(parseRecentSessionCards(JSON.stringify([valid]))).toEqual([valid])
    expect(parseRecentSessionCards('not-json')).toEqual([])
  })
})

describe('recordRecentSessionCardVisit and visibility filtering', () => {
  it('orders MRU visits first, deduplicates keys, and caps per host', () => {
    recordRecentSessionCardVisit(card({ tabId: 'tab-1', title: 'first', lastVisitedAt: 1 }))
    recordRecentSessionCardVisit(card({ tabId: 'tab-2', lastVisitedAt: 2 }))
    const updated = recordRecentSessionCardVisit(
      card({ tabId: 'tab-1', title: 'updated', lastVisitedAt: 5 })
    )
    expect(updated.map((item) => [item.tabId, item.title])).toEqual([
      ['tab-1', 'updated'],
      ['tab-2', 'tab-2']
    ])

    for (let i = 3; i <= MAX_RECENT_SESSION_CARDS_STORED + 4; i += 1) {
      recordRecentSessionCardVisit(card({ tabId: `tab-${i}`, lastVisitedAt: i }))
    }
    expect(readAllRecentSessionCardsSync()).toHaveLength(MAX_RECENT_SESSION_CARDS_STORED)
    expect(recordRecentSessionCardVisit(card({ tabId: '' }))).toHaveLength(
      MAX_RECENT_SESSION_CARDS_STORED
    )
  })

  it('filters active tab, other hosts, archived/closed worktrees, and syncs live status', () => {
    recordRecentSessionCardVisit(
      card({ tabId: 'tab-1', terminalHandle: 'term-1', agentState: 'waiting', lastVisitedAt: 10 })
    )
    recordRecentSessionCardVisit(
      card({ tabId: 'tab-2', worktreeId: 'wt-2', agentState: 'working', lastVisitedAt: 20 })
    )
    recordRecentSessionCardVisit(
      card({ tabId: 'archived', worktreeId: 'wt-archived', lastVisitedAt: 30 })
    )
    recordRecentSessionCardVisit(card({ tabId: 'other-host', hostId: 'host-2', lastVisitedAt: 40 }))

    const visible = getVisibleRecentSessionCards({
      hostId: 'host-1',
      currentWorktreeId: 'wt-1',
      currentTabId: 'tab-1',
      liveWorktrees: [
        { worktreeId: 'wt-1', displayName: 'orca-wt1' },
        { worktreeId: 'wt-2', displayName: 'orca-wt2' },
        { worktreeId: 'wt-archived', isArchived: true }
      ],
      currentWorktreeTabs: [{ id: 'tab-1', terminal: 'term-1', agentState: 'done' }]
    })
    expect(visible.map((item) => item.tabId)).toEqual(['tab-2'])
    expect(visible[0]?.worktreeName).toBe('orca-wt2')

    const visibleOtherActive = getVisibleRecentSessionCards({
      hostId: 'host-1',
      currentWorktreeId: 'wt-1',
      currentTabId: 'other',
      currentWorktreeTabs: [{ id: 'tab-1', terminal: 'term-1', agentState: 'blocked' }]
    })
    expect(visibleOtherActive.find((item) => item.tabId === 'tab-1')?.agentState).toBe('blocked')
  })

  it('projects host unread verdicts onto recent cards and strips transient unread from storage', async () => {
    const unreadSnapshot = recentCardSnapshotTabs({
      tabs: [
        {
          id: 'tab-1',
          type: 'terminal',
          terminal: 'term-1',
          unread: true,
          agentStatus: { state: 'done', updatedAt: 100 }
        },
        {
          id: 'tab-2',
          type: 'agent-session',
          sessionId: 'sess-2',
          unread: true,
          chatStatus: { state: 'done', updatedAt: 100 }
        },
        { id: 'tab-3', type: 'markdown', unread: true }
      ]
    })
    expect(unreadSnapshot).toEqual([
      { id: 'tab-1', terminal: 'term-1', agentState: 'done', unread: true },
      { id: 'tab-2', sessionId: 'sess-2', agentState: 'done', unread: true },
      { id: 'tab-3', agentState: null, unread: false }
    ])

    recordRecentSessionCardVisit(
      card({ tabId: 'tab-1', terminalHandle: 'term-1', lastVisitedAt: 10 })
    )
    reconcileRecentSessionCardsForWorktree({
      hostId: 'host-1',
      worktreeId: 'wt-1',
      liveTabs: unreadSnapshot ?? []
    })
    expect(
      getVisibleRecentSessionCards({
        hostId: 'host-1',
        currentWorktreeId: 'wt-1',
        currentTabId: 'other',
        currentWorktreeTabs: [{ id: 'tab-1', terminal: 'term-1', agentState: 'done', unread: true }]
      })[0]?.unread
    ).toBe(true)

    await settleWrites()
    const rawStored = storage.items.get(RECENT_SESSION_CARDS_STORAGE_KEY)
    expect(parseRecentSessionCards(rawStored)[0]?.unread).toBeUndefined()

    const clearedSnapshot = recentCardSnapshotTabs({
      tabs: [
        {
          id: 'tab-1',
          type: 'terminal',
          terminal: 'term-1',
          agentStatus: { state: 'done', updatedAt: 200 }
        }
      ]
    })
    expect(clearedSnapshot?.[0]?.unread).toBe(false)
    const cleared = reconcileRecentSessionCardsForWorktree({
      hostId: 'host-1',
      worktreeId: 'wt-1',
      liveTabs: clearedSnapshot ?? []
    })
    expect(cleared[0]?.unread).toBeUndefined()
  })
})

describe('removal, reconciliation, and pending cross-worktree targets', () => {
  it('removes closed cards even before hydration completes', async () => {
    await persistMirrored(
      RECENT_SESSION_CARDS_STORAGE_KEY,
      JSON.stringify([
        card({ tabId: 'tab-1', lastVisitedAt: 1 }),
        card({ tabId: 'tab-2', lastVisitedAt: 2 })
      ])
    )
    clearRecentSessionCardsForTests()
    removeRecentSessionCard('host-1', 'wt-1', 'tab-1')
    const hydrated = await hydrateRecentSessionCards()
    expect(hydrated.map((item) => item.tabId)).toEqual(['tab-2'])
  })

  it('reconciles closed tabs out and resolves cross-worktree selections', () => {
    recordRecentSessionCardVisit(
      card({ tabId: 'tab-1', terminalHandle: 'term-1', agentState: 'waiting', lastVisitedAt: 2 })
    )
    recordRecentSessionCardVisit(card({ tabId: 'tab-2', lastVisitedAt: 3 }))

    const reconciled = reconcileRecentSessionCardsForWorktree({
      hostId: 'host-1',
      worktreeId: 'wt-1',
      liveTabs: [{ id: 'tab-1', terminal: 'term-1', agentState: 'done' }]
    })
    expect(reconciled).toHaveLength(1)
    expect(reconciled[0]?.agentState).toBe('done')

    setPendingCrossWorktreeTabTarget({
      worktreeId: 'id:wt-2',
      tabId: 'tab-2',
      terminalHandle: 'term-2'
    })
    expect(consumePendingCrossWorktreeTabTarget('other')).toBeNull()
    expect(
      resolveCrossWorktreePendingSelection('wt-2', [
        { type: 'terminal', id: 'tab-2', title: 'bash', isActive: false, terminal: 'term-2' }
      ])
    ).toEqual({ kind: 'terminal', handle: 'term-2', tabId: 'tab-2' })
    expect(consumePendingCrossWorktreeTabTarget('id:wt-2')).toBeNull()
  })

  it('clamps max display and trims stored payload below page-storage ceiling', async () => {
    await writeLastVisitedWorktree({ hostId: 'host-1', worktreeId: 'wt-1' })
    expect(getRecentSessionCardsMaxDisplaySync()).toBe(MAX_RECENT_SESSION_CARDS_DISPLAY)
    expect(setRecentSessionCardsMaxDisplay(0)).toBe(1)
    expect(setRecentSessionCardsMaxDisplay(99)).toBe(MAX_RECENT_SESSION_CARDS_LIMIT)

    for (let i = 0; i < MAX_RECENT_SESSION_CARDS_STORED; i += 1) {
      recordRecentSessionCardVisit(
        card({
          tabId: `tab-${i}`,
          worktreeName: 'workspace-with-very-long-name-to-grow-payload-size-'.repeat(4),
          title: 'session-title-'.repeat(8),
          lastVisitedAt: i + 1
        })
      )
    }
    await settleWrites()

    const dedicated = storage.items.get(RECENT_SESSION_CARDS_STORAGE_KEY)
    const mirrored = storage.items.get(LAST_VISITED_WORKTREE_STORAGE_KEY)
    expect(dedicated).toBeTruthy()
    expect(dedicated!.length).toBeLessThanOrEqual(PAGE_STORAGE_MAX_VALUE_CHARS)
    expect(mirrored!.length).toBeLessThanOrEqual(PAGE_STORAGE_MAX_VALUE_CHARS)
  })
})
