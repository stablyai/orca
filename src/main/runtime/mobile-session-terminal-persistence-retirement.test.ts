import { describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import {
  retireTerminalSurfaceFromPersistence,
  sanitizeWorkspaceSessionTerminalRetirements
} from './mobile-session-terminal-persistence-retirement'

const WORKTREE_ID = 'repo::/worktree'
const REPO_ID = 'repo'

describe('mobile session terminal persistence retirement', () => {
  it('de-persists a final leaf and repairs active group state', () => {
    const session = {
      ...getDefaultWorkspaceSession(),
      activeTabId: 'terminal',
      activeTabIdByWorktree: { [WORKTREE_ID]: 'terminal' },
      activeTabTypeByWorktree: { [WORKTREE_ID]: 'terminal' as const },
      activeGroupIdByWorktree: { [WORKTREE_ID]: 'terminal-group' },
      tabsByWorktree: {
        [WORKTREE_ID]: [
          {
            id: 'terminal',
            ptyId: 'pty-left',
            worktreeId: WORKTREE_ID,
            title: 'Terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      terminalLayoutsByTabId: {
        terminal: {
          root: { type: 'leaf' as const, leafId: 'left' },
          activeLeafId: 'left',
          expandedLeafId: null,
          ptyIdsByLeafId: { left: 'pty-left' }
        }
      },
      unifiedTabs: {
        [WORKTREE_ID]: [
          {
            id: 'terminal',
            entityId: 'terminal',
            groupId: 'terminal-group',
            worktreeId: WORKTREE_ID,
            contentType: 'terminal' as const,
            label: 'Terminal',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          },
          {
            id: 'notes',
            entityId: 'notes.md',
            groupId: 'notes-group',
            worktreeId: WORKTREE_ID,
            contentType: 'editor' as const,
            label: 'Notes',
            customLabel: null,
            color: null,
            sortOrder: 1,
            createdAt: 2
          }
        ]
      },
      tabGroups: {
        [WORKTREE_ID]: [
          {
            id: 'terminal-group',
            worktreeId: WORKTREE_ID,
            activeTabId: 'terminal',
            tabOrder: ['terminal']
          },
          {
            id: 'notes-group',
            worktreeId: WORKTREE_ID,
            activeTabId: 'notes',
            tabOrder: ['notes']
          }
        ]
      },
      tabGroupLayouts: {
        [WORKTREE_ID]: {
          type: 'split' as const,
          direction: 'horizontal' as const,
          first: { type: 'leaf' as const, groupId: 'terminal-group' },
          second: { type: 'leaf' as const, groupId: 'notes-group' }
        }
      },
      remoteSessionIdsByTabId: { terminal: 'pty-left' }
    }

    const result = retireTerminalSurfaceFromPersistence(session, {
      worktreeId: WORKTREE_ID,
      parentTabId: 'terminal',
      leafId: 'left',
      ptyId: 'pty-left'
    })

    expect(result.tabsByWorktree[WORKTREE_ID]).toEqual([])
    expect(result.terminalLayoutsByTabId.terminal).toBeUndefined()
    expect(result.unifiedTabs?.[WORKTREE_ID].map((tab) => tab.id)).toEqual(['notes'])
    expect(result.tabGroups?.[WORKTREE_ID].map((group) => group.id)).toEqual(['notes-group'])
    expect(result.tabGroupLayouts?.[WORKTREE_ID]).toEqual({
      type: 'leaf',
      groupId: 'notes-group'
    })
    expect(result.activeTabIdByWorktree?.[WORKTREE_ID]).toBe('notes')
    expect(result.activeTabTypeByWorktree?.[WORKTREE_ID]).toBe('editor')
    expect(result.activeGroupIdByWorktree?.[WORKTREE_ID]).toBe('notes-group')
    expect(result.remoteSessionIdsByTabId?.terminal).toBeUndefined()
  })

  it('retires an exact split leaf when only its sibling has a persisted PTY mapping', () => {
    const session = {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: {
        [WORKTREE_ID]: [
          {
            id: 'terminal',
            ptyId: 'pty-right',
            worktreeId: WORKTREE_ID,
            title: 'Terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      terminalLayoutsByTabId: {
        terminal: {
          root: {
            type: 'split' as const,
            direction: 'vertical' as const,
            first: { type: 'leaf' as const, leafId: 'left' },
            second: { type: 'leaf' as const, leafId: 'right' }
          },
          activeLeafId: 'left',
          expandedLeafId: null,
          ptyIdsByLeafId: { right: 'pty-right' }
        }
      }
    }

    const result = retireTerminalSurfaceFromPersistence(session, {
      worktreeId: WORKTREE_ID,
      parentTabId: 'terminal',
      leafId: 'left',
      ptyId: 'pty-left'
    })

    expect(result.tabsByWorktree[WORKTREE_ID]).toEqual([
      expect.objectContaining({ id: 'terminal', ptyId: 'pty-right' })
    ])
    expect(result.terminalLayoutsByTabId.terminal).toMatchObject({
      root: { type: 'leaf', leafId: 'right' },
      ptyIdsByLeafId: { right: 'pty-right' }
    })
  })

  it('fences an absent exact leaf without deleting its live sibling parent', () => {
    const session = {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: {
        [WORKTREE_ID]: [
          {
            id: 'terminal',
            ptyId: 'pty-right',
            worktreeId: WORKTREE_ID,
            title: 'Terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      terminalLayoutsByTabId: {
        terminal: {
          root: { type: 'leaf' as const, leafId: 'right' },
          activeLeafId: 'right',
          expandedLeafId: null,
          ptyIdsByLeafId: { right: 'pty-right' }
        }
      },
      terminalPtyIncarnationsByPaneKey: { 'terminal:left': 'incarnation-left' },
      remoteSessionIdsByTabId: { terminal: 'pty-right' }
    }

    const result = retireTerminalSurfaceFromPersistence(session, {
      worktreeId: WORKTREE_ID,
      parentTabId: 'terminal',
      leafId: 'left',
      ptyId: 'pty-left',
      incarnationId: 'incarnation-left',
      retiredAt: 42
    })

    expect(result.tabsByWorktree[WORKTREE_ID]).toEqual(session.tabsByWorktree[WORKTREE_ID])
    expect(result.terminalLayoutsByTabId.terminal).toEqual(session.terminalLayoutsByTabId.terminal)
    expect(result.remoteSessionIdsByTabId).toEqual({ terminal: 'pty-right' })
    expect(result.terminalPtyIncarnationsByPaneKey?.['terminal:left']).toBeUndefined()
    expect(result.terminalSurfaceTombstonesByPaneKey).toEqual({})
    expect(result.terminalTopologyRevisionByRepoId?.[REPO_ID]).toBe(1)
  })

  it('does not treat a sibling parent PTY as the exact leaf when layout is unavailable', () => {
    const session = {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: {
        [WORKTREE_ID]: [
          {
            id: 'terminal',
            ptyId: 'pty-right',
            worktreeId: WORKTREE_ID,
            title: 'Terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      }
    }

    const result = retireTerminalSurfaceFromPersistence(session, {
      worktreeId: WORKTREE_ID,
      parentTabId: 'terminal',
      leafId: 'left',
      ptyId: 'pty-left',
      incarnationId: 'incarnation-left'
    })

    expect(result.tabsByWorktree[WORKTREE_ID]).toEqual(session.tabsByWorktree[WORKTREE_ID])
    expect(result.terminalSurfaceTombstonesByPaneKey).toEqual({})
    expect(result.terminalTopologyRevisionByRepoId?.[REPO_ID]).toBe(1)
  })

  it('rebases stale writes onto durable host membership without retaining pane history', () => {
    const staleSession = {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: {
        [WORKTREE_ID]: [
          {
            id: 'terminal',
            ptyId: 'pty-left',
            worktreeId: WORKTREE_ID,
            title: 'Terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      terminalLayoutsByTabId: {
        terminal: {
          root: { type: 'leaf' as const, leafId: 'left' },
          activeLeafId: 'left',
          expandedLeafId: null,
          ptyIdsByLeafId: { left: 'pty-left' }
        }
      },
      terminalPtyIncarnationsByPaneKey: { 'terminal:left': 'incarnation-a' }
    }
    const retired = retireTerminalSurfaceFromPersistence(staleSession, {
      worktreeId: WORKTREE_ID,
      parentTabId: 'terminal',
      leafId: 'left',
      ptyId: 'pty-left',
      incarnationId: 'incarnation-a',
      retiredAt: 42
    })

    const afterStaleWrite = sanitizeWorkspaceSessionTerminalRetirements(staleSession, retired)
    expect(afterStaleWrite.tabsByWorktree[WORKTREE_ID]).toEqual([])
    expect(afterStaleWrite.terminalSurfaceTombstonesByPaneKey).toEqual({})
    expect(afterStaleWrite.terminalTopologyRevisionByRepoId?.[REPO_ID]).toBe(1)

    const afterRestart = sanitizeWorkspaceSessionTerminalRetirements(staleSession, afterStaleWrite)
    expect(afterRestart.tabsByWorktree[WORKTREE_ID]).toEqual([])

    const untrustedReplacement = sanitizeWorkspaceSessionTerminalRetirements(
      {
        ...staleSession,
        terminalPtyIncarnationsByPaneKey: { 'terminal:left': 'incarnation-b' }
      },
      afterRestart
    )
    expect(untrustedReplacement.tabsByWorktree[WORKTREE_ID]).toEqual([])
    expect(untrustedReplacement.terminalPtyIncarnationsByPaneKey).toBeUndefined()
  })

  it('migrates legacy tombstones into one repo watermark', () => {
    const stale = {
      ...getDefaultWorkspaceSession(),
      terminalSurfaceTombstonesByPaneKey: {
        'terminal:left': {
          worktreeId: WORKTREE_ID,
          parentTabId: 'terminal',
          leafId: 'left',
          ptyId: 'pty-left',
          incarnationId: 'incarnation-a',
          retiredAt: 42
        }
      }
    }

    const migrated = sanitizeWorkspaceSessionTerminalRetirements(stale, stale)

    expect(migrated.terminalSurfaceTombstonesByPaneKey).toEqual({})
    expect(migrated.terminalTopologyRevisionByRepoId).toEqual({ [REPO_ID]: 1 })
  })

  it('keeps retirement state proportional to repos across many worktrees and closed panes', () => {
    let session = getDefaultWorkspaceSession()
    for (let index = 0; index < 1_000; index += 1) {
      session = retireTerminalSurfaceFromPersistence(session, {
        worktreeId: `${REPO_ID}::/worktree-${index}`,
        parentTabId: `terminal-${index}`,
        leafId: `leaf-${index}`,
        ptyId: `pty-${index}`,
        incarnationId: `incarnation-${index}`
      })
    }

    expect(session.terminalSurfaceTombstonesByPaneKey).toEqual({})
    expect(Object.keys(session.terminalTopologyRevisionByRepoId ?? {})).toEqual([REPO_ID])
    expect(session.terminalTopologyRevisionByRepoId?.[REPO_ID]).toBe(1_000)
  })
})
