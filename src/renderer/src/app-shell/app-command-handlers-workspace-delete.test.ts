import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import type { HoveredWorkspaceDeleteTarget } from '../components/sidebar/hovered-workspace-delete'
import type { AppShortcutState, ShortcutDispatchInput } from './app-command-handlers'

const mocks = vi.hoisted(() => ({
  deleteHoveredWorkspaceImmediately: vi.fn(),
  hoveredTarget: { kind: 'worktree', worktree: {} } as HoveredWorkspaceDeleteTarget | null,
  store: {} as AppState
}))

vi.mock('../store', () => ({
  useAppStore: Object.assign(vi.fn(), { getState: () => mocks.store })
}))

vi.mock('../components/sidebar/hovered-workspace-delete', () => ({
  deleteHoveredWorkspaceImmediately: mocks.deleteHoveredWorkspaceImmediately,
  resolveHoveredWorkspaceDeleteTarget: () => mocks.hoveredTarget
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
    mocks.hoveredTarget = { kind: 'worktree', worktree: {} as never }
  })

  it('claims the chord and immediately deletes the active workspace', () => {
    const input = shortcutInput()
    const handler = createAppCommandHandlers(shortcutState(), input, 'terminal').get(
      'workspace.delete'
    )

    expect(handler?.()).toBe(true)
    expect(input.preventDefault).toHaveBeenCalledOnce()
    expect(mocks.deleteHoveredWorkspaceImmediately).toHaveBeenCalledWith(
      mocks.store,
      mocks.hoveredTarget
    )
  })

  it('does not claim the chord without a hovered workspace', () => {
    const input = shortcutInput()
    const handler = createAppCommandHandlers(shortcutState(), input).get('workspace.delete')

    mocks.hoveredTarget = null
    expect(handler?.()).toBe(false)
    expect(input.preventDefault).not.toHaveBeenCalled()
    expect(mocks.deleteHoveredWorkspaceImmediately).not.toHaveBeenCalled()
  })
})
