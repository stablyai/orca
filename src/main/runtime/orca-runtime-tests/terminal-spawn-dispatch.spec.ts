import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime-test-mocks.spec'
import { TEST_WORKTREE_PATH, store } from '../orca-runtime-test-fixtures.spec'

// `agent.launch` settles a launch as failed only when its create threw before this hook ran.
describe('OrcaRuntimeService createTerminal spawn dispatch', () => {
  it('reports the spawn request before it leaves for the pty controller', async () => {
    const dispatched = vi.fn()
    const spawn = vi.fn(async () => {
      expect(dispatched).toHaveBeenCalledOnce()
      return { id: 'pty-dispatch' }
    })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'codex',
      onPtySpawnDispatched: dispatched
    })

    expect(spawn).toHaveBeenCalledOnce()
  })

  it('reports it even when the spawn itself then fails', async () => {
    const dispatched = vi.fn()
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn(async () => {
        throw new Error('ssh_channel_closed')
      }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    await expect(
      runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
        command: 'codex',
        onPtySpawnDispatched: dispatched
      })
    ).rejects.toThrow('ssh_channel_closed')
    expect(dispatched).toHaveBeenCalledOnce()
  })

  it('does not report it when the create fails before any spawn request', async () => {
    const dispatched = vi.fn()
    const spawn = vi.fn()
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    await expect(
      runtime.createTerminal('path:/no/such/workspace', {
        command: 'codex',
        onPtySpawnDispatched: dispatched
      })
    ).rejects.toThrow()
    expect(spawn).not.toHaveBeenCalled()
    expect(dispatched).not.toHaveBeenCalled()
  })
})
