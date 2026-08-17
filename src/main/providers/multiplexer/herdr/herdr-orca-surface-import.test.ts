import { describe, expect, it } from 'vitest'
import type { Project } from '../../../../shared/project-types'
import { ORCA_BINDING_TOKEN, orcaPaneBinding, orcaWorkspaceBinding } from './herdr-binding-metadata'
import { collectUnboundHerdrSurfaces } from './herdr-orca-surface-import'
import type { HerdrSessionSnapshot } from './herdr-runtime-contract'

const project: Project = {
  id: 'project-1',
  displayName: 'Project',
  badgeColor: '#000',
  sourceRepoIds: ['repo-1'],
  createdAt: 1,
  updatedAt: 1
}

const worktree = { id: 'wt-1', path: '/repo', displayName: 'repo' }

function snapshot(overrides: Partial<HerdrSessionSnapshot> = {}): HerdrSessionSnapshot {
  return {
    version: '0.8.0',
    protocol: 19,
    workspaces: [],
    tabs: [],
    panes: [],
    layouts: [],
    agents: [],
    ...overrides
  }
}

describe('collectUnboundHerdrSurfaces', () => {
  it('imports a Herdr-created tab as a new Orca tab', () => {
    const workspaceBinding = orcaWorkspaceBinding(project.id, worktree)
    const surfaces = collectUnboundHerdrSurfaces(
      'orca',
      {
        project,
        worktrees: [worktree],
        tabsByWorktreeId: { 'wt-1': [] },
        layoutsByTabId: {}
      },
      snapshot({
        workspaces: [
          { workspace_id: 'w1', label: 'repo', tokens: { [ORCA_BINDING_TOKEN]: workspaceBinding } }
        ],
        tabs: [{ tab_id: 'w1:t2', workspace_id: 'w1', label: 'logs' }],
        panes: [{ pane_id: 'w1:p9', tab_id: 'w1:t2', workspace_id: 'w1', cwd: '/repo' }]
      }),
      new Map()
    )

    expect(surfaces).toHaveLength(1)
    expect(surfaces[0]).toMatchObject({
      worktreeId: 'wt-1',
      paneId: 'w1:p9',
      title: 'logs',
      cwd: '/repo'
    })
    expect(surfaces[0].splitFromLeafId).toBeUndefined()
    expect(surfaces[0].ptyId.startsWith('herdr:')).toBe(true)
  })

  it('imports a Herdr-created tab even when its pane still has a stale binding', () => {
    const workspaceBinding = orcaWorkspaceBinding(project.id, worktree)
    const staleBinding = orcaPaneBinding(project.id, 'gone-leaf')
    const surfaces = collectUnboundHerdrSurfaces(
      'orca',
      {
        project,
        worktrees: [worktree],
        tabsByWorktreeId: { 'wt-1': [] },
        layoutsByTabId: {}
      },
      snapshot({
        workspaces: [
          { workspace_id: 'w1', label: 'repo', tokens: { [ORCA_BINDING_TOKEN]: workspaceBinding } }
        ],
        tabs: [{ tab_id: 'w1:t2', workspace_id: 'w1', label: 'logs' }],
        panes: [
          {
            pane_id: 'w1:p9',
            tab_id: 'w1:t2',
            workspace_id: 'w1',
            tokens: { [ORCA_BINDING_TOKEN]: staleBinding }
          }
        ]
      }),
      new Map()
    )

    expect(surfaces).toHaveLength(1)
    expect(surfaces[0]).toMatchObject({
      worktreeId: 'wt-1',
      paneId: 'w1:p9',
      title: 'logs'
    })
  })

  it('imports an unbound sibling pane as a split on the bound Orca tab', () => {
    const workspaceBinding = orcaWorkspaceBinding(project.id, worktree)
    const leafId = 'leaf-1'
    const paneBinding = orcaPaneBinding(project.id, leafId)
    const paneMap = new Map([[`orca:${paneBinding}`, 'w1:p1']])
    const surfaces = collectUnboundHerdrSurfaces(
      'orca',
      {
        project,
        worktrees: [worktree],
        tabsByWorktreeId: {
          'wt-1': [
            {
              id: 'tab-1',
              ptyId: null,
              worktreeId: 'wt-1',
              title: 'Terminal',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            }
          ]
        },
        layoutsByTabId: {
          'tab-1': {
            root: { type: 'leaf', leafId },
            activeLeafId: leafId,
            expandedLeafId: null
          }
        }
      },
      snapshot({
        workspaces: [
          { workspace_id: 'w1', label: 'repo', tokens: { [ORCA_BINDING_TOKEN]: workspaceBinding } }
        ],
        tabs: [{ tab_id: 'w1:t1', workspace_id: 'w1', label: 'Terminal' }],
        panes: [
          {
            pane_id: 'w1:p1',
            tab_id: 'w1:t1',
            workspace_id: 'w1',
            tokens: { [ORCA_BINDING_TOKEN]: paneBinding }
          },
          { pane_id: 'w1:p2', tab_id: 'w1:t1', workspace_id: 'w1' }
        ]
      }),
      paneMap
    )

    expect(surfaces).toHaveLength(1)
    expect(surfaces[0]).toMatchObject({
      tabId: 'tab-1',
      paneId: 'w1:p2',
      splitFromLeafId: leafId,
      splitDirection: 'vertical'
    })
  })
})
