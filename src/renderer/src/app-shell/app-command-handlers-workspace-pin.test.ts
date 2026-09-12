import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import type { Worktree } from '../../../shared/worktree/types'
import type { AppShortcutState, ShortcutDispatchInput } from './app-command-handlers'

const mocks = vi.hoisted(() => ({
  applyWorkspacePinIntent: vi.fn(),
  pinTarget: null as Worktree | null,
  store: {} as AppState
}))

vi.mock('../store', () => ({
  useAppStore: Object.assign(vi.fn(), { getState: () => mocks.store })
}))

vi.mock('../components/sidebar/workspace-pin-shortcut-target', () => ({
  applyWorkspacePinIntent: mocks.applyWorkspacePinIntent,
  resolveWorkspacePinShortcutTarget: () => mocks.pinTarget
}))

vi.mock('../components/sidebar/hovered-workspace-delete', () => ({
  deleteHoveredWorkspaceImmediately: vi.fn(),
  resolveHoveredWorkspaceDeleteTarget: () => null
}))

vi.mock('@/lib/floating-workspace-terminal-actions', () => ({
  isFloatingWorkspacePanelFocused: () => false
}))

vi.mock('@/lib/terminal-shortcut-capture-notification', () => ({
  showTerminalShortcutCaptureNotification: vi.fn()
}))

import { createAppCommandHandlers } from './app-command-handlers'
import { PLUGIN_COMMAND_ALIAS_ACTION_IDS } from '../../../shared/plugins/plugin-command-actions'

function shortcutState(): AppShortcutState {
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
    workspaceChromeActive: true
  }
}

function shortcutInput(): ShortcutDispatchInput {
  return { target: null, defaultPrevented: false, preventDefault: vi.fn() }
}

describe('workspace pin app commands', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.store = { activeWorktreeId: 'repo::/feature' } as AppState
    mocks.pinTarget = { id: 'repo::/feature', isPinned: false } as Worktree
  })

  it.each([
    { actionId: 'workspace.pin' as const, intent: 'pin' },
    { actionId: 'workspace.unpin' as const, intent: 'unpin' },
    { actionId: 'workspace.togglePin' as const, intent: 'toggle' }
  ])('claims $actionId and applies the $intent intent', ({ actionId, intent }) => {
    const input = shortcutInput()
    const handler = createAppCommandHandlers(shortcutState(), input, 'terminal').get(actionId)

    expect(handler?.()).toBe(true)
    expect(input.preventDefault).toHaveBeenCalledOnce()
    expect(mocks.applyWorkspacePinIntent).toHaveBeenCalledWith(mocks.store, mocks.pinTarget, intent)
  })

  // useGlobalKeybindings dispatches key events by iterating this list, so an action
  // missing from it has a handler that no chord can ever reach.
  it.each(['workspace.pin', 'workspace.unpin', 'workspace.togglePin'])(
    'keeps %s reachable from the window key dispatcher',
    (actionId) => {
      expect(PLUGIN_COMMAND_ALIAS_ACTION_IDS).toContain(actionId)
    }
  )

  it('falls through when no workspace resolves', () => {
    const input = shortcutInput()
    const handler = createAppCommandHandlers(shortcutState(), input).get('workspace.togglePin')

    mocks.pinTarget = null
    expect(handler?.()).toBe(false)
    expect(input.preventDefault).not.toHaveBeenCalled()
    expect(mocks.applyWorkspacePinIntent).not.toHaveBeenCalled()
  })
})
