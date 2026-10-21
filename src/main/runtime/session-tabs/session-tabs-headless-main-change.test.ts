// A windowless server (orca serve, orcad): a change main makes to its own layout reaches a
// subscribed phone, with no window to republish rows. Rows there are rebuilt from the saved layout
// main writes (mobile-session-hydration.ts), not by A2's merge, which needs a window publication.
import { describe, expect, it, vi } from 'vitest'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../../shared/runtime-types'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-session-contracts'
import { TEST_WORKTREE_ID } from '../orca-runtime-test-fixtures.spec'
import {
  SURFACE_TAB_ID,
  surfaceRuntime
} from '../terminal/surface/terminal-surface-replies.test-fixture'

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
})
