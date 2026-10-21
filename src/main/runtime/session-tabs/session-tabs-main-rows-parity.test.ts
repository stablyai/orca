// Phone-mirror parity (flip step 7) against main's projection: with the switch on, the rows a
// phone or paired desktop reads for a workspace main owns follow main's layout after a create, a
// close and a rename, whatever rows the window's next publication still carries. Main's rows land
// with that publication (the window republishes after each layout frame), not before it.
import { describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsSnapshot } from '../../../shared/runtime-session-contracts'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../../shared/runtime-types'
import {
  HEADLESS_LEAF_ID,
  HEADLESS_SECOND_LEAF_ID,
  HEADLESS_THIRD_LEAF_ID,
  TEST_WORKTREE_ID
} from '../orca-runtime-test-fixtures.spec'
import {
  SURFACE_TAB_ID,
  surfaceRuntime
} from '../terminal/surface/terminal-surface-replies.test-fixture'

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

async function phoneActiveRow(runtime: ReturnType<typeof surfaceRuntime>['runtime']) {
  return (await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).activeTabId
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
  it('a pane main split in, and a pane main closed, before the window republished', async () => {
    const { runtime, store, setSession } = surfaceRuntime()
    runtime.attachWindow(1)
    const session = store.getSession()
    const layout = session.terminalLayoutsByTabId[SURFACE_TAB_ID]!
    setSession({
      ...session,
      terminalLayoutsByTabId: {
        [SURFACE_TAB_ID]: {
          ...layout,
          root: {
            type: 'split',
            direction: 'vertical',
            first: { type: 'leaf', leafId: HEADLESS_LEAF_ID },
            second: { type: 'leaf', leafId: HEADLESS_THIRD_LEAF_ID }
          }
        }
      }
    })
    runtime.syncWindowGraph(1, { tabs: [], leaves: [], mobileSessionTabs: [stalePublication(1)] })

    const rows = await phoneRows(runtime)
    expect(rows.map((entry) => entry.id)).toEqual([
      row(HEADLESS_LEAF_ID),
      row(HEADLESS_THIRD_LEAF_ID)
    ])
  })

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

  it("save or view lands after publication: the phone's row updates", async () => {
    const { runtime, store, setSession } = surfaceRuntime()
    runtime.attachWindow(1)
    // The user focuses the second pane: the window publishes at once, its save lands later.
    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [stalePublication(1, HEADLESS_SECOND_LEAF_ID)]
    })
    expect(await phoneActiveRow(runtime)).toBe(row(HEADLESS_SECOND_LEAF_ID))

    const session = store.getSession()
    const layout = session.terminalLayoutsByTabId[SURFACE_TAB_ID]!
    setSession({
      ...session,
      terminalLayoutsByTabId: {
        [SURFACE_TAB_ID]: { ...layout, activeLeafId: HEADLESS_SECOND_LEAF_ID }
      }
    })
    expect(await phoneActiveRow(runtime)).toBe(row(HEADLESS_SECOND_LEAF_ID))

    // Back to the first pane, published before its save: the phone follows the view.
    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [stalePublication(2, HEADLESS_LEAF_ID)]
    })
    expect(await phoneActiveRow(runtime)).toBe(row(HEADLESS_LEAF_ID))
  })

  it("with no window, rows follow main's saved view", async () => {
    const { runtime, store, setSession } = surfaceRuntime()
    runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
    const session = store.getSession()
    const layout = session.terminalLayoutsByTabId[SURFACE_TAB_ID]!
    setSession({
      ...session,
      terminalLayoutsByTabId: {
        [SURFACE_TAB_ID]: { ...layout, activeLeafId: HEADLESS_SECOND_LEAF_ID }
      }
    })

    expect(await phoneActiveRow(runtime)).toBe(row(HEADLESS_SECOND_LEAF_ID))
  })
})
