// A windowless server's held session.tabs rows across main's layout commits: what a commit keeps,
// what it pushes, and which writes the row writer may skip.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../../shared/runtime-types'
import { HEADLESS_LEAF_ID, TEST_WORKTREE_ID } from '../orca-runtime-test-fixtures.spec'
import {
  SURFACE_TAB_ID,
  surfaceRuntime
} from '../terminal/surface/terminal-surface-replies.test-fixture'
import {
  MOVED_STRIP,
  THIRD_TAB_ID,
  moveAndSplitTabs,
  threeTabSurfaceRuntime
} from './session-tabs-layout-moves.test-fixture'

vi.mock('../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

type Runtime = ReturnType<typeof surfaceRuntime>['runtime']

const held = (runtime: Runtime) => runtime.mobileSessionTabsByWorktree.get(TEST_WORKTREE_ID)
const heldStrip = (runtime: Runtime): string[][] =>
  (held(runtime)?.tabGroups ?? []).map((group) => group.tabOrder)

/** The rows with whole tabs in reverse order, each tab's panes as they were. */
function tabsInReverseTabOrder<Row extends { type: string; id: string; parentTabId?: string }>(
  rows: readonly Row[]
): Row[] {
  const tabOf = (row: Row): string => row.parentTabId ?? row.id
  return [...new Set(rows.map(tabOf))]
    .toReversed()
    .flatMap((tab) => rows.filter((row) => tabOf(row) === tab))
}

async function windowlessRows(runtime: Runtime): Promise<void> {
  runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
  await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
  await vi.runAllTimersAsync()
}

describe('held session.tabs rows across layout commits (switch on)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  /** Three tabs moved and split, then the CLI closes the first: kept until L255's hook drops it. */
  async function closedFirstTab(): Promise<ReturnType<typeof threeTabSurfaceRuntime>> {
    const harness = threeTabSurfaceRuntime()
    await windowlessRows(harness.runtime)
    await moveAndSplitTabs(harness.runtime)
    await vi.runAllTimersAsync()
    expect(heldStrip(harness.runtime)).toEqual(MOVED_STRIP)
    await harness.runtime.applyLayoutCommand({
      type: 'closeTabs',
      workspace: TEST_WORKTREE_ID,
      tabIds: [THIRD_TAB_ID],
      force: true
    })
    await vi.runAllTimersAsync()
    return harness
  }

  it('a tab main closed keeps its group and place, not the active group', async () => {
    const { runtime } = await closedFirstTab()

    expect(heldStrip(runtime)).toEqual(MOVED_STRIP)
  })

  it("another workspace's commits push nothing for a workspace with a kept row", async () => {
    const { runtime } = await closedFirstTab()
    let pushes = 0
    runtime.onMobileSessionTabsChanged((snapshot) => {
      if (snapshot.worktree === TEST_WORKTREE_ID) {
        pushes += 1
      }
    })

    for (let commit = 0; commit < 3; commit += 1) {
      await runtime.applyLayoutCommand({
        type: 'createTerminalTab',
        workspace: 'repo-1::/tmp/worktree-b',
        tabId: `b-tab-${commit}`
      })
      await vi.runAllTimersAsync()
    }

    expect(pushes).toBe(0)
  })

  it("stores a write that names a new occupant or proof, though main's order undoes its order", async () => {
    const { runtime } = threeTabSurfaceRuntime()
    await windowlessRows(runtime)
    const before = held(runtime)
    if (!before) {
      throw new Error('the list built rows')
    }
    const proof = {
      parentTabId: 'gone',
      leafId: 'gone-leaf',
      ptyId: 'pty-gone',
      terminal: 'term-gone'
    }

    runtime.storeMobileSessionSnapshot(TEST_WORKTREE_ID, {
      ...before,
      worktreeInstanceId: 'successor',
      retiredTerminalSurfaces: [proof],
      tabs: tabsInReverseTabOrder(before.tabs)
    })

    expect(held(runtime)).toMatchObject({
      worktreeInstanceId: 'successor',
      retiredTerminalSurfaces: [proof]
    })
    // Main's order still holds.
    expect(held(runtime)?.tabs).toEqual(before.tabs)
  })

  it('a pane main rebound takes the new terminal once it connects, with no commit', async () => {
    const { runtime, bindPane } = surfaceRuntime()
    await windowlessRows(runtime)
    const rowId = `${SURFACE_TAB_ID}::${HEADLESS_LEAF_ID}`
    const ptyOf = () => {
      const row = held(runtime)?.tabs.find((tab) => tab.id === rowId)
      return row?.type === 'terminal' ? row.ptyId : undefined
    }

    await bindPane({
      worktreeId: TEST_WORKTREE_ID,
      tabId: SURFACE_TAB_ID,
      leafId: HEADLESS_LEAF_ID,
      ptyId: 'pty-new'
    })
    await vi.runAllTimersAsync()
    // Not running yet: the running terminal stands.
    expect(ptyOf()).toBe('pty-a')

    runtime.registerPty('pty-new', TEST_WORKTREE_ID, null, {
      tabId: SURFACE_TAB_ID,
      leafId: HEADLESS_LEAF_ID
    })
    await vi.runAllTimersAsync()

    expect(ptyOf()).toBe('pty-new')
  })
})
