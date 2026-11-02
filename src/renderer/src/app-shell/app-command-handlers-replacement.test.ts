import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppShortcutState } from './app-command-handlers'

const runBuiltInOrReplacement = vi.hoisted(() => vi.fn())
vi.mock('@/lib/plugin-command-replacements', () => ({ runBuiltInOrReplacement }))
vi.mock('../store', () => ({ useAppStore: Object.assign(vi.fn(), { getState: () => ({}) }) }))
vi.mock('@/lib/floating-workspace-terminal-actions', () => ({
  isFloatingWorkspacePanelFocused: () => false
}))
vi.mock('@/lib/terminal-shortcut-capture-notification', () => ({
  showTerminalShortcutCaptureNotification: vi.fn()
}))

import { createAppCommandHandlers } from './app-command-handlers'

function state(toggleSidebar: () => void): AppShortcutState {
  return {
    activeView: 'terminal',
    activeWorktreeId: 'wt-1',
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: sidebar.left.toggle calls only toggleSidebar.
    actions: { toggleSidebar } as unknown as AppShortcutState['actions'],
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

beforeEach(() => runBuiltInOrReplacement.mockReset())

describe('built-in actions and plugin replacements', () => {
  it('lets a replacing plugin command run for a shortcut or alias', () => {
    const toggleSidebar = vi.fn()
    expect(createAppCommandHandlers(state(toggleSidebar)).get('sidebar.left.toggle')?.()).toBe(true)
    expect(runBuiltInOrReplacement).toHaveBeenCalledWith(
      'sidebar.left.toggle',
      expect.any(Function)
    )
    expect(toggleSidebar).not.toHaveBeenCalled()
  })

  it("runs Orca's own for a plugin's commands.run, so a replacing plugin never calls itself", () => {
    const toggleSidebar = vi.fn()
    const handlers = createAppCommandHandlers(state(toggleSidebar), undefined, 'app', true)
    expect(handlers.get('sidebar.left.toggle')?.()).toBe(true)
    expect(toggleSidebar).toHaveBeenCalledTimes(1)
    expect(runBuiltInOrReplacement).not.toHaveBeenCalled()
  })
})
