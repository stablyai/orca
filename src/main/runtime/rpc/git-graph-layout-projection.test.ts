import { withoutGitGraph } from '../../../shared/workspace-layout/client-views/workspace-layout-client-visibility'
import type { LayoutCommand } from '../../../shared/workspace-layout/workspace-layout-command-types'
import type { WorkspaceLayoutModel } from '../../../shared/workspace-layout/workspace-layout-model'
import { applyLayoutCommand } from '../../../shared/workspace-layout/workspace-layout-commands'
import { expect, it } from 'vitest'
import './git-graph-layout-projection'
import type { PublishedWorkspaceLayout } from '../../../shared/workspace-layout/published-layout/workspace-layout-published'
import '../../../shared/workspace-layout/published-layout/workspace-layout-records'

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

it('reopens at the visible index and accounts for preview replacement before placing', () => {
  const model = canonical()
  model.workspaces.w!.tabs.find((tab) => tab.id === 'a')!.isPreview = true
  const opened = applyClient(
    {
      type: 'openEditorTab',
      workspace: 'w',
      contentType: 'editor',
      fileId: '/new',
      tabId: 'new',
      preview: true,
      groupId: 'g1',
      index: 1
    },
    model
  )
  expect(opened.ok && opened.model.workspaces.w!.groups[0]!.tabOrder).toEqual(['graph', 'b', 'new'])
  model.workspaces.w!.tabs.find((tab) => tab.id === 'a')!.isPreview = false
  model.workspaces.w!.tabs.find((tab) => tab.id === 'graph')!.isPreview = true
  const hiddenPreview = applyClient(
    {
      type: 'openEditorTab',
      workspace: 'w',
      contentType: 'editor',
      fileId: '/new',
      tabId: 'new',
      preview: true,
      groupId: 'g1',
      index: 1
    },
    model
  )
  expect(hiddenPreview.ok && hiddenPreview.model.workspaces.w!.groups[0]!.tabOrder).toEqual([
    'a',
    'graph',
    'new',
    'b'
  ])
  const root = canonical()
  root.workspaces.w!.groups = [{ id: 'g1', tabOrder: ['graph', 'a', 'b', 'c'] }]
  root.workspaces.w!.groupLayout = { type: 'leaf', groupId: 'g1' }
  const closed = applyClient({ type: 'closeTabs', workspace: 'w', tabIds: ['b'] }, root)
  if (!closed.ok) {
    throw new Error(closed.code)
  }
  const reopened = applyClient(
    {
      type: 'openEditorTab',
      workspace: 'w',
      contentType: 'editor',
      fileId: 'b',
      tabId: 'b',
      groupId: 'g1',
      index: 1
    },
    closed.model
  )
  expect(reopened.ok && reopened.model.workspaces.w!.groups[0]!.tabOrder).toEqual([
    'graph',
    'a',
    'b',
    'c'
  ])
})

it.each([
  { index: 0, afterTabId: 'a', expected: ['a', 'graph', 'b'] },
  { index: 1, afterTabId: null, expected: ['b', 'a', 'graph'] },
  { index: 1, afterTabId: 'gone', expected: ['a', 'graph', 'b'] }
])('moves using anchor precedence: $afterTabId', ({ index, afterTabId, expected }) => {
  const moved = applyClient({
    type: 'moveTab',
    workspace: 'w',
    tabId: 'b',
    toGroupId: 'g1',
    index,
    afterTabId
  })
  expect(moved.ok && moved.model.workspaces.w!.groups[0]!.tabOrder).toEqual(expected)
})

it('gives creation indexes precedence over anchors and retains pin-aware omitted placement', () => {
  const model = canonical()
  model.workspaces.w!.tabs.find((tab) => tab.id === 'a')!.isPinned = true
  const command = {
    type: 'openSimulatorTab',
    workspace: 'w',
    tabId: 'new',
    groupId: 'g1',
    afterTabId: 'b'
  } as const
  const indexed = applyClient({ ...command, index: 0 }, model)
  expect(indexed.ok && indexed.model.workspaces.w!.groups[0]!.tabOrder).toEqual([
    'new',
    'a',
    'graph',
    'b'
  ])
  const omitted = applyClient({ ...command, afterTabId: 'a' }, model)
  expect(omitted.ok && omitted.model.workspaces.w!.groups[0]!.tabOrder).toEqual([
    'a',
    'graph',
    'new',
    'b'
  ])
})

