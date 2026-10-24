// A windowless server (orca serve, orcad): a change main makes to its own layout reaches a
// subscribed phone, with no window to republish rows.
import { describe, expect, it, vi } from 'vitest'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../../shared/runtime-types'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-session-contracts'
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
  SAVED_GROUP_ID,
  SAVED_STRIP,
  moveAndSplitTabs,
  tabStrip,
  threeTabSurfaceRuntime
} from './session-tabs-layout-moves.test-fixture'

vi.mock('../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

describe('session.tabs on a windowless server (switch on)', () => {
  it("a tab main renames reaches a subscribed phone's rows", async () => {
    vi.useFakeTimers()
    try {
      const { runtime } = surfaceRuntime()
      runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
      await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
      const seen: RuntimeMobileSessionTabsResult[] = []
      runtime.onMobileSessionTabsChanged((snapshot) => {
        seen.push(snapshot)
      })

      await runtime.applyLayoutCommand({
        type: 'renameTab',
        workspace: TEST_WORKTREE_ID,
        tabId: SURFACE_TAB_ID,
        kind: 'custom',
        title: 'Build'
      })
      await vi.runAllTimersAsync()

      // Pushed by main on its own, before any phone asks again.
      expect(seen.at(-1)?.tabs.map((tab) => tab.title)).toEqual(['Build', 'Build'])
      const listed = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
      expect(listed.tabs.map((tab) => tab.title)).toEqual(['Build', 'Build'])
    } finally {
      vi.useRealTimers()
    }
  })

  it("a reorder and a move to a split follow main's layout, listed and pushed", async () => {
    vi.useFakeTimers()
    try {
      const { runtime } = threeTabSurfaceRuntime()
      runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
      expect(tabStrip(await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`))).toEqual(
        SAVED_STRIP
      )
      const seen: RuntimeMobileSessionTabsResult[] = []
      runtime.onMobileSessionTabsChanged((snapshot) => {
        seen.push(snapshot)
      })

      await moveAndSplitTabs(runtime)
      await vi.runAllTimersAsync()

      // Pushed by main on its own, and listed, with no window to republish.
      expect(tabStrip(seen.at(-1))).toEqual(MOVED_STRIP)
      const listed = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
      expect(tabStrip(listed)).toEqual(MOVED_STRIP)
      // A second ask changes nothing: the merge is settled.
      const again = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
      expect(again.snapshotVersion).toBe(listed.snapshotVersion)
    } finally {
      vi.useRealTimers()
    }
  })

  it("a pane main renames shows main's title on the phone, with no window", async () => {
    vi.useFakeTimers()
    try {
      const { runtime } = surfaceRuntime()
      runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
      await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

      await runtime.applyLayoutCommand({
        type: 'renamePane',
        workspace: TEST_WORKTREE_ID,
        tabId: SURFACE_TAB_ID,
        leafId: HEADLESS_SECOND_LEAF_ID,
        title: 'Logs'
      })
      await vi.runAllTimersAsync()

      const held = runtime.mobileSessionTabsByWorktree.get(TEST_WORKTREE_ID)
      expect(held?.tabs.map((tab) => [tab.id.split('::')[1], tab.title])).toEqual([
        [HEADLESS_LEAF_ID, 'Persisted Terminal'],
        [HEADLESS_SECOND_LEAF_ID, 'Logs']
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('a list call on settled rows bumps no version and pushes nothing', async () => {
    vi.useFakeTimers()
    try {
      const { runtime, store, setSession } = threeTabSurfaceRuntime()
      // A terminal the server started, saved in the session main's layout came from.
      const session = store.getSession()
      const saved = session.tabsByWorktree[TEST_WORKTREE_ID] ?? []
      const [first] = saved
      if (!first) {
        throw new Error('threeTabSurfaceRuntime saves three tabs')
      }
      const serveTab = { ...first, id: 'serve-tab', ptyId: 'serve-1', sortOrder: 3, createdAt: 9 }
      const serveLeaf = '99999999-9999-4999-8999-999999999999'
      setSession({
        ...session,
        tabsByWorktree: { [TEST_WORKTREE_ID]: [...saved, serveTab] },
        terminalLayoutsByTabId: {
          ...session.terminalLayoutsByTabId,
          [serveTab.id]: {
            root: { type: 'leaf', leafId: serveLeaf },
            activeLeafId: serveLeaf,
            expandedLeafId: null,
            ptyIdsByLeafId: { [serveLeaf]: 'serve-1' }
          }
        }
      })
      runtime.registerPty('serve-1', TEST_WORKTREE_ID)
      runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
      await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
      await vi.runAllTimersAsync()
      const settled = runtime.mobileSessionTabsByWorktree.get(TEST_WORKTREE_ID)
      let pushes = 0
      runtime.onMobileSessionTabsChanged(() => {
        pushes += 1
      })

      for (let ask = 0; ask < 3; ask += 1) {
        await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
        await runtime.listAllMobileSessionTabs()
        await vi.runAllTimersAsync()
      }

      expect(settled?.tabs.some((tab) => tab.id.startsWith('serve-tab::'))).toBe(true)
      expect(runtime.mobileSessionTabsByWorktree.get(TEST_WORKTREE_ID)?.snapshotVersion).toBe(
        settled?.snapshotVersion
      )
      expect(pushes).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it("a rebuild from the saved session pushes main's groups and mints no version", async () => {
    vi.useFakeTimers()
    try {
      const { runtime } = threeTabSurfaceRuntime()
      runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
      await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
      await vi.runAllTimersAsync()
      const settled = runtime.mobileSessionTabsByWorktree.get(TEST_WORKTREE_ID)
      const seen: RuntimeMobileSessionTabsResult[] = []
      runtime.onMobileSessionTabsChanged((snapshot) => {
        seen.push(snapshot)
      })

      // What an editor change does: rebuild the rows from the saved session, then push. Each
      // rebuild mints a new publication stamp from the clock, so time moves between them.
      for (let rebuild = 0; rebuild < 3; rebuild += 1) {
        vi.advanceTimersByTime(1_000)
        runtime.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(TEST_WORKTREE_ID, {
          force: true
        })
        runtime.notifyMobileSessionTabsChanged(TEST_WORKTREE_ID)
        await vi.runAllTimersAsync()
      }

      expect(seen.map((pushed) => pushed.tabGroups?.map((group) => group.id))).toEqual([
        [SAVED_GROUP_ID],
        [SAVED_GROUP_ID],
        [SAVED_GROUP_ID]
      ])
      expect(tabStrip(seen.at(-1))).toEqual(SAVED_STRIP)
      // A list after that rebuild serves main's groups too, through the writer.
      const listed = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
      expect(listed.tabGroups?.map((group) => group.id)).toEqual([SAVED_GROUP_ID])
      expect(tabStrip(listed)).toEqual(SAVED_STRIP)
      expect(runtime.mobileSessionTabsByWorktree.get(TEST_WORKTREE_ID)?.snapshotVersion).toBe(
        settled?.snapshotVersion
      )
    } finally {
      vi.useRealTimers()
    }
  })
})
