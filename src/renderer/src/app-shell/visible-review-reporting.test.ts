import { describe, expect, it, vi } from 'vitest'
import {
  createTestStore,
  makePRRefreshWorktree,
  makePR
} from '../store/slices/github-slice-test-harness'
import type { AppState } from '../store/types'
import { createGlobalSettingsFixture } from '../../../shared/global-settings-test-fixture'
import {
  createVisibleReviewReportIdentitySelector,
  refreshForegroundVisibleReview,
  visibleReviewWorktreeIdsForState
} from './use-visible-review-refresh-reporting'

function state() {
  const store = createTestStore()
  store.setState({
    repos: [
      { id: 'repo-1', path: '/repo', displayName: 'repo', badgeColor: '', addedAt: 1, kind: 'git' }
    ],
    worktreesByRepo: {
      'repo-1': [makePRRefreshWorktree({ id: 'selected' }), makePRRefreshWorktree({ id: 'card' })]
    },
    activeWorktreeId: 'selected',
    activeView: 'terminal',
    rightSidebarOpen: true,
    rightSidebarTab: 'checks',
    visibleReviewCardWorktreeIds: []
  })
  return store
}

describe('review surface visibility union', () => {
  it('keeps the selected panel when the left sidebar has no visible cards', () => {
    expect(visibleReviewWorktreeIdsForState(state().getState())).toEqual(['selected'])
  })
  it('unions cards and the panel without duplicate requests', () => {
    const store = state()
    store.setState({ visibleReviewCardWorktreeIds: ['card', 'selected'] })
    expect(visibleReviewWorktreeIdsForState(store.getState())).toEqual(['card', 'selected'])
  })
  it('drops the selected panel when closed or suppressed by the active view', () => {
    const store = state()
    store.setState({ visibleReviewCardWorktreeIds: ['card'], activeView: 'settings' })
    expect(visibleReviewWorktreeIdsForState(store.getState())).toEqual(['card'])
    store.setState({ activeView: 'terminal', rightSidebarOpen: false })
    expect(visibleReviewWorktreeIdsForState(store.getState())).toEqual(['card'])
  })
  it('excludes archived and bare workspace cards', () => {
    const store = state()
    store.setState({
      rightSidebarOpen: false,
      visibleReviewCardWorktreeIds: ['bare', 'archived'],
      worktreesByRepo: {
        'repo-1': [
          makePRRefreshWorktree({ id: 'bare', isBare: true }),
          makePRRefreshWorktree({ id: 'archived', isArchived: true })
        ]
      }
    })
    expect(visibleReviewWorktreeIdsForState(store.getState())).toEqual([])
  })
})

describe('review report selector work', () => {
  it('does not rebuild candidates or serialize on unrelated agent updates', () => {
    const current = state().getState()
    const select = createVisibleReviewReportIdentitySelector()
    const stringify = vi.spyOn(JSON, 'stringify')
    try {
      const initial = select(current)
      const initialSerializations = stringify.mock.calls.length
      expect(initialSerializations).toBeGreaterThan(0)
      for (let tick = 0; tick < 1_000; tick++) {
        expect(select({ ...current, agentStatusByPaneKey: {}, agentStatusEpoch: tick })).toBe(
          initial
        )
      }
      expect(stringify).toHaveBeenCalledTimes(initialSerializations)
    } finally {
      stringify.mockRestore()
    }
  })

  it('recomputes for every relevant input without retaining the whole state', () => {
    const current = state().getState()
    const updates: Partial<AppState>[] = [
      { activeView: 'settings' },
      { activeWorktreeId: 'card' },
      { rightSidebarOpen: false },
      { rightSidebarTab: 'source-control' },
      { visibleReviewCardWorktreeIds: ['card'] },
      { repos: [...current.repos] },
      { worktreesByRepo: { ...current.worktreesByRepo } },
      { settings: createGlobalSettingsFixture(current.settings ?? {}) },
      { sshConnectionStates: new Map(current.sshConnectionStates) },
      { sshConnectedGeneration: current.sshConnectedGeneration + 1 },
      { prVisibleRefreshGeneration: current.prVisibleRefreshGeneration + 1 },
      { prCache: { ...current.prCache } },
      { hostedReviewCache: { ...current.hostedReviewCache } }
    ]
    const stringify = vi.spyOn(JSON, 'stringify')
    try {
      for (const update of updates) {
        const select = createVisibleReviewReportIdentitySelector()
        select(current)
        const before = stringify.mock.calls.length
        select({ ...current, ...update })
        expect(stringify.mock.calls.length).toBeGreaterThan(before)
      }
    } finally {
      stringify.mockRestore()
    }
  })

  it('changes reports for a visible HEAD change and panel closure', () => {
    const store = state()
    const select = createVisibleReviewReportIdentitySelector()
    const initial = select(store.getState())
    store.setState({
      worktreesByRepo: {
        'repo-1': [makePRRefreshWorktree({ id: 'selected', head: 'new-head' })]
      }
    })
    const changedHead = select(store.getState())
    expect(changedHead).not.toBe(initial)
    store.setState({ rightSidebarOpen: false })
    expect(select(store.getState())).not.toBe(changedHead)
  })
})

describe('selected foreground refresh admission', () => {
  it('fast-tracks a stale local GitHub panel using visible gates and skips fresh or other-provider answers', () => {
    const store = state()
    const enqueue = vi.fn()
    store.setState({
      enqueueGitHubPRRefresh: enqueue,
      prCache: { 'repo-1::feature/test': { data: makePR(), fetchedAt: 0 } }
    })
    const candidate = store.getState().worktreesByRepo['repo-1'][0]
    const key = `repo-1::${candidate.branch}`
    store.setState({ prCache: { [key]: { data: makePR(), fetchedAt: 0 } } })
    refreshForegroundVisibleReview(store.getState())
    expect(enqueue).toHaveBeenCalledExactlyOnceWith('selected', 'visible', 80)
    enqueue.mockClear()
    store.setState({ prCache: { [key]: { data: makePR(), fetchedAt: Date.now() } } })
    refreshForegroundVisibleReview(store.getState())
    expect(enqueue).not.toHaveBeenCalled()
    store.setState({ worktreesByRepo: { 'repo-1': [{ ...candidate, linkedGitLabMR: 8 }] } })
    refreshForegroundVisibleReview(store.getState())
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('reports panel exposure even when the selected card was already visible', () => {
    const store = state()
    store.setState({ visibleReviewCardWorktreeIds: ['selected'], rightSidebarOpen: false })
    const select = createVisibleReviewReportIdentitySelector()
    const initial = select(store.getState())
    store.setState({ rightSidebarOpen: true })
    expect(select(store.getState())).not.toBe(initial)
  })
})
