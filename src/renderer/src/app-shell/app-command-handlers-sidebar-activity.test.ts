import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import type { AppShortcutState, ShortcutDispatchInput } from './app-command-handlers'

const mocks = vi.hoisted(() => ({
  store: {} as AppState
}))

vi.mock('../store', () => ({
  useAppStore: Object.assign(vi.fn(), { getState: () => mocks.store })
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

describe('sidebar activity app command', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.store = {
      sidebarOpen: true,
      sidebarBody: 'workspaces',
      setSidebarOpen: vi.fn(),
      setSidebarBody: vi.fn()
    } as unknown as AppState
  })

  it('claims the chord and shows activity', () => {
    const input = shortcutInput()
    const handler = createAppCommandHandlers(shortcutState(), input).get('sidebar.activity.toggle')

    expect(handler?.()).toBe(true)
    expect(input.preventDefault).toHaveBeenCalledOnce()
    expect(mocks.store.setSidebarOpen).toHaveBeenCalledWith(true)
    expect(mocks.store.setSidebarBody).toHaveBeenCalledWith('agents')
  })

  it('claims the chord and returns to workspaces when activity is visible', () => {
    mocks.store = {
      ...mocks.store,
      sidebarBody: 'agents'
    }
    const input = shortcutInput()
    const handler = createAppCommandHandlers(shortcutState(), input).get('sidebar.activity.toggle')

    expect(handler?.()).toBe(true)
    expect(mocks.store.setSidebarBody).toHaveBeenCalledWith('workspaces')
    expect(mocks.store.setSidebarOpen).not.toHaveBeenCalled()
  })
})
