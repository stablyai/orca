// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SidebarLayoutToggle } from './SidebarLayoutToggle'

const mocks = vi.hoisted(
  (): {
    state: {
      settings:
        | { toolsSidebarPosition?: 'left' | 'right'; workspaceMode?: 'work' | 'code' }
        | undefined
      updateSettings: ReturnType<typeof vi.fn>
      setSidebarOpen: ReturnType<typeof vi.fn>
      setRightSidebarOpen: ReturnType<typeof vi.fn>
      setRightSidebarTab: ReturnType<typeof vi.fn>
    }
  } => ({
    state: {
      settings: undefined,
      updateSettings: vi.fn().mockResolvedValue(undefined),
      setSidebarOpen: vi.fn(),
      setRightSidebarOpen: vi.fn(),
      setRightSidebarTab: vi.fn()
    }
  })
)

vi.mock('../store', () => {
  const useAppStore = (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state)
  // The mode switch reads live layout ownership off the store, not the snapshot.
  return {
    useAppStore: Object.assign(useAppStore, {
      getState: () => ({ layoutByWorktree: {}, groupsByWorktree: {} })
    })
  }
})
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

afterEach(cleanup)
beforeEach(() => {
  mocks.state.settings = undefined
  mocks.state.updateSettings.mockClear()
  mocks.state.setSidebarOpen.mockClear()
  mocks.state.setRightSidebarOpen.mockClear()
  mocks.state.setRightSidebarTab.mockClear()
})

describe('SidebarLayoutToggle', () => {
  it('treats older settings without a mode as Work and switches to the fixed Code layout', () => {
    render(
      <TooltipProvider>
        <SidebarLayoutToggle />
      </TooltipProvider>
    )
    const button = screen.getByRole('button', { name: /Switch to Code mode/ })
    expect(button.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(button)
    // Why: Code fixes Explorer left and chat right, so the switch restores the whole bundle.
    expect(mocks.state.setSidebarOpen).toHaveBeenCalledExactlyOnceWith(false)
    expect(mocks.state.setRightSidebarTab).toHaveBeenCalledExactlyOnceWith('explorer')
    expect(mocks.state.setRightSidebarOpen).toHaveBeenCalledExactlyOnceWith(true)
    expect(mocks.state.updateSettings).toHaveBeenCalledExactlyOnceWith({
      workspaceMode: 'code',
      toolsSidebarPosition: 'left'
    })
  })

  it('returns from Code to the fixed Work layout', () => {
    mocks.state.settings = { workspaceMode: 'code', toolsSidebarPosition: 'left' }
    render(
      <TooltipProvider>
        <SidebarLayoutToggle />
      </TooltipProvider>
    )
    const button = screen.getByRole('button', { name: /Switch to Work mode/ })
    expect(button.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(button)
    expect(mocks.state.setSidebarOpen).toHaveBeenCalledExactlyOnceWith(true)
    expect(mocks.state.setRightSidebarTab).toHaveBeenCalledExactlyOnceWith('explorer')
    expect(mocks.state.setRightSidebarOpen).toHaveBeenCalledExactlyOnceWith(false)
    expect(mocks.state.updateSettings).toHaveBeenCalledExactlyOnceWith({
      workspaceMode: 'work',
      toolsSidebarPosition: 'right'
    })
  })
})
