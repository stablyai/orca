// Main-owned layout changes must reach subscribed phones without a window to republish rows.
import { describe, expect, it, vi } from 'vitest'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../../shared/runtime-session-contracts'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-session-contracts'
import { TEST_WORKTREE_ID } from '../orca-runtime-tests/orca-runtime-test-fixtures.spec'
import {
  SURFACE_TAB_ID,
  surfaceRuntime
} from '../terminal/surface/terminal-surface-replies.test-fixture'
import {
  MOVED_STRIP,
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
})
