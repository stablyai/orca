// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import type { PendingWorktreeCreation } from '@/lib/workspace/creation/pending-worktree-creation'
import { RightSidebarToggle } from './TitlebarMainStrip'

afterEach(cleanup)

function showCloudBuild(): void {
  useAppStore.setState({
    activeView: 'terminal',
    activePendingCreationId: 'c1',
    rightSidebarOpen: false,
    pendingWorktreeCreations: {
      c1: {
        creationId: 'c1',
        status: 'creating',
        loaderVisible: true,
        request: {
          name: 'fix-login',
          ephemeralVmRecipe: {
            sourceRepoId: 'r',
            recipeId: 'cloud',
            projectId: 'p',
            provider: 'orca-cloud'
          }
        }
      } as PendingWorktreeCreation
    }
  })
}

it('explains itself instead of toggling a hidden sidebar during a build, by click or shortcut', () => {
  showCloudBuild()
  render(
    <TooltipProvider>
      <RightSidebarToggle />
    </TooltipProvider>
  )
  const button = screen.getByRole('button', { name: 'Toggle right sidebar' })
  expect(button.getAttribute('aria-disabled')).toBe('true')
  fireEvent.click(button)
  // The shortcut path calls the store action directly.
  act(() => useAppStore.getState().toggleRightSidebar())
  expect(useAppStore.getState().rightSidebarOpen).toBe(false)
  act(() => {
    fireEvent.focus(button)
  })
  expect(document.body.textContent).toContain('Available when the workspace is ready')
})
