import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentPaneThread } from '../components/activity/activity-thread-types'
import type { AppShortcutState, ShortcutDispatchInput } from './app-command-handlers'
import {
  makeRepo,
  makeTab,
  makeWorktree
} from '../components/activity/ActivityPrototypePage-test-fixtures'

const mocks = vi.hoisted(() => ({
  activate: vi.fn(),
  resolve: vi.fn<() => AgentPaneThread | null>(),
  notify: vi.fn(),
  overlay: false,
  store: { activeModal: 'none' }
}))

vi.mock('../store', () => ({
  useAppStore: Object.assign(vi.fn(), { getState: () => mocks.store })
}))
vi.mock('../components/activity/latest-attention-thread', () => ({
  resolveLatestAttentionThread: mocks.resolve
}))
vi.mock('../components/activity/activity-thread-actions', () => ({
  activateActivityThreadTarget: mocks.activate
}))
vi.mock('@/lib/floating-workspace-terminal-actions', () => ({
  isFloatingWorkspacePanelFocused: () => false
}))
vi.mock('@/lib/visible-overlay', () => ({ hasVisibleOverlay: () => mocks.overlay }))
vi.mock('@/lib/terminal-shortcut-capture-notification', () => ({
  showTerminalShortcutCaptureNotification: mocks.notify
}))

import { createAppCommandHandlers } from './app-command-handlers'

function shortcutState(): AppShortcutState {
  return {
    activeView: 'terminal',
    activeWorktreeId: 'current',
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
    terminalShortcutPolicy: 'terminal-first',
    workspaceChromeActive: true
  }
}

function pendingThread(): AgentPaneThread {
  return {
    paneKey: 'tab-1:11111111-1111-4111-8111-111111111111',
    paneTitle: 'Synthetic pending agent',
    worktree: makeWorktree(),
    repo: makeRepo(),
    tab: makeTab(),
    agentType: 'codex',
    currentAgentState: 'waiting',
    currentAgentEntry: null,
    responsePreview: '',
    latestTimestamp: 1_000,
    latestEvent: null,
    events: [],
    unread: true
  }
}

function run(state = shortcutState(), context: 'app' | 'terminal' = 'terminal') {
  const input: ShortcutDispatchInput = {
    target: null,
    defaultPrevented: false,
    preventDefault: vi.fn()
  }
  const handled = createAppCommandHandlers(state, input, context).get(
    'worktree.jumpToLatestAttention'
  )?.()
  return { handled, input }
}

describe('latest attention app command', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.resolve.mockReturnValue(pendingThread())
    mocks.overlay = false
    mocks.store.activeModal = 'none'
  })

  it('claims the shortcut and reuses exact activity pane activation under terminal-first policy', () => {
    const { handled, input } = run()
    expect(handled).toBe(true)
    expect(input.preventDefault).toHaveBeenCalledOnce()
    expect(mocks.activate).toHaveBeenCalledWith(mocks.resolve.mock.results[0]?.value)
    expect(mocks.notify).not.toHaveBeenCalled()
  })

  it('passes the chord through when no current request exists', () => {
    mocks.resolve.mockReturnValue(null)
    const { handled, input } = run()
    expect(handled).toBe(false)
    expect(input.preventDefault).not.toHaveBeenCalled()
    expect(mocks.activate).not.toHaveBeenCalled()
  })

  it('does not interrupt an open dialog', () => {
    mocks.store.activeModal = 'settings'
    expect(run().handled).toBe(false)
    expect(mocks.resolve).not.toHaveBeenCalled()
    expect(mocks.activate).not.toHaveBeenCalled()
  })

  it('does not interrupt a local overlay or workspace creation', () => {
    mocks.overlay = true
    expect(run().handled).toBe(false)
    mocks.overlay = false
    expect(run({ ...shortcutState(), creationLayoutActive: true }).handled).toBe(false)
    expect(mocks.resolve).not.toHaveBeenCalled()
  })

  it('reports capture through the existing orca-first notification policy', () => {
    expect(run({ ...shortcutState(), terminalShortcutPolicy: 'orca-first' }).handled).toBe(true)
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({ actionId: 'worktree.jumpToLatestAttention' })
    )
  })
})
