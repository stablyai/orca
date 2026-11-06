import { expect, it } from 'vitest'
import {
  createGitGraphFrameProjection,
  projectGitGraphLayout,
  translateGitGraphLayoutCommand
} from './git-graph-layout-projection'
import type { PublishedWorkspaceLayout } from '../../../shared/workspace-layout/workspace-layout-published'
import {
  diffPublishedLayouts,
  indexPublishedLayout
} from '../../../shared/workspace-layout/workspace-layout-records'

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

it('hides graph tabs in snapshots and later record frames while preserving sequence', () => {
  const original = layout()
  const project = createGitGraphFrameProjection()
  expect(
    project({ type: 'snapshot', seq: 1, workspaces: [{ key: 'w', layout: original }] })
  ).toMatchObject({
    workspaces: [
      {
        layout: {
          groups: [
            { id: 'g1', tabIds: ['a', 'b'] },
            { id: 'g2', tabIds: ['c'] }
          ]
        }
      }
    ]
  })
  const after = {
    ...original,
    groups: [
      { id: 'g1', tabIds: ['graph'] },
      { id: 'g2', tabIds: ['a', 'b', 'c'] }
    ]
  }
  const change = diffPublishedLayouts(
    'w',
    indexPublishedLayout(original),
    indexPublishedLayout(after),
    after
  )!
  const frame = project({ type: 'records', epoch: 'e', seq: 2, workspaces: [change] })
  expect(frame).toMatchObject({
    type: 'records',
    epoch: 'e',
    seq: 2,
    workspaces: [
      {
        workspace: {
          groups: [{ id: 'g2', tabIds: ['a', 'b', 'c'] }],
          groupLayout: { type: 'leaf', groupId: 'g2' }
        }
      }
    ]
  })
  expect(projectGitGraphLayout(after).tabs.map((tab) => tab.id)).toEqual(['a', 'b', 'c'])
})

it('preserves hidden tab slots during reorders and translates collapsed split paths', () => {
  const original = layout()
  expect(
    translateGitGraphLayoutCommand(
      { type: 'moveTab', workspace: 'w', tabId: 'b', toGroupId: 'g1', index: 0 },
      original
    )
  ).toMatchObject({ index: 0 })
  expect(
    translateGitGraphLayoutCommand(
      {
        type: 'moveTab',
        workspace: 'w',
        tabId: 'b',
        toGroupId: 'g1',
        index: 1,
        afterTabId: 'gone'
      },
      original
    )
  ).toMatchObject({ index: 2 })
  const split: PublishedWorkspaceLayout = {
    ...original,
    groups: [
      { id: 'hidden', tabIds: ['graph'] },
      { id: 'g1', tabIds: ['a', 'b'] },
      { id: 'g2', tabIds: ['c'] }
    ],
    groupLayout: {
      type: 'split',
      direction: 'vertical',
      ratio: 0.2,
      first: { type: 'leaf', groupId: 'hidden' },
      second: original.groupLayout!
    }
  }
  expect(projectGitGraphLayout(split).groupLayout).toEqual(original.groupLayout)
  expect(
    translateGitGraphLayoutCommand(
      {
        type: 'setGroupRatios',
        workspace: 'w',
        ratios: [
          { path: '', ratio: 0.7, split: { direction: 'horizontal', first: 'g1', second: 'g2' } }
        ]
      },
      split
    )
  ).toEqual({
    type: 'setGroupRatios',
    workspace: 'w',
    groupLayout: undefined,
    ratios: [
      { path: 'second', ratio: 0.7, split: { direction: 'horizontal', first: 'g1', second: 'g2' } }
    ]
  })
  expect(split.groupLayout).toMatchObject({ ratio: 0.2 })
})
