import { describe, expect, it } from 'vitest'
import { createTestStore, makePRRefreshWorktree } from '../store/slices/github-slice-test-harness'

import { visibleReviewWorktreeIdsForState } from './use-visible-review-refresh-reporting'

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
})
