// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SidebarLayoutToggle } from './SidebarLayoutToggle'

const mocks = vi.hoisted(
  (): {
    state: {
      settings: { toolsSidebarPosition?: 'left' | 'right' } | undefined
      updateSettings: ReturnType<typeof vi.fn>
    }
  } => ({
    state: {
      settings: undefined,
      updateSettings: vi.fn().mockResolvedValue(undefined)
    }
  })
)

vi.mock('../store', () => ({
  useAppStore: (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state)
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

afterEach(cleanup)
beforeEach(() => {
  mocks.state.settings = undefined
  mocks.state.updateSettings.mockClear()
})

describe('SidebarLayoutToggle', () => {
  it('keeps the original layout when older settings omit the preference', () => {
    render(
      <TooltipProvider>
        <SidebarLayoutToggle />
      </TooltipProvider>
    )
    const button = screen.getByRole('button', { name: /Move tools sidebar to the left/ })
    expect(button.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(button)
    expect(mocks.state.updateSettings).toHaveBeenCalledExactlyOnceWith({
      toolsSidebarPosition: 'left'
    })
  })

  it('can return from the left-hand layout without changing other settings', () => {
    mocks.state.settings = { toolsSidebarPosition: 'left' }
    render(
      <TooltipProvider>
        <SidebarLayoutToggle />
      </TooltipProvider>
    )
    const button = screen.getByRole('button', { name: 'Move tools sidebar to the right' })
    expect(button.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(button)
    expect(mocks.state.updateSettings).toHaveBeenCalledExactlyOnceWith({
      toolsSidebarPosition: 'right'
    })
  })
})
