import { describe, expect, it, vi } from 'vitest'
import { setupLayoutOwnerRuntime, WORKTREE_ID } from '../../orca-runtime-layout-owner-start-fixture'

// Why: pinned off, so a run with ORCA_LAYOUT_OWNER=main still checks the switch-off refusal.
vi.mock('../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: false }))

describe("the window's new-tab start with the layout-owner build off", () => {
  it('is refused, starting nothing, so the window starts its tab as today', async () => {
    const { runtime, spawn } = setupLayoutOwnerRuntime()

    await expect(
      runtime.startWindowTabTerminal(WORKTREE_ID, { tabId: 'tab', leafId: 'leaf' }, {})
    ).rejects.toThrow('host_not_owned')
    expect(spawn).not.toHaveBeenCalled()
  })
})
