import { beforeEach, describe, expect, it, vi } from 'vitest'
import { persistMirrored } from '../storage/mirrored-storage-keys'
import {
  LAST_VISITED_WORKTREE_STORAGE_KEY,
  writeLastVisitedWorktree
} from '../worktree/last-visited-worktree-repo'
import {
  consumePendingCrossWorktreeTabTarget,
  setPendingCrossWorktreeTabTarget
} from './mobile-session-tab-activation'
import {
  recentCardSnapshotTabs,
  resolveMobileSessionTabDotState
} from './mobile-terminal-tab-agent'
import { PAGE_STORAGE_MAX_VALUE_CHARS } from '../mobile-web-shell/page-storage-keys'
import {
  MAX_RECENT_SESSION_CARDS_DISPLAY,
  MAX_RECENT_SESSION_CARDS_LIMIT,
  MAX_RECENT_SESSION_CARDS_STORED,
  RECENT_SESSION_CARDS_STORAGE_KEY,
  buildRecentSessionCardFromTab,
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

beforeEach(async () => {
  await settleWrites()
  storage.items.clear()
  await persistMirrored(RECENT_SESSION_CARDS_STORAGE_KEY, null)
  await persistMirrored(LAST_VISITED_WORKTREE_STORAGE_KEY, null)
  clearRecentSessionCardsForTests()
  setPendingCrossWorktreeTabTarget(null)
})

describe('parseRecentSessionCards', () => {
  it('reads an array or a last-visited payload and skips malformed entries', () => {
    const valid = card({ tabId: 'tab-1', lastVisitedAt: 3, leafId: 'leaf-1' })
    const wrapped = JSON.stringify({
      hostId: 'host-1',
      worktreeId: 'wt-1',
      recentCards: [valid, { tabId: 'missing' }, null]
    })

    expect(parseRecentSessionCards(JSON.stringify([valid, { title: 1 }]))).toEqual([valid])
    expect(parseRecentSessionCards(wrapped)).toEqual([valid])
    expect(parseRecentSessionCards('{')).toEqual([])
    expect(parseRecentSessionCards(null)).toEqual([])
  })
})

describe('recordRecentSessionCardVisit', () => {
  it('promotes a revisited card to the front for Alt+Tab MRU ordering', () => {
    recordRecentSessionCardVisit(card({ tabId: 'tab-1', title: 'first', lastVisitedAt: 1 }))
    recordRecentSessionCardVisit(card({ tabId: 'tab-2', lastVisitedAt: 2 }))
    const next = recordRecentSessionCardVisit(
      card({ tabId: 'tab-1', title: 'again', lastVisitedAt: 3 })
    )

    expect(next.map((item) => item.tabId)).toEqual(['tab-1', 'tab-2'])
    expect(next[0]).toMatchObject({ title: 'again', lastVisitedAt: 3 })
  })

  it('inserts a visit outside the top display set at the front', () => {
    for (let index = 0; index < MAX_RECENT_SESSION_CARDS_DISPLAY + 1; index += 1) {
      recordRecentSessionCardVisit(card({ tabId: `tab-${index}`, lastVisitedAt: index }))
    }

    const next = recordRecentSessionCardVisit(
      card({ tabId: 'tab-0', title: 'promoted', lastVisitedAt: 50 })
    )

    expect(next[0]).toMatchObject({ tabId: 'tab-0', title: 'promoted', lastVisitedAt: 50 })
    expect(next.filter((item) => item.tabId === 'tab-0')).toHaveLength(1)
    expect(next[1]?.tabId).toBe(`tab-${MAX_RECENT_SESSION_CARDS_DISPLAY}`)
  })

  it('ignores a visit that names no host, worktree, or tab', () => {
    recordRecentSessionCardVisit(card({ tabId: 'tab-1' }))

    expect(recordRecentSessionCardVisit(card({ tabId: 'tab-2', hostId: '' }))).toHaveLength(1)
    expect(recordRecentSessionCardVisit(card({ tabId: '' }))).toHaveLength(1)
  })

  it('keeps at most the stored cap per host and 40 cards in total', () => {
    for (let index = 0; index < MAX_RECENT_SESSION_CARDS_STORED + 1; index += 1) {
      recordRecentSessionCardVisit(card({ tabId: `a-${index}`, lastVisitedAt: index }))
    }
    expect(readAllRecentSessionCardsSync()).toHaveLength(MAX_RECENT_SESSION_CARDS_STORED)
    expect(readAllRecentSessionCardsSync()[0]?.tabId).toBe(`a-${MAX_RECENT_SESSION_CARDS_STORED}`)

    for (let index = 0; index < MAX_RECENT_SESSION_CARDS_STORED; index += 1) {
      recordRecentSessionCardVisit(
        card({ hostId: 'host-2', tabId: `b-${index}`, lastVisitedAt: 100 + index })
      )
    }
    recordRecentSessionCardVisit(
      card({ hostId: 'host-3', tabId: 'c-0', lastVisitedAt: 200, worktreeId: 'wt-3' })
    )

    const stored = readAllRecentSessionCardsSync()
    expect(stored).toHaveLength(40)
    expect(stored[0]?.tabId).toBe('c-0')
    expect(stored.filter((item) => item.hostId === 'host-1')).toHaveLength(
      MAX_RECENT_SESSION_CARDS_STORED - 1
    )
    expect(stored.filter((item) => item.hostId === 'host-2')).toHaveLength(
      MAX_RECENT_SESSION_CARDS_STORED
    )
  })
})

describe('getVisibleRecentSessionCards', () => {
  it('excludes the currently open card so the previous card is at index 0 and caps at the display limit', () => {
    for (let index = 0; index < MAX_RECENT_SESSION_CARDS_DISPLAY + 2; index += 1) {
      recordRecentSessionCardVisit(card({ tabId: `tab-${index}`, lastVisitedAt: index }))
    }

    const currentTabId = `tab-${MAX_RECENT_SESSION_CARDS_DISPLAY + 1}`
    const previousTabId = `tab-${MAX_RECENT_SESSION_CARDS_DISPLAY}`
    const visible = getVisibleRecentSessionCards({
      hostId: 'host-1',
      currentWorktreeId: 'wt-1',
      currentTabId
    })

    expect(visible).toHaveLength(MAX_RECENT_SESSION_CARDS_DISPLAY)
    expect(visible.map((item) => item.tabId)).not.toContain(currentTabId)
    expect(visible[0]?.tabId).toBe(previousTabId)
  })

  it('allows increasing and persisting the display limit beyond the default 7', async () => {
    for (let index = 0; index < 12; index += 1) {
      recordRecentSessionCardVisit(card({ tabId: `tab-${index}`, lastVisitedAt: index }))
    }

    expect(getRecentSessionCardsMaxDisplaySync()).toBe(7)
    expect(setRecentSessionCardsMaxDisplay(10)).toBe(10)
    expect(getRecentSessionCardsMaxDisplaySync()).toBe(10)
    expect(
      getVisibleRecentSessionCards({
        hostId: 'host-1',
        currentWorktreeId: 'wt-1',
        currentTabId: 'tab-11'
      })
    ).toHaveLength(10)
    expect(setRecentSessionCardsMaxDisplay(99)).toBe(MAX_RECENT_SESSION_CARDS_LIMIT)

    setRecentSessionCardsMaxDisplay(11)
    await settleWrites()
    writeLastVisitedWorktree({ hostId: 'host-1', worktreeId: 'wt-1' })
    await settleWrites()
    clearRecentSessionCardsForTests()

    expect(getRecentSessionCardsMaxDisplaySync()).toBe(11)
  })

  it('drops archived or missing worktrees and refreshes the live name', () => {
    recordRecentSessionCardVisit(
      card({ tabId: 'live', worktreeId: 'wt-live', worktreeName: 'old' })
    )
    recordRecentSessionCardVisit(card({ tabId: 'gone', worktreeId: 'wt-gone', lastVisitedAt: 2 }))
    recordRecentSessionCardVisit(
      card({ tabId: 'archived', worktreeId: 'wt-archived', lastVisitedAt: 3 })
    )

    expect(
      getVisibleRecentSessionCards({
        hostId: 'host-1',
        currentWorktreeId: 'wt-other',
        currentTabId: null,
        liveWorktrees: [
          { worktreeId: 'wt-live', displayName: 'Orca' },
          { worktreeId: 'wt-archived', displayName: 'Old', isArchived: true }
        ]
      })
    ).toEqual([expect.objectContaining({ tabId: 'live', worktreeName: 'Orca' })])
  })
})

describe('removeRecentSessionCard', () => {
  it('removes one closed tab, or every card for a worktree', () => {
    recordRecentSessionCardVisit(card({ tabId: 'tab-1' }))
    recordRecentSessionCardVisit(card({ tabId: 'tab-2', lastVisitedAt: 2 }))
    recordRecentSessionCardVisit(card({ tabId: 'tab-3', worktreeId: 'wt-2', lastVisitedAt: 3 }))

    expect(removeRecentSessionCard('host-1', 'wt-1', 'tab-1').map((item) => item.tabId)).toEqual([
      'tab-3',
      'tab-2'
    ])
    expect(removeRecentSessionCard('host-1', 'wt-2').map((item) => item.tabId)).toEqual(['tab-2'])
  })
})

describe('cross-worktree pending tab', () => {
  it('strips an id: prefix and consumes only the matching worktree', () => {
    setPendingCrossWorktreeTabTarget({
      worktreeId: 'id:wt-1',
      tabId: 'tab-1',
      leafId: 'leaf-1',
      terminalHandle: 'pty-1'
    })

    expect(consumePendingCrossWorktreeTabTarget('id:wt-2')).toBeNull()
    expect(consumePendingCrossWorktreeTabTarget('wt-1')).toEqual({
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'leaf-1',
      terminalHandle: 'pty-1'
    })
    expect(consumePendingCrossWorktreeTabTarget('id:wt-1')).toBeNull()
  })

  it('drops a target whose worktree id is only the prefix', () => {
    setPendingCrossWorktreeTabTarget({ worktreeId: 'id:', tabId: 'tab-1' })

    expect(consumePendingCrossWorktreeTabTarget('id:')).toBeNull()
  })
})

describe('storage hydration', () => {
  it('reads the dedicated key before the last-visited copy', async () => {
    const dedicated = card({ tabId: 'dedicated', lastVisitedAt: 4 })
    const piggy = card({ tabId: 'piggy', lastVisitedAt: 9 })
    await persistMirrored(RECENT_SESSION_CARDS_STORAGE_KEY, JSON.stringify([dedicated]))
    await persistMirrored(
      LAST_VISITED_WORKTREE_STORAGE_KEY,
      JSON.stringify({ hostId: 'host-1', worktreeId: 'wt-1', recentCards: [piggy] })
    )
    clearRecentSessionCardsForTests()

    expect(readAllRecentSessionCardsSync()).toEqual([dedicated])
  })

  it('falls back to last-visited cards and merges them on hydrate', async () => {
    const older = card({ tabId: 'tab-1', title: 'old', lastVisitedAt: 1 })
    const newer = card({ tabId: 'tab-1', title: 'new', lastVisitedAt: 5 })
    const extra = card({ tabId: 'tab-2', lastVisitedAt: 2 })
    await persistMirrored(RECENT_SESSION_CARDS_STORAGE_KEY, null)
    await persistMirrored(
      LAST_VISITED_WORKTREE_STORAGE_KEY,
      JSON.stringify({ hostId: 'host-1', worktreeId: 'wt-9', recentCards: [older, extra] })
    )
    clearRecentSessionCardsForTests()

    expect(readAllRecentSessionCardsSync().map((item) => item.tabId)).toEqual(['tab-1', 'tab-2'])

    clearRecentSessionCardsForTests()
    await persistMirrored(RECENT_SESSION_CARDS_STORAGE_KEY, JSON.stringify([newer]))
    await expect(hydrateRecentSessionCards()).resolves.toEqual([newer, extra])
  })

  it('merges a visit recorded before hydration with stored cards', async () => {
    const visit = card({ tabId: 'visit', lastVisitedAt: 4 })
    recordRecentSessionCardVisit(visit)
    await settleWrites()

    const stored = card({ tabId: 'stored', lastVisitedAt: 1 })
    await persistMirrored(RECENT_SESSION_CARDS_STORAGE_KEY, JSON.stringify([stored]))

    await expect(hydrateRecentSessionCards()).resolves.toEqual([visit, stored])
  })

  it('leaves an empty hydrate unseeded so a later mirror write is still visible', async () => {
    await hydrateRecentSessionCards()
    const arrived = card({ tabId: 'late', lastVisitedAt: 8 })
    await persistMirrored(RECENT_SESSION_CARDS_STORAGE_KEY, JSON.stringify([arrived]))

    expect(readAllRecentSessionCardsSync()).toEqual([arrived])
  })

  it('keeps byHost when recent cards or the last-visited writer update the record', async () => {
    const byHost = {
      'host-1': { worktreeId: 'wt-1' },
      'host-2': { worktreeId: 'wt-9', executionHost: 'runtime:env-1' }
    }
    await persistMirrored(
      LAST_VISITED_WORKTREE_STORAGE_KEY,
      JSON.stringify({ hostId: 'host-1', worktreeId: 'wt-1', byHost })
    )
    recordRecentSessionCardVisit(card({ tabId: 'tab-1', lastVisitedAt: 5 }))
    await settleWrites()

    const afterCards = storage.items.get(LAST_VISITED_WORKTREE_STORAGE_KEY)
    const parsedCards: unknown = afterCards ? JSON.parse(afterCards) : null
    expect(parsedCards).toMatchObject({
      hostId: 'host-1',
      worktreeId: 'wt-1',
      byHost,
      recentCards: [expect.objectContaining({ tabId: 'tab-1' })]
    })

    writeLastVisitedWorktree({ hostId: 'host-3', worktreeId: 'wt-3' })
    await settleWrites()
    const afterVisit = storage.items.get(LAST_VISITED_WORKTREE_STORAGE_KEY)
    const parsedVisit: unknown = afterVisit ? JSON.parse(afterVisit) : null
    expect(parsedVisit).toMatchObject({
      hostId: 'host-3',
      worktreeId: 'wt-3',
      byHost,
      recentCards: [expect.objectContaining({ tabId: 'tab-1' })]
    })
  })

  it('drops a card removed before hydration can merge the stored copy back', async () => {
    removeRecentSessionCard('host-1', 'wt-1', 'gone')
    await persistMirrored(
      RECENT_SESSION_CARDS_STORAGE_KEY,
      JSON.stringify([
        card({ tabId: 'gone', lastVisitedAt: 3 }),
        card({ tabId: 'kept', lastVisitedAt: 1 })
      ])
    )

    await expect(hydrateRecentSessionCards()).resolves.toEqual([
      card({ tabId: 'kept', lastVisitedAt: 1 })
    ])
  })

  it('lets a later visit restore a card removed before hydration', async () => {
    removeRecentSessionCard('host-1', 'wt-1', 'gone')
    await persistMirrored(
      RECENT_SESSION_CARDS_STORAGE_KEY,
      JSON.stringify([
        card({ tabId: 'gone', lastVisitedAt: 3 }),
        card({ tabId: 'kept', lastVisitedAt: 1 })
      ])
    )
    recordRecentSessionCardVisit(card({ tabId: 'gone', lastVisitedAt: 9 }))

    await expect(hydrateRecentSessionCards()).resolves.toEqual([
      card({ tabId: 'gone', lastVisitedAt: 9 }),
      card({ tabId: 'kept', lastVisitedAt: 1 })
    ])
  })

  it('prunes closed tabs via removeRecentSessionCard and reconcileRecentSessionCardsForWorktree', () => {
    recordRecentSessionCardVisit(
      card({ worktreeId: 'wt-1', tabId: 'tab-1', terminalHandle: 'pty-1', lastVisitedAt: 10 })
    )
    recordRecentSessionCardVisit(card({ worktreeId: 'wt-1', tabId: 'tab-2', lastVisitedAt: 20 }))
    recordRecentSessionCardVisit(
      card({ worktreeId: 'wt-1', tabId: 'tab-4', terminalHandle: 'pty-4', lastVisitedAt: 25 })
    )
    recordRecentSessionCardVisit(card({ worktreeId: 'wt-2', tabId: 'tab-3', lastVisitedAt: 30 }))

    expect(
      getVisibleRecentSessionCards({
        hostId: 'host-1',
        currentWorktreeId: 'wt-1',
        currentTabId: 'tab-1',
        currentWorktreeTabs: [
          { id: 'tab-1', terminal: 'pty-1' },
          { id: 'tab-4', terminal: 'pty-4', agentState: 'working' }
        ]
      })
    ).toEqual([
      expect.objectContaining({ tabId: 'tab-3' }),
      expect.objectContaining({ tabId: 'tab-4', agentState: 'working' })
    ])

    reconcileRecentSessionCardsForWorktree({
      hostId: 'host-1',
      worktreeId: 'wt-1',
      liveTabs: [{ id: 'tab-1', terminal: 'pty-1', agentState: 'done' }]
    })
    expect(readAllRecentSessionCardsSync()).toEqual([
      expect.objectContaining({ tabId: 'tab-3' }),
      expect.objectContaining({ tabId: 'tab-1', agentState: 'done' })
    ])

    removeRecentSessionCard('host-1', 'wt-1', undefined, 'pty-1')
    expect(readAllRecentSessionCardsSync().map((item) => item.tabId)).toEqual(['tab-3'])
  })
})

describe('buildRecentSessionCardFromTab', () => {
  it('copies terminal identity, the agent-session agent, and SSOT agent dot state', () => {
    expect(
      buildRecentSessionCardFromTab({
        hostId: 'host-1',
        worktreeId: 'wt-1',
        worktreeName: 'orca',
        now: 42,
        tab: {
          type: 'terminal',
          id: 'tab-1',
          title: 'shell',
          leafId: 'leaf-1',
          terminal: 'pty-1',
          isActive: true
        }
      })
    ).toEqual({
      hostId: 'host-1',
      worktreeId: 'wt-1',
      worktreeName: 'orca',
      tabId: 'tab-1',
      leafId: 'leaf-1',
      terminalHandle: 'pty-1',
      title: 'shell',
      tabType: 'terminal',
      lastVisitedAt: 42
    })

    expect(
      buildRecentSessionCardFromTab({
        hostId: 'host-1',
        worktreeId: 'wt-1',
        worktreeName: 'orca',
        now: 7,
        tab: {
          type: 'agent-session',
          id: 'tab-2',
          title: '',
          sessionId: 'session-1',
          agent: 'claude',
          chatStatus: { state: 'working', updatedAt: 7 },
          isActive: false
        }
      })
    ).toMatchObject({
      tabId: 'tab-2',
      title: 'Chat',
      tabType: 'agent-session',
      agentId: 'claude',
      agentState: 'working'
    })
  })

  it('marks non-active tabs and recent cards as unread when a working turn completes until viewed', () => {
    recordRecentSessionCardVisit(
      card({
        worktreeId: 'wt-1',
        tabId: 'tab-bg',
        terminalHandle: 'pty-bg',
        agentState: 'working',
        lastVisitedAt: 10
      })
    )

    // Background tab in the session strip is working, then completes while not active on screen.
    expect(
      resolveMobileSessionTabDotState(
        {
          type: 'terminal',
          id: 'tab-bg',
          terminal: 'pty-bg',
          isActive: false,
          agentStatus: {
            state: 'working',
            prompt: 'fix bug',
            paneKey: 'tab-bg:leaf-1',
            stateHistory: [],
            updatedAt: 100,
            stateStartedAt: 90
          }
        },
        100,
        { isActiveOnScreen: false }
      )
    ).toBe('working')

    const completedBgTab = {
      type: 'terminal' as const,
      id: 'tab-bg',
      terminal: 'pty-bg',
      isActive: false,
      agentStatus: {
        state: 'done' as const,
        prompt: 'fix bug',
        paneKey: 'tab-bg:leaf-1',
        stateHistory: [],
        updatedAt: 200,
        stateStartedAt: 200
      }
    }

    expect(
      resolveMobileSessionTabDotState(completedBgTab, 200, { isActiveOnScreen: false })
    ).toBe('unread')

    expect(
      getVisibleRecentSessionCards({
        hostId: 'host-1',
        currentWorktreeId: 'wt-1',
        currentTabId: 'tab-fg',
        currentWorktreeTabs: [completedBgTab]
      })
    ).toEqual([expect.objectContaining({ tabId: 'tab-bg', agentState: 'unread' })])

    // Once the user views tab-bg on screen, it acknowledges the completion and turns to done.
    expect(
      resolveMobileSessionTabDotState(completedBgTab, 210, { isActiveOnScreen: true })
    ).toBe('done')

    reconcileRecentSessionCardsForWorktree({
      hostId: 'host-1',
      worktreeId: 'wt-1',
      liveTabs: [completedBgTab],
      activeTabId: 'tab-bg'
    })

    // Switching back to tab-fg leaves tab-bg as done (green dot) since that turn was acknowledged.
    expect(
      resolveMobileSessionTabDotState(completedBgTab, 220, { isActiveOnScreen: false })
    ).toBe('done')
    expect(
      getVisibleRecentSessionCards({
        hostId: 'host-1',
        currentWorktreeId: 'wt-1',
        currentTabId: 'tab-fg',
        currentWorktreeTabs: [completedBgTab]
      })
    ).toEqual([expect.objectContaining({ tabId: 'tab-bg', agentState: 'done' })])
  })

  it('reconciles shell-masked snapshot tabs against worktree.ps agent rows and bounds storage payload size', async () => {
    const snapshot = {
      tabs: [
        {
          type: 'terminal',
          id: 'tab-other',
          parentTabId: 'tab-other',
          leafId: 'leaf-1',
          terminal: 'pty-other',
          agentStatus: {
            state: 'done',
            prompt: '',
            paneKey: 'tab-other:leaf-1',
            updatedAt: 100,
            stateStartedAt: 90
          }
        }
      ]
    }
    const worktrees = [
      {
        worktreeId: 'wt-2',
        agents: [
          {
            paneKey: 'tab-other:leaf-1',
            state: 'working',
            updatedAt: 150,
            stateStartedAt: 90
          }
        ]
      }
    ]

    expect(recentCardSnapshotTabs(snapshot, { worktreeId: 'wt-2', worktrees })).toEqual([
      {
        id: 'tab-other',
        terminal: 'pty-other',
        agentState: 'working',
        doneStamp: 90
      }
    ])

    const hugeTitle = 'x'.repeat(800)
    for (let i = 0; i < 30; i += 1) {
      recordRecentSessionCardVisit(
        card({
          hostId: i < 15 ? 'host-1' : 'host-2',
          worktreeId: `wt-${i}`,
          tabId: `tab-${i}`,
          title: hugeTitle,
          lastVisitedAt: i + 1
        })
      )
    }
    await settleWrites()
    const rawDedicated = storage.items.get(RECENT_SESSION_CARDS_STORAGE_KEY) ?? ''
    expect(rawDedicated.length).toBeLessThanOrEqual(PAGE_STORAGE_MAX_VALUE_CHARS)
  })
})
