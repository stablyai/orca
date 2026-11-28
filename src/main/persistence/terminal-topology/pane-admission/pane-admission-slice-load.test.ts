// A sliced pane admission must write exactly what the whole-partition load wrote, or the stored layout drifts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../../shared/orca-profiles/constants'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host/execution-host'
import { loadWorkspaceLayoutWithoutReport } from '../../../../shared/workspace-layout/persistence/workspace-layout-load'
import { nameBasedLoadContext } from '../../../../shared/workspace-layout/persistence/workspace-layout-minted-ids'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'
import type * as Crypto from 'node:crypto'
import type * as SliceLoad from './pane-admission-slice-load'
import {
  admitPaneToSession,
  withdrawPaneFromSession,
  type TerminalPaneAdmission
} from './terminal-pane-admission'

const mode = vi.hoisted(() => ({ main: true, slice: true, sliced: 0, minted: 0 }))

// Both runs must mint the same ids for a new group to compare.
vi.mock('node:crypto', async (importOriginal) => ({
  ...(await importOriginal<typeof Crypto>()),
  randomUUID: () => `00000000-0000-4000-8000-${String(++mode.minted).padStart(12, '0')}`
}))

vi.mock('../../../../shared/workspace-layout/layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return mode.main
  }
}))

vi.mock('./pane-admission-slice-load', async (importOriginal) => {
  const actual = await importOriginal<typeof SliceLoad>()
  return {
    ...actual,
    loadPaneCommandLayout: (...args: Parameters<typeof actual.loadPaneCommandLayout>) => {
      if (!mode.slice) {
        const [hostId, session] = args
        const loaded = loadWorkspaceLayoutWithoutReport(hostId, session, nameBasedLoadContext())
        return { loaded, sliced: false }
      }
      const load = actual.loadPaneCommandLayout(...args)
      mode.sliced += load.sliced ? 1 : 0
      return load
    }
  }
})

