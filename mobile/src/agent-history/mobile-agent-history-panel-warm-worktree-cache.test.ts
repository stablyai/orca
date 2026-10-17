import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setCachedWorktrees } from '../cache/worktree-cache'
import type { Worktree } from '../worktree/workspace-list-types'
import {
  clearMobileAgentHistoryPanelWorktreeCache,
  readInitialMobileAgentHistoryWorktrees,
  recordMobileAgentHistoryPanelWorktrees
} from './mobile-agent-history-worktree-cache'

describe('mobile-agent-history-worktree-cache', () => {
  beforeEach(() => {
    clearMobileAgentHistoryPanelWorktreeCache()
  })

  afterEach(() => {
    clearMobileAgentHistoryPanelWorktreeCache()
  })

  it('returns empty array when cache is cold', () => {
    expect(readInitialMobileAgentHistoryWorktrees('host-cold')).toEqual([])
  })

  it('seeds initial worktrees from global cache when available', () => {
    const fakeWorktree: Worktree = {
      worktreeId: 'wt-warm',
      path: '/path/to/worktree',
      repoId: 'repo-1'
    }
    setCachedWorktrees('host-warm', [fakeWorktree], { proven: true })
    const initial = readInitialMobileAgentHistoryWorktrees('host-warm')
    expect(initial).toEqual([fakeWorktree])
  })

  it('preserves panel worktrees across reads and updates cache', () => {
    const list: Worktree[] = [
      { worktreeId: 'wt-1', path: '/code/repo1', repoId: 'r1' },
      { worktreeId: 'wt-2', path: '/code/repo2', repoId: 'r2' }
    ]
    recordMobileAgentHistoryPanelWorktrees('host-recorded', list)
    expect(readInitialMobileAgentHistoryWorktrees('host-recorded')).toEqual(list)

    clearMobileAgentHistoryPanelWorktreeCache()
    // Global cache was also populated by recordMobileAgentHistoryPanelWorktrees
    expect(readInitialMobileAgentHistoryWorktrees('host-recorded')).toEqual(list)
  })
})
