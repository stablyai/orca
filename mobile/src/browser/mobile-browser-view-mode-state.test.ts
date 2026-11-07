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

  it('opens every page in mobile view on the phone, wherever it was opened first', () => {
    expect(getInitialMobileBrowserViewMode('worktree-1', 'page-1')).toBe('mobile')
    expect(getInitialMobileBrowserViewMode('worktree-1', null)).toBe('mobile')
  })

  it('restores the last mode for the same browser page after remount', () => {
    saveMobileBrowserViewMode('worktree-1', 'page-1', 'web')

    expect(getInitialMobileBrowserViewMode('worktree-1', 'page-1')).toBe('web')
    expect(getInitialMobileBrowserViewMode('worktree-1', 'page-2')).toBe('mobile')
    expect(getInitialMobileBrowserViewMode('worktree-2', 'page-1')).toBe('mobile')
  })
})
