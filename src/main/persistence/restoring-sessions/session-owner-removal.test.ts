import { describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import type { WorkspaceSessionState } from '../../../shared/workspace-session/workspace-session-state-types'
import { removeWorkspaceSessionOwners } from './session-owner-removal'

const GONE = 'repo-1::/workspaces/gone'
const KEPT = 'repo-1::/workspaces/kept'

type Workspace = { id: string; name: string }

const entries = <T>(workspaces: Workspace[], entry: (workspace: Workspace) => [string, T][]) =>
  Object.fromEntries(workspaces.flatMap(entry))

/** Every per-workspace field a workspace can own, keyed by owner, tab or pane. */
function sessionFor(...workspaces: Workspace[]): WorkspaceSessionState {
  // Why a unified-only terminal: its legacy row can be gone while its layout and scrollback remain.
  const terminal = ({ name }: Workspace) => `${name}-terminal`
  const unifiedTerminal = ({ name }: Workspace) => `${name}-unified-terminal`
  const filePath = ({ name }: Workspace) => `/workspaces/${name}/README.md`
  const emptyLayout = { root: null, activeLeafId: null, expandedLeafId: null }
  return {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: entries(workspaces, (w) => [
      [
        w.id,
        [
          {
            id: terminal(w),
            ptyId: null,
            worktreeId: w.id,
            title: 'Terminal 1',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      ]
    ]),
    unifiedTabs: entries(workspaces, (w) => [
      [
        w.id,
        [
          {
            id: unifiedTerminal(w),
            entityId: unifiedTerminal(w),
            groupId: `${w.name}-group`,
            worktreeId: w.id,
            contentType: 'terminal',
            label: 'Terminal 2',
            customLabel: null,
            color: null,
            sortOrder: 1,
            createdAt: 1
          }
        ]
      ]
    ]),
    tabGroups: entries(workspaces, (w) => [
      [
        w.id,
        [
          {
            id: `${w.name}-group`,
            worktreeId: w.id,
            activeTabId: unifiedTerminal(w),
            tabOrder: [unifiedTerminal(w)]
          }
        ]
      ]
    ]),
    tabGroupLayouts: entries(workspaces, (w) => [
      [w.id, { type: 'leaf', groupId: `${w.name}-group` }]
    ]),
    activeGroupIdByWorktree: entries(workspaces, (w) => [[w.id, `${w.name}-group`]]),
    activeTabIdByWorktree: entries(workspaces, (w) => [[w.id, terminal(w)]]),
    activeTabTypeByWorktree: entries(workspaces, (w) => [[w.id, 'terminal']]),
    terminalLayoutsByTabId: entries(workspaces, (w) => [
      [terminal(w), emptyLayout],
      [unifiedTerminal(w), emptyLayout]
    ]),
    localOnlyScrollbackByTabId: entries(workspaces, (w) => [
      [unifiedTerminal(w), { leaf: 'scrollback' }]
    ]),
    remoteSessionIdsByTabId: entries(workspaces, (w) => [[terminal(w), `${w.name}-relay`]]),
    terminalPtyIncarnationsByPaneKey: entries(workspaces, (w) => [
      [`${unifiedTerminal(w)}:leaf`, `${w.name}-incarnation`]
    ]),
    openFilesByWorktree: entries(workspaces, (w) => [
      [
        w.id,
        [
          {
            filePath: filePath(w),
            relativePath: 'README.md',
            worktreeId: w.id,
            language: 'markdown'
          }
        ]
      ]
    ]),
    activeFileIdByWorktree: entries(workspaces, (w) => [[w.id, filePath(w)]]),
    markdownFrontmatterVisible: entries(workspaces, (w) => [[filePath(w), false]]),
    defaultTerminalTabsAppliedByWorktreeId: entries(workspaces, (w) => [[w.id, true]]),
    lastVisitedAtByWorktreeId: entries(workspaces, (w) => [[w.id, 1]]),
    closedTerminalTabTombstonesByTabId: entries(workspaces, (w) => [
      [`${w.name}-closed`, { closedAt: 1, worktreeId: w.id }]
    ]),
    activeWorktreeIdsOnShutdown: workspaces.map((w) => w.id)
  }
}

describe('removeWorkspaceSessionOwners', () => {
  it('drops every owner-, tab- and pane-keyed entry of a removed workspace and keeps its sibling', () => {
    const gone = { id: GONE, name: 'gone' }
    const kept = { id: KEPT, name: 'kept' }

    const next = removeWorkspaceSessionOwners(sessionFor(gone, kept), new Set([GONE]))

    expect(next).toEqual(sessionFor(kept))
  })
})
