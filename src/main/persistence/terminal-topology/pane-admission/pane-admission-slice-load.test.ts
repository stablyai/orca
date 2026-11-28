// A sliced pane admission must write exactly what the whole-partition load wrote, or the stored layout drifts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../../shared/orca-profiles/constants'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host/execution-host'
import {
  loadWorkspaceLayoutWithoutReport,
  workspaceKeys
} from '../../../../shared/workspace-layout/persistence/workspace-layout-load'
import { nameBasedLoadContext } from '../../../../shared/workspace-layout/persistence/workspace-layout-minted-ids'
import type { CommandOf } from '../../../../shared/workspace-layout/workspace-layout-command-types'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'
import type * as Crypto from 'node:crypto'
import type * as SliceLoad from './pane-admission-slice-load'
import { SLICE_FIELD_SCOPES } from './pane-admission-slice-records'
import {
  admitPaneToSession,
  withdrawPaneFromSession,
  type TerminalPaneAdmission
} from './terminal-pane-admission'

const mode = vi.hoisted(
  (): {
    main: boolean
    slice: boolean
    sliced: number
    minted: number
    lastSlice?: WorkspaceSessionState
  } => ({ main: true, slice: true, sliced: 0, minted: 0 })
)

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
        return { loaded }
      }
      const load = actual.loadPaneCommandLayout(...args)
      mode.sliced += load.slice ? 1 : 0
      mode.lastSlice = load.slice
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
  // A one-pane row listed under two workspaces: withdrawing it must not leave the hidden copy to return.
  addTerminal(session, key(24), 't24', [leaf(24)])
  addTerminal(session, key(25), 't25', [leaf(25)])
  session.tabsByWorktree[key(25)]!.push(session.tabsByWorktree[key(24)]![0]!)
  // A workspace storing the same row twice; the Loader keeps one.
  addTerminal(session, key(26), 't26', [leaf(26)])
  session.tabsByWorktree[key(26)]!.push({ ...session.tabsByWorktree[key(26)]![0]! })
  // A legacy row folded into the tab-bar terminal whose process it claims; the saved selections name it.
  addTerminal(session, key(27), 'tC', [leaf(271)])
  addTerminal(session, key(27), 'tD', [leaf(272)], { rowOnly: true })
  session.tabsByWorktree[key(27)]!.forEach((row) => (row.ptyId = 'pty-27'))
  session.terminalLayoutsByTabId.tC!.ptyIdsByLeafId = { [leaf(271)]: 'pty-27' }
  session.terminalLayoutsByTabId.tD!.ptyIdsByLeafId = { [leaf(272)]: 'pty-27' }
  session.activeTabId = 'tD'
  session.activeTabIdByWorktree = {
    ...session.activeTabIdByWorktree,
    [key(27)]: 'tD',
    // A legacy selection under a key no workspace uses.
    'legacy-key': 'tD'
  }
  // The withdrawn pane holds the slice's only incarnation; another workspace's must survive.
  session.terminalPtyIncarnationsByPaneKey = {
    [`t22:${leaf(122)}`]: 'incarnation-22',
    [`t3:${leaf(3)}`]: 'incarnation-3',
    // A legacy recovery record for a pane no longer in t3's tree; whole loads carry it.
    't3:0': 'legacy-incarnation'
  }
  // A layout no terminal row owns, named only by a tab-bar entry; whole loads carry it.
  session.terminalLayoutsByTabId.orphan = {
    root: { type: 'leaf', leafId: leaf(30) },
    activeLeafId: leaf(30),
    expandedLeafId: null,
    ptyIdsByLeafId: {}
  }
  session.unifiedTabs![key(3)]!.push({
    ...session.unifiedTabs![key(3)]![0]!,
    id: 'orphan',
    entityId: 'orphan'
  })
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
  extra: Pick<CommandOf<'createTerminalTab'>, 'groupId' | 'split'> = {}
): TerminalPaneAdmission => ({
  type: 'createTerminalTab',
  workspace,
  tabId,
  leafId: leaf(500),
  ...extra
})

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
          split: { besideGroupId: 'group-t3', direction: 'right' }
        })
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
      })
  ],
  [
    'the withdrawn last pane of a row another workspace also lists',
    (s) => () =>
      withdrawPaneFromSession(LOCAL_EXECUTION_HOST_ID, s, {
        type: 'closePane',
        workspace: key(24),
        tabId: 't24',
        leafId: leaf(24)
      })
  ],
  [
    'the withdrawn last pane of a row stored twice',
    (s) => () =>
      withdrawPaneFromSession(LOCAL_EXECUTION_HOST_ID, s, {
        type: 'closePane',
        workspace: key(26),
        tabId: 't26',
        leafId: leaf(26)
      })
  ],
  [
    'a new tab beside a folded row the selections name',
    (s) => admit(s, create(key(27), 'new-tab'))
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Each record the sliced write changed, as `result` holds it. */
function rewritten(
  stored: WorkspaceSessionState,
  sliced: WorkspaceSessionState,
  result: WorkspaceSessionState
): Record<string, unknown> {
  const records: Record<string, unknown> = {}
  const [storedFields, slicedFields, resultFields]: Record<string, unknown>[] = [
    stored,
    sliced,
    result
  ]
  for (const field of new Set([...Object.keys(stored), ...Object.keys(sliced)])) {
    const [was, is] = [storedFields[field], slicedFields[field]]
    const keyed = (value: unknown): Record<string, unknown> | null =>
      isRecord(value) ? value : null
    const [wasMap, isMap, resultMap] = [keyed(was), keyed(is), keyed(resultFields[field])]
    if (!wasMap || !isMap) {
      if (JSON.stringify(was) !== JSON.stringify(is)) {
        records[field] = resultFields[field]
      }
      continue
    }
    for (const key of new Set([...Object.keys(wasMap), ...Object.keys(isMap)])) {
      if (JSON.stringify(wasMap[key]) !== JSON.stringify(isMap[key])) {
        records[`${field}.${key}`] = resultMap?.[key]
      }
    }
  }
  return records
}

/** Whether a `field.key` record is one the slice loaded: its own workspaces' entries and its rows' and panes' records. */
function loadedBy(slice: WorkspaceSessionState): (record: string) => boolean {
  const workspaces = new Set(workspaceKeys(slice))
  const fields: Record<string, unknown> = slice
  return (record) => {
    const dot = record.indexOf('.')
    if (dot === -1) {
      return false
    }
    const [field, key] = [record.slice(0, dot), record.slice(dot + 1)]
    const map = fields[field]
    const scope: unknown = Object.hasOwn(SLICE_FIELD_SCOPES, field)
      ? Object.entries(SLICE_FIELD_SCOPES).find(([name]) => name === field)?.[1]
      : undefined
    if (scope === 'workspace' || scope === 'workspace-selection') {
      return workspaces.has(key)
    }
    return isRecord(map) && Object.hasOwn(map, key)
  }
}

function pick(records: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(keys.map((key) => [key, records[key]]))
}

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
      // Window-owned whole loads rewrite every record; the slice rewrites its own exactly as they did.
      expect(loadedLayout(sliced.session)).toEqual(loadedLayout(whole.session))
      expect(rewritten(session, sliced.session, whole.session)).toEqual(
        rewritten(session, sliced.session, sliced.session)
      )
      // And every record the whole rewrite changed among those the slice loaded, so none is left stale.
      const inSlice = loadedBy(mode.lastSlice!)
      const fixed = Object.keys(rewritten(session, whole.session, whole.session)).filter(inSlice)
      expect(pick(rewritten(session, whole.session, sliced.session), fixed)).toEqual(
        pick(rewritten(session, whole.session, whole.session), fixed)
      )
    }
  })
})

