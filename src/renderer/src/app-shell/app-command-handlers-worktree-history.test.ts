import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppShortcutState } from './app-command-handlers'

const mocks = vi.hoisted(() => ({
  goBackWorktree: vi.fn(),
  goForwardWorktree: vi.fn()
}))

vi.mock('../store', () => ({
  useAppStore: Object.assign(vi.fn(), {
    getState: () => mocks
  })
}))

vi.mock('@/lib/floating-workspace-terminal-actions', () => ({
  isFloatingWorkspacePanelFocused: () => false
}))

vi.mock('@/lib/terminal-shortcut-capture-notification', () => ({
  showTerminalShortcutCaptureNotification: vi.fn()
}))

import { createAppCommandHandlers } from './app-command-handlers'

function shortcutState(overrides: Partial<AppShortcutState> = {}): AppShortcutState {
  return {
    activeView: 'terminal',
    activeWorktreeId: 'repo::/feature',
    actions: {
      toggleSidebar: vi.fn(),
      toggleRightSidebar: vi.fn(),
      setRightSidebarOpen: vi.fn(),
      setRightSidebarTab: vi.fn(),
      showRightSidebarFiles: vi.fn(),
      showRightSidebarSearch: vi.fn(),
      openDiffNotesSendMenuForActiveWorktree: vi.fn()
    },
    creationLayoutActive: false,
    floatingTerminalEnabled: false,
    floatingTerminalOpen: false,
    floatingVisibleTabCount: 0,
    keybindings: {},
    openFloatingWorkspaceMaximized: vi.fn(),
    pluginCommands: [],
    setFloatingTerminalOpen: vi.fn(),
    terminalShortcutPolicy: 'orca-first',
    workspaceChromeActive: true,
    ...overrides
  }
}

// Mouse Back/Forward invoke these handlers without a key event.
function runWithoutInput(
  actionId: 'worktree.history.back' | 'worktree.history.forward',
  state: AppShortcutState
): boolean | undefined {
  return createAppCommandHandlers(state).get(actionId)?.()
}

describe('worktree history app commands', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('goes back and forward from the terminal view', () => {
    expect(runWithoutInput('worktree.history.back', shortcutState())).toBe(true)
    expect(runWithoutInput('worktree.history.forward', shortcutState())).toBe(true)

    expect(mocks.goBackWorktree).toHaveBeenCalledOnce()
    expect(mocks.goForwardWorktree).toHaveBeenCalledOnce()
  })

  it.each(['tasks', 'automations', 'artifacts', 'skills'] as const)(
    'navigates from the %s page',
    (activeView) => {
      expect(runWithoutInput('worktree.history.back', shortcutState({ activeView }))).toBe(true)
      expect(mocks.goBackWorktree).toHaveBeenCalledOnce()
    }
  )

  it('does nothing in Settings, where the history controls are hidden', () => {
    expect(
      runWithoutInput('worktree.history.back', shortcutState({ activeView: 'settings' }))
    ).toBe(false)
    expect(mocks.goBackWorktree).not.toHaveBeenCalled()
  })

  it('does nothing while the creation layout is open', () => {
    expect(
      runWithoutInput('worktree.history.forward', shortcutState({ creationLayoutActive: true }))
    ).toBe(false)
    expect(mocks.goForwardWorktree).not.toHaveBeenCalled()
  })
})
