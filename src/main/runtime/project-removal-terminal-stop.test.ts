/** Host-owned project removal stops even hidden/unhydrated workspace shells that no client can sweep. */
import { describe, expect, it, vi } from 'vitest'
import { spawnWorktreeTarget } from '../../shared/worktree/host-qualified-identity'
import type { Repo } from '../../shared/repo-types'
import { OrcaRuntimeService } from './orca-runtime-test-mocks.spec'
import { TEST_REPO_ID, TEST_WORKTREE_ID, store } from './orca-runtime-test-fixtures.spec'

const HIDDEN_WORKTREE_ID = `${TEST_REPO_ID}::/tmp/hidden-worktree`
const OTHER_WORKTREE_ID = 'repo-2::/tmp/other'

function createRemovableRuntime(onFirstStop?: () => void): {
  runtime: InstanceType<typeof OrcaRuntimeService>
  stopAndWait: ReturnType<typeof vi.fn>
  removeProjectForHost: ReturnType<typeof vi.fn>
  stoppedBeforeRemoval: string[]
} {
  const removeProjectForHost = vi.fn()
  const stoppedBeforeRemoval: string[] = []
  let firstStop = true
  const stopAndWait = vi.fn(async (ptyId: string) => {
    if (removeProjectForHost.mock.calls.length === 0) {
      stoppedBeforeRemoval.push(ptyId)
    }
    if (firstStop) {
      firstStop = false
      onFirstStop?.()
    }
    if (ptyId === 'pty-unverifiable') {
      return false
    }
    // Like the provider: a stopped PTY exits and leaves the runtime's table.
    runtime.onPtyExit(ptyId, 0)
    return true
  })
  const runtime = new OrcaRuntimeService({ ...store, removeProjectForHost })
  runtime.setPtyController({
    write: () => true,
    kill: vi.fn(() => false),
    stopAndWait,
    getForegroundProcess: async () => null
  })
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
  return { runtime, stopAndWait, removeProjectForHost, stoppedBeforeRemoval }
}