it('keeps the redirect to the tab-bar terminal when a sliced window-owned write drops a folded row', () => {
  mode.main = false
  vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ['Date'] })
  const session = fleet()
  mode.slice = false
  mode.minted = 0
  const whole = admit(session, create(key(27), 'new-tab'))()
  mode.slice = true
  mode.minted = 0
  const sliced = admit(session, create(key(27), 'new-tab'))()
  vi.useRealTimers()

  expect(whole.session?.activeTabIdByWorktree?.[key(27)]).not.toBe('tD')
  expect(sliced.session?.activeTabIdByWorktree?.[key(27)]).toBe(
    whole.session?.activeTabIdByWorktree?.[key(27)]
  )
  expect(sliced.session?.activeTabId).toBe(whole.session?.activeTabId)
  expect(whole.session?.activeTabIdByWorktree?.['legacy-key']).not.toBe('tD')
  expect(sliced.session?.activeTabIdByWorktree?.['legacy-key']).toBe(
    whole.session?.activeTabIdByWorktree?.['legacy-key']
  )
})

it('keeps records the slice never loaded when a sliced window-owned write rewrites its own', () => {
  mode.main = false
  vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ['Date'] })
  const session = fleet()
  mode.slice = false
  mode.minted = 0
  const whole = admit(session, create(key(3), 'new-tab'))()
  mode.slice = true
  mode.minted = 0
  mode.sliced = 0
  const sliced = admit(session, create(key(3), 'new-tab'))()
  vi.useRealTimers()

  expect(mode.sliced).toBe(1)
  expect(whole.session?.terminalPtyIncarnationsByPaneKey?.['t3:0']).toBe('legacy-incarnation')
  expect(sliced.session?.terminalPtyIncarnationsByPaneKey?.['t3:0']).toBe('legacy-incarnation')
  expect(whole.session?.terminalLayoutsByTabId.orphan).toBeDefined()
  expect(sliced.session?.terminalLayoutsByTabId.orphan).toEqual(
    whole.session?.terminalLayoutsByTabId.orphan
  )
})
