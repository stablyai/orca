import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  TerminalLayoutSnapshot,
  TerminalTab
} from '../../../shared/workspace-layout/terminal-tab-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session/workspace-session-state-types'
import { normalizeWorkspaceSessionPaneIdentities } from './workspace-pane-normalization'

const { registerPaneKeyAliasMock } = vi.hoisted(() => ({
  registerPaneKeyAliasMock: vi.fn()
}))

vi.mock('../../agent-hooks/server/agent-hook-server', () => ({
  agentHookServer: {
    registerPaneKeyAlias: registerPaneKeyAliasMock
  }
}))

function terminalTab(id: string, worktreeId: string, ptyId: string | null): TerminalTab {
  return {
    id,
    worktreeId,
    ptyId,
    title: 'Terminal',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

function workspaceSession(
  tabsByWorktree: Record<string, TerminalTab[]>,
  terminalLayoutsByTabId: Record<string, TerminalLayoutSnapshot>
): WorkspaceSessionState {
  return {
    activeRepoId: null,
    activeWorktreeId: null,
    activeTabId: null,
    tabsByWorktree,
    terminalLayoutsByTabId
  }
}

function legacyLayout(): TerminalLayoutSnapshot {
  return {
    root: { type: 'leaf', leafId: 'pane:1' },
    activeLeafId: 'pane:1',
    expandedLeafId: null
  }
}

describe('workspace pane normalization tab index', () => {
  beforeEach(() => {
    registerPaneKeyAliasMock.mockReset()
  })

  it('keeps the first tab when duplicate ids occur across worktrees', () => {
    const result = normalizeWorkspaceSessionPaneIdentities(
      workspaceSession(
        {
          first: [terminalTab('duplicate-tab', 'first', 'first-pty')],
          second: [terminalTab('duplicate-tab', 'second', 'second-pty')]
        },
        { 'duplicate-tab': legacyLayout() }
      )
    )

    expect(result.legacyPaneKeyAliasEntries).not.toHaveLength(0)
    expect(result.legacyPaneKeyAliasEntries.every((entry) => entry.ptyId === 'first-pty')).toBe(
      true
    )
  })

  it('keeps missing tab ids without inventing persisted aliases', () => {
    const result = normalizeWorkspaceSessionPaneIdentities(
      workspaceSession({}, { 'missing-tab': legacyLayout() })
    )

    expect(result.legacyPaneKeyAliasEntries).toEqual([])
  })
})
