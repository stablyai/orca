import { describe, expect, it, vi } from 'vitest'

import { spawnWorktreeTarget } from '../../../../shared/worktree/host-qualified-identity'

import type { RuntimeClientEvent } from '../../../../shared/runtime-client-events'

// Fragments stay side-effect ordered: mocks, then lifecycle, then fixtures.
await import('../../orca-runtime-tests/runtime-test-module-registration.spec')
const { OrcaRuntimeService } = await import('../../orca-runtime')
await import('../../orca-runtime-tests/orca-runtime-test-lifecycle.spec')
const {
  TEST_WORKTREE_ID,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} = await import('../../orca-runtime-tests/orca-runtime-test-fixtures.spec')

async function makeRuntime() {
  const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
    makeWorkspaceSessionWithHeadlessTerminal()
  )
  const runtime = new OrcaRuntimeService(runtimeStore)
  runtime.setPtyController({
    spawn: vi.fn().mockResolvedValue({ id: 'pty-1' }),
    write: () => true,
    kill: () => false,
    stopAndWait: async () => true,
    getForegroundProcess: async () => null,
    listProcesses: async () => []
  })
  await runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
  const events: RuntimeClientEvent[] = []
  runtime.onClientEvent((event) => events.push(event))
  const sleepPhases = (): string[] =>
    events.flatMap((event) => (event.type === 'worktreeTerminalSleepState' ? [event.phase] : []))
  return { runtime, runtimeStore, sleepPhases }
}

describe('owned-session teardown policy', () => {
  it('sleeps the terminals on the host when no renderer can run the sleep flow', async () => {
    const { runtime, sleepPhases } = await makeRuntime()

    await runtime.sleepManagedWorktree(`id:${TEST_WORKTREE_ID}`)

    expect(sleepPhases()[0]).toBe('started')
    await expect(
      runtime.acquireWorktreeTerminalSpawn(spawnWorktreeTarget(TEST_WORKTREE_ID, null), {
        refuseSleptWorktree: true
      })
    ).rejects.toThrow()
  })

  it('never reports a headless sleep whose stop is unproven as done', async () => {
    const { runtime } = await makeRuntime()
    vi.spyOn(runtime, 'sleepTerminalsForWorktree').mockResolvedValue({
      stopped: 0,
      stoppedPtyIds: [],
      livePtyIds: ['pty-1'],
      postStopVerified: false,
      postStopFailure: 'terminal_worktree_sleep_still_live',
      remainingLivePtyIds: ['pty-1']
    })

    await expect(runtime.sleepManagedWorktree(`id:${TEST_WORKTREE_ID}`)).rejects.toThrow(
      'terminal_worktree_sleep_still_live'
    )
  })

  it("stops every project workspace's terminals under one deadline, not one after another", async () => {
    const { runtime, runtimeStore } = await makeRuntime()
    const [repo] = runtimeStore.getRepos()
    const slow = `${repo.id}::/slow`
    const fast = `${repo.id}::/fast`
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the sweep reads only id and repoId.
    const worktrees = new Map([slow, fast].map((id) => [id, { id, repoId: repo.id }])) as never
    vi.spyOn(runtime, 'getResolvedWorktreeMap').mockResolvedValue(worktrees)
    const stop = vi.spyOn(runtime, 'stopTerminalsForWorktree').mockImplementation(
      async (selector) =>
        await new Promise<{ stopped: number }>((resolve) => {
          // The slow workspace's provider never answers; the fast one takes a moment.
          if (selector === `id:${fast}`) {
            setTimeout(() => resolve({ stopped: 1 }), 20)
          }
        })
    )

    const result = await runtime.stopTerminalsForProject(repo, { deadline: Date.now() + 500 })

    expect(stop.mock.calls.map(([selector]) => selector).sort()).toEqual([
      `id:${fast}`,
      `id:${slow}`
    ])
    expect(result.stopped).toBe(1)
  })
})
