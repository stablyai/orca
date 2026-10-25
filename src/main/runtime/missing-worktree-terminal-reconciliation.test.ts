import { describe, expect, it, vi } from 'vitest'
import type { IPtyProvider } from '../providers/pty-provider-contract'
import type { Repo } from '../../shared/repo-types'
import type { OrcaRuntimeService } from './orca-runtime'
import { stopMissingWorktreeTerminals } from './missing-worktree-terminal-reconciliation'
import { createAdapter } from '../daemon/daemon-pty-router-test-fixture'
import { DaemonPtyRouter } from '../daemon/daemon-pty-router'

function createProvider(sessionIds: string[]): IPtyProvider {
  return {
    listProcesses: vi.fn(async () =>
      sessionIds.map((id) => ({ id, cwd: '/workspace', title: 'shell' }))
    ),
    shutdown: vi.fn(async () => {})
  } as unknown as IPtyProvider
}

function createRuntime(): OrcaRuntimeService {
  return {
    stopTerminalsForWorktree: vi.fn(async () => ({ stopped: 0 }))
  } as unknown as OrcaRuntimeService
}

const localRepo: Repo = {
  id: 'repo-1',
  path: '/workspace/repo',
  displayName: 'Repo',
  badgeColor: '#000',
  addedAt: 1
}

