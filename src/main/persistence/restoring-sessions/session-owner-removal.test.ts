import { describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import type { WorkspaceSessionState } from '../../../shared/workspace-session/workspace-session-state-types'
import { removeWorkspaceSessionOwners } from './session-owner-removal'

const GONE = 'repo-1::/workspaces/gone'
const KEPT = 'repo-1::/workspaces/kept'

/** Every per-workspace field one workspace can own, keyed by owner, tab or pane. */
function workspaceState(worktreeId: string, name: string): Partial<WorkspaceSessionState> {
  const terminalTabId = `${name}-terminal`
  // Why a unified-only terminal: its legacy row can be gone while its layout and scrollback remain.
  const unifiedOnlyTerminalId = `${name}-unified-terminal`
  const filePath = `/workspaces/${name}/README.md`
  return {
    tabsByWorktree: {
      [worktreeId]: [
        {
          id: terminalTabId,
          ptyId: null,
          worktreeId,
          title: 'Terminal 1',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    unifiedTabs: {
      [worktreeId]: [
        {
          id: unifiedOnlyTerminalId,
          entityId: unifiedOnlyTerminalId,
          groupId: `${name}-group`,
          worktreeId,
          contentType: 'terminal',
          label: 'Terminal 2',
          customLabel: null,
          color: null,
          sortOrder: 1,
          createdAt: 1
        }
      ]
    },
    tabGroups: {
      [worktreeId]: [
        {
          id: `${name}-group`,
          worktreeId,
          activeTabId: unifiedOnlyTerminalId,
          tabOrder: [unifiedOnlyTerminalId]
        }
      ]
    },
    tabGroupLayouts: { [worktreeId]: { type: 'leaf', groupId: `${name}-group` } },
    activeGroupIdByWorktree: { [worktreeId]: `${name}-group` },
    activeTabIdByWorktree: { [worktreeId]: terminalTabId },
    activeTabTypeByWorktree: { [worktreeId]: 'terminal' },
    terminalLayoutsByTabId: {
      [terminalTabId]: { root: null, activeLeafId: null, expandedLeafId: null },
      [unifiedOnlyTerminalId]: { root: null, activeLeafId: null, expandedLeafId: null }
    },
    localOnlyScrollbackByTabId: { [unifiedOnlyTerminalId]: { leaf: 'scrollback' } },
    remoteSessionIdsByTabId: { [terminalTabId]: `${name}-relay` },
    terminalPtyIncarnationsByPaneKey: { [`${unifiedOnlyTerminalId}:leaf`]: `${name}-incarnation` },
    openFilesByWorktree: {
      [worktreeId]: [{ filePath, relativePath: 'README.md', worktreeId, language: 'markdown' }]
    },
    activeFileIdByWorktree: { [worktreeId]: filePath },
    markdownFrontmatterVisible: { [filePath]: false },
    defaultTerminalTabsAppliedByWorktreeId: { [worktreeId]: true },
    lastVisitedAtByWorktreeId: { [worktreeId]: 1 },
    closedTerminalTabTombstonesByTabId: { [`${name}-closed`]: { closedAt: 1, worktreeId } },
    activeWorktreeIdsOnShutdown: [worktreeId]
  }
}

function sessionWith(...parts: Partial<WorkspaceSessionState>[]): WorkspaceSessionState {
  const session: Record<string, unknown> = { ...getDefaultWorkspaceSession() }
  for (const part of parts) {
    for (const [field, value] of Object.entries(part)) {
      const current = session[field]
      session[field] = Array.isArray(value)
        ? [...((current as unknown[]) ?? []), ...value]
        : { ...(current as object), ...(value as object) }
    }
  }
  return session as WorkspaceSessionState
}

describe('removeWorkspaceSessionOwners', () => {
  it('drops every owner-, tab- and pane-keyed entry of a removed workspace and keeps its sibling', () => {
    const session = sessionWith(workspaceState(GONE, 'gone'), workspaceState(KEPT, 'kept'))

    const next = removeWorkspaceSessionOwners(session, new Set([GONE]))

    expect(next).toEqual(sessionWith(workspaceState(KEPT, 'kept')))
  })
})
