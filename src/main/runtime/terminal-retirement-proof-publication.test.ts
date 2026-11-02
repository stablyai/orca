import { expect, it } from 'vitest'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../shared/layout-owner-switch'
import {
  createStaleTabCloseHarness,
  WORKTREE_ID
} from './__fixtures__/orca-runtime-terminal-close-continuity-fixtures'

// L259a: switch-on bug waiting on its ledger row's fix (same stale headless close).
;(ORCA_LAYOUT_OWNER_IS_MAIN ? it.fails : it)(
  'keeps host retirement proof across a later renderer publication',
  async () => {
    const harness = await createStaleTabCloseHarness({ headless: true })
    await harness.runtime.closeTerminalTab(harness.terminal.handle)
    const before = await harness.runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)
    expect(before.retiredTerminalSurfaces).toHaveLength(1)

    harness.runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree: WORKTREE_ID,
          publicationEpoch: 'renderer:close-continuity',
          snapshotVersion: 100,
          activeGroupId: null,
          activeTabId: null,
          activeTabType: null,
          tabs: []
        }
      ]
    })
    const after = await harness.runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)
    expect(after.tabs).toEqual([])
    expect(after.retiredTerminalSurfaces).toEqual(before.retiredTerminalSurfaces)
  }
)
