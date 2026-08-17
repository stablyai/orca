// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppShortcutState } from './app-command-handlers'

const setRenamingTabId = vi.hoisted(() => vi.fn())
const storeState = vi.hoisted(() => ({
  activeTabId: 'main-tab' as string | null,
  activeTabType: 'terminal' as 'terminal' | 'editor',
  groupsByWorktree: {
    aux: [
      {
        id: 'aux-group',
        worktreeId: 'aux',
        activeTabId: 'aux-unified',
        tabOrder: ['aux-unified']
      }
    ]
  },
  unifiedTabsByWorktree: {
    aux: [
      {
        id: 'aux-unified',
        entityId: 'aux-terminal',
        groupId: 'aux-group',
        worktreeId: 'aux',
        contentType: 'terminal' as const
      }
    ]
  },
  setRenamingTabId
}))

vi.mock('../store', () => ({
  useAppStore: Object.assign(vi.fn(), { getState: () => storeState })
}))

vi.mock('@/lib/floating-workspace-terminal-actions', () => ({
  isFloatingWorkspacePanelFocused: () => false
}))

import { createAppCommandHandlers } from './app-command-handlers'

function state(overrides: Partial<AppShortcutState> = {}): AppShortcutState {
  return {
    activeView: 'terminal',
    activeWorktreeId: 'main',
    actions: {} as AppShortcutState['actions'],
    creationLayoutActive: false,
    floatingTerminalEnabled: true,
    floatingTerminalOpen: false,
    floatingVisibleTabCount: 0,
    keybindings: {},
    openFloatingWorkspaceMaximized: vi.fn(),
    pluginCommands: [] as unknown as AppShortcutState['pluginCommands'],
    setFloatingTerminalOpen: vi.fn(),
    terminalShortcutPolicy: 'orca-first',
    workspaceChromeActive: true,
    ...overrides
  }
}

describe('tab rename command routing', () => {
  beforeEach(() => {
    setRenamingTabId.mockReset()
    storeState.activeTabId = 'main-tab'
    storeState.activeTabType = 'terminal'
  })

  it('preserves main-window chrome and tab-type guards', () => {
    const mainTarget = { worktreeId: 'main', groupId: 'main-group', auxiliary: false }

    expect(
      createAppCommandHandlers(
        state({ workspaceChromeActive: false }),
        undefined,
        'app',
        mainTarget
      ).get('tab.rename')?.()
    ).toBe(false)

    storeState.activeTabType = 'editor'
    expect(
      createAppCommandHandlers(state(), undefined, 'app', mainTarget).get('tab.rename')?.()
    ).toBe(false)
    expect(setRenamingTabId).not.toHaveBeenCalled()
  })

  it('routes an auxiliary-window rename to its active terminal', () => {
    const auxiliaryTarget = { worktreeId: 'aux', groupId: 'aux-group', auxiliary: true }

    expect(
      createAppCommandHandlers(
        state({ workspaceChromeActive: false }),
        undefined,
        'app',
        auxiliaryTarget
      ).get('tab.rename')?.()
    ).toBe(true)
    expect(setRenamingTabId).toHaveBeenCalledWith('aux-terminal')
  })
})
