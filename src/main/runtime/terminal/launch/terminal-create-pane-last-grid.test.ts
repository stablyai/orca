import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService, getDefaultWorkspaceSession } from '../../orca-runtime-test-mocks.spec'
import '../../orca-runtime-test-lifecycle.spec'
import {
  TEST_WORKTREE_ID,
  makeRuntimeStoreWithWorkspaceSession
} from '../../orca-runtime-test-fixtures.spec'

vi.mock('../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

const LEAF = '11111111-1111-4111-8111-111111111111'

function runtimeWithSavedGrid() {
  const spawn = vi.fn().mockResolvedValue({ id: 'pty-held' })
  const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession({
    ...getDefaultWorkspaceSession(),
    activeGroupIdByWorktree: { [TEST_WORKTREE_ID]: 'group-active' },
    terminalLayoutsByTabId: {
      'tab-held': {
        root: { type: 'leaf', leafId: LEAF },
        activeLeafId: LEAF,
        expandedLeafId: null,
        lastGridsByLeafId: { [LEAF]: { cols: 91, rows: 33 } }
      }
    }
  })
  const runtime = new OrcaRuntimeService(runtimeStore)
  runtime.setPtyController({
    spawn,
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  })
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, {
    tabs: [],
    leaves: [],
    terminalGroupGridSizes: { 'group-active': { cols: 63, rows: 60 } }
  })
  return { runtime, spawn }
}

describe('a pane main holds starts at its last grid (layout-owner build)', () => {
  it('before its group size', async () => {
    const { runtime, spawn } = runtimeWithSavedGrid()

    await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, { tabId: 'tab-held', leafId: LEAF })

    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ cols: 91, rows: 33 }))
  })

  it("after a caller's own measured pane", async () => {
    const { runtime, spawn } = runtimeWithSavedGrid()

    await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'tab-held',
      leafId: LEAF,
      initialSize: { cols: 101, rows: 30 }
    })

    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ cols: 101, rows: 30 }))
  })
})
