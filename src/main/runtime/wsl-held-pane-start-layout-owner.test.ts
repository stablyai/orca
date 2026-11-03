// A background start held for a stopped WSL distro publishes `failed` with the hold, and Start starts it as the user.
import { describe, expect, it, vi } from 'vitest'
import { wslDistroHoldMessage } from '../../shared/wsl-distro-stopped-hold'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../shared/execution-host'
import { committingSpawn } from './bind-first-pane.test-fixture'

vi.mock('../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

// Preserve side-effect order: mocks, lifecycle, fixtures.
const { OrcaRuntimeService } = await import('./orca-runtime-test-mocks.spec')
await import('./orca-runtime-test-lifecycle.spec')
const {
  HEADLESS_LEAF_ID,
  TEST_WORKTREE_ID,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} = await import('./orca-runtime-test-fixtures.spec')

const PANE = { worktreeId: TEST_WORKTREE_ID, tabId: 'host-tab', leafId: HEADLESS_LEAF_ID }
const HOLD = wslDistroHoldMessage('Ubuntu', 'stopped')

type SpawnArgs = {
  sessionId?: string
  worktreeId?: string
  tabId?: string
  leafId?: string
  wslUserAct?: true
}

async function heldPaneRuntime() {
  const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
    makeWorkspaceSessionWithHeadlessTerminal()
  )
  const runtime = new OrcaRuntimeService(
    Object.assign(runtimeStore, {
      getWorkspaceSessionHostIds: (): ExecutionHostId[] => [LOCAL_EXECUTION_HOST_ID]
    })
  )
  runtime.subscribeWorkspaceLayouts(() => {})
  const spawn = vi.fn(committingSpawn(runtime, async (_args: SpawnArgs) => ({ id: 'pty-started' })))
  spawn.mockRejectedValueOnce(new Error(HOLD))
  runtime.setPtyController({
    spawn,
    write: () => true,
    kill: () => false,
    stopAndWait: async () => true,
    getForegroundProcess: async () => null,
    listProcesses: async () => []
  })
  runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
  await expect(runtime.ensureRestoredPaneStarted(PANE)).rejects.toThrow(HOLD)
  return { runtime, spawn }
}

function publishedPane(runtime: InstanceType<typeof OrcaRuntimeService>) {
  const { snapshot, unsubscribe } = runtime.subscribeWorkspaceLayouts(() => {})
  unsubscribe()
  return snapshot
    .find((entry) => entry.key === TEST_WORKTREE_ID)
    ?.layout.tabs.flatMap((tab) => tab.terminal?.panes ?? [])
    .find((pane) => pane.leafId === HEADLESS_LEAF_ID)
}

describe('a pane main held for a stopped WSL distro (layout-owner build)', () => {
  it('publishes failed, not held, so older desktops never offer the newer-build Reopen', async () => {
    const { runtime, spawn } = await heldPaneRuntime()

    expect(publishedPane(runtime)).toMatchObject({ status: 'failed', statusReason: HOLD })
    // Main's own start is background work: it never names the user's act.
    expect(spawn.mock.calls[0]?.[0]).not.toHaveProperty('wslUserAct')
  })

  it("starts as the user's act on Start, and the failure clears", async () => {
    const { runtime, spawn } = await heldPaneRuntime()

    await expect(runtime.startWslHeldTerminalPanes([PANE])).resolves.toEqual({ started: true })

    expect(spawn).toHaveBeenCalledTimes(2)
    expect(spawn).toHaveBeenLastCalledWith(expect.objectContaining({ wslUserAct: true }))
    expect(publishedPane(runtime)?.status).toBeUndefined()
  })
})
