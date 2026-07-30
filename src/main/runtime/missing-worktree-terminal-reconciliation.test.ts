import { describe, expect, it, vi } from 'vitest'
import type { IPtyProvider } from '../providers/types'
import type { Repo } from '../../shared/types'
import type { OrcaRuntimeService } from './orca-runtime'
import { stopMissingWorktreeTerminals } from './missing-worktree-terminal-reconciliation'

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
        getLocalProvider: () => provider,
        getSshProvider: () => undefined
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

  it('uses the owning SSH provider without consulting the local provider', async () => {
    const deletedId = 'repo-1::/workspace/deleted'
    const localProvider = createProvider([`${deletedId}@@local-session`])
    const sshProvider = createProvider([`${deletedId}@@ssh-session`])
    const getSshProvider = vi.fn(() => sshProvider)

    await stopMissingWorktreeTerminals({ ...localRepo, connectionId: 'ssh-1' }, [deletedId], [], {
      runtime: createRuntime(),
      getLocalProvider: () => localProvider,
      getSshProvider
    })

    expect(getSshProvider).toHaveBeenCalledWith('ssh-1')
    expect(sshProvider.shutdown).toHaveBeenCalledWith(
      `${deletedId}@@ssh-session`,
      expect.objectContaining({ immediate: true })
    )
    expect(localProvider.listProcesses).not.toHaveBeenCalled()
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
        getLocalProvider: () => null,
        getSshProvider: () => undefined
      }
    )

    expect(result).toEqual({ stoppedWorktreeIds: [deletedId] })
    expect(runtime.stopTerminalsForWorktree).toHaveBeenCalledWith(deletedId)
  })

  // Why: an agent cleaning up workspaces deletes many at once. Enumerating the
  // host once per missing worktree is O(N) relay round-trips carrying O(N^2)
  // rows — on SSH that stalls teardown for minutes.
  it('enumerates the host once for the whole sweep', async () => {
    const ids = Array.from({ length: 25 }, (_, index) => `repo-1::/workspace/wt-${index}`)
    const provider = createProvider(ids.map((id) => `${id}@@session`))

    const result = await stopMissingWorktreeTerminals(
      { ...localRepo, connectionId: 'ssh-1' },
      ids,
      [],
      { runtime: createRuntime(), getLocalProvider: () => null, getSshProvider: () => provider }
    )

    expect(result.stoppedWorktreeIds).toHaveLength(ids.length)
    expect(provider.listProcesses).toHaveBeenCalledTimes(1)
    expect(provider.shutdown).toHaveBeenCalledTimes(ids.length)
  })

  // Why: real providers put listProcesses/shutdown on the prototype and use `this`;
  // batching them behind a wrapper must not break that binding.
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

    const result = await stopMissingWorktreeTerminals(
      { ...localRepo, connectionId: 'ssh-1' },
      ids,
      [],
      {
        runtime: createRuntime(),
        getLocalProvider: () => null,
        getSshProvider: () => provider as unknown as IPtyProvider
      }
    )

    expect(result.stoppedWorktreeIds).toHaveLength(ids.length)
    expect(provider.listCalls).toBe(1)
    expect(provider.shutdownCalls).toHaveLength(ids.length)
  })

  // Why: the batching must not leak past the calls it was built for. If the proxy
  // were the receiver, a provider whose own method called `this.listProcesses()`
  // would silently read this sweep's cached snapshot instead of the live host.
  it('does not serve the shared snapshot to provider-internal listProcesses', async () => {
    class SelfListingProvider {
      listCalls = 0
      constructor(private readonly sessions: { id: string; cwd: string; title: string }[]) {}
      async listProcesses(): Promise<{ id: string; cwd: string; title: string }[]> {
        this.listCalls += 1
        return this.sessions
      }
      async shutdown(): Promise<void> {
        // A provider that re-reads live state as part of stopping.
        await this.listProcesses()
      }
    }
    const ids = ['repo-1::/workspace/a', 'repo-1::/workspace/b']
    const provider = new SelfListingProvider(
      ids.map((id) => ({ id: `${id}@@session`, cwd: '/workspace', title: 'shell' }))
    )

    await stopMissingWorktreeTerminals({ ...localRepo, connectionId: 'ssh-1' }, ids, [], {
      runtime: createRuntime(),
      getLocalProvider: () => null,
      getSshProvider: () => provider as unknown as IPtyProvider
    })

    // One shared sweep scan, plus each shutdown's own live re-read.
    expect(provider.listCalls).toBe(1 + ids.length)
  })

  // Why: caching a rejected scan would let one transient failure suppress
  // teardown for every remaining worktree in the sweep.
  it('does not reuse a failed process scan', async () => {
    const ids = ['repo-1::/workspace/a', 'repo-1::/workspace/b']
    const listProcesses = vi
      .fn()
      .mockRejectedValueOnce(new Error('relay dropped'))
      .mockResolvedValue([{ id: `${ids[1]}@@session`, cwd: '/workspace', title: 'shell' }])
    const provider = { listProcesses, shutdown: vi.fn(async () => {}) } as unknown as IPtyProvider

    await stopMissingWorktreeTerminals({ ...localRepo, connectionId: 'ssh-1' }, ids, [], {
      runtime: createRuntime(),
      getLocalProvider: () => null,
      getSshProvider: () => provider
    })

    expect(listProcesses.mock.calls.length).toBeGreaterThan(1)
    expect(provider.shutdown).toHaveBeenCalledWith(
      `${ids[1]}@@session`,
      expect.objectContaining({ immediate: true })
    )
  })
})
