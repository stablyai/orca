// Pins main's current launch behaviour as the convergence parity baseline: the host-side
// client-disconnect guards around createTerminal's spawn (runtime lane only).
import { describe, expect, it, vi } from 'vitest'

// Fragments stay side-effect ordered: mocks, then lifecycle, then fixtures.
const { OrcaRuntimeService } = await import('./orca-runtime-test-mocks.spec')
await import('./orca-runtime-test-lifecycle.spec')
const { HEADLESS_LEAF_ID, TEST_WORKTREE_ID, store } =
  await import('./orca-runtime-test-fixtures.spec')

const SPAWN_REACHED = 'spawn_reached'

function makeRuntime(adoptStablePane: () => Promise<null>) {
  const runtime = new OrcaRuntimeService(store)
  // Rejecting keeps the test at the spawn boundary; only what reached it matters here.
  const spawn = vi.fn(async (_args: Record<string, unknown>) => {
    throw new Error(SPAWN_REACHED)
  })
  runtime.setPtyController({
    adoptStablePane: vi.fn(adoptStablePane),
    spawn,
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  })
  return { runtime, spawn }
}

describe('launch race parity: createTerminal client-disconnect guards', () => {
  it('refuses before adopting the pane when the client already disconnected (orca-runtime-create-terminal.ts:60-62)', async () => {
    const adoptStablePane = vi.fn(async () => null)
    const { runtime, spawn } = makeRuntime(adoptStablePane)
    const abort = new AbortController()
    abort.abort()

    await expect(
      runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
        tabId: 'guard-disconnected-before-adopt',
        leafId: HEADLESS_LEAF_ID,
        signal: abort.signal
      })
    ).rejects.toThrow('client_disconnected')

    expect(adoptStablePane).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
  })

  it('refuses before spawning when the client disconnects during pane adoption (orca-runtime-create-terminal.ts:119-121)', async () => {
    const abort = new AbortController()
    const { runtime, spawn } = makeRuntime(async () => {
      abort.abort()
      return null
    })

    await expect(
      runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
        tabId: 'guard-disconnected-during-adopt',
        leafId: HEADLESS_LEAF_ID,
        signal: abort.signal
      })
    ).rejects.toThrow('client_disconnected')

    expect(spawn).not.toHaveBeenCalled()
  })

  it('hands the client signal and the slept-worktree refusal to the spawn (orca-runtime-create-terminal.ts:167)', async () => {
    const { runtime, spawn } = makeRuntime(async () => null)
    const abort = new AbortController()

    await expect(
      runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
        tabId: 'guard-forwarded',
        leafId: HEADLESS_LEAF_ID,
        signal: abort.signal,
        refuseSleptWorktree: true
      })
    ).rejects.toThrow(SPAWN_REACHED)

    expect(spawn).toHaveBeenCalledOnce()
    expect(spawn.mock.calls[0]?.[0]).toMatchObject({
      signal: abort.signal,
      refuseSleptWorktree: true
    })
  })
})
