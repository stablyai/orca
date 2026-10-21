// Layout-owner build: a sleep of a workspace main owns runs in main, window or not, and the window
// draws the slept panes from main's frames; a workspace main does not own still goes to the window.
import { describe, expect, it, vi } from 'vitest'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../shared/execution-host'
import type { RuntimeClientEvent } from '../../../shared/runtime-client-events'
import type { RuntimeNotifier } from '../runtime-notifier-contract'

vi.mock('../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

// Fragments stay side-effect ordered: mocks, then lifecycle, then fixtures.
const { OrcaRuntimeService } = await import('../orca-runtime-test-mocks.spec')
await import('../orca-runtime-test-lifecycle.spec')
const {
  TEST_WORKTREE_ID,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} = await import('../orca-runtime-test-fixtures.spec')

function sleepRuntime(hostIds: ExecutionHostId[]) {
  const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
    makeWorkspaceSessionWithHeadlessTerminal()
  )
  const runtime = new OrcaRuntimeService(
    Object.assign(runtimeStore, { getWorkspaceSessionHostIds: () => hostIds })
  )
  runtime.setPtyController({
    write: () => true,
    kill: () => false,
    stopAndWait: async () => true,
    getForegroundProcess: async () => null,
    listProcesses: async () => []
  })
  runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
  const sleepWorktree = vi.fn()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: sleepManagedWorktree reads only sleepWorktree.
  runtime.setNotifier({ sleepWorktree } as unknown as RuntimeNotifier)
  const events: RuntimeClientEvent[] = []
  runtime.onClientEvent((event) => events.push(event))
  const sleepPhases = (): string[] =>
    events.flatMap((event) => (event.type === 'worktreeTerminalSleepState' ? [event.phase] : []))
  return { runtime, sleepWorktree, sleepPhases }
}

describe('a worktree sleep in a layout-owner build, with a window attached', () => {
  it('sleeps a workspace main owns in main, not in the window', async () => {
    const { runtime, sleepWorktree, sleepPhases } = sleepRuntime([LOCAL_EXECUTION_HOST_ID])

    await runtime.sleepManagedWorktree(`id:${TEST_WORKTREE_ID}`)

    expect(sleepWorktree).not.toHaveBeenCalled()
    expect(sleepPhases()[0]).toBe('started')
  })

  it("leaves a paired server's workspace to the window, as today", async () => {
    const { runtime, sleepWorktree, sleepPhases } = sleepRuntime(['runtime:env-1'])

    await runtime.sleepManagedWorktree(`id:${TEST_WORKTREE_ID}`)

    expect(sleepWorktree).toHaveBeenCalledWith(TEST_WORKTREE_ID)
    expect(sleepPhases()).toEqual([])
  })
})
