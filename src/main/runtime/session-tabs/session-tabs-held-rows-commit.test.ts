// A windowless server's held session.tabs rows across main's layout commits: what a commit keeps,
// what it pushes, and which writes the row writer may skip.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../../shared/runtime-session-contracts'
import {
  HEADLESS_LEAF_ID,
  TEST_WORKTREE_ID
} from '../orca-runtime-tests/orca-runtime-test-fixtures.spec'
import {
  SURFACE_TAB_ID,
  surfaceRuntime
} from '../terminal/surface/terminal-surface-replies.test-fixture'
import './session-tabs-layout-moves.test-fixture'

vi.mock('../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

type Runtime = ReturnType<typeof surfaceRuntime>['runtime']

const held = (runtime: Runtime) => runtime.mobileSessionTabsByWorktree.get(TEST_WORKTREE_ID)

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
