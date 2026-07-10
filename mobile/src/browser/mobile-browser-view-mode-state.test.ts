import { beforeEach, describe, expect, it } from 'vitest'
import {
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
})