describe('project removal on the execution host', () => {
  it('stops every terminal of the project, including workspaces no client listed', async () => {
    const { runtime, removeProjectForHost, stoppedBeforeRemoval } = createRemovableRuntime()
    runtime.registerPty('pty-visible', TEST_WORKTREE_ID, null)
    runtime.registerPty('pty-hidden', HIDDEN_WORKTREE_ID, null)
    runtime.registerPty('pty-other-project', OTHER_WORKTREE_ID, null)
    runtime.registerPty('pty-ssh-twin', HIDDEN_WORKTREE_ID, 'ssh-target')

    await expect(runtime.removeProject(TEST_REPO_ID)).resolves.toEqual({ removed: true })

    expect(stoppedBeforeRemoval.sort()).toEqual(['pty-hidden', 'pty-visible'])
    expect(removeProjectForHost).toHaveBeenCalledWith(expect.objectContaining({ id: TEST_REPO_ID }))
  })

  it('stops native shells of a project a paired client registered under a runtime stamp', async () => {
    const removeProjectForHost = vi.fn()
    const stopAndWait = vi.fn(async () => true)
    const stampedRepo: Repo = {
      ...store.getRepo(TEST_REPO_ID)!,
      executionHostId: 'runtime:env-self'
    }
    const runtime = new OrcaRuntimeService({
      ...store,
      getRepo: (id: string) => (id === TEST_REPO_ID ? stampedRepo : undefined),
      getRepos: () => [stampedRepo],
      removeProjectForHost
    })
    runtime.setPtyController({
      write: () => true,
      kill: vi.fn(() => false),
      stopAndWait,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    runtime.registerPty('pty-native', TEST_WORKTREE_ID, null)

    await expect(runtime.removeProject(TEST_REPO_ID)).resolves.toEqual({ removed: true })

    expect(stopAndWait).toHaveBeenCalledWith('pty-native', expect.anything())
  })

  it('fences a runtime-stamped project with a nested SSH connection to that connection', async () => {
    const removeProjectForHost = vi.fn()
    const stopAndWait = vi.fn(async (_ptyId: string) => true)
    const sshRepo: Repo = {
      ...store.getRepo(TEST_REPO_ID)!,
      executionHostId: 'runtime:env-self',
      connectionId: 'ssh-target'
    }
    const runtime = new OrcaRuntimeService({
      ...store,
      getRepo: (id: string) => (id === TEST_REPO_ID ? sshRepo : undefined),
      getRepos: () => [sshRepo],
      removeProjectForHost
    })
    runtime.setPtyController({
      write: () => true,
      kill: vi.fn(() => false),
      stopAndWait,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    runtime.registerPty('pty-native-sibling', TEST_WORKTREE_ID, null)
    runtime.registerPty('pty-over-ssh', TEST_WORKTREE_ID, 'ssh-target')

    await runtime.removeProject(TEST_REPO_ID)

    expect([...new Set(stopAndWait.mock.calls.map(([ptyId]) => ptyId))]).toEqual(['pty-over-ssh'])
  })

  it('waits out a spawn already in flight and stops what it registers', async () => {
    const { runtime, stopAndWait } = createRemovableRuntime()
    runtime.registerPty('pty-early', TEST_WORKTREE_ID, null)
    const releaseSpawn = await runtime.acquireWorktreeTerminalSpawn(
      spawnWorktreeTarget(TEST_WORKTREE_ID, null)
    )

    const removal = runtime.removeProject(TEST_REPO_ID)
    await new Promise((resolve) => setTimeout(resolve, 0))
    runtime.registerPty('pty-in-flight', TEST_WORKTREE_ID, null)
    releaseSpawn()
    await removal

    expect(stopAndWait.mock.calls.map(([ptyId]) => ptyId)).toContain('pty-in-flight')
  })

  it('refuses a spawn that reaches its lease after the project is gone', async () => {
    let removed = false
    const repo = store.getRepo(TEST_REPO_ID)!
    const runtime = new OrcaRuntimeService({
      ...store,
      getRepo: (id: string) => (id === TEST_REPO_ID && !removed ? repo : undefined),
      getRepos: () => (removed ? [] : [repo]),
      removeProjectForHost: () => {
        removed = true
      }
    })
    runtime.setPtyController({
      write: () => true,
      kill: vi.fn(() => false),
      stopAndWait: vi.fn(async () => true),
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

    await runtime.removeProject(TEST_REPO_ID)

    await expect(
      runtime.acquireWorktreeTerminalSpawn(spawnWorktreeTarget(TEST_WORKTREE_ID, null))
    ).rejects.toThrow('repo_not_found')
  })

  it('refuses an SSH spawn after removal even though a local same-id sibling survives', async () => {
    const localRow = store.getRepo(TEST_REPO_ID)!
    const sshRow: Repo = { ...localRow, path: '/srv/ssh-copy', connectionId: 'ssh-target' }
    let rows = [localRow, sshRow]
    const runtime = new OrcaRuntimeService({
      ...store,
      getRepo: (id: string) => rows.find((row) => row.id === id),
      getRepos: () => rows,
      removeProjectForHost: () => {
        rows = [localRow]
      }
    })
    runtime.setPtyController({
      write: () => true,
      kill: vi.fn(() => false),
      stopAndWait: vi.fn(async () => true),
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

    await runtime.removeProject('path:/srv/ssh-copy')

    await expect(
      runtime.acquireWorktreeTerminalSpawn(spawnWorktreeTarget(TEST_WORKTREE_ID, 'ssh-target'))
    ).rejects.toThrow('repo_not_found')
    const releaseLocal = await runtime.acquireWorktreeTerminalSpawn(
      spawnWorktreeTarget(TEST_WORKTREE_ID, null)
    )
    releaseLocal()
  })

  it('keeps admitting a self-stamped row after its SSH twin is removed', async () => {
    const sshRow: Repo = { ...store.getRepo(TEST_REPO_ID)!, connectionId: 'ssh-target' }
    // A paired client's registration: the runtime stamp names files on this host.
    const selfRow: Repo = { ...store.getRepo(TEST_REPO_ID)!, executionHostId: 'runtime:env-self' }
    let rows = [sshRow, selfRow]
    const runtime = new OrcaRuntimeService({
      ...store,
      getRepo: (id: string) => rows.find((row) => row.id === id),
      getRepos: () => rows,
      removeProjectForHost: () => {
        rows = [selfRow]
      }
    })
    runtime.setPtyController({
      write: () => true,
      kill: vi.fn(() => false),
      stopAndWait: vi.fn(async () => true),
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

    await runtime.removeProject(sshRow)

    await expect(
      runtime.acquireWorktreeTerminalSpawn(spawnWorktreeTarget(TEST_WORKTREE_ID, 'ssh-target'))
    ).rejects.toThrow('repo_not_found')
    const releaseLocal = await runtime.acquireWorktreeTerminalSpawn(
      spawnWorktreeTarget(TEST_WORKTREE_ID, null)
    )
    releaseLocal()
  })

  it('refuses a spawn on any host once no row with the removed id survives', async () => {
    const sshRow: Repo = { ...store.getRepo(TEST_REPO_ID)!, connectionId: 'ssh-target' }
    let rows = [sshRow]
    const runtime = new OrcaRuntimeService({
      ...store,
      getRepo: (id: string) => rows.find((row) => row.id === id),
      getRepos: () => rows,
      removeProjectForHost: () => {
        rows = []
      }
    })
    runtime.setPtyController({
      write: () => true,
      kill: vi.fn(() => false),
      stopAndWait: vi.fn(async () => true),
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

    await runtime.removeProject(TEST_REPO_ID)

    await expect(
      runtime.acquireWorktreeTerminalSpawn(spawnWorktreeTarget(TEST_WORKTREE_ID, null))
    ).rejects.toThrow('repo_not_found')
  })

  it('stops nothing when a same-id sibling row would claim the same PTYs', async () => {
    const removeProjectForHost = vi.fn()
    const stopAndWait = vi.fn(async (_ptyId: string) => true)
    const localRow = store.getRepo(TEST_REPO_ID)!
    const foreignRow: Repo = {
      ...localRow,
      path: '/srv/foreign-copy',
      executionHostId: 'runtime:env-other'
    }
    const runtime = new OrcaRuntimeService({
      ...store,
      getRepos: () => [localRow, foreignRow],
      removeProjectForHost
    })
    runtime.setPtyController({
      write: () => true,
      kill: vi.fn(() => false),
      stopAndWait,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    runtime.registerPty('pty-local-sibling', TEST_WORKTREE_ID, null)

    await runtime.removeProject('path:/srv/foreign-copy')

    expect(stopAndWait).not.toHaveBeenCalled()
    expect(removeProjectForHost).toHaveBeenCalledTimes(1)
  })

  it('stops a terminal spawned while the first sweep ran', async () => {
    const { runtime, stopAndWait } = createRemovableRuntime(() =>
      runtime.registerPty('pty-late', TEST_WORKTREE_ID, null)
    )
    runtime.registerPty('pty-early', TEST_WORKTREE_ID, null)

    await runtime.removeProject(TEST_REPO_ID)

    expect(stopAndWait.mock.calls.map(([ptyId]) => ptyId)).toContain('pty-late')
  })

  it('still removes the project when a stop cannot be verified', async () => {
    const { runtime, stopAndWait, removeProjectForHost } = createRemovableRuntime()
    runtime.registerPty('pty-unverifiable', TEST_WORKTREE_ID, null)

    await expect(runtime.removeProject(TEST_REPO_ID)).resolves.toEqual({ removed: true })

    expect(stopAndWait).toHaveBeenCalledWith('pty-unverifiable', expect.anything())
    expect(removeProjectForHost).toHaveBeenCalledTimes(1)
  })
})
