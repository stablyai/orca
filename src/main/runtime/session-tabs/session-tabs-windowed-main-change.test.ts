// Main layout changes must reach subscribed phones even without another attached-window publication.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTabsSnapshot
} from '../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import {
  HEADLESS_LEAF_ID,
  HEADLESS_SECOND_LEAF_ID,
  TEST_WORKTREE_ID
} from '../orca-runtime-tests/orca-runtime-test-fixtures.spec'
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

vi.mock('../../../shared/workspace-layout/layout-owner-switch', () => ({
  ORCA_LAYOUT_OWNER_IS_MAIN: true
}))

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
  await runtime.syncWindowGraph(1, {
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
