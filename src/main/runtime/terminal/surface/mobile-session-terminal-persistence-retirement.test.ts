import { describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../../shared/constants'
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

  it('replays a legacy retirement when its host partition omits terminal layouts', () => {
    const tabId = 'web-terminal-24aa462c-589c-45fa-b332-6aa233cd84cf'
    const incoming = {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: {
        [WORKTREE_ID]: [
          {
            id: tabId,
            ptyId: 'pty-worker',
            worktreeId: WORKTREE_ID,
            title: 'Worker',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      terminalSurfaceTombstonesByPaneKey: {
        [`${tabId}:worker`]: {
          worktreeId: WORKTREE_ID,
          parentTabId: tabId,
          leafId: 'worker',
          ptyId: 'pty-worker',
          incarnationId: 'incarnation-worker',
          retiredAt: 42
        }
      }
    }
    const partialIncoming: Partial<typeof incoming> = incoming
    delete partialIncoming.terminalLayoutsByTabId

    const result = sanitizeWorkspaceSessionTerminalRetirements(incoming, undefined)

    expect(result.tabsByWorktree[WORKTREE_ID]).toEqual([])
    expect(result.terminalLayoutsByTabId).toEqual({})
    expect(result.terminalSurfaceTombstonesByPaneKey).toEqual({})
    expect(result.terminalTopologyRevisionByRepoId).toEqual({ [REPO_ID]: 1 })
  })
})
