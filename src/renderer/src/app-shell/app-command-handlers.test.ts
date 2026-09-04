import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tab } from '../../../shared/tab-types'
import { useAppStore } from '../store'
import {
  createAppCommandHandlers,
  type AppShortcutState,
  type ShortcutDispatchInput
} from './app-command-handlers'

const WT = 'wt-1'

vi.mock('@/lib/floating-workspace-terminal-actions', () => ({
  isFloatingWorkspacePanelFocused: () => false
}))

describe('createAppCommandHandlers', () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState(), true)
  })

  it('does not claim a move-to-split chord when the store rejects the move', () => {
    const dropUnifiedTab = vi.fn(() => false)
    useAppStore.setState({
      activeWorktreeId: WT,
      activeGroupIdByWorktree: { [WT]: 'group-1' },
      groupsByWorktree: {
        [WT]: [
          {
            id: 'group-1',
            worktreeId: WT,
            activeTabId: 'tab-a',
            tabOrder: ['tab-a', 'tab-b']
          }
        ]
      },
      unifiedTabsByWorktree: {
        [WT]: [
          {
            id: 'tab-a',
            groupId: 'group-1',
            worktreeId: WT,
            contentType: 'terminal',
            entityId: 'term-a',
            label: 'A',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 0
          } satisfies Tab,
          {
            id: 'tab-b',
            groupId: 'group-1',
            worktreeId: WT,
            contentType: 'terminal',
            entityId: 'term-b',
            label: 'B',
            customLabel: null,
            color: null,
            sortOrder: 1,
            createdAt: 1
          } satisfies Tab
        ]
      },
      dropUnifiedTab
    })

    const preventDefault = vi.fn()
    const input: ShortcutDispatchInput = {
      target: null,
      defaultPrevented: false,
      preventDefault
    }
    const state: AppShortcutState = {
      activeView: 'terminal',
      activeWorktreeId: WT,
      actions: {} as AppShortcutState['actions'],
      creationLayoutActive: false,
      floatingTerminalEnabled: false,
      floatingTerminalOpen: false,
      floatingVisibleTabCount: 0,
      keybindings: useAppStore.getState().keybindings,
      openFloatingWorkspaceMaximized: vi.fn(),
      pluginCommands: [],
      setFloatingTerminalOpen: vi.fn(),
      terminalShortcutPolicy: 'orca-first',
      workspaceChromeActive: true
    }

    const handled = createAppCommandHandlers(state, input).get('tab.moveToSplitRight')?.()

    expect(handled).toBe(false)
    expect(dropUnifiedTab).toHaveBeenCalledWith('tab-a', {
      groupId: 'group-1',
      splitDirection: 'right'
    })
    expect(preventDefault).not.toHaveBeenCalled()
  })
})
