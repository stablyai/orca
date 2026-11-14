// Phones/paired desktops must project main layout after create/close/rename despite stale window rows; rows arrive with the window's next publication.
import { describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsSnapshot } from '../../../shared/runtime-session-contracts'
import '../../../shared/runtime-types'
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
  SAVED_GROUP_ID,
  SAVED_STRIP,
  moveAndSplitTabs,
  tabStrip,
  threeTabSurfaceRuntime
} from './session-tabs-layout-moves.test-fixture'

vi.mock('../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

const row = (leafId: string) => `${SURFACE_TAB_ID}::${leafId}`

/** The window's publication as it was before main's change: both panes, the old title. */
function stalePublication(
  version: number,
  activeLeafId: string = HEADLESS_LEAF_ID
): RuntimeMobileSessionTabsSnapshot {
  const tabs = [HEADLESS_LEAF_ID, HEADLESS_SECOND_LEAF_ID].map((leafId) => ({
    type: 'terminal' as const,
    id: row(leafId),
    title: 'Persisted Terminal',
    parentTabId: SURFACE_TAB_ID,
    leafId,
    isActive: leafId === activeLeafId
  }))
  return {
    worktree: TEST_WORKTREE_ID,
    publicationEpoch: 'renderer',
    snapshotVersion: version,
    activeGroupId: null,
    activeTabId: row(activeLeafId),
    activeTabType: 'terminal',
    tabs
  }
}

async function phoneRows(runtime: ReturnType<typeof surfaceRuntime>['runtime']) {
  const listed = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
  return listed.tabs.map((tab) => ({
    id: tab.id,
    title: tab.title,
    customTitle: tab.type === 'terminal' ? tab.customTitle : undefined
  }))
}

describe('session.tabs rows follow main’s layout (switch on)', () => {
  it('a tab main renamed before the window republished', async () => {
    const { runtime } = surfaceRuntime()
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [], mobileSessionTabs: [stalePublication(1)] })
    await runtime.applyLayoutCommand({
      type: 'renameTab',
      workspace: TEST_WORKTREE_ID,
      tabId: SURFACE_TAB_ID,
      kind: 'custom',
      title: 'Build'
    })
    runtime.syncWindowGraph(1, { tabs: [], leaves: [], mobileSessionTabs: [stalePublication(2)] })

    const rows = await phoneRows(runtime)
    expect(rows.map((entry) => [entry.title, entry.customTitle])).toEqual([
      ['Build', 'Build'],
      ['Build', 'Build']
    ])
  })

  it("a reorder and a move to a split main made, before the window's groups caught up", async () => {
    const { runtime } = threeTabSurfaceRuntime()
    runtime.attachWindow(1)
    const publication = (version: number): RuntimeMobileSessionTabsSnapshot => ({
      ...stalePublication(version),
      activeGroupId: SAVED_GROUP_ID,
      tabGroups: [{ id: SAVED_GROUP_ID, activeTabId: SURFACE_TAB_ID, tabOrder: SAVED_STRIP[0]! }]
    })
    runtime.syncWindowGraph(1, { tabs: [], leaves: [], mobileSessionTabs: [publication(1)] })
    await moveAndSplitTabs(runtime)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [], mobileSessionTabs: [publication(2)] })

    expect(tabStrip(await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`))).toEqual(
      MOVED_STRIP
    )
  })
})
