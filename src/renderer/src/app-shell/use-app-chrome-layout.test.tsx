// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../shared/constants'
import { useAppStore } from '../store'

vi.mock('../components/terminal-pane/use-system-prefers-dark', () => ({
  useSystemPrefersDark: () => false
}))

import { useAppChromeLayout } from './use-app-chrome-layout'

const initialState = useAppStore.getState()

function leftHeaderIsClipped(layout: ReturnType<typeof useAppChromeLayout>): boolean {
  return (
    layout.leftTitlebarChromeLayout.shouldMount &&
    !layout.leftSlotOpen &&
    !layout.leftColumnHeaderFloating
  )
}

function setChromeState(overrides: Record<string, unknown>): void {
  useAppStore.setState({
    settings: { ...getDefaultSettings('/tmp'), workspaceSidebarPosition: 'right' },
    rightSidebarOpen: true,
    sidebarOpen: true,
    activeView: 'terminal',
    activeWorktreeId: null,
    ...overrides
  } as never)
}

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      disconnect(): void {}
    }
  )
})

afterEach(() => {
  useAppStore.setState(initialState, true)
  vi.unstubAllGlobals()
})

describe('useAppChromeLayout with the workspace list on the right', () => {
  it('treats the left activity slot as open while the activity sidebar is drawn', () => {
    setChromeState({ activeView: 'terminal' })
    const { result } = renderHook(() => useAppChromeLayout())

    expect(result.current.activitySidebarEdge).toBe('left')
    expect(result.current.leftSlotOpen).toBe(true)
  })

  it('releases the left slot in a full-page view that suppresses the activity sidebar', () => {
    setChromeState({ activeView: 'tasks' })
    const { result } = renderHook(() => useAppChromeLayout())

    expect(result.current.showRightSidebarControls).toBe(false)
    // Why: the sidebar body is not mounted, so keeping its column "open" clips the header controls in a 0-width box.
    expect(result.current.leftSlotOpen).toBe(false)
  })

  it('releases the left slot while worktree creation hides the activity sidebar', () => {
    setChromeState({
      activeView: 'terminal',
      activePendingCreationId: 'creation-1',
      pendingWorktreeCreations: { 'creation-1': { id: 'creation-1' } }
    })
    const { result } = renderHook(() => useAppChromeLayout())

    expect(result.current.creationLayoutActive).toBe(true)
    expect(result.current.leftSlotOpen).toBe(false)
  })

  it('keeps the left header out of a zero-width column in stacked views', () => {
    for (const rightSidebarOpen of [true, false]) {
      setChromeState({ activeView: 'tasks', sidebarOpen: true, rightSidebarOpen })
      const { result, unmount } = renderHook(() => useAppChromeLayout())

      // Why: the open workspace list sits on the right, so nothing occupies the left column and the full-width titlebar must render.
      expect(result.current.stackedSidebarOpen).toBe(false)
      expect(result.current.leftTitlebarChromeLayout.shouldMount).toBe(false)
      expect(leftHeaderIsClipped(result.current)).toBe(false)
      unmount()
    }
  })
})

describe('useAppChromeLayout with the workspace list on the left', () => {
  it('keeps the stacked layout while the workspace list is open in a full-page view', () => {
    setChromeState({
      settings: { ...getDefaultSettings('/tmp'), workspaceSidebarPosition: 'left' },
      activeView: 'tasks',
      sidebarOpen: true
    })
    const { result } = renderHook(() => useAppChromeLayout())

    expect(result.current.stackedSidebarOpen).toBe(true)
    expect(result.current.leftTitlebarChromeLayout.shouldMount).toBe(true)
    expect(leftHeaderIsClipped(result.current)).toBe(false)
  })

  it('floats the left header once the workspace list collapses', () => {
    setChromeState({
      settings: { ...getDefaultSettings('/tmp'), workspaceSidebarPosition: 'left' },
      activeView: 'terminal',
      activeWorktreeId: 'wt-1',
      sidebarOpen: false
    })
    const { result } = renderHook(() => useAppChromeLayout())

    expect(result.current.leftColumnHeaderFloating).toBe(true)
  })
})
