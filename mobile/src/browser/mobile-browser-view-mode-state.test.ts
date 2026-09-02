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

  it('defaults local HTML reports to mobile view', () => {
    expect(
      getInitialMobileBrowserViewMode(
        'folder:workspace-1',
        'page-1',
        'file:///Users/me/report%20one.HTML?generated=1'
      )
    ).toBe('mobile')
    expect(
      getInitialMobileBrowserViewMode('worktree-1', 'page-2', 'file:///C:/Users/me/report.htm')
    ).toBe('mobile')
  })

  it('keeps remote HTML URLs and non-HTML files in web view', () => {
    expect(
      getInitialMobileBrowserViewMode('worktree-1', 'page-1', 'https://example.com/report.html')
    ).toBe('web')
    expect(getInitialMobileBrowserViewMode('worktree-1', 'page-2', 'file:///repo/notes.txt')).toBe(
      'web'
    )
  })

  it('restores the last mode for the same browser page after remount', () => {
    saveMobileBrowserViewMode('worktree-1', 'page-1', 'mobile')

    expect(getInitialMobileBrowserViewMode('worktree-1', 'page-1')).toBe('mobile')
    expect(getInitialMobileBrowserViewMode('worktree-1', 'page-2')).toBe('web')
    expect(getInitialMobileBrowserViewMode('worktree-2', 'page-1')).toBe('web')
  })

  it('preserves an explicit web choice for a local HTML report', () => {
    saveMobileBrowserViewMode('worktree-1', 'page-1', 'web')

    expect(
      getInitialMobileBrowserViewMode('worktree-1', 'page-1', 'file:///repo/report.html')
    ).toBe('web')
  })
})
