import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime-test-mocks.spec'
import { TEST_WORKTREE_ID, spawnedPtyEnv, store } from '../orca-runtime-test-fixtures.spec'

function makeRuntime(): { runtime: OrcaRuntimeService; spawn: ReturnType<typeof vi.fn> } {
  const spawn = vi.fn().mockResolvedValue({ id: 'pty-workspace-id' })
  const runtime = new OrcaRuntimeService(store)
  runtime.setPtyController({
    spawn,
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  })
  return { runtime, spawn }
}

// Host-created panes need the same workspace id that renderer panes pass to agent wrappers.
describe('OrcaRuntimeService terminal ORCA_WORKSPACE_ID', () => {
  it('stamps the worktree id on a git worktree terminal, as the window does', async () => {
    const { runtime, spawn } = makeRuntime()

    await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, { title: 'phone shell' })

    const env = spawnedPtyEnv(spawn.mock.calls[0]?.[0])
    expect(env.ORCA_WORKSPACE_ID).toBe(TEST_WORKTREE_ID)
    expect(env.ORCA_WORKSPACE_ID).toBe(env.ORCA_WORKTREE_ID)
  })

  it('replaces a client-sent value with the host workspace id', async () => {
    const { runtime, spawn } = makeRuntime()

    await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      env: { ORCA_WORKSPACE_ID: 'stale-client-id' }
    })

    expect(spawnedPtyEnv(spawn.mock.calls[0]?.[0]).ORCA_WORKSPACE_ID).toBe(TEST_WORKTREE_ID)
  })
})
