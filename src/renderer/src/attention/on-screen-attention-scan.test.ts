import { afterEach, expect, it, vi } from 'vitest'
import { createTestStore } from '@/store/testing/app-store-test-fixture'
import { createStoreSessionMockApi } from '@/store/testing/app-store-session-api.test-fixture'
import { makeTab } from '@/store/terminals/testing/terminal-tab.test-fixture'
import { makeTabGroup, makeUnifiedTab } from '@/store/slices/tabs/tab-group.test-fixture'
import { startOnScreenAttentionScan } from './on-screen-attention-scan'
import { isAgentSubjectUnread } from './agent-attention-acknowledgement'

vi.mock('./orca-window-foreground-focus', () => ({ isOrcaWindowForegroundFocused: () => true }))

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it('keeps an empty session explicitly unread after leaving it and reads it on the next visit', () => {
  vi.useFakeTimers()
  vi.stubGlobal('window', undefined)
  createStoreSessionMockApi()
  const store = createTestStore()
  const leaf = '11111111-1111-4111-8111-111111111111'
  const pane = `first:${leaf}`
  store.setState({
    activeView: 'terminal',
    activeWorktreeId: 'wt',
    activeTabId: 'first',
    tabsByWorktree: { wt: ['first', 'second'].map((id) => makeTab({ id, worktreeId: 'wt' })) },
    groupsByWorktree: {
      wt: [
        makeTabGroup({
          id: 'group',
          worktreeId: 'wt',
          activeTabId: 'first',
          tabOrder: ['first', 'second']
        })
      ]
    },
    activeGroupIdByWorktree: { wt: 'group' },
    unifiedTabsByWorktree: {
      wt: ['first', 'second'].map((id) =>
        makeUnifiedTab({ id, worktreeId: 'wt', groupId: 'group' })
      )
    },
    terminalLayoutsByTabId: Object.fromEntries(
      ['first', 'second'].map((id) => [
        id,
        { root: { type: 'leaf' as const, leafId: leaf }, activeLeafId: leaf, expandedLeafId: null }
      ])
    )
  })
  store
    .getState()
    .setAgentStatus(pane, { state: 'done', sessionBoundary: true, prompt: '' }, undefined, {
      updatedAt: 1_000,
      stateStartedAt: 1_000
    })
  const stop = startOnScreenAttentionScan(store, {
    readDesktopAway: null,
    subscribeStructuredViews: () => () => {},
    subscribePresenceSignals: () => () => {}
  })
  const unread = () =>
    isAgentSubjectUnread(
      {
        liveTurns: store.getState().agentStatusByPaneKey,
        acknowledgedTurnStartedAt: store.getState().acknowledgedAgentsByPaneKey,
        manuallyUnreadTurnStartedAt: store.getState().manuallyUnreadTurnsByPaneKey
      },
      pane
    )
  const visit = (id: string) =>
    store.setState({
      activeTabId: id,
      groupsByWorktree: {
        wt: [
          makeTabGroup({
            id: 'group',
            worktreeId: 'wt',
            activeTabId: id,
            tabOrder: ['first', 'second']
          })
        ]
      }
    })
  try {
    store.getState().unacknowledgeAgents([pane])
    expect(unread()).toBe(true)
    visit('second')
    expect(unread()).toBe(true)
    visit('first')
    expect(unread()).toBe(false)
  } finally {
    stop()
  }
})
