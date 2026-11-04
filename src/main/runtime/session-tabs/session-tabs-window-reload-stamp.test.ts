// Store new reload publication stamps even for identical rows so unchanged syncs need no republish.
import { describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsSnapshot } from '../../../shared/runtime-session-contracts'
import {
  HEADLESS_LEAF_ID,
  HEADLESS_SECOND_LEAF_ID,
  TEST_WORKTREE_ID
} from '../orca-runtime-test-fixtures.spec'
import { SURFACE_TAB_ID } from '../terminal/surface/terminal-surface-replies.test-fixture'
import {
  SAVED_GROUP_ID,
  SECOND_TAB_ID,
  THIRD_TAB_ID,
  threeTabSurfaceRuntime
} from './session-tabs-layout-moves.test-fixture'

vi.mock('../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

const terminalRow = (parentTabId: string, leafId: string, isActive = false) => ({
  type: 'terminal' as const,
  id: `${parentTabId}::${leafId}`,
  title: 'Persisted Terminal',
  parentTabId,
  leafId,
  isActive
})

/** Window browser rows have a separate group; main groups them after terminals, producing order-only differences. */
function windowRows(publicationEpoch: string): RuntimeMobileSessionTabsSnapshot {
  return {
    worktree: TEST_WORKTREE_ID,
    publicationEpoch,
    snapshotVersion: 1,
    activeGroupId: SAVED_GROUP_ID,
    activeTabId: `${SURFACE_TAB_ID}::${HEADLESS_LEAF_ID}`,
    activeTabType: 'terminal',
    tabGroups: [
      {
        id: SAVED_GROUP_ID,
        activeTabId: SURFACE_TAB_ID,
        tabOrder: [SURFACE_TAB_ID, SECOND_TAB_ID, THIRD_TAB_ID]
      },
      { id: 'window-group', activeTabId: 'browser-1', tabOrder: ['browser-1'] }
    ],
    tabs: [
      terminalRow(SURFACE_TAB_ID, HEADLESS_LEAF_ID, true),
      terminalRow(SURFACE_TAB_ID, HEADLESS_SECOND_LEAF_ID),
      {
        type: 'browser',
        id: 'browser-1',
        title: 'Page',
        browserWorkspaceId: 'browser-1',
        browserPageId: null,
        url: 'https://example.com',
        loading: false,
        canGoBack: false,
        canGoForward: false,
        isActive: false
      },
      terminalRow(SECOND_TAB_ID, '77777777-7777-4777-8777-777777777777'),
      terminalRow(THIRD_TAB_ID, '88888888-8888-4888-8888-888888888888')
    ]
  }
}

describe('a window reload with the same rows (switch on)', () => {
  it('stores the new stamp, so the next unchanged sync asks for no republish', () => {
    const { runtime } = threeTabSurfaceRuntime()
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [], mobileSessionTabs: [windowRows('R1')] })

    // The reload: the same rows under a new stamp.
    runtime.syncWindowGraph(1, { tabs: [], leaves: [], mobileSessionTabs: [windowRows('R2')] })
    const next = runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      unchangedMobileSessionWorktrees: [TEST_WORKTREE_ID]
    })

    expect(runtime.mobileSessionTabsByWorktree.get(TEST_WORKTREE_ID)?.publicationEpoch).toBe('R2')
    expect(next.mobileSessionResyncWorktrees).toBeUndefined()
  })
})
