import { describe, expect, it } from 'vitest'
import { orcaPaneBinding, paneBindingMapKey } from './herdr-binding-metadata'
import {
  collectHerdrSurfaceActions,
  herdrLayoutToOrcaLayout,
  resolveHerdrPaneIdentities
} from './herdr-orca-surface-import'
import type { HerdrSessionSnapshot } from './herdr-runtime-contract'
import type { Project } from '../../../../shared/project-types'

const project: Project = {
  id: 'project-1',
  displayName: 'Project',
  badgeColor: '#000',
  sourceRepoIds: ['repo-1'],
  createdAt: 1,
  updatedAt: 1
}

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

const identities = new Map([['w1:p1', { worktreeId: 'wt-1', tabId: 'tab-1', leafId: 'leaf-1' }]])

describe('collectHerdrSurfaceActions', () => {
  it('emits nothing on the first snapshot', () => {
    expect(
      collectHerdrSurfaceActions(
        null,
        snapshot({ tabs: [{ tab_id: 'w1:t1', workspace_id: 'w1', label: 'logs' }] }),
        identities
      )
    ).toEqual([])
  })

  it('renames the Orca tab when the Herdr tab label changes', () => {
    const previous = snapshot({
      tabs: [{ tab_id: 'w1:t1', workspace_id: 'w1', label: 'old' }],
      panes: [{ pane_id: 'w1:p1', tab_id: 'w1:t1', workspace_id: 'w1' }]
    })
    const current = snapshot({
      tabs: [{ tab_id: 'w1:t1', workspace_id: 'w1', label: 'new' }],
      panes: [{ pane_id: 'w1:p1', tab_id: 'w1:t1', workspace_id: 'w1' }]
    })
    expect(collectHerdrSurfaceActions(previous, current, identities)).toEqual([
      { kind: 'rename', tabId: 'tab-1', title: 'new' }
    ])
  })

  it('closes the Orca tab when the Herdr tab disappears', () => {
    const previous = snapshot({
      tabs: [{ tab_id: 'w1:t1', workspace_id: 'w1', label: 'logs' }],
      panes: [{ pane_id: 'w1:p1', tab_id: 'w1:t1', workspace_id: 'w1' }]
    })
    expect(collectHerdrSurfaceActions(previous, snapshot(), identities)).toEqual([
      { kind: 'close', tabId: 'tab-1' }
    ])
  })

  it('focuses the Orca leaf when Herdr focus moves', () => {
    const previous = snapshot({
      panes: [{ pane_id: 'w1:p1', tab_id: 'w1:t1', workspace_id: 'w1', focused: false }],
      layouts: [
        {
          workspace_id: 'w1',
          tab_id: 'w1:t1',
          panes: [],
          focused_pane_id: 'w1:p2'
        }
      ]
    })
    const current = snapshot({
      panes: [{ pane_id: 'w1:p1', tab_id: 'w1:t1', workspace_id: 'w1', focused: true }],
      layouts: [
        {
          workspace_id: 'w1',
          tab_id: 'w1:t1',
          panes: [],
          focused_pane_id: 'w1:p1'
        }
      ]
    })
    expect(collectHerdrSurfaceActions(previous, current, identities)).toEqual([
      { kind: 'focus', tabId: 'tab-1', worktreeId: 'wt-1', leafId: 'leaf-1' }
    ])
  })
})

describe('herdrLayoutToOrcaLayout', () => {
  it('rebuilds a two-pane split from Herdr rects and ratio', () => {
    const two = new Map([
      ['w1:p1', { worktreeId: 'wt-1', tabId: 'tab-1', leafId: 'leaf-1' }],
      ['w1:p2', { worktreeId: 'wt-1', tabId: 'tab-1', leafId: 'leaf-2' }]
    ])
    const layout = herdrLayoutToOrcaLayout(
      {
        workspace_id: 'w1',
        tab_id: 'w1:t1',
        focused_pane_id: 'w1:p1',
        panes: [
          { pane_id: 'w1:p1', rect: { x: 0, y: 0, width: 40, height: 20 } },
          { pane_id: 'w1:p2', rect: { x: 40, y: 0, width: 40, height: 20 } }
        ],
        splits: [
          { id: 's1', direction: 'right', ratio: 0.4, rect: { x: 0, y: 0, width: 80, height: 20 } }
        ]
      },
      two
    )
    expect(layout).toEqual({
      root: {
        type: 'split',
        direction: 'vertical',
        ratio: 0.4,
        first: { type: 'leaf', leafId: 'leaf-1' },
        second: { type: 'leaf', leafId: 'leaf-2' }
      },
      activeLeafId: 'leaf-1',
      expandedLeafId: null
    })
  })
})

describe('resolveHerdrPaneIdentities', () => {
  it('maps bound Herdr pane ids back to Orca leaves', () => {
    const leafId = 'leaf-1'
    const binding = orcaPaneBinding(project.id, leafId)
    const paneMap = new Map([[paneBindingMapKey('orca', binding), 'w1:p1']])
    const resolved = resolveHerdrPaneIdentities(
      'orca',
      [
        {
          project,
          worktrees: [{ id: 'wt-1', path: '/repo', displayName: 'repo' }],
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
        }
      ],
      paneMap
    )
    expect(resolved.get('w1:p1')).toEqual({
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId
    })
  })
})
