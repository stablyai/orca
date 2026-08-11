/**
 * The same repo id is allowed on two execution hosts (persistence.ts `removeProjectForHost`).
 * `repo.rm` resolves a *row*, so the deletion it performs must be scoped to that row's host:
 * `Store.removeProject` is id-only and would take the sibling host's registration with it.
 * A `path:`/`name:` selector resolves unambiguously even when the id is duplicated, so this
 * is reachable — and since #11994 every paired device now learns about it immediately.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/types'
import type { PtyProcessInfo } from '../providers/types'
import { OrcaRuntimeService } from './orca-runtime'

function makeRepos(): Repo[] {
  return [
    {
      id: 'dup',
      path: '/laptop/dup',
      displayName: 'Dup Local',
      badgeColor: '#000',
      addedAt: 1,
      executionHostId: 'local'
    } as Repo,
    {
      id: 'dup',
      path: '/remote/dup',
      displayName: 'Dup Remote',
      badgeColor: '#000',
      addedAt: 2,
      connectionId: 'ssh-1'
    } as Repo
  ]
}

function createRuntime(providerProcesses: PtyProcessInfo[] = []) {
  const repos = makeRepos()
  const removeProject = vi.fn((id: string) => {
    for (let index = repos.length - 1; index >= 0; index -= 1) {
      if (repos[index].id === id) {
        repos.splice(index, 1)
      }
    }
  })
  const removeProjectForHost = vi.fn((id: string, hostId: string) => {
    for (let index = repos.length - 1; index >= 0; index -= 1) {
      const repo = repos[index]
      const repoHostId =
        repo.executionHostId ?? (repo.connectionId ? `ssh:${repo.connectionId}` : 'local')
      if (repo.id === id && repoHostId === hostId) {
        repos.splice(index, 1)
      }
    }
  })
  const provider = {
    listProcesses: vi.fn(async () => [...providerProcesses]),
    shutdown: vi.fn().mockResolvedValue(undefined)
  }
  const runtime = new OrcaRuntimeService(
    {
      getRepos: () => [...repos],
      getRepo: (id: string) => repos.find((repo) => repo.id === id) ?? null,
      getAllWorktreeMeta: () => ({}),
      getWorktreeMeta: () => null,
      setWorktreeMeta: vi.fn(),
      removeWorktreeMeta: vi.fn(),
      getGitHubCache: () => null,
      removeProject,
      removeProjectForHost
    } as never,
    undefined,
    {
      getLocalProvider: () => provider as never,
      getSshProvider: () => provider as never
    }
  )
  return { runtime, repos, removeProject, removeProjectForHost, provider }
}

async function spawnPidFixture(): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], {
    stdio: 'ignore',
    windowsHide: true
  })
  await once(child, 'spawn')
  return child
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

describe('repo.rm with the same repo id on two execution hosts', () => {
  it('removes only the resolved row when a path selector picks the SSH host copy', async () => {
    const { runtime, repos } = createRuntime()

    await runtime.removeProject('path:/remote/dup')

    expect(repos.map((repo) => repo.path)).toEqual(['/laptop/dup'])
  })

  it('removes only the resolved row when a name selector picks the local copy', async () => {
    const { runtime, repos } = createRuntime()

    await runtime.removeProject('name:Dup Local')

    expect(repos.map((repo) => repo.path)).toEqual(['/remote/dup'])
  })

  it('refuses a bare duplicated id rather than guessing a host', async () => {
    const { runtime, repos, removeProject, removeProjectForHost } = createRuntime()

    await expect(runtime.removeProject('dup')).rejects.toThrow('selector_ambiguous')
    expect(removeProject).not.toHaveBeenCalled()
    expect(removeProjectForHost).not.toHaveBeenCalled()
    expect(repos).toHaveLength(2)
  })

  it('uses an explicit host to disambiguate the duplicated id', async () => {
    const { runtime, repos, removeProject, removeProjectForHost } = createRuntime()

    await runtime.removeProject('dup', 'ssh:ssh-1')

    expect(removeProjectForHost).toHaveBeenCalledWith('dup', 'ssh:ssh-1')
    expect(removeProject).not.toHaveBeenCalled()
    expect(repos).toEqual([expect.objectContaining({ path: '/laptop/dup' })])
  })

  it('stops provider-only sessions before removing the owning host row', async () => {
    const owned = {
      id: 'ssh:ssh-1@@owned',
      cwd: '/remote/dup',
      title: 'codex',
      worktreeId: 'dup::/remote/dup'
    }
    const unrelated = {
      id: 'ssh:ssh-1@@unrelated',
      cwd: '/remote/other',
      title: 'shell',
      worktreeId: 'other::/remote/other'
    }
    const ownedWorktree = {
      id: 'ssh:ssh-1@@owned-worktree',
      cwd: '/remote/worktree',
      title: 'claude',
      worktreeId: 'dup::/remote/worktree'
    }
    const { runtime, provider, removeProjectForHost } = createRuntime([
      owned,
      ownedWorktree,
      unrelated
    ])

    await runtime.removeProject('path:/remote/dup')

    expect(provider.listProcesses).toHaveBeenCalledTimes(1)
    expect(provider.shutdown).toHaveBeenCalledWith(
      owned.id,
      expect.objectContaining({ immediate: true })
    )
    expect(provider.shutdown).toHaveBeenCalledWith(
      ownedWorktree.id,
      expect.objectContaining({ immediate: true })
    )
    expect(provider.shutdown).not.toHaveBeenCalledWith(
      unrelated.id,
      expect.objectContaining({ immediate: true })
    )
    expect(provider.shutdown).toHaveBeenCalledTimes(2)
    expect(provider.shutdown.mock.invocationCallOrder[0]).toBeLessThan(
      removeProjectForHost.mock.invocationCallOrder[0]
    )
  })

  it('keeps the project retryable when authoritative provider inventory fails', async () => {
    const { runtime, repos, provider, removeProjectForHost } = createRuntime()
    provider.listProcesses.mockRejectedValueOnce(new Error('relay unavailable'))

    await expect(runtime.removeProject('path:/remote/dup')).rejects.toThrow('relay unavailable')

    expect(removeProjectForHost).not.toHaveBeenCalled()
    expect(repos).toHaveLength(2)
  })

  it('waits for an admitted spawn and rejects later spawns during removal', async () => {
    const { runtime, provider } = createRuntime()
    const releaseSpawn = await runtime.acquireWorktreeTerminalSpawn('dup::/remote/dup', 'ssh-1')
    const removal = runtime.removeProject('path:/remote/dup')

    await Promise.resolve()
    await expect(runtime.acquireWorktreeTerminalSpawn('dup::/remote/dup', 'ssh-1')).rejects.toThrow(
      'Project removal in progress'
    )
    const releaseSiblingHostSpawn = await runtime.acquireWorktreeTerminalSpawn('dup::/remote/dup')
    releaseSiblingHostSpawn()
    expect(provider.listProcesses).not.toHaveBeenCalled()

    releaseSpawn()
    await expect(removal).resolves.toEqual({ removed: true })
    expect(provider.listProcesses).toHaveBeenCalledTimes(1)
  })

  it('uses a repo execution host for unqualified terminal spawn admission', async () => {
    const { runtime, repos, provider } = createRuntime()
    repos.push({
      id: 'runtime-only',
      path: '/runtime/only',
      displayName: 'Runtime Only',
      badgeColor: '#000',
      addedAt: 3,
      executionHostId: 'runtime:runtime-1'
    } as Repo)

    const releaseSpawn = await runtime.acquireWorktreeTerminalSpawn('runtime-only::/runtime/only')
    const removal = runtime.removeProject('runtime-only')

    await Promise.resolve()
    await expect(
      runtime.acquireWorktreeTerminalSpawn('runtime-only::/runtime/only')
    ).rejects.toThrow('Project removal in progress')

    releaseSpawn()
    await expect(removal).resolves.toEqual({ removed: true })
    expect(provider.listProcesses).toHaveBeenCalled()
  })

  it('drains an admitted uncatalogued-worktree spawn before project inventory', async () => {
    const providerProcesses: PtyProcessInfo[] = []
    const { runtime, repos, provider } = createRuntime(providerProcesses)
    const worktreeId = 'dup::/remote/uncatalogued'
    const releaseSpawn = await runtime.acquireWorktreeTerminalSpawn(worktreeId, 'ssh-1')
    let child: ChildProcess | undefined
    let spawnReleased = false
    try {
      let inventoryObserved!: () => void
      const inventoryStarted = new Promise<void>((resolve) => {
        inventoryObserved = resolve
      })
      provider.listProcesses.mockImplementation(async () => {
        inventoryObserved()
        return [...providerProcesses]
      })

      const removal = runtime.removeProject('path:/remote/dup')
      const phase = await Promise.race([
        inventoryStarted.then(() => 'inventory' as const),
        new Promise<'spawn-drain'>((resolve) => setImmediate(() => resolve('spawn-drain')))
      ])
      if (phase === 'inventory') {
        await removal
      }

      child = await spawnPidFixture()
      const pid = child.pid
      if (!pid) {
        throw new Error('PID fixture did not expose its process id')
      }
      const ptyId = `${worktreeId}@@${pid}`
      providerProcesses.push({ id: ptyId, cwd: '/remote/uncatalogued', title: 'codex', worktreeId })
      provider.shutdown.mockImplementation(async (id: string) => {
        if (id !== ptyId || !child || !isProcessAlive(pid)) {
          return
        }
        child.kill('SIGKILL')
        await once(child, 'exit')
      })

      releaseSpawn()
      spawnReleased = true
      await removal

      expect(isProcessAlive(pid), `orphaned exact PID ${pid}`).toBe(false)
      expect(phase).toBe('spawn-drain')
      expect(repos.map((repo) => repo.path)).toEqual(['/laptop/dup'])
    } finally {
      if (!spawnReleased) {
        releaseSpawn()
      }
      if (child?.pid && isProcessAlive(child.pid)) {
        child.kill('SIGKILL')
        await once(child, 'exit').catch(() => undefined)
      }
    }
  })

  it('bounds an admitted spawn drain and leaves project removal retryable', async () => {
    vi.useFakeTimers()
    let releaseSpawn: (() => void) | undefined
    try {
      const { runtime, repos, provider } = createRuntime()
      const acquiredReleaseSpawn = await runtime.acquireWorktreeTerminalSpawn(
        'dup::/remote/uncatalogued',
        'ssh-1'
      )
      releaseSpawn = acquiredReleaseSpawn
      const removal = runtime.removeProject('path:/remote/dup')
      const rejection = expect(removal).rejects.toThrow('Project terminal spawn drain timed out')

      await vi.advanceTimersByTimeAsync(10_001)
      await rejection
      expect(provider.listProcesses).not.toHaveBeenCalled()
      expect(repos).toHaveLength(2)

      acquiredReleaseSpawn()
      releaseSpawn = undefined
      await expect(runtime.removeProject('path:/remote/dup')).resolves.toEqual({ removed: true })
      expect(provider.listProcesses).toHaveBeenCalledTimes(1)
    } finally {
      releaseSpawn?.()
      vi.useRealTimers()
    }
  })

  it('releases the removal fence when catalog deletion fails', async () => {
    const { runtime, repos, removeProjectForHost, provider } = createRuntime()
    removeProjectForHost.mockImplementationOnce(() => {
      throw new Error('store write failed')
    })

    await expect(runtime.removeProject('path:/remote/dup')).rejects.toThrow('store write failed')
    expect(repos).toHaveLength(2)
    await expect(runtime.removeProject('path:/remote/dup')).resolves.toEqual({ removed: true })
    expect(provider.listProcesses).toHaveBeenCalledTimes(2)
  })
})
