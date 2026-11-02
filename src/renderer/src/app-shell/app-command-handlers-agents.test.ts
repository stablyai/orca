import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppShortcutState } from './app-command-handlers'
import { AI_VAULT_SCOPE_STEP_EVENT } from '@/components/right-sidebar/ai-vault-scope-state'

const mocks = vi.hoisted(() => ({ focusActiveTabSurface: vi.fn() }))

vi.mock('../store', () => ({
  useAppStore: Object.assign(vi.fn(), { getState: () => ({}) })
}))

vi.mock('@/lib/floating-workspace-terminal-actions', () => ({
  isFloatingWorkspacePanelFocused: () => false
}))

vi.mock('@/lib/terminal-shortcut-capture-notification', () => ({
  showTerminalShortcutCaptureNotification: vi.fn()
}))

vi.mock('@/lib/focus-active-tab-surface', () => ({
  focusActiveTabSurface: mocks.focusActiveTabSurface
}))

import { createAppCommandHandlers } from './app-command-handlers'

function shortcutState(activeView: AppShortcutState['activeView'] = 'terminal') {
  const actions = {
    toggleSidebar: vi.fn(),
    toggleRightSidebar: vi.fn(),
    setRightSidebarOpen: vi.fn(),
    setRightSidebarTab: vi.fn(),
    showRightSidebarFiles: vi.fn(),
    showRightSidebarSearch: vi.fn(),
    showAiVaultSearchKeepingScope: vi.fn(),
    openDiffNotesSendMenuForActiveWorktree: vi.fn()
  }
  const state: AppShortcutState = {
    activeView,
    activeWorktreeId: 'wt',
    actions,
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
  return { actions, state }
}

function focusInsideAgentsPanel(inside: boolean): void {
  vi.stubGlobal('document', { activeElement: { closest: () => (inside ? {} : null) } })
}

describe('agents shortcuts', () => {
  const steps: number[] = []
  const windowStub = new EventTarget()
  const record = (event: Event): void => {
    if (event instanceof CustomEvent) {
      steps.push(event.detail)
    }
  }
  beforeEach(() => {
    steps.length = 0
    mocks.focusActiveTabSurface.mockClear()
    vi.stubGlobal('window', windowStub)
    windowStub.addEventListener(AI_VAULT_SCOPE_STEP_EVENT, record)
    return () => {
      windowStub.removeEventListener(AI_VAULT_SCOPE_STEP_EVENT, record)
      vi.unstubAllGlobals()
    }
  })

  describe('sidebar.agents.toggle', () => {
    it('opens the Agents tab with session search focused', () => {
      const { actions, state } = shortcutState()
      focusInsideAgentsPanel(false)

      expect(createAppCommandHandlers(state).get('sidebar.agents.toggle')?.()).toBe(true)
      expect(actions.showAiVaultSearchKeepingScope).toHaveBeenCalledOnce()
      expect(actions.setRightSidebarOpen).not.toHaveBeenCalled()
    })

    it('closes the sidebar and returns focus to the tab when pressed inside the panel', () => {
      const { actions, state } = shortcutState()
      focusInsideAgentsPanel(true)

      expect(createAppCommandHandlers(state).get('sidebar.agents.toggle')?.()).toBe(true)
      expect(actions.setRightSidebarOpen).toHaveBeenCalledWith(false)
      expect(mocks.focusActiveTabSurface).toHaveBeenCalledOnce()
      expect(actions.showAiVaultSearchKeepingScope).not.toHaveBeenCalled()
    })

    it('does nothing where the right sidebar is suppressed', () => {
      const { actions, state } = shortcutState('settings')
      focusInsideAgentsPanel(false)

      expect(createAppCommandHandlers(state).get('sidebar.agents.toggle')?.()).toBe(false)
      expect(actions.showAiVaultSearchKeepingScope).not.toHaveBeenCalled()
    })
  })

  describe('scope shortcuts', () => {
    it('step the scope while focus is inside the Agents panel', () => {
      const { state } = shortcutState()
      focusInsideAgentsPanel(true)
      const handlers = createAppCommandHandlers(state)

      expect(handlers.get('sidebar.agents.scopeNext')?.()).toBe(true)
      expect(handlers.get('sidebar.agents.scopePrevious')?.()).toBe(true)
      expect(steps).toEqual([1, -1])
    })

    it('leave the chord to tab switching once focus is back on a tab', () => {
      const { state } = shortcutState()
      focusInsideAgentsPanel(false)

      expect(createAppCommandHandlers(state).get('sidebar.agents.scopeNext')?.()).toBe(false)
      expect(steps).toEqual([])
    })
  })
})
