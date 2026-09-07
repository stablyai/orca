import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tab, TabGroup } from '../../../shared/tab-types'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import type { AppState } from '@/store/types'
import { createTabsFocusActions } from '../store/slices/tabs/tabs-focus-actions'
import type { TabsSliceGet, TabsSliceSet } from '../store/slices/tabs/tabs-slice-contract'
import { buildActiveSurfacePatch } from '../store/slices/tabs/tabs-surface'
import type { AppShortcutState, ShortcutDispatchInput } from './app-command-handlers'

const mocks = vi.hoisted(() => ({
  requestTerminalTabRename: vi.fn(),
  store: {} as AppState
}))

vi.mock('../store', () => ({
  useAppStore: Object.assign(vi.fn(), { getState: () => mocks.store })
}))

vi.mock('../components/tab-bar/terminal-tab-rename-request', () => ({
  requestTerminalTabRename: mocks.requestTerminalTabRename
}))

vi.mock('@/lib/floating-workspace-terminal-actions', () => ({
  isFloatingWorkspacePanelFocused: () => false
}))

vi.mock('@/lib/terminal-shortcut-capture-notification', () => ({
  showTerminalShortcutCaptureNotification: vi.fn()
}))

import { createAppCommandHandlers } from './app-command-handlers'

const WORKTREE_ID = 'repo::/feature'
const GROUP_ID = 'group-1'
const TERMINAL_ENTITY_ID = 'terminal-1'
const TERMINAL_UNIFIED_ID = 'unified-terminal'
const CHAT_UNIFIED_ID = 'unified-chat'

function unifiedTab(overrides: Partial<Tab> & Pick<Tab, 'id' | 'entityId' | 'contentType'>): Tab {
  return {
    groupId: GROUP_ID,
    worktreeId: WORKTREE_ID,
    label: overrides.id,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0,
    ...overrides
  }
}

/**
 * Builds the store the real app has when `activeGroupTabId` is focused: the raw group/tab state
 * plus the active-surface fields derived from it by the same code the store runs. That derivation
 * is what leaves `activeTabId` pointing at a background terminal while a structured tab is active,
 * so stubbing those fields instead would hide exactly the half under test.
 */
function storeForActiveTab(activeGroupTabId: string): AppState {
  const groups: TabGroup[] = [
    {
      id: GROUP_ID,
      worktreeId: WORKTREE_ID,
      activeTabId: activeGroupTabId,
      tabOrder: [TERMINAL_UNIFIED_ID, CHAT_UNIFIED_ID]
    }
  ]
  const rawState = {
    activeBrowserTabIdByWorktree: {},
    activeFileIdByWorktree: {},
    activeGroupIdByWorktree: { [WORKTREE_ID]: GROUP_ID },
    // The user focused this terminal before switching to the structured tab.
    activeTabIdByWorktree: { [WORKTREE_ID]: TERMINAL_ENTITY_ID },
    activeTabTypeByWorktree: {},
    browserTabsByWorktree: {},
    groupsByWorktree: { [WORKTREE_ID]: groups },
    layoutByWorktree: {},
    openFiles: [],
    tabsByWorktree: {
      [WORKTREE_ID]: [{ id: TERMINAL_ENTITY_ID, worktreeId: WORKTREE_ID } as TerminalTab]
    },
    unifiedTabsByWorktree: {
      [WORKTREE_ID]: [
        unifiedTab({
          id: TERMINAL_UNIFIED_ID,
          entityId: TERMINAL_ENTITY_ID,
          contentType: 'terminal'
        }),
        unifiedTab({ id: CHAT_UNIFIED_ID, entityId: 'session-1', contentType: 'agent-session' })
      ]
    }
  } as unknown as AppState
  const store = {
    ...rawState,
    ...buildActiveSurfacePatch(rawState, WORKTREE_ID)
  } as AppState
  const noopSet = (() => {}) as unknown as TabsSliceSet
  store.getActiveTab = createTabsFocusActions(noopSet, (() => store) as TabsSliceGet).getActiveTab
  return store
}

function shortcutState(): AppShortcutState {
  return {
    activeView: 'terminal',
    activeWorktreeId: WORKTREE_ID,
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

function runRename(state: AppShortcutState = shortcutState()): boolean | undefined {
  return createAppCommandHandlers(state, shortcutInput(), 'terminal').get('tab.rename')?.()
}

describe('tab.rename shortcut', () => {
  beforeEach(() => vi.clearAllMocks())

  it('leaves activeTabId on a background terminal while a structured tab is active', () => {
    // Guards the premise of the test below: without this the structured case proves nothing.
    mocks.store = storeForActiveTab(CHAT_UNIFIED_ID)
    expect(mocks.store.activeTabType).toBe('agent-session')
    expect(mocks.store.activeTabId).toBe(TERMINAL_ENTITY_ID)
  })

  it('renames the structured chat tab, not the stale background terminal', () => {
    mocks.store = storeForActiveTab(CHAT_UNIFIED_ID)
    expect(runRename()).toBe(true)
    expect(mocks.requestTerminalTabRename).toHaveBeenCalledWith(CHAT_UNIFIED_ID)
    expect(mocks.requestTerminalTabRename).not.toHaveBeenCalledWith(TERMINAL_ENTITY_ID)
  })

  it('still renames the terminal tab by its backing terminal id', () => {
    mocks.store = storeForActiveTab(TERMINAL_UNIFIED_ID)
    expect(mocks.store.activeTabType).toBe('terminal')
    expect(runRename()).toBe(true)
    expect(mocks.requestTerminalTabRename).toHaveBeenCalledWith(TERMINAL_ENTITY_ID)
  })

  it('does not claim the chord for a tab type that has no inline rename', () => {
    mocks.store = {
      ...storeForActiveTab(CHAT_UNIFIED_ID),
      activeTabType: 'browser'
    } as AppState
    expect(runRename()).toBe(false)
    expect(mocks.requestTerminalTabRename).not.toHaveBeenCalled()
  })

  it('does not claim the chord for a structured tab with no active worktree', () => {
    mocks.store = storeForActiveTab(CHAT_UNIFIED_ID)
    expect(runRename({ ...shortcutState(), activeWorktreeId: null })).toBe(false)
    expect(mocks.requestTerminalTabRename).not.toHaveBeenCalled()
  })
})
