import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppShortcutState, ShortcutDispatchInput } from './app-command-handlers'

const mocks = vi.hoisted(() => {
  const target: { groupKey: string | null } = { groupKey: 'lineage:parent' }
  return {
    target,
    floatingFocused: false,
    visibleModal: false,
    requestScrollAnchor: vi.fn(),
    notifyTerminalCapture: vi.fn(),
    store: {
      activeModal: 'none',
      collapsedGroups: new Set<string>(),
      setSidebarOpen: vi.fn(),
      toggleCollapsedGroup: vi.fn()
    }
  }
})

vi.mock('../store', () => ({
  useAppStore: Object.assign(vi.fn(), { getState: () => mocks.store })
}))

vi.mock('../components/sidebar/child-workspaces-toggle-target', () => ({
  getRenderedLineageChipKeys: () => new Set<string>(),
  resolveChildWorkspacesToggleGroupKey: () => mocks.target.groupKey
}))

vi.mock('@/hooks/requestVirtualizedScrollAnchorRecord', () => ({
  requestVirtualizedScrollAnchorRecord: mocks.requestScrollAnchor
}))

vi.mock('@/lib/floating-workspace-terminal-actions', () => ({
  isFloatingWorkspacePanelFocused: () => mocks.floatingFocused
}))

vi.mock('@/lib/visible-overlay', () => ({
  hasVisibleOverlay: () => mocks.visibleModal
}))

vi.mock('@/lib/terminal-shortcut-capture-notification', () => ({
  showTerminalShortcutCaptureNotification: mocks.notifyTerminalCapture
}))

import { createAppCommandHandlers } from './app-command-handlers'

function shortcutState(): AppShortcutState {
  return {
    activeView: 'terminal',
    activeWorktreeId: 'parent',
    actions: {
      toggleSidebar: vi.fn(),
      toggleRightSidebar: vi.fn(),
      setRightSidebarOpen: vi.fn(),
      setRightSidebarTab: vi.fn(),
      showRightSidebarFiles: vi.fn(),
      showRightSidebarSearch: vi.fn(),
      openDiffNotesSendMenuForActiveWorktree: vi.fn()
    },
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

function runToggle(input: ShortcutDispatchInput): boolean | undefined {
  return createAppCommandHandlers(shortcutState(), input).get('sidebar.childWorkspaces.toggle')?.()
}

describe('child workspaces toggle app command', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.target.groupKey = 'lineage:parent'
    mocks.floatingFocused = false
    mocks.visibleModal = false
    mocks.store.activeModal = 'none'
    mocks.store.collapsedGroups = new Set()
  })

  it('hides the target’s children without forcing the sidebar open', () => {
    const input = shortcutInput()

    expect(runToggle(input)).toBe(true)
    expect(input.preventDefault).toHaveBeenCalledOnce()
    expect(mocks.requestScrollAnchor).toHaveBeenCalledWith('[data-worktree-sidebar]')
    expect(mocks.store.toggleCollapsedGroup).toHaveBeenCalledWith('lineage:parent')
    expect(mocks.store.setSidebarOpen).not.toHaveBeenCalled()
    expect(mocks.requestScrollAnchor.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.store.toggleCollapsedGroup.mock.invocationCallOrder[0] ?? 0
    )
  })

  it('opens the sidebar when showing hidden children', () => {
    mocks.store.collapsedGroups = new Set(['lineage:parent'])

    expect(runToggle(shortcutInput())).toBe(true)
    expect(mocks.store.toggleCollapsedGroup).toHaveBeenCalledWith('lineage:parent')
    expect(mocks.store.setSidebarOpen).toHaveBeenCalledWith(true)
  })

  it('lets the chord through when the target is in no lineage', () => {
    mocks.target.groupKey = null
    const input = shortcutInput()

    expect(runToggle(input)).toBe(false)
    expect(input.preventDefault).not.toHaveBeenCalled()
    expect(mocks.store.toggleCollapsedGroup).not.toHaveBeenCalled()
    expect(mocks.requestScrollAnchor).not.toHaveBeenCalled()
  })

  it('lets a modal keep its keyboard input', () => {
    mocks.store.activeModal = 'delete-worktree'
    const input = shortcutInput()

    expect(runToggle(input)).toBe(false)
    expect(input.preventDefault).not.toHaveBeenCalled()
    expect(mocks.store.toggleCollapsedGroup).not.toHaveBeenCalled()
  })

  it('lets the focused floating workspace keep its keyboard input', () => {
    mocks.floatingFocused = true
    const input = shortcutInput()

    expect(runToggle(input)).toBe(false)
    expect(input.preventDefault).not.toHaveBeenCalled()
    expect(mocks.store.toggleCollapsedGroup).not.toHaveBeenCalled()
  })

  it('leaves locally controlled modal input and persistence untouched', () => {
    mocks.visibleModal = true
    const input = shortcutInput()

    expect(runToggle(input)).toBe(false)
    expect(input.preventDefault).not.toHaveBeenCalled()
    expect(mocks.store.toggleCollapsedGroup).not.toHaveBeenCalled()
    expect(mocks.requestScrollAnchor).not.toHaveBeenCalled()
    expect(mocks.store.setSidebarOpen).not.toHaveBeenCalled()
  })

  it('reports a claimed terminal shortcut through the existing notification policy', () => {
    const input = shortcutInput()
    expect(
      createAppCommandHandlers(shortcutState(), input, 'terminal').get(
        'sidebar.childWorkspaces.toggle'
      )?.()
    ).toBe(true)
    expect(mocks.notifyTerminalCapture).toHaveBeenCalledWith(
      expect.objectContaining({ actionId: 'sidebar.childWorkspaces.toggle' })
    )
  })
})
