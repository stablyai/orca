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

describe('sidebar.activity.toggle app command', () => {
  let setSidebarBody: ReturnType<typeof vi.fn>
  let setSidebarOpen: ReturnType<typeof vi.fn>

  beforeEach(() => {
    setSidebarBody = vi.fn()
    setSidebarOpen = vi.fn()
    mocks.store = {
      sidebarBody: 'workspaces',
      setSidebarBody,
      setSidebarOpen
    } as unknown as AppState
  })

  it('switches to the activity view and reveals the sidebar', () => {
    const input = shortcutInput()
    const handler = createAppCommandHandlers(shortcutState(), input).get('sidebar.activity.toggle')

    expect(handler?.()).toBe(true)
    expect(setSidebarBody).toHaveBeenCalledWith('agents')
    expect(setSidebarOpen).toHaveBeenCalledWith(true)
  })

  it('switches back to workspaces without forcing the sidebar open or closed', () => {
    mocks.store = {
      sidebarBody: 'agents',
      setSidebarBody,
      setSidebarOpen
    } as unknown as AppState
    const handler = createAppCommandHandlers(shortcutState()).get('sidebar.activity.toggle')

    expect(handler?.()).toBe(true)
    expect(setSidebarBody).toHaveBeenCalledWith('workspaces')
    expect(setSidebarOpen).not.toHaveBeenCalled()
  })

  it('does not claim the chord from the Settings view', () => {
    const handler = createAppCommandHandlers(shortcutState({ activeView: 'settings' })).get(
      'sidebar.activity.toggle'
    )

    expect(handler?.()).toBe(false)
    expect(setSidebarBody).not.toHaveBeenCalled()
  })
})
