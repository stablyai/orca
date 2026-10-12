import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import type { ActiveWorkspaceDeleteTarget } from '../components/sidebar/active-workspace-delete'
import type { AppShortcutState, ShortcutDispatchInput } from './app-command-handlers'

const mocks = vi.hoisted(() => ({
  requestActiveWorkspaceDelete: vi.fn(),
  activeTarget: null as ActiveWorkspaceDeleteTarget | null,
  store: {} as AppState
}))

vi.mock('../store', () => ({
  useAppStore: Object.assign(vi.fn(), { getState: () => mocks.store })
}))

vi.mock('../components/sidebar/active-workspace-delete', () => ({
  requestActiveWorkspaceDelete: mocks.requestActiveWorkspaceDelete,
  resolveActiveWorkspaceDeleteTarget: () => mocks.activeTarget
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
    mocks.activeTarget = {
      kind: 'worktree',
      worktree: {} as never,
      identity: 'local|repo::/feature'
    }
  })

  it('claims the chord and hands the active workspace to the press-again flow', () => {
    const input = shortcutInput()
    const handler = createAppCommandHandlers(shortcutState(), input, 'terminal').get(
      'workspace.delete'
    )

    expect(handler?.()).toBe(true)
    expect(input.preventDefault).toHaveBeenCalledOnce()
    expect(mocks.requestActiveWorkspaceDelete).toHaveBeenCalledWith(mocks.store, mocks.activeTarget)
  })

  it('does not claim the chord without a deletable active workspace', () => {
    const input = shortcutInput()
    const handler = createAppCommandHandlers(shortcutState(), input).get('workspace.delete')

    mocks.activeTarget = null
    expect(handler?.()).toBe(false)
    expect(input.preventDefault).not.toHaveBeenCalled()
    expect(mocks.requestActiveWorkspaceDelete).not.toHaveBeenCalled()
  })
})
