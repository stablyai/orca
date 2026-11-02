// #24399: a plain shell pane has no agent sleep record, so only the host's sleep state proves it was slept.
import { describe, expect, it, vi } from 'vitest'
import type { RuntimeClientEvent } from '../../shared/runtime-client-events'

// Fragments stay side-effect ordered: mocks, then lifecycle, then fixtures.
const { OrcaRuntimeService } = await import('./orca-runtime-test-mocks.spec')
await import('./orca-runtime-test-lifecycle.spec')
const {
  HEADLESS_LEAF_ID,
  TEST_WORKTREE_ID,
  deferred,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} = await import('./orca-runtime-test-fixtures.spec')

function makeRuntime(listProcesses: () => Promise<never[]> = async () => []) {
  const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
    makeWorkspaceSessionWithHeadlessTerminal()
  )
  const runtime = new OrcaRuntimeService(runtimeStore)
  const spawn = vi.fn().mockResolvedValue({ id: 'persisted-pty' })
  runtime.setPtyController({
    spawn,
    write: () => true,
    kill: () => false,
    stopAndWait: async () => true,
    getForegroundProcess: async () => null,
    listProcesses
  })
  runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
  const events: RuntimeClientEvent[] = []
  runtime.onClientEvent((event) => events.push(event))
  const sleepPhases = (): string[] =>
    events.flatMap((event) => (event.type === 'worktreeTerminalSleepState' ? [event.phase] : []))
  return { runtime, spawn, sleepPhases }
}

function activate(runtime: InstanceType<typeof OrcaRuntimeService>, intent: 'user' | 'automatic') {
  return runtime.activateMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab', HEADLESS_LEAF_ID, {
    notifyClients: false,
    navigation: 'caller',
    intent
  })
}

describe('automatic tab activation honors the host sleep state', () => {
  it('refuses an automatic probe for a slept worktree and still wakes on a user tap', async () => {
    const { runtime, spawn, sleepPhases } = makeRuntime()
    await runtime.sleepTerminalsForWorktree(`id:${TEST_WORKTREE_ID}`)

    const refused = await activate(runtime, 'automatic')

    expect(spawn).not.toHaveBeenCalled()
    expect(refused.tabs[0]).toMatchObject({ status: 'pending-handle', terminal: null })
    expect(sleepPhases()).not.toContain('woken')

    await activate(runtime, 'user')

    expect(spawn).toHaveBeenCalledOnce()
  })

  it('asks the spawn to refuse a slept worktree only for an automatic probe', async () => {
    const { runtime, spawn } = makeRuntime()

    await activate(runtime, 'automatic')

    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ refuseSleptWorktree: true }))
  })

  it('refuses under the spawn lock when a sleep commits while an automatic spawn waits', async () => {
    const inventory = deferred<never[]>()
    const listProcesses = vi.fn(() => inventory.promise)
    const { runtime, sleepPhases } = makeRuntime(listProcesses)
    const sleeping = runtime.sleepTerminalsForWorktree(`id:${TEST_WORKTREE_ID}`)
    await vi.waitFor(() => expect(listProcesses).toHaveBeenCalled())
    // Queued behind the sleep's exclusive hold, so the pre-spawn check has already passed.
    const automaticSpawn = runtime.acquireWorktreeTerminalSpawn(TEST_WORKTREE_ID, {
      refuseSleptWorktree: true
    })
    inventory.resolve([])

    await expect(sleeping).resolves.toBeDefined()
    await expect(automaticSpawn).rejects.toThrow('worktree_terminals_sleeping')
    expect(sleepPhases()).not.toContain('woken')
    // The refusal released the lock, so a user spawn still proceeds and wakes.
    const release = await runtime.acquireWorktreeTerminalSpawn(TEST_WORKTREE_ID)
    release()
    expect(sleepPhases()).toContain('woken')
  })
})
