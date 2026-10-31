// Main layout changes must reach subscribed phones even without another attached-window publication.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTabsSnapshot
} from '../../../shared/runtime-session-contracts'
import {
  HEADLESS_LEAF_ID,
  HEADLESS_SECOND_LEAF_ID,
  TEST_WORKTREE_ID
} from '../orca-runtime-test-fixtures.spec'
import {
  SURFACE_TAB_ID,
  surfaceRuntime
} from '../terminal/surface/terminal-surface-replies.test-fixture'
import {
  MOVED_STRIP,
  SECOND_TAB_ID,
  moveAndSplitTabs,
  tabStrip,
  threeTabSurfaceRuntime
} from './session-tabs-layout-moves.test-fixture'

vi.mock('../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

type Runtime = ReturnType<typeof surfaceRuntime>['runtime']

const rowOf = (leafId: string): string => `${SURFACE_TAB_ID}::${leafId}`

/** A workspace on an SSH host whose layout main has not loaded: the window's rows stand. */
const UNLOADED_SSH_ROWS: RuntimeMobileSessionTabsSnapshot = {
  worktree: 'repo-ssh::/srv/remote',
  publicationEpoch: 'renderer',
  snapshotVersion: 1,
  activeGroupId: 'ssh-group',
  activeTabId: 'ssh-tab::ssh-leaf',
  activeTabType: 'terminal',
  tabGroups: [{ id: 'ssh-group', activeTabId: 'ssh-tab', tabOrder: ['ssh-tab'] }],
  tabs: [
    {
      type: 'terminal',
      id: 'ssh-tab::ssh-leaf',
      title: 'remote shell',
      parentTabId: 'ssh-tab',
      leafId: 'ssh-leaf',
      isActive: true
    }
  ]
}

/** The window's one publication: both panes of the saved split, under their saved title. */
function windowPublication(): RuntimeMobileSessionTabsSnapshot {
  return {
    worktree: TEST_WORKTREE_ID,
    publicationEpoch: 'renderer',
    snapshotVersion: 1,
    activeGroupId: null,
    activeTabId: rowOf(HEADLESS_LEAF_ID),
    activeTabType: 'terminal',
    tabs: [HEADLESS_LEAF_ID, HEADLESS_SECOND_LEAF_ID].map((leafId) => ({
      type: 'terminal' as const,
      id: rowOf(leafId),
      title: 'Persisted Terminal',
      parentTabId: SURFACE_TAB_ID,
      leafId,
      isActive: leafId === HEADLESS_LEAF_ID
    }))
  }
}

/** Attaches a window that publishes once, then records every push a phone gets. */
async function windowedPhone(runtime: Runtime): Promise<RuntimeMobileSessionTabsResult[]> {
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, {
    tabs: [],
    leaves: [],
    mobileSessionTabs: [windowPublication(), UNLOADED_SSH_ROWS]
  })
  await vi.runAllTimersAsync()
  const seen: RuntimeMobileSessionTabsResult[] = []
  runtime.onMobileSessionTabsChanged((snapshot) => {
    seen.push(snapshot)
  })
  return seen
}

const listed = (runtime: Runtime) => runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
const parentTabsOf = (
  rows: Pick<RuntimeMobileSessionTabsResult | RuntimeMobileSessionTabsSnapshot, 'tabs'> | undefined
): string[] => [
  ...new Set((rows?.tabs ?? []).map((tab) => (tab.type === 'terminal' ? tab.parentTabId : tab.id)))
]

/** The terminal tabs main's layout holds for the workspace, in saved order. */
function layoutTabIds(store: ReturnType<typeof surfaceRuntime>['store']): string[] {
  return (store.getSession().tabsByWorktree[TEST_WORKTREE_ID] ?? []).map((tab) => tab.id)
}

