import { publishWorkspaceLayout } from '../../../shared/workspace-layout/workspace-layout-published'
import { withoutGitGraph } from '../../../shared/workspace-layout/workspace-layout-client-visibility'
import type {
  CommandOf,
  LayoutCommand
} from '../../../shared/workspace-layout/workspace-layout-command-types'
import type { WorkspaceLayoutModel } from '../../../shared/workspace-layout/workspace-layout-model'
import { applyLayoutCommand } from '../../../shared/workspace-layout/workspace-layout-commands'
import { expect, it } from 'vitest'
import { createGitGraphFrameProjection, projectGitGraphLayout } from './git-graph-layout-projection'
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

it('passes graph-free record deltas through unchanged and preserves existing empty groups', () => {
  const original = layout()
  const graphFree = { ...original, tabs: original.tabs.filter((tab) => tab.kind !== 'git-graph') }
  const project = createGitGraphFrameProjection()
  project({ type: 'workspace', key: 'w', seq: 1, layout: graphFree })
  const change = {
    key: 'w',
    change: 'records' as const,
    workspace: { ...graphFree, groups: [{ id: 'g1', tabIds: ['a', 'b', 'c'] }] }
  }
  const frame = project({ type: 'records', epoch: 'e', seq: 2, workspaces: [change] })
  expect(frame.type === 'records' && frame.workspaces[0]).toBe(change)
  original.groups.push({ id: 'empty', tabIds: [] })
  expect(projectGitGraphLayout(original).groups).toContainEqual({ id: 'empty', tabIds: [] })
})

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

const opens: CommandOf<
  | 'openEditorTab'
  | 'createTerminalTab'
  | 'openSimulatorTab'
  | 'openBrowserTab'
  | 'openAgentSessionTab'
>[] = [
  {
    type: 'openEditorTab',
    workspace: 'w',
    contentType: 'editor',
    fileId: '/new',
    tabId: 'new',
    index: 1
  },
  { type: 'createTerminalTab', workspace: 'w', tabId: 'new', leafId: 'leaf', index: 1 },
  { type: 'openSimulatorTab', workspace: 'w', tabId: 'new', index: 1 },
  { type: 'openBrowserTab', workspace: 'w', tabId: 'new', index: 1 },
  {
    type: 'openAgentSessionTab',
    workspace: 'w',
    tabId: 'new',
    sessionId: 'session',
    agent: 'codex',
    index: 1
  }
]

it.each(opens)(
  '$type resolves a visible creation gap without moving the hidden graph',
  (command) => {
    const opened = applyClient({ ...command, groupId: 'g1' })
    expect(opened.ok).toBe(true)
    if (!opened.ok) {
      throw new Error(opened.code)
    }
    expect(opened.model.workspaces.w!.groups).toEqual([
      { id: 'g1', tabOrder: ['a', 'graph', 'new', 'b'] },
      { id: 'g2', tabOrder: ['c'] }
    ])
    expect(
      projectGitGraphLayout(publishWorkspaceLayout(opened.model.workspaces.w!, 'local')).groups
    ).toEqual([
      { id: 'g1', tabIds: ['a', 'new', 'b'] },
      { id: 'g2', tabIds: ['c'] }
    ])
    expect(opened.effects).toEqual({
      stopPtyIds: [],
      startPaneKeys: command.type === 'createTerminalTab' ? ['new:leaf'] : []
    })
    expect(opened.model.workspaces.w!.tabs.find((tab) => tab.id === 'graph')).toMatchObject({
      kind: 'git-graph'
    })
  }
)

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

