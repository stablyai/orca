import { describe, expect, it } from 'vitest'
import { buildHeadlessMobileSessionTerminalTabs } from './mobile-session-terminal-projection'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { Tab } from '../../shared/tab-types'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { buildHeadlessSessionTabPropsPatch } from './headless-session-tab-props-patch'

const WT = 'repo::/wt'
const LEAF_A = '11111111-1111-4111-8111-111111111111'
const LEAF_B = '22222222-2222-4222-8222-222222222222'

function row(overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id: 'tab-1',
    ptyId: null,
    worktreeId: WT,
    title: 'Terminal 1',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    ...overrides
  }
}

function unified(overrides: Partial<Tab> = {}): Tab {
  return {
    id: 'tab-1',
    entityId: 'tab-1',
    groupId: 'group-1',
    worktreeId: WT,
    contentType: 'terminal',
    label: 'Terminal 1',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    ...overrides
  }
}

function singleLeaf(): TerminalLayoutSnapshot {
  return { root: { type: 'leaf', leafId: LEAF_A }, activeLeafId: LEAF_A, expandedLeafId: null }
}

function split(chatLeafId?: string): TerminalLayoutSnapshot {
  return {
    root: {
      type: 'split',
      direction: 'vertical',
      first: { type: 'leaf', leafId: LEAF_A },
      second: { type: 'leaf', leafId: LEAF_B }
    },
    activeLeafId: LEAF_A,
    expandedLeafId: null,
    ...(chatLeafId ? { chatLeafId } : {})
  }
}

function session(
  tabs: TerminalTab[],
  layouts: Record<string, TerminalLayoutSnapshot>,
  unifiedTabs?: Tab[]
): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: { [WT]: tabs },
    terminalLayoutsByTabId: layouts,
    ...(unifiedTabs ? { unifiedTabs: { [WT]: unifiedTabs } } : {})
  }
}

function project(state: WorkspaceSessionState) {
  return buildHeadlessMobileSessionTerminalTabs(WT, state.tabsByWorktree[WT]!, state)
}

describe('buildHeadlessMobileSessionTerminalTabs view mode', () => {
  it('publishes the unified tab view when the row does not carry it', () => {
    const tabs = project(
      session([row()], { 'tab-1': singleLeaf() }, [unified({ viewMode: 'chat' })])
    )
    expect(tabs.map((tab) => tab.viewMode)).toEqual(['chat'])
  })

  it('prefers the unified view over a disagreeing row and falls back to the row', () => {
    expect(
      project(
        session([row({ viewMode: 'chat' })], { 'tab-1': singleLeaf() }, [
          unified({ viewMode: 'terminal' })
        ])
      ).map((tab) => tab.viewMode)
    ).toEqual(['terminal'])
    expect(
      project(session([row({ viewMode: 'chat' })], { 'tab-1': singleLeaf() })).map(
        (tab) => tab.viewMode
      )
    ).toEqual(['chat'])
  })

  it('publishes a present owner that left the tree as terminal with no owner', () => {
    const stale: TerminalLayoutSnapshot = { ...singleLeaf(), chatLeafId: LEAF_B }
    const [tab] = project(session([row()], { 'tab-1': stale }, [unified({ viewMode: 'chat' })]))
    expect(tab?.viewMode).toBe('terminal')
    expect(tab?.parentLayout?.chatLeafId).toBeUndefined()
  })

  it('writes the view to both the row and the unified tab', () => {
    const next = buildHeadlessSessionTabPropsPatch(
      session([row()], { 'tab-1': split() }, [unified()]),
      WT,
      'tab-1',
      { viewMode: 'chat', chatLeafId: LEAF_B }
    )!
    expect(next.tabsByWorktree[WT]![0]!.viewMode).toBe('chat')
    expect(next.unifiedTabs![WT]![0]!.viewMode).toBe('chat')
    expect(next.terminalLayoutsByTabId['tab-1']!.chatLeafId).toBe(LEAF_B)
  })
})
