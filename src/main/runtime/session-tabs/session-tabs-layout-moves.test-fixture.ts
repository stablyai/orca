// Model desktop reorder/split layout commands; session.tabs must list the resulting main-owned groups/order.
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-session-contracts'
import { TEST_WORKTREE_ID } from '../orca-runtime-test-fixtures.spec'
import {
  SURFACE_TAB_ID,
  surfaceRuntime
} from '../terminal/surface/terminal-surface-replies.test-fixture'

export const SECOND_TAB_ID = '55555555-5555-4555-8555-555555555555'
export const THIRD_TAB_ID = '66666666-6666-4666-8666-666666666666'
const ADDED_TABS = [
  { id: SECOND_TAB_ID, leafId: '77777777-7777-4777-8777-777777777777' },
  { id: THIRD_TAB_ID, leafId: '88888888-8888-4888-8888-888888888888' }
]
export const SAVED_GROUP_ID = 'group-a'

/** Each group's tab order, as saved: one group. */
export const SAVED_STRIP = [[SURFACE_TAB_ID, SECOND_TAB_ID, THIRD_TAB_ID]]
/** After moveAndSplitTabs: the third tab first, the second in a split of its own. */
export const MOVED_STRIP = [[THIRD_TAB_ID, SURFACE_TAB_ID], [SECOND_TAB_ID]]

export const tabStrip = (listed: RuntimeMobileSessionTabsResult | undefined): string[][] =>
  (listed?.tabGroups ?? []).map((group) => group.tabOrder)

/** The fixture's split tab plus two single-pane tabs, all in one saved group. */
export function threeTabSurfaceRuntime(): ReturnType<typeof surfaceRuntime> {
  const harness = surfaceRuntime()
  const session = harness.store.getSession()
  const [first] = session.tabsByWorktree[TEST_WORKTREE_ID] ?? []
  if (!first) {
    throw new Error('surfaceRuntime saves one tab')
  }
  const extra = ADDED_TABS.map(({ id }, index) => ({
    ...first,
    id,
    ptyId: null,
    sortOrder: index + 1,
    createdAt: index + 2
  }))
  harness.setSession({
    ...session,
    tabsByWorktree: { [TEST_WORKTREE_ID]: [first, ...extra] },
    terminalLayoutsByTabId: {
      ...session.terminalLayoutsByTabId,
      ...Object.fromEntries(
        ADDED_TABS.map(({ id, leafId }) => [
          id,
          { root: { type: 'leaf' as const, leafId }, activeLeafId: leafId, expandedLeafId: null }
        ])
      )
    },
    tabGroups: {
      [TEST_WORKTREE_ID]: [
        {
          id: SAVED_GROUP_ID,
          worktreeId: TEST_WORKTREE_ID,
          activeTabId: SURFACE_TAB_ID,
          tabOrder: SAVED_STRIP[0]!
        }
      ]
    },
    activeGroupIdByWorktree: { [TEST_WORKTREE_ID]: SAVED_GROUP_ID }
  })
  return harness
}

/** A desktop's drag of the third tab to the front, then Move Tab to Split (right) on the second. */
export async function moveAndSplitTabs(
  runtime: ReturnType<typeof surfaceRuntime>['runtime']
): Promise<void> {
  await runtime.applyLayoutCommand({
    type: 'moveTab',
    workspace: TEST_WORKTREE_ID,
    tabId: THIRD_TAB_ID,
    toGroupId: SAVED_GROUP_ID,
    index: 0
  })
  await runtime.applyLayoutCommand({
    type: 'splitGroup',
    workspace: TEST_WORKTREE_ID,
    tabId: SECOND_TAB_ID,
    besideGroupId: SAVED_GROUP_ID,
    direction: 'right'
  })
}