it.each([undefined, 'older-root', 'g2'])(
  'opens in a projected-empty workspace, requested group %s',
  (groupId) => {
    const model = canonical()
    model.workspaces.w!.tabs = model.workspaces.w!.tabs.filter((tab) => tab.id === 'graph')
    model.workspaces.w!.groups = [{ id: 'g2', tabOrder: ['graph'] }]
    model.workspaces.w!.groupLayout = { type: 'leaf', groupId: 'g2' }
    const opened = applyClient(
      {
        type: 'openEditorTab',
        workspace: 'w',
        contentType: 'editor',
        fileId: '/file',
        tabId: 'file',
        groupId
      },
      model
    )
    expect(opened.ok && opened.model.workspaces.w!.groups).toEqual([
      { id: 'g2', tabOrder: ['graph', 'file'] }
    ])
    const split = applyClient(
      {
        type: 'openEditorTab',
        workspace: 'w',
        contentType: 'editor',
        fileId: '/file',
        tabId: 'file',
        groupId: 'new-group',
        split: { besideGroupId: 'older-root', direction: 'right' }
      },
      model
    )
    expect(split.ok && split.model.workspaces.w!.groups).toEqual([
      { id: 'g2', tabOrder: ['graph'] },
      { id: 'new-group', tabOrder: ['file'] }
    ])
  }
)

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

it('keeps identity commands addressed by stable tab ids', () => {
  const renamed = applyClient({
    type: 'renameTab',
    workspace: 'w',
    tabId: 'b',
    kind: 'custom',
    title: 'Renamed'
  })
  expect(
    renamed.ok && renamed.model.workspaces.w!.tabs.find((tab) => tab.id === 'b')?.customTitle
  ).toBe('Renamed')
  const closed = applyClient({ type: 'closeTabs', workspace: 'w', tabIds: ['a', 'b'] })
  expect(closed.ok && closed.model.workspaces.w!.groups).toEqual([
    { id: 'g1', tabOrder: ['graph'] },
    { id: 'g2', tabOrder: ['c'] }
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

it('projects graph add/remove around binding-only deltas without losing visible updates', () => {
  const original = layout()
  original.tabs = original.tabs.map((tab) =>
    tab.id === 'c'
      ? {
          ...tab,
          kind: 'terminal',
          terminal: {
            defaultTitle: 'Terminal 1',
            root: { type: 'leaf', leafId: 'one' },
            panes: [{ leafId: 'one', ptyId: 'initial' }]
          }
        }
      : tab
  )
  const graphFree = {
    ...original,
    tabs: original.tabs.filter((tab) => tab.id !== 'graph'),
    groups: [
      { id: 'g1', tabIds: ['a', 'b'] },
      { id: 'g2', tabIds: ['c'] }
    ]
  }
  const project = createGitGraphFrameProjection()
  project({ type: 'workspace', key: 'w', seq: 1, layout: graphFree })
  const binding = {
    key: 'w',
    change: 'records' as const,
    bindings: { set: [{ leafId: 'one', ptyId: 'pty' }] }
  }
  const before = project({ type: 'records', epoch: 'e', seq: 2, workspaces: [binding] })
  expect(before.type === 'records' && before.workspaces[0]).toBe(binding)
  const added = project({
    type: 'records',
    epoch: 'e',
    seq: 3,
    workspaces: [
      diffPublishedLayouts(
        'w',
        indexPublishedLayout(graphFree),
        indexPublishedLayout(original),
        original
      )!
    ]
  })
  expect(added).toMatchObject({ workspaces: [] })
  const whileHidden = project({
    type: 'records',
    epoch: 'e',
    seq: 4,
    workspaces: [{ ...binding, bindings: { set: [{ leafId: 'one', ptyId: 'next' }] } }]
  })
  expect(whileHidden).toMatchObject({
    workspaces: [{ key: 'w', bindings: { set: [{ leafId: 'one', ptyId: 'next' }] } }]
  })
  const removed = project({
    type: 'records',
    epoch: 'e',
    seq: 5,
    workspaces: [
      diffPublishedLayouts(
        'w',
        indexPublishedLayout(original),
        indexPublishedLayout(graphFree),
        graphFree
      )!
    ]
  })
  expect(removed).toMatchObject({ workspaces: [] })
  const after = project({ type: 'records', epoch: 'e', seq: 6, workspaces: [binding] })
  expect(after.type === 'records' && after.workspaces[0]).toBe(binding)
})
