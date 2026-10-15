import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import type { Worktree } from '../../../shared/worktree/types'
import type { AppShortcutState, ShortcutDispatchInput } from './app-command-handlers'

const mocks = vi.hoisted(() => ({
  applyWorkspacePinIntent: vi.fn(),
  floatingWorkspaceFocused: false,
  visibleOverlay: false,
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hoisted slot starts empty and each test assigns the row it needs.
  pinTarget: null as Worktree | null,
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: beforeEach replaces this with the fields the handlers read; the empty seed is never exercised.
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
  isFloatingWorkspacePanelFocused: () => mocks.floatingWorkspaceFocused
}))

vi.mock('@/lib/terminal-shortcut-capture-notification', () => ({
  showTerminalShortcutCaptureNotification: vi.fn()
}))

vi.mock('@/lib/visible-overlay', () => ({
  hasVisibleOverlay: () => mocks.visibleOverlay
}))

import { createAppCommandHandlers } from './app-command-handlers'
import { WORKSPACE_PIN_ACTION_IDS } from './workspace-pin-command-handlers'
import { isPluginCommandAliasActionId } from '../../../shared/plugins/plugin-command-actions'

function shortcutState(): AppShortcutState {
  return {
    activeView: 'terminal',
    activeWorktreeId: 'repo::/feature',
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the pin handlers never read the action bag; an unexpected access must fail the test.
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
    mocks.floatingWorkspaceFocused = false
    mocks.visibleOverlay = false
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the pin handlers read only the active workspace id off the store.
    mocks.store = { activeWorktreeId: 'repo::/feature' } as AppState
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the target is forwarded untouched to a mocked apply, which only needs these two fields.
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

  // useGlobalKeybindings dispatches these explicitly from WORKSPACE_PIN_ACTION_IDS, so every
  // id there must have a handler; they stay out of the plugin alias list because a palette-run
  // alias would trip the hover/focus-aware resolver while the search box still has focus.
  it.each(WORKSPACE_PIN_ACTION_IDS)(
    'registers %s as an explicit handler rather than a plugin alias',
    (actionId) => {
      expect(createAppCommandHandlers(shortcutState()).has(actionId)).toBe(true)
      expect(isPluginCommandAliasActionId(actionId)).toBe(false)
    }
  )

  it('falls through while the floating workspace panel has focus', () => {
    mocks.floatingWorkspaceFocused = true
    const input = shortcutInput()
    const handler = createAppCommandHandlers(shortcutState(), input).get('workspace.togglePin')

    expect(handler?.()).toBe(false)
    expect(input.preventDefault).not.toHaveBeenCalled()
    expect(mocks.applyWorkspacePinIntent).not.toHaveBeenCalled()
  })

  it('falls through while an overlay such as a context menu is open', () => {
    mocks.visibleOverlay = true
    const input = shortcutInput()
    const handler = createAppCommandHandlers(shortcutState(), input).get('workspace.togglePin')

    expect(handler?.()).toBe(false)
    expect(input.preventDefault).not.toHaveBeenCalled()
    expect(mocks.applyWorkspacePinIntent).not.toHaveBeenCalled()
  })

  it('falls through when no workspace resolves', () => {
    const input = shortcutInput()
    const handler = createAppCommandHandlers(shortcutState(), input).get('workspace.togglePin')

    mocks.pinTarget = null
    expect(handler?.()).toBe(false)
    expect(input.preventDefault).not.toHaveBeenCalled()
    expect(mocks.applyWorkspacePinIntent).not.toHaveBeenCalled()
  })
})
