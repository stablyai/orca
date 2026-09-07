import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import type { CurrentWorkspaceDeleteTarget } from '../components/sidebar/current-workspace-delete'
import type { AppShortcutState, ShortcutDispatchInput } from './app-command-handlers'

const mocks = vi.hoisted(() => ({
  deleteCurrentWorkspaceImmediately: vi.fn(),
  activeTarget: { kind: 'worktree', worktree: {} } as CurrentWorkspaceDeleteTarget | null,
  store: {} as AppState
}))

vi.mock('../store', () => ({
  useAppStore: Object.assign(vi.fn(), { getState: () => mocks.store })
}))

vi.mock('../components/sidebar/current-workspace-delete', () => ({
  deleteCurrentWorkspaceImmediately: mocks.deleteCurrentWorkspaceImmediately,
  resolveCurrentWorkspaceDeleteTarget: () => mocks.activeTarget
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
    actions: {} as AppShortcutState['actions'],
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

function shortcutInput(): ShortcutDispatchInput {
  return {
    target: null,
    defaultPrevented: false,
    preventDefault: vi.fn()
  }
}

describe('workspace delete app command', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.store = { activeWorktreeId: 'repo::/feature' } as AppState
    mocks.activeTarget = { kind: 'worktree', worktree: {} as never }
  })

  it('claims the chord and immediately deletes the active workspace', () => {
    const input = shortcutInput()
    const handler = createAppCommandHandlers(shortcutState(), input, 'terminal').get(
      'workspace.delete'
    )

    expect(handler?.()).toBe(true)
    expect(input.preventDefault).toHaveBeenCalledOnce()
    expect(mocks.deleteCurrentWorkspaceImmediately).toHaveBeenCalledWith(
      mocks.store,
      mocks.activeTarget
    )
  })

  it('does not claim the chord without a deletable active workspace', () => {
    const input = shortcutInput()
    const handler = createAppCommandHandlers(shortcutState(), input).get('workspace.delete')

    mocks.activeTarget = null
    expect(handler?.()).toBe(false)
    expect(input.preventDefault).not.toHaveBeenCalled()
    expect(mocks.deleteCurrentWorkspaceImmediately).not.toHaveBeenCalled()
  })
})
