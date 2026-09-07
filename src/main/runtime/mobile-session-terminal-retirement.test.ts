import { describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type {
  RuntimeMobileSessionTabsSnapshot,
  RuntimeMobileSessionTerminalTab
} from '../../shared/runtime-types'
import { retireTerminalSurfacesFromSnapshot } from './mobile-session-terminal-retirement'
import { retireTerminalSurfaceFromPersistence } from './mobile-session-terminal-persistence-retirement'

const WORKTREE_ID = 'repo::/worktree'

function splitSnapshot(): RuntimeMobileSessionTabsSnapshot {
  const parentLayout = {
    root: {
      type: 'split' as const,
      direction: 'vertical' as const,
      first: { type: 'leaf' as const, leafId: 'left' },
      second: { type: 'leaf' as const, leafId: 'right' }
    },
    activeLeafId: 'left',
    expandedLeafId: 'left',
    ptyIdsByLeafId: { left: 'pty-left', right: 'pty-right' },
    buffersByLeafId: { left: 'left buffer', right: 'right buffer' },
    titlesByLeafId: { left: 'Left', right: 'Right' }
  }
  return {
    worktree: WORKTREE_ID,
    publicationEpoch: 'host',
    snapshotVersion: 4,
    activeGroupId: 'terminals',
    activeTabId: 'terminal::left',
    activeTabType: 'terminal',
    tabGroups: [
      {
        id: 'terminals',
        activeTabId: 'terminal',
        tabOrder: ['terminal', 'notes'],
        recentTabIds: ['notes', 'terminal']
      },
      { id: 'secondary', activeTabId: 'other', tabOrder: ['other'] }
    ],
    tabGroupLayout: {
      type: 'split',
      direction: 'horizontal',
      first: { type: 'leaf', groupId: 'terminals' },
      second: { type: 'leaf', groupId: 'secondary' }
    },
    tabs: [
      {
        type: 'terminal',
        id: 'terminal::left',
        parentTabId: 'terminal',
        leafId: 'left',
        ptyId: 'pty-left',
        title: 'Left',
        parentLayout,
        isActive: true
      },
      {
        type: 'terminal',
        id: 'terminal::right',
        parentTabId: 'terminal',
        leafId: 'right',
        ptyId: 'pty-right',
        title: 'Right',
        parentLayout,
        isActive: false
      },
      {
        type: 'markdown',
        id: 'notes',
        title: 'Notes',
        filePath: '/worktree/notes.md',
        relativePath: 'notes.md',
        language: 'markdown',
        mode: 'edit',
        isDirty: false,
        sourceFileId: 'notes.md',
        sourceFilePath: '/worktree/notes.md',
        sourceRelativePath: 'notes.md',
        documentVersion: '1',
        isActive: false
      },
      {
        type: 'file',
        id: 'other',
        title: 'Other',
        filePath: '/worktree/other.ts',
        relativePath: 'other.ts',
        language: 'typescript',
        isDirty: false,
        isActive: false
      }
    ]
  }
}

describe('mobile session terminal retirement', () => {
  it('retires one split leaf and rewrites every surviving sibling layout', () => {
    const result = retireTerminalSurfacesFromSnapshot({
      snapshot: splitSnapshot(),
      ptyId: 'pty-left'
    })

    expect(result?.snapshot).toMatchObject({
      snapshotVersion: 5,
      activeGroupId: 'terminals',
      activeTabId: 'terminal::right',
      activeTabType: 'terminal'
    })
    expect(result?.snapshot.tabs).toHaveLength(3)
    expect(result?.snapshot.tabs[0]).toMatchObject({
      id: 'terminal::right',
      isActive: true,
      parentLayout: {
        root: { type: 'leaf', leafId: 'right' },
        activeLeafId: 'right',
        expandedLeafId: null,
        ptyIdsByLeafId: { right: 'pty-right' },
        buffersByLeafId: { right: 'right buffer' },
        titlesByLeafId: { right: 'Right' }
      }
    })
  })

  it('removes the final parent, empty group, and group-layout leaf', () => {
    const first = retireTerminalSurfacesFromSnapshot({
      snapshot: splitSnapshot(),
      ptyId: 'pty-left'
    })!
    const result = retireTerminalSurfacesFromSnapshot({
      snapshot: first.snapshot,
      ptyId: 'pty-right'
    })

    expect(result?.snapshot).toMatchObject({
      activeGroupId: 'terminals',
      activeTabId: 'notes',
      activeTabType: 'markdown',
      tabGroupLayout: {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', groupId: 'terminals' },
        second: { type: 'leaf', groupId: 'secondary' }
      }
    })
    expect(result?.snapshot.tabGroups?.[0]).toMatchObject({
      id: 'terminals',
      activeTabId: 'notes',
      tabOrder: ['notes']
    })
    expect(result?.snapshot.tabs.map((tab) => tab.id)).toEqual(['notes', 'other'])
  })

  it('does not retire an exact surface rebound to a replacement PTY', () => {
    const snapshot = splitSnapshot()
    const rebound = {
      ...snapshot,
      tabs: snapshot.tabs.map((tab) =>
        tab.type === 'terminal' && tab.leafId === 'left'
          ? {
              ...tab,
              ptyId: 'pty-replacement',
              parentLayout: tab.parentLayout
                ? {
                    ...tab.parentLayout,
                    ptyIdsByLeafId: {
                      ...tab.parentLayout.ptyIdsByLeafId,
                      left: 'pty-replacement'
                    }
                  }
                : undefined
            }
          : tab
      )
    }

    expect(
      retireTerminalSurfacesFromSnapshot({
        snapshot: rebound,
        ptyId: 'pty-left',
        exactSurfaces: [{ parentTabId: 'terminal', leafId: 'left' }]
      })
    ).toBeNull()
  })

  it('de-persists an exact leaf without removing its live sibling', () => {
    const session = {
      ...getDefaultWorkspaceSession(),
      activeTabId: 'terminal',
      activeTabIdByWorktree: { [WORKTREE_ID]: 'terminal' },
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
        terminal: (splitSnapshot().tabs[0] as RuntimeMobileSessionTerminalTab).parentLayout!
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
      activeLeafId: 'right',
      ptyIdsByLeafId: { right: 'pty-right' }
    })
  })

  it('retires a permanently exited surface despite a stale sleeping record', () => {
    const session = {
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
      sleepingAgentSessionsByPaneKey: {
        'terminal:left': {} as never
      }
    }

    const result = retireTerminalSurfaceFromPersistence(session, {
      worktreeId: WORKTREE_ID,
      parentTabId: 'terminal',
      leafId: 'left',
      ptyId: 'pty-left'
    })

    expect(result.tabsByWorktree[WORKTREE_ID]).toEqual([])
    expect(result.terminalLayoutsByTabId.terminal).toBeUndefined()
  })
})
