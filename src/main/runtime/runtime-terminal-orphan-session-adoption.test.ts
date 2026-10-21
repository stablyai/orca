import { expect, it } from 'vitest'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { makePaneKey } from '../../shared/stable-pane-id'
import type { RuntimeTerminalOrphanAdoptionRequest } from '../../shared/runtime-types'
import { collectLayoutLeafIdsInOrder } from '../../shared/workspace-layout/terminal-pane-tree'
import {
  GIT_KEY,
  addWorkspace,
  emptySession,
  leaf
} from '../../shared/workspace-layout/workspace-layout-session.test-fixture'
import { buildRuntimeTerminalOrphanSession } from './runtime-terminal-orphan-session-adoption'
import type { RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'

const TAB = 'tab-1'
const HEALTHY = leaf(1)
const ORPHAN = leaf(2)

function adopt(existingLeaves: [string, string?][]) {
  const session = addWorkspace(emptySession(), GIT_KEY, [
    { id: 'group-1', tabs: [{ id: TAB, leaves: existingLeaves }] }
  ])
  const claim = {
    terminal: 'terminal-orphan',
    ptyId: 'pty-orphan',
    incarnationId: 'incarnation-orphan',
    tabId: TAB,
    leafId: ORPHAN
  }
  const topology: NonNullable<RuntimeTerminalOrphanAdoptionRequest['topology']> = {
    tabs: [
      {
        tabId: TAB,
        root: { type: 'leaf', leafId: ORPHAN },
        activeLeafId: ORPHAN,
        expandedLeafId: null
      }
    ],
    groups: [{ id: 'group-1', activeTabId: TAB, tabOrder: [TAB] }]
  }
  const request: RuntimeTerminalOrphanAdoptionRequest = {
    worktree: GIT_KEY,
    expectedTopologyRevision: 0,
    claims: [claim],
    topology
  }
  return buildRuntimeTerminalOrphanSession({
    hostId: LOCAL_EXECUTION_HOST_ID,
    session,
    sessionWorktreeId: GIT_KEY,
    worktreeId: GIT_KEY,
    request,
    validated: [
      {
        claim,
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the tab already exists, so the builder never reads the PTY record.
        pty: {} as RuntimePtyWorktreeRecord,
        paneKey: makePaneKey(TAB, ORPHAN)
      }
    ],
    topologyTabsById: new Map(topology.tabs.map((tab) => [tab.tabId, tab])),
    topologyGroups: topology.groups,
    getDisplayTitle: () => null
  })
}

it('keeps the healthy sibling pane and its PTY when one split pane is recovered', () => {
  const layout = adopt([[HEALTHY, 'pty-healthy']]).terminalLayoutsByTabId[TAB]

  expect(collectLayoutLeafIdsInOrder(layout?.root)).toEqual([HEALTHY, ORPHAN])
  expect(layout?.ptyIdsByLeafId).toEqual({ [HEALTHY]: 'pty-healthy', [ORPHAN]: 'pty-orphan' })
  expect(layout?.activeLeafId).toBe(ORPHAN)
})

it('keeps the saved split when it already holds the recovered pane', () => {
  const layout = adopt([[HEALTHY, 'pty-healthy'], [ORPHAN]]).terminalLayoutsByTabId[TAB]

  expect(collectLayoutLeafIdsInOrder(layout?.root)).toEqual([HEALTHY, ORPHAN])
  expect(layout?.ptyIdsByLeafId).toEqual({ [HEALTHY]: 'pty-healthy', [ORPHAN]: 'pty-orphan' })
})
