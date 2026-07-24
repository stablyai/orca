import { beforeEach, describe, expect, it } from 'vitest'
import {
  BROWSER_VIEW_MODE_PAGE_KEY_MAX_CHARACTERS,
  BROWSER_VIEW_MODE_STATE_LIMIT,
  clearMobileBrowserViewModeState,
  getInitialMobileBrowserViewMode,
  saveMobileBrowserViewMode
} from './mobile-browser-view-mode-state'

describe('mobile browser view mode state', () => {
  beforeEach(() => {
    clearMobileBrowserViewModeState()
  })

  it('defaults each browser page to web view', () => {
    expect(getInitialMobileBrowserViewMode('worktree-1', 'page-1')).toBe('web')
    expect(getInitialMobileBrowserViewMode('worktree-1', null)).toBe('web')
  })

  it('restores the last mode for the same browser page after remount', () => {
    saveMobileBrowserViewMode('worktree-1', 'page-1', 'mobile')

    expect(getInitialMobileBrowserViewMode('worktree-1', 'page-1')).toBe('mobile')
    expect(getInitialMobileBrowserViewMode('worktree-1', 'page-2')).toBe('web')
    expect(getInitialMobileBrowserViewMode('worktree-2', 'page-1')).toBe('web')
  })

  it('retains the exact LRU count and evicts the oldest page at one over', () => {
    for (let index = 0; index < BROWSER_VIEW_MODE_STATE_LIMIT; index += 1) {
      saveMobileBrowserViewMode('worktree', `page-${index}`, 'mobile')
    }
    expect(getInitialMobileBrowserViewMode('worktree', 'page-0')).toBe('mobile')

    saveMobileBrowserViewMode('worktree', 'one-over', 'mobile')

    expect(getInitialMobileBrowserViewMode('worktree', 'page-0')).toBe('web')
    expect(getInitialMobileBrowserViewMode('worktree', 'one-over')).toBe('mobile')
  })

  it('accepts the exact page-key character limit and rejects one over', () => {
    const worktreeId = 'w'
    const exactPageId = 'p'.repeat(BROWSER_VIEW_MODE_PAGE_KEY_MAX_CHARACTERS - 2)
    const oversizedPageId = `${exactPageId}p`

    saveMobileBrowserViewMode(worktreeId, exactPageId, 'mobile')
    saveMobileBrowserViewMode(worktreeId, oversizedPageId, 'mobile')

    expect(getInitialMobileBrowserViewMode(worktreeId, exactPageId)).toBe('mobile')
    expect(getInitialMobileBrowserViewMode(worktreeId, oversizedPageId)).toBe('web')
  })
})
