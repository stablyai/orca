import { describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import {
  applyCrossMachineRecoveryOp,
  type RecoveryWorkspaceFragment
} from '../../shared/cross-machine-recovery-session-ops'
import type { Tab } from '../../shared/tab-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
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

  it('rebases a host partition that no longer carries the closed web-terminal layout', () => {
    const tabId = 'web-terminal-24aa462c-589c-45fa-b332-6aa233cd84cf'
    const prior = {
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
      terminalLayoutsByTabId: {
        [tabId]: {
          root: { type: 'leaf' as const, leafId: 'worker' },
          activeLeafId: 'worker',
          expandedLeafId: null,
          ptyIdsByLeafId: { worker: 'pty-worker' }
        }
      },
      terminalTopologyRevisionByRepoId: { [REPO_ID]: 1 }
    }
    const incoming = {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: { [WORKTREE_ID]: [] }
    }
    const partialIncoming: Partial<typeof incoming> = incoming
    delete partialIncoming.terminalLayoutsByTabId

    const result = sanitizeWorkspaceSessionTerminalRetirements(incoming, prior)

    expect(result.tabsByWorktree[WORKTREE_ID]).toEqual(prior.tabsByWorktree[WORKTREE_ID])
    expect(result.terminalLayoutsByTabId[tabId]).toEqual(prior.terminalLayoutsByTabId[tabId])
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

const LANDING_ID = `${REPO_ID}::/landing`

function landingTab(id: string, contentType: Tab['contentType'], groupId: string): Tab {
  return {
    id,
    entityId: id,
    groupId,
    worktreeId: LANDING_ID,
    contentType,
    label: id,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

function landingFragment(): RecoveryWorkspaceFragment {
  return {
    worktreeId: LANDING_ID,
    terminalTabs: [
      {
        id: 'recovered',
        worktreeId: LANDING_ID,
        ptyId: null,
        title: 'claude',
        customTitle: null,
        color: null,
        sortOrder: 0,
        createdAt: 1
      }
    ],
    terminalLayoutsByTabId: {
      recovered: {
        root: {
          type: 'split',
          direction: 'vertical',
          first: { type: 'leaf', leafId: 'a' },
          second: { type: 'leaf', leafId: 'b' }
        },
        activeLeafId: 'a',
        expandedLeafId: null
      }
    },
    unifiedTabs: [
      landingTab('recovered', 'terminal', 'terminals'),
      landingTab('/landing/README.md', 'editor', 'files')
    ],
    tabGroups: [
      {
        id: 'terminals',
        worktreeId: LANDING_ID,
        activeTabId: 'recovered',
        tabOrder: ['recovered']
      },
      {
        id: 'files',
        worktreeId: LANDING_ID,
        activeTabId: '/landing/README.md',
        tabOrder: ['/landing/README.md']
      }
    ],
    tabGroupLayout: {
      type: 'split',
      direction: 'horizontal',
      first: { type: 'leaf', groupId: 'terminals' },
      second: { type: 'leaf', groupId: 'files' },
      ratio: 0.35
    },
    activeGroupId: 'terminals',
    openFiles: [],
    activeFileId: null,
    browserWorkspaces: [],
    browserPagesByWorkspace: {},
    activeBrowserTabId: null,
    activeTabType: 'terminal',
    activeTabId: 'recovered'
  }
}

function landImport(session: WorkspaceSessionState, importKey: string): WorkspaceSessionState {
  const { session: landed, outcome } = applyCrossMachineRecoveryOp(session, {
    kind: 'import',
    importKey,
    fragment: landingFragment(),
    records: []
  })
  expect(outcome).toEqual({ ok: true, claimed: null })
  return landed
}

describe('recovery import landing in a fenced repo', () => {
  const host: WorkspaceSessionState = {
    ...getDefaultWorkspaceSession(),
    terminalTopologyRevisionByRepoId: { [REPO_ID]: 3 }
  }

  function expectLandedLayout(session: WorkspaceSessionState): void {
    expect(session.tabsByWorktree[LANDING_ID]?.map((tab) => tab.id)).toEqual(['recovered'])
    expect(session.terminalLayoutsByTabId.recovered?.root).toMatchObject({ type: 'split' })
    expect(session.unifiedTabs?.[LANDING_ID]?.map((tab) => tab.id)).toEqual([
      'recovered',
      '/landing/README.md'
    ])
    expect(session.tabGroups?.[LANDING_ID]?.map((group) => group.tabOrder)).toEqual([
      ['recovered'],
      ['/landing/README.md']
    ])
    expect(session.tabGroupLayouts?.[LANDING_ID]).toMatchObject({ type: 'split', ratio: 0.35 })
  }

  it.each([
    ['the renderer, which never carries the host fence', getDefaultWorkspaceSession()],
    ['the headless runtime writer, which carries it', host]
  ])('keeps the imported terminal layout written by %s', (_writer, base) => {
    const incoming = landImport(base, 'import-1')

    expectLandedLayout(sanitizeWorkspaceSessionTerminalRetirements(incoming, host))
  })

  it('rebases a later stale write onto the landed membership', () => {
    const landed = sanitizeWorkspaceSessionTerminalRetirements(
      landImport(getDefaultWorkspaceSession(), 'import-1'),
      host
    )
    const stale = {
      ...landImport(getDefaultWorkspaceSession(), 'import-1'),
      tabsByWorktree: { [LANDING_ID]: [] }
    }

    expect(
      sanitizeWorkspaceSessionTerminalRetirements(stale, landed).tabsByWorktree[LANDING_ID]?.map(
        (tab) => tab.id
      )
    ).toEqual(['recovered'])
  })

  it('keeps host-admitted terminals when a landing races them', () => {
    const admitted = {
      ...host,
      tabsByWorktree: {
        [LANDING_ID]: [{ ...landingFragment().terminalTabs[0], id: 'host-admitted' }]
      }
    }

    expect(
      sanitizeWorkspaceSessionTerminalRetirements(
        landImport(getDefaultWorkspaceSession(), 'import-1'),
        admitted
      ).tabsByWorktree[LANDING_ID]?.map((tab) => tab.id)
    ).toEqual(['host-admitted'])
  })
})