describe('session.tabs on a windowed server follow main without a window publish (switch on)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('a CLI rename reaches the pushed and listed rows', async () => {
    const { runtime } = surfaceRuntime()
    const seen = await windowedPhone(runtime)

    await runtime.applyLayoutCommand({
      type: 'renameTab',
      workspace: TEST_WORKTREE_ID,
      tabId: SURFACE_TAB_ID,
      kind: 'custom',
      title: 'Build'
    })
    await vi.runAllTimersAsync()

    const named = (rows: RuntimeMobileSessionTabsResult | undefined) =>
      (rows?.tabs ?? []).map((tab) => [tab.title, tab.type === 'terminal' && tab.customTitle])
    // The manual name too, which a paired desktop reads to keep or replace its own.
    expect(named(seen.at(-1))).toEqual([
      ['Build', 'Build'],
      ['Build', 'Build']
    ])
    expect(named(await listed(runtime))).toEqual([
      ['Build', 'Build'],
      ['Build', 'Build']
    ])
  })

  it('a CLI create reaches the pushed and listed rows', async () => {
    const { runtime, store } = surfaceRuntime()
    const seen = await windowedPhone(runtime)

    await runtime.applyLayoutCommand({
      type: 'createTerminalTab',
      workspace: TEST_WORKTREE_ID,
      tabId: SECOND_TAB_ID
    })
    await vi.runAllTimersAsync()

    expect(layoutTabIds(store)).toEqual([SURFACE_TAB_ID, SECOND_TAB_ID])
    expect(parentTabsOf(seen.at(-1))).toEqual([SURFACE_TAB_ID, SECOND_TAB_ID])
    expect(parentTabsOf(await listed(runtime))).toEqual([SURFACE_TAB_ID, SECOND_TAB_ID])
  })

  // Stale until W4's dropped-leaf hook (its close PR, ledger L255) drops the row; remove .fails then.
  it.fails("a CLI close reaches the rows, which then agree with main's layout", async () => {
    const { runtime, store } = threeTabSurfaceRuntime()
    const seen = await windowedPhone(runtime)
    expect(parentTabsOf(await listed(runtime))).toContain(SECOND_TAB_ID)

    await runtime.applyLayoutCommand({
      type: 'closeTabs',
      workspace: TEST_WORKTREE_ID,
      tabIds: [SECOND_TAB_ID],
      force: true
    })
    await vi.runAllTimersAsync()

    expect(layoutTabIds(store)).not.toContain(SECOND_TAB_ID)
    expect(parentTabsOf(seen.at(-1))).toEqual(layoutTabIds(store))
    expect(parentTabsOf(await listed(runtime))).toEqual(layoutTabIds(store))
  })

  it("a later commit, or the window's older snapshot, never re-adds a row main's layout lacks", async () => {
    const { runtime } = threeTabSurfaceRuntime()
    await windowedPhone(runtime)
    await runtime.applyLayoutCommand({
      type: 'closeTabs',
      workspace: TEST_WORKTREE_ID,
      tabIds: [SECOND_TAB_ID],
      force: true
    })
    await vi.runAllTimersAsync()
    // The interim phone-close drop: a writer stores the rows without the closed tab.
    const held = runtime.mobileSessionTabsByWorktree.get(TEST_WORKTREE_ID)
    if (!held) {
      throw new Error('the window published rows')
    }
    runtime.storeMobileSessionSnapshot(TEST_WORKTREE_ID, {
      ...held,
      tabs: held.tabs.filter((tab) => !parentTabsOf({ tabs: [tab] }).includes(SECOND_TAB_ID))
    })

    await runtime.applyLayoutCommand({
      type: 'renameTab',
      workspace: TEST_WORKTREE_ID,
      tabId: SURFACE_TAB_ID,
      kind: 'custom',
      title: 'Build'
    })
    await vi.runAllTimersAsync()
    // The window republishes its older snapshot, which still lists the closed tab.
    const older = windowPublication()
    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [
        {
          ...older,
          snapshotVersion: 2,
          tabs: [
            ...older.tabs,
            ...held.tabs.filter((tab) => parentTabsOf({ tabs: [tab] }).includes(SECOND_TAB_ID))
          ]
        }
      ]
    })
    await vi.runAllTimersAsync()

    expect(parentTabsOf(await listed(runtime))).not.toContain(SECOND_TAB_ID)
  })

  it('a workspace on an unloaded SSH host keeps the rows its window published', async () => {
    const { runtime } = surfaceRuntime()
    await windowedPhone(runtime)
    const before = runtime.mobileSessionTabsByWorktree.get(UNLOADED_SSH_ROWS.worktree)

    await runtime.applyLayoutCommand({
      type: 'renameTab',
      workspace: TEST_WORKTREE_ID,
      tabId: SURFACE_TAB_ID,
      kind: 'custom',
      title: 'Build'
    })
    await vi.runAllTimersAsync()
    runtime.storeMobileSessionSnapshot(UNLOADED_SSH_ROWS.worktree, {
      ...UNLOADED_SSH_ROWS,
      snapshotVersion: 2
    })

    expect(before?.tabs.map((tab) => tab.id)).toEqual(['ssh-tab::ssh-leaf'])
    const after = runtime.mobileSessionTabsByWorktree.get(UNLOADED_SSH_ROWS.worktree)
    expect(after?.tabs).toEqual(UNLOADED_SSH_ROWS.tabs)
    expect(after?.tabGroups).toEqual(UNLOADED_SSH_ROWS.tabGroups)
  })

  it("after the window closes, main's later moves reach the phone, as no-window rows", async () => {
    const { runtime } = threeTabSurfaceRuntime()
    const seen = await windowedPhone(runtime)
    runtime.markGraphUnavailable(1)
    await vi.runAllTimersAsync()

    await moveAndSplitTabs(runtime)
    await vi.runAllTimersAsync()

    expect(tabStrip(seen.at(-1))).toEqual(MOVED_STRIP)
    expect(tabStrip(await listed(runtime))).toEqual(MOVED_STRIP)
  })
})