const key = (n: number): string => `repo-1::/fleet/w${n}`
const leaf = (n: number): string => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`

function addTerminal(
  session: WorkspaceSessionState,
  workspace: string,
  tabId: string,
  leafIds: string[],
  options: { groupId?: string; rowOnly?: boolean } = {}
): void {
  const groupId = options.groupId ?? `group-${tabId}`
  const row = {
    id: tabId,
    ptyId: null,
    worktreeId: workspace,
    title: tabId,
    defaultTitle: tabId,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1_700_000_000_000
  }
  session.tabsByWorktree[workspace] = [...(session.tabsByWorktree[workspace] ?? []), row]
  const [first, second] = leafIds
  session.terminalLayoutsByTabId[tabId] = {
    root: second
      ? {
          type: 'split',
          direction: 'vertical',
          ratio: 0.5,
          first: { type: 'leaf', leafId: first! },
          second: { type: 'leaf', leafId: second }
        }
      : { type: 'leaf', leafId: first! },
    activeLeafId: first!,
    expandedLeafId: null,
    ptyIdsByLeafId: {}
  }
  if (options.rowOnly) {
    return
  }
  session.unifiedTabs![workspace] = [
    ...(session.unifiedTabs![workspace] ?? []),
    {
      id: tabId,
      entityId: tabId,
      contentType: 'terminal',
      label: tabId,
      groupId,
      worktreeId: workspace,
      executionHostId: LOCAL_EXECUTION_HOST_ID,
      sortOrder: 0,
      createdAt: 1_700_000_000_000,
      customLabel: null,
      color: null
    }
  ]
  session.tabGroups![workspace] = [
    { id: groupId, worktreeId: workspace, activeTabId: tabId, tabOrder: [tabId] }
  ]
  session.tabGroupLayouts![workspace] = { type: 'leaf', groupId }
}

/** Plain workspaces around the ties the Loader and commands read across workspaces. */
function fleet(): WorkspaceSessionState {
  const session: WorkspaceSessionState = {
    ...getDefaultWorkspaceSession(),
    unifiedTabs: {},
    tabGroups: {},
    tabGroupLayouts: {},
    activeGroupIdByWorktree: {}
  }
  for (let n = 0; n < 12; n++) {
    addTerminal(session, key(n), `t${n}`, [leaf(n)])
  }
  // A repeated pane id is reminted in the later workspace.
  addTerminal(session, key(20), 't20', [leaf(99)])
  addTerminal(session, key(21), 't21', [leaf(99)])
  // A row listed under two workspaces lives in the one whose tab bar names it.
  addTerminal(session, key(22), 't22', [leaf(22), leaf(122)])
  addTerminal(session, key(23), 't23', [leaf(23)])
  session.tabsByWorktree[key(23)]!.push(session.tabsByWorktree[key(22)]![0]!)
  // The withdrawn pane holds the slice's only incarnation; another workspace's must survive.
  session.terminalPtyIncarnationsByPaneKey = {
    [`t22:${leaf(122)}`]: 'incarnation-22',
    [`t3:${leaf(3)}`]: 'incarnation-3'
  }
  session.closedTerminalTabTombstonesByTabId = {
    'closed-tab': { closedAt: Date.now(), worktreeId: key(5) }
  }
  return session
}

type Run = () => ReturnType<typeof admitPaneToSession> | ReturnType<typeof withdrawPaneFromSession>

const admit =
  (session: WorkspaceSessionState, admission: TerminalPaneAdmission): Run =>
  () =>
    admitPaneToSession(LOCAL_EXECUTION_HOST_ID, session, admission)

const create = (
  workspace: string,
  tabId: string,
  extra: Partial<TerminalPaneAdmission> = {}
): TerminalPaneAdmission =>
  ({
    type: 'createTerminalTab',
    workspace,
    tabId,
    leafId: leaf(500),
    ...extra
  }) as TerminalPaneAdmission

const CASES: [string, (session: WorkspaceSessionState) => Run][] = [
  ['a new tab in a plain workspace', (s) => admit(s, create(key(3), 'new-tab'))],
  ['a new tab in a workspace sharing a pane id', (s) => admit(s, create(key(21), 'new-tab'))],
  ['a new tab in a workspace sharing a row', (s) => admit(s, create(key(23), 'new-tab'))],
  ['the first tab of a new workspace', (s) => admit(s, create(key(40), 'new-tab'))],
  ['a tab id another workspace holds', (s) => admit(s, create(key(3), 't7'))],
  ['a tab id closed in another workspace', (s) => admit(s, create(key(3), 'closed-tab'))],
  [
    'a split into a group id another workspace holds',
    (s) =>
      admit(
        s,
        create(key(3), 'new-tab', {
          groupId: 'group-t8',
          split: { besideGroupId: 'group-t3', direction: 'horizontal' }
        } as Partial<TerminalPaneAdmission>)
      )
  ],
  [
    'a split pane',
    (s) =>
      admit(s, {
        type: 'splitPane',
        workspace: key(22),
        tabId: 't22',
        leafId: leaf(22),
        direction: 'vertical',
        newLeafId: leaf(501)
      } as TerminalPaneAdmission)
  ],
  [
    'a withdrawn pane',
    (s) => () =>
      withdrawPaneFromSession(LOCAL_EXECUTION_HOST_ID, s, {
        type: 'closePane',
        workspace: key(22),
        tabId: 't22',
        leafId: leaf(122)
      })
  ]
]

function loadedLayout(session: WorkspaceSessionState) {
  return loadWorkspaceLayoutWithoutReport(LOCAL_EXECUTION_HOST_ID, session, nameBasedLoadContext())
    .layout
}

describe.each([
  ['main-owned', true],
  ['window-owned', false]
])('%s layouts', (_name, main) => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ['Date'] })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it.each(CASES)('slices %s with the whole load’s result', (_case, runOf) => {
    mode.main = main
    const session = fleet()
    mode.slice = false
    mode.minted = 0
    const whole = runOf(session)()
    mode.slice = true
    mode.minted = 0
    mode.sliced = 0
    const sliced = runOf(session)()

    expect(mode.sliced).toBe(1)
    expect(sliced.value).toEqual(whole.value)
    expect(sliced.workspaces).toEqual(whole.workspaces)
    expect(sliced.session === null).toBe(whole.session === null)
    if (main) {
      expect(sliced.session).toEqual(whole.session)
    } else if (whole.session && sliced.session) {
      // Window-owned whole loads rewrite the partition; the patch must load the same layout.
      expect(loadedLayout(sliced.session)).toEqual(loadedLayout(whole.session))
    }
  })
})