describe('stopMissingWorktreeTerminals', () => {
  it('stops only locally owned worktrees absent from the authoritative scan', async () => {
    const deletedId = 'repo-1::/workspace/deleted'
    const survivingId = 'repo-1::/workspace/surviving'
    const provider = createProvider([
      `${deletedId}@@deleted-session`,
      `${survivingId}@@surviving-session`
    ])
    const runtime = createRuntime()

    const result = await stopMissingWorktreeTerminals(
      localRepo,
      [deletedId, survivingId, 'repo-2::/workspace/other'],
      [survivingId],
      {
        runtime,
        getLocalProvider: () => provider
      }
    )

    expect(result).toEqual({ stoppedWorktreeIds: [deletedId] })
    expect(provider.shutdown).toHaveBeenCalledWith(
      `${deletedId}@@deleted-session`,
      expect.objectContaining({ immediate: true })
    )
    expect(provider.shutdown).not.toHaveBeenCalledWith(
      `${survivingId}@@surviving-session`,
      expect.anything()
    )
  })

  it.each([
    ['legacy connectionId', { connectionId: 'ssh-1' }],
    ['unified executionHostId', { executionHostId: 'ssh:ssh-1' as const }]
  ])('never sweeps an SSH repo (%s) through the local provider', async (_, host) => {
    const deletedId = 'repo-1::/workspace/deleted'
    const localProvider = createProvider([`${deletedId}@@local-session`])
    const runtime = createRuntime()

    await stopMissingWorktreeTerminals({ ...localRepo, ...host }, [deletedId], [], {
      runtime,
      getLocalProvider: () => localProvider
    })

    expect(runtime.stopTerminalsForWorktree).toHaveBeenCalledWith(deletedId, {
      resolvedWorktreeId: deletedId,
      resolvedConnectionId: 'ssh-1'
    })
    expect(localProvider.listProcesses).not.toHaveBeenCalled()
    expect(localProvider.shutdown).not.toHaveBeenCalled()
  })

  it('still stops graph-visible sessions when the owning provider is unavailable', async () => {
    const deletedId = 'repo-1::/workspace/deleted'
    const runtime = createRuntime()

    const result = await stopMissingWorktreeTerminals(
      { ...localRepo, connectionId: 'ssh-1' },
      [deletedId],
      [],
      {
        runtime,
        getLocalProvider: () => null
      }
    )

    expect(result).toEqual({ stoppedWorktreeIds: [deletedId] })
    expect(runtime.stopTerminalsForWorktree).toHaveBeenCalledWith(deletedId, {
      resolvedWorktreeId: deletedId,
      resolvedConnectionId: 'ssh-1'
    })
  })

  // Per-workspace scans cost O(N) round trips carrying O(N²) rows; share one host inventory.
  it('enumerates the host once for the whole sweep', async () => {
    const ids = Array.from({ length: 25 }, (_, index) => `repo-1::/workspace/wt-${index}`)
    const provider = createProvider(ids.map((id) => `${id}@@session`))

    const result = await stopMissingWorktreeTerminals(localRepo, ids, [], {
      runtime: createRuntime(),
      getLocalProvider: () => provider
    })

    expect(result.stoppedWorktreeIds).toHaveLength(ids.length)
    expect(provider.listProcesses).toHaveBeenCalledTimes(1)
    expect(provider.shutdown).toHaveBeenCalledTimes(ids.length)
  })

  it.each([false, true])(
    'stops multiple workspaces through scoped daemon listings (unrelated duplicate: %s)',
    async (duplicate) => {
      const ids = ['repo-1::/workspace/a', 'repo-1::/workspace/b']
      const targetSessions = ids.map((id) => `${id}@@session`)
      const currentSessions = [...targetSessions, ...(duplicate ? ['unrelated'] : [])]
      const current = createAdapter('current', currentSessions)
      const legacy = createAdapter('legacy', duplicate ? ['unrelated'] : [])
      const provider = new DaemonPtyRouter({ current, legacy: [legacy] })

      await expect(
        stopMissingWorktreeTerminals(localRepo, ids, [], {
          runtime: createRuntime(),
          getLocalProvider: () => provider
        })
      ).resolves.toEqual({ stoppedWorktreeIds: ids })

      expect(currentSessions).toEqual(duplicate ? ['unrelated'] : [])
      expect(
        vi
          .mocked(current.shutdown)
          .mock.calls.map(([id]) => id)
          .sort()
      ).toEqual(targetSessions)
      expect(legacy.shutdown).not.toHaveBeenCalled()
      if (!duplicate) {
        expect(current.listProcesses).toHaveBeenCalledOnce()
      }
    }
  )

  it('keeps provider method binding intact while batching', async () => {
    class PrototypeProvider {
      listCalls = 0
      shutdownCalls: string[] = []
      private readonly sessions: { id: string; cwd: string; title: string }[]
      constructor(sessionIds: string[]) {
        this.sessions = sessionIds.map((id) => ({ id, cwd: '/workspace', title: 'shell' }))
      }
      async listProcesses(): Promise<{ id: string; cwd: string; title: string }[]> {
        this.listCalls += 1
        return this.sessions
      }
      async shutdown(sessionId: string): Promise<void> {
        this.shutdownCalls.push(sessionId)
      }
    }
    const ids = ['repo-1::/workspace/a', 'repo-1::/workspace/b', 'repo-1::/workspace/c']
    const provider = new PrototypeProvider(ids.map((id) => `${id}@@session`))

    const result = await stopMissingWorktreeTerminals(localRepo, ids, [], {
      runtime: createRuntime(),
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the sweep calls only listProcesses and shutdown, which this class implements.
      getLocalProvider: () => provider as unknown as IPtyProvider
    })

    expect(result.stoppedWorktreeIds).toHaveLength(ids.length)
    expect(provider.listCalls).toBe(1)
    expect(provider.shutdownCalls).toHaveLength(ids.length)
  })

  // Provider-internal this.listProcesses must bypass the sweep cache and read the live host.
  it('does not serve the shared snapshot to provider-internal listProcesses', async () => {
    class SelfListingProvider {
      listCalls = 0
      constructor(private readonly sessions: { id: string; cwd: string; title: string }[]) {}
      async listProcesses(): Promise<{ id: string; cwd: string; title: string }[]> {
        this.listCalls += 1
        return this.sessions
      }
      async shutdown(): Promise<void> {
        await this.listProcesses()
      }
    }
    const ids = ['repo-1::/workspace/a', 'repo-1::/workspace/b']
    const provider = new SelfListingProvider(
      ids.map((id) => ({ id: `${id}@@session`, cwd: '/workspace', title: 'shell' }))
    )

    await stopMissingWorktreeTerminals(localRepo, ids, [], {
      runtime: createRuntime(),
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the sweep calls only listProcesses and shutdown, which this class implements.
      getLocalProvider: () => provider as unknown as IPtyProvider
    })

    expect(provider.listCalls).toBe(1 + ids.length)
  })

  it('does not reuse a failed process scan', async () => {
    const ids = ['repo-1::/workspace/a', 'repo-1::/workspace/b']
    const listProcesses = vi
      .fn()
      .mockRejectedValueOnce(new Error('relay dropped'))
      .mockResolvedValue([{ id: `${ids[1]}@@session`, cwd: '/workspace', title: 'shell' }])
    const provider = { listProcesses, shutdown: vi.fn(async () => {}) } as unknown as IPtyProvider

    await stopMissingWorktreeTerminals(localRepo, ids, [], {
      runtime: createRuntime(),
      getLocalProvider: () => provider
    })

    expect(listProcesses.mock.calls.length).toBeGreaterThan(1)
    expect(provider.shutdown).toHaveBeenCalledWith(
      `${ids[1]}@@session`,
      expect.objectContaining({ immediate: true })
    )
  })
})
