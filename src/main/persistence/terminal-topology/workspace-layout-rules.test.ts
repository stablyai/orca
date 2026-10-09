import { describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import type { Tab, TabGroup } from '../../../shared/tab-types'
import type { TerminalPaneLayoutNode } from '../../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { TEST_LEAF_1, TEST_LEAF_2, TEST_LEAF_LIVE } from '../../persistence-session-fixtures'
import {
  checkWorkspaceLayoutRules,
  type WorkspaceLayoutPartition,
  type WorkspaceLayoutRule
} from './workspace-layout-rules'

const WT = 'repo-1::/tmp/wt'

type TabSpec = { id: string; leaves: [string, string?][]; group?: string }

const leaf = (leafId: string): TerminalPaneLayoutNode => ({ type: 'leaf', leafId })

function rootOf(leafIds: string[]): TerminalPaneLayoutNode {
  const [first, ...rest] = leafIds
  return rest.length === 0
    ? leaf(first!)
    : { type: 'split', direction: 'vertical', first: leaf(first!), second: rootOf(rest) }
}

function unifiedTab(
  id: string,
  groupId: string,
  contentType: Tab['contentType'] = 'terminal'
): Tab {
  return {
    id,
    entityId: id,
    groupId,
    worktreeId: WT,
    contentType,
    label: id,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

/** A consistent session: each tab in group `g1` (or its own `group`), rows in group order. */
function session(tabs: TabSpec[]): WorkspaceSessionState {
  const groupIds = [...new Set(tabs.map((tab) => tab.group ?? 'g1'))]
  const groups: TabGroup[] = groupIds.map((id) => ({
    id,
    worktreeId: WT,
    activeTabId: null,
    tabOrder: tabs.filter((tab) => (tab.group ?? 'g1') === id).map((tab) => tab.id)
  }))
  return {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: {
      [WT]: tabs.map((tab, index) => ({
        id: tab.id,
        ptyId: tab.leaves[0]?.[1] ?? null,
        worktreeId: WT,
        title: tab.id,
        customTitle: null,
        color: null,
        sortOrder: index,
        createdAt: 1
      }))
    },
    terminalLayoutsByTabId: Object.fromEntries(
      tabs.map((tab) => [
        tab.id,
        {
          root: rootOf(tab.leaves.map(([leafId]) => leafId)),
          activeLeafId: tab.leaves[0]![0],
          expandedLeafId: null,
          ptyIdsByLeafId: Object.fromEntries(
            tab.leaves.flatMap(([leafId, ptyId]) => (ptyId ? [[leafId, ptyId]] : []))
          )
        }
      ])
    ),
    unifiedTabs: { [WT]: tabs.map((tab) => unifiedTab(tab.id, tab.group ?? 'g1')) },
    tabGroups: { [WT]: groups }
  }
}

const local = (state: WorkspaceSessionState): WorkspaceLayoutPartition[] => [
  { hostId: 'local', session: state }
]

const rules = (
  state: WorkspaceSessionState,
  previous?: WorkspaceSessionState
): WorkspaceLayoutRule[] =>
  checkWorkspaceLayoutRules(local(state), previous ? local(previous) : undefined).map(
    (violation) => violation.rule
  )

const SPLIT: TabSpec[] = [
  {
    id: 'tab-a',
    leaves: [
      [TEST_LEAF_1, 'pty-1'],
      [TEST_LEAF_2, 'pty-2']
    ]
  },
  { id: 'tab-b', leaves: [[TEST_LEAF_LIVE, 'pty-3']] }
]

describe('checkWorkspaceLayoutRules', () => {
  it('passes a consistent layout, and one with no tabs', () => {
    expect(rules(session(SPLIT))).toEqual([])
    expect(rules(getDefaultWorkspaceSession())).toEqual([])
  })

  // STA-9417: the activation sweep minted a second tab for a terminal the split already shows.
  it('flags a terminal shown in two panes', () => {
    const state = session([
      {
        id: 'tab-a',
        leaves: [
          [TEST_LEAF_1, 'pty-1'],
          [TEST_LEAF_2, 'pty-2']
        ]
      },
      { id: 'tab-b', leaves: [[TEST_LEAF_LIVE, 'pty-2']] }
    ])
    expect(rules(state)).toEqual(['terminal_in_two_panes'])
  })

  it('treats one PTY id with two recorded incarnations as two terminals', () => {
    const state = session([
      { id: 'tab-a', leaves: [[TEST_LEAF_1, 'pty-1']] },
      { id: 'tab-b', leaves: [[TEST_LEAF_2, 'pty-1']] }
    ])
    state.terminalPtyIncarnationsByPaneKey = {
      [`tab-a:${TEST_LEAF_1}`]: 'i1',
      [`tab-b:${TEST_LEAF_2}`]: 'i2'
    }
    expect(rules(state)).toEqual([])
  })

  // STA-9259: a dragged-out pane stayed in its source tab.
  it('flags a pane in two tabs', () => {
    const state = session([
      {
        id: 'tab-a',
        leaves: [
          [TEST_LEAF_1, 'pty-1'],
          [TEST_LEAF_2, 'pty-2']
        ]
      },
      { id: 'tab-b', leaves: [[TEST_LEAF_2, 'pty-2']] }
    ])
    expect(rules(state)).toEqual(['pane_in_two_tabs'])
  })

  it('flags a pane listed twice in one tab', () => {
    const state = session([{ id: 'tab-a', leaves: [[TEST_LEAF_1, 'pty-1'], [TEST_LEAF_1]] }])
    expect(rules(state)).toEqual(['pane_twice_in_one_tab'])
  })

  it('flags panes whose tab row is gone, and bindings to panes the layout lacks', () => {
    const state = session(SPLIT)
    state.tabsByWorktree[WT] = state.tabsByWorktree[WT]!.filter((tab) => tab.id !== 'tab-b')
    state.unifiedTabs![WT] = state.unifiedTabs![WT]!.filter((tab) => tab.id !== 'tab-b')
    state.tabGroups![WT]![0]!.tabOrder = ['tab-a']
    state.terminalLayoutsByTabId['tab-a']!.ptyIdsByLeafId![TEST_LEAF_LIVE] = 'pty-9'
    expect(rules(state).sort()).toEqual(['binding_without_pane', 'pane_without_tab'])
  })

  it('flags a tab row listed under two worktrees', () => {
    const state = session(SPLIT)
    state.tabsByWorktree['repo-1::/tmp/other'] = [state.tabsByWorktree[WT]![1]!]
    expect(rules(state)).toContain('tab_in_two_places')
  })

  it('flags a tab in no group, in two groups, or in a group it does not name', () => {
    const none = session(SPLIT)
    none.tabGroups![WT]![0]!.tabOrder = ['tab-a']
    expect(rules(none)).toEqual(['tab_without_group'])

    const two = session([...SPLIT, { id: 'tab-c', leaves: [['leaf-c', 'pty-c']], group: 'g2' }])
    two.tabGroups![WT]![1]!.tabOrder = ['tab-c', 'tab-b']
    expect(rules(two)).toContain('tab_in_two_groups')

    const mismatch = session(SPLIT)
    mismatch.unifiedTabs![WT]![1] = unifiedTab('tab-b', 'g2')
    expect(rules(mismatch)).toEqual(['tab_group_mismatch'])
  })

  it('flags terminal tabs with no tab bar at all once per worktree', () => {
    const state = session(SPLIT)
    delete state.unifiedTabs
    delete state.tabGroups
    expect(rules(state)).toEqual(['tab_bar_missing'])
  })

  it('flags a group naming a tab that does not exist', () => {
    const state = session(SPLIT)
    state.tabGroups![WT]![0]!.tabOrder.push('ghost')
    expect(rules(state)).toEqual(['group_lists_missing_tab'])
  })

  // Lost or resurrected tabs: the tab rows and the tab bar are two lists of one thing.
  it('flags terminal tab rows and tab bar entries that disagree', () => {
    const rowOnly = session(SPLIT)
    rowOnly.unifiedTabs![WT] = rowOnly.unifiedTabs![WT]!.filter((tab) => tab.id !== 'tab-b')
    rowOnly.tabGroups![WT]![0]!.tabOrder = ['tab-a']
    expect(rules(rowOnly)).toEqual(['tab_lists_disagree'])

    const withEditor = session(SPLIT)
    withEditor.unifiedTabs![WT]!.push(unifiedTab('/tmp/wt/a.ts', 'g1', 'editor'))
    withEditor.tabGroups![WT]![0]!.tabOrder.push('/tmp/wt/a.ts')
    expect(rules(withEditor)).toEqual([])
  })

  it('flags tab rows ordered differently from their group', () => {
    const state = session(SPLIT)
    state.tabGroups![WT]![0]!.tabOrder = ['tab-b', 'tab-a']
    expect(rules(state)).toEqual(['tab_order_disagrees'])
  })

  it('accepts a drag-out that keeps the pane id and a respawn into the same pane', () => {
    const before = session(SPLIT)
    const movedOut = session([
      { id: 'tab-a', leaves: [[TEST_LEAF_1, 'pty-1']] },
      { id: 'tab-c', leaves: [[TEST_LEAF_2, 'pty-2']] },
      { id: 'tab-b', leaves: [[TEST_LEAF_LIVE, 'pty-3']] }
    ])
    expect(rules(movedOut, before)).toEqual([])
    const respawned = session([
      {
        id: 'tab-a',
        leaves: [
          [TEST_LEAF_1, 'pty-9'],
          [TEST_LEAF_2, 'pty-2']
        ]
      },
      SPLIT[1]!
    ])
    expect(rules(respawned, before)).toEqual([])
  })

  it('flags a pane, tab or group whose id changed for the same entity', () => {
    const before = session(SPLIT)
    const newPane = session([
      {
        id: 'tab-a',
        leaves: [
          [TEST_LEAF_1, 'pty-1'],
          ['leaf-new', 'pty-2']
        ]
      },
      SPLIT[1]!
    ])
    expect(rules(newPane, before)).toEqual(['pane_id_changed'])

    const newTab = session([SPLIT[0]!, { id: 'tab-new', leaves: [[TEST_LEAF_LIVE, 'pty-3']] }])
    expect(rules(newTab, before)).toEqual(['tab_id_changed'])

    const newGroup = session(SPLIT.map((tab) => ({ ...tab, group: 'g-new' })))
    expect(rules(newGroup, before)).toEqual(['group_id_changed'])
  })

  it('checks terminals across owner partitions but keeps a remote mirror apart', () => {
    const one = session([{ id: 'tab-a', leaves: [[TEST_LEAF_1, 'pty-1']] }])
    const two = session([{ id: 'tab-b', leaves: [[TEST_LEAF_2, 'pty-1']] }])
    const flagged = checkWorkspaceLayoutRules([
      { hostId: 'local', session: one },
      { hostId: 'ssh:target', session: two }
    ])
    expect(flagged.map((violation) => violation.rule)).toEqual(['terminal_in_two_panes'])
    expect(
      checkWorkspaceLayoutRules([
        { hostId: 'local', session: one },
        { hostId: 'runtime:env', session: two }
      ])
    ).toEqual([])
  })
})
