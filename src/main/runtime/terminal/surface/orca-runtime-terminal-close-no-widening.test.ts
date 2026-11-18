import { describe, expect, it } from 'vitest'
import '../../../../shared/workspace-layout/layout-owner-switch'
import {
  LEAF_ID,
  PTY_ID,
  TAB_ID,
  WORKTREE_ID
} from '../../__fixtures__/orca-runtime-terminal-close-continuity-state-fixture'
import { createHarness } from '../../__fixtures__/orca-runtime-terminal-close-continuity-fixtures'
import '../../__fixtures__/main-layout-close-fixture'

import './mobile-session-terminal-persistence-retirement'

/** All explicit pane-close paths must retain live siblings and send no tab-level close. */

// L255: expected main-owned headless phone-close widening until its fix lands.

/** Last-pane tab close uses legacy renderer acknowledgement or main-owned layout without renderer notice. */

describe("a close of a tab's last pane still closes the tab", () => {
  it('on a host with no desktop window, closes the whole tab in main and for paired clients', async () => {
    const harness = await createHarness({ publishMobileSurface: true, registerPtyBacked: true })
    harness.runtime.setNotifier(null)
    await harness.syncEmptyGraph()

    await harness.runtime.closeMobileSessionTab(`id:${WORKTREE_ID}`, `${TAB_ID}::${LEAF_ID}`, {
      reason: 'user'
    })

    expect(harness.getSession().tabsByWorktree[WORKTREE_ID]).toEqual([])
    expect((await harness.runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)).tabs).toEqual([])
    expect(harness.kill).toHaveBeenCalledWith(PTY_ID)
  })
})
