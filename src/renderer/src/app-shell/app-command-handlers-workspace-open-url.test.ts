import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppShortcutState, ShortcutDispatchInput } from './app-command-handlers'

const mocks = vi.hoisted(() => {
  const noLink = (): { worktreeId: string; url: string } | null => null
  return { link: noLink(), open: vi.fn() }
})

vi.mock('../store', () => ({
  useAppStore: Object.assign(vi.fn(), { getState: () => ({}) })
}))

vi.mock('@/lib/workspace-url-open', () => ({
  getActiveWorkspaceUrl: () => mocks.link,
  openWorkspaceUrlInOrcaBrowser: mocks.open
}))

vi.mock('@/lib/floating-workspace-terminal-actions', () => ({
  isFloatingWorkspacePanelFocused: () => false
}))

vi.mock('@/lib/terminal-shortcut-capture-notification', () => ({
  showTerminalShortcutCaptureNotification: vi.fn()
}))

import { createAppCommandHandlers } from './app-command-handlers'

function shortcutState(): AppShortcutState {
  return {
    activeView: 'terminal',
    activeWorktreeId: 'repo::/feature',
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the open-url handler reads no shortcut actions.
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
    workspaceChromeActive: true
  }
}

function shortcutInput(): ShortcutDispatchInput {
  return { target: null, defaultPrevented: false, preventDefault: vi.fn() }
}

describe('workspace open-url app command', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.link = null
  })

  it('opens the saved link in the Orca browser and claims the chord', () => {
    mocks.link = { worktreeId: 'repo::/feature', url: 'https://app.test/admin' }
    const input = shortcutInput()

    expect(
      createAppCommandHandlers(shortcutState(), input, 'app').get('workspace.openUrl')?.()
    ).toBe(true)
    expect(input.preventDefault).toHaveBeenCalledOnce()
    expect(mocks.open).toHaveBeenCalledWith('repo::/feature', 'https://app.test/admin')
  })

  it('leaves the chord alone when the workspace has no saved link', () => {
    const input = shortcutInput()

    expect(
      createAppCommandHandlers(shortcutState(), input, 'app').get('workspace.openUrl')?.()
    ).toBe(false)
    expect(input.preventDefault).not.toHaveBeenCalled()
    expect(mocks.open).not.toHaveBeenCalled()
  })
})
