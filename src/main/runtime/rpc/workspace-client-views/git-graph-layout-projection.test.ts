import { withoutGitGraph } from '../../../../shared/workspace-layout/client-views/workspace-layout-client-visibility'
import type { LayoutCommand } from '../../../../shared/workspace-layout/workspace-layout-command-types'
import type { WorkspaceLayoutModel } from '../../../../shared/workspace-layout/workspace-layout-model'
import { applyLayoutCommand } from '../../../../shared/workspace-layout/workspace-layout-commands'
import { expect, it } from 'vitest'
import './git-graph-layout-projection'
import type { PublishedWorkspaceLayout } from '../../../../shared/workspace-layout/published-layout/workspace-layout-published'
import '../../../../shared/workspace-layout/published-layout/workspace-layout-records'

function layout(): PublishedWorkspaceLayout {
  return {
    worktreeId: 'w',
    editorFiles: [],
    browserTabs: [],
    tabs: ['a', 'graph', 'b', 'c'].map((id) => ({
      id,
      entityId: id,
      kind: id === 'graph' ? 'git-graph' : 'editor',
      executionHostId: 'local',
      createdAt: 0,
      customTitle: null,
      color: null
    })),
    groups: [
      { id: 'g1', tabIds: ['a', 'graph', 'b'] },
      { id: 'g2', tabIds: ['c'] }
    ],
    groupLayout: {
      type: 'split',
      direction: 'horizontal',
      ratio: 0.3,
      first: { type: 'leaf', groupId: 'g1' },
      second: { type: 'leaf', groupId: 'g2' }
    }
  }
}

function canonical(original = layout()): WorkspaceLayoutModel {
  return {
    hostId: 'local',
    records: {},
    legacy: { terminalRowOwners: {} },
    workspaces: {
      w: {
        worktreeId: 'w',
        tabs: original.tabs.map(({ kind, ...tab }) => {
          if (kind === 'terminal') {
            throw new Error('Expected a content fixture')
          }
          return { ...tab, kind }
        }),
        groups: original.groups.map(({ id, tabIds }) => ({ id, tabOrder: tabIds })),
        groupLayout: original.groupLayout
      }
    }
  }
}

function applyClient(command: LayoutCommand, model = canonical()) {
  return applyLayoutCommand(model, command, {
    visibility: withoutGitGraph,
    mintId: () => 'minted',
    mintLeafId: () => 'leaf',
    now: () => 0
  })
}

it('translates split paths and identities together while retaining hidden branches', () => {
  const model = canonical()
  const workspace = model.workspaces.w!
  workspace.groups = [
    { id: 'hidden', tabOrder: ['graph'] },
    { id: 'g1', tabOrder: ['a', 'b'] },
    { id: 'g2', tabOrder: ['c'] }
  ]
  workspace.groupLayout = {
    type: 'split',
    direction: 'vertical',
    ratio: 0.2,
    first: { type: 'leaf', groupId: 'hidden' },
    second: workspace.groupLayout!
  }
  const resized = applyClient(
    {
      type: 'setGroupRatios',
      workspace: 'w',
      ratios: [
        { path: '', ratio: 0.7, split: { direction: 'horizontal', first: 'g1', second: 'g2' } }
      ]
    },
    model
  )
  expect(resized.ok && resized.model.workspaces.w!.groupLayout).toEqual({
    ...workspace.groupLayout,
    second: { ...layout().groupLayout, ratio: 0.7 }
  })
  workspace.groupLayout = {
    type: 'split',
    direction: 'horizontal',
    ratio: 0.3,
    first: {
      type: 'split',
      direction: 'vertical',
      ratio: 0.2,
      first: { type: 'leaf', groupId: 'hidden' },
      second: { type: 'leaf', groupId: 'g1' }
    },
    second: { type: 'leaf', groupId: 'g2' }
  }
  const identities = applyClient(
    {
      type: 'setGroupRatios',
      workspace: 'w',
      ratios: [
        { path: '', ratio: 0.7, split: { direction: 'horizontal', first: 'g1', second: 'g2' } }
      ]
    },
    model
  )
  expect(identities.ok && identities.model.workspaces.w!.groupLayout).toEqual({
    ...workspace.groupLayout,
    ratio: 0.7
  })
  expect(
    applyClient(
      {
        type: 'setGroupRatios',
        workspace: 'w',
        ratios: [
          { path: '', ratio: 0.7, split: { direction: 'vertical', first: 'stale', second: 'g2' } }
        ]
      },
      model
    )
  ).toEqual({ ok: false, code: 'group_set_changed' })
})