it('uses visible groups for implicit opens and refuses stale split anchors', () => {
  const model = canonical()
  model.workspaces.w!.groups = [
    { id: 'hidden', tabOrder: ['graph'] },
    { id: 'g1', tabOrder: ['a', 'b', 'c'] }
  ]
  const implicit = applyClient(
    { type: 'openEditorTab', workspace: 'w', contentType: 'editor', fileId: '/new', tabId: 'new' },
    model
  )
  expect(implicit.ok && implicit.model.workspaces.w!.groups).toEqual([
    { id: 'hidden', tabOrder: ['graph'] },
    { id: 'g1', tabOrder: ['a', 'b', 'c', 'new'] }
  ])
  const defaults = applyClient(
    { type: 'applyDefaultTabs', workspace: 'w', tabs: [{ tabId: 'default', leafId: 'leaf' }] },
    model
  )
  expect(defaults.ok && defaults.model.workspaces.w!.groups).toEqual([
    { id: 'hidden', tabOrder: ['graph'] },
    { id: 'g1', tabOrder: ['a', 'b', 'c', 'default'] }
  ])
  expect(defaults.ok && defaults.effects).toEqual({
    stopPtyIds: [],
    startPaneKeys: ['default:leaf']
  })
  expect(
    applyClient(
      {
        type: 'openEditorTab',
        workspace: 'w',
        contentType: 'editor',
        fileId: '/new',
        tabId: 'new',
        groupId: 'proposed',
        split: { besideGroupId: 'stale', direction: 'right' }
      },
      model
    )
  ).toEqual({ ok: false, code: 'group_not_found' })
})

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

it('splits a lone visible tab without moving its hidden sibling and refuses splitting it off itself', () => {
  const model = canonical()
  model.workspaces.w!.groups = [
    { id: 'g1', tabOrder: ['a', 'graph'] },
    { id: 'g2', tabOrder: ['b', 'c'] }
  ]
  expect(
    applyClient(
      { type: 'splitGroup', workspace: 'w', tabId: 'a', besideGroupId: 'g1', direction: 'right' },
      model
    )
  ).toEqual({ ok: false, code: 'invalid_params' })
  const split = applyClient(
    { type: 'splitGroup', workspace: 'w', tabId: 'a', besideGroupId: 'g2', direction: 'right' },
    model
  )
  expect(split.ok && split.model.workspaces.w!.groups).toEqual([
    { id: 'g1', tabOrder: ['graph'] },
    { id: 'g2', tabOrder: ['b', 'c'] },
    { id: 'minted', tabOrder: ['a'] }
  ])
})

it('places a detached pane at a visible gap and leaves the hidden graph untouched', () => {
  const model = canonical()
  const workspace = model.workspaces.w!
  workspace.tabs = workspace.tabs.filter((tab) => tab.id !== 'c')
  workspace.tabs.push({
    id: 'c',
    entityId: 'c',
    kind: 'terminal',
    createdAt: 0,
    customTitle: null,
    color: null,
    terminal: { defaultTitle: 'Terminal 1' },
    panes: {
      root: {
        type: 'split',
        direction: 'vertical',
        first: { type: 'leaf', leafId: 'one' },
        second: { type: 'leaf', leafId: 'two' }
      }
    }
  })
  const detached = applyClient(
    {
      type: 'movePaneToNewTab',
      workspace: 'w',
      tabId: 'c',
      leafId: 'one',
      groupId: 'g1',
      index: 1
    },
    model
  )
  expect(detached.ok && detached.model.workspaces.w!.groups).toEqual([
    { id: 'g1', tabOrder: ['a', 'graph', 'minted', 'b'] },
    { id: 'g2', tabOrder: ['c'] }
  ])
  expect(detached.ok && detached.effects).toEqual({ stopPtyIds: [], startPaneKeys: [] })
  const implicit = applyClient(
    { type: 'movePaneToNewTab', workspace: 'w', tabId: 'c', leafId: 'one' },
    model
  )
  expect(implicit.ok && implicit.model.workspaces.w!.groups).toEqual([
    { id: 'g1', tabOrder: ['a', 'graph', 'b'] },
    { id: 'g2', tabOrder: ['c', 'minted'] }
  ])
})
