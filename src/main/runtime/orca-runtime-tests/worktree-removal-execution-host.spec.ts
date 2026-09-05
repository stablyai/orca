import {
  listWorktrees,
  listWorktreesStrict,
  registerSshFilesystemProvider,
  registerSshGitProvider,
  removeWorktree,
  unregisterSshFilesystemProvider,
  unregisterSshGitProvider
} from '../orca-runtime-test-mocks.spec'
import type { WorktreeMeta } from '../orca-runtime-test-mocks.spec'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  makeWorktreeMeta,
  store
} from '../orca-runtime-test-fixtures.spec'
import { createWorktreeRemovalRuntime } from '../orca-runtime-test-scenario-builders.spec'
import type { ExecutionHostId } from '../../../shared/execution-host'

const REMOTE_REPO_PATH = '/remote/repo'

function missingPath(): never {
  throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
}

function makeGitProvider(worktrees: readonly unknown[]) {
  return {
    exec: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
    listWorktrees: vi.fn().mockResolvedValue(worktrees),
    removeWorktree: vi.fn().mockResolvedValue({})
  }
}

function makeRemoteRepoStore(
  executionHostId: ExecutionHostId,
  extraRepoFields: Record<string, unknown> = {},
  metaOverrides: Partial<WorktreeMeta> = {}
) {
  const repo = {
    ...store.getRepos()[0]!,
    path: REMOTE_REPO_PATH,
    executionHostId,
    ...extraRepoFields
  }
  const metaById: Record<string, WorktreeMeta> = {
    [TEST_WORKTREE_ID]: makeWorktreeMeta({ hostId: executionHostId, ...metaOverrides })
  }
  const removeWorktreeMeta = vi.fn((worktreeId: string, hostId?: string) => {
    if (!hostId || metaById[worktreeId]?.hostId === hostId) {
      delete metaById[worktreeId]
    }
  })
  return {
    repo,
    metaById,
    removeWorktreeMeta,
    runtimeStore: {
      ...store,
      getRepos: () => [repo],
      getRepo: (id: string) => (id === repo.id ? repo : undefined),
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
        return metaById[worktreeId]
      },
      removeWorktreeMeta
    }
  }
}

const REPO_ROOT_ENTRY = {
  path: REMOTE_REPO_PATH,
  head: 'main',
  branch: 'main',
  isBare: false,
  isMainWorktree: true
}

const REGISTERED_ENTRY = {
  path: TEST_WORKTREE_PATH,
  head: 'def456',
  branch: 'feature/test',
  isBare: false,
  isMainWorktree: false
}

describe('OrcaRuntimeService worktree removal execution host', () => {
  beforeEach(() => {
    vi.mocked(listWorktrees).mockClear()
    vi.mocked(listWorktreesStrict).mockClear()
    vi.mocked(removeWorktree).mockClear()
  })

  it('removes a migrated-spelling SSH row on its own host, never this machine', async () => {
    // No `connectionId` at all: the row names its owner only as `executionHostId: 'ssh:target-a'`.
    const { runtimeStore, removeWorktreeMeta, metaById } = makeRemoteRepoStore('ssh:target-a')
    const provider = makeGitProvider([REPO_ROOT_ENTRY, REGISTERED_ENTRY])
    registerSshGitProvider('target-a', provider as never)
    const runtime = createWorktreeRemovalRuntime(runtimeStore)
    vi.spyOn(runtime, 'acquireFileWatcherRemoval').mockResolvedValue({ finish: vi.fn() })

    try {
      await runtime.removeManagedWorktree(TEST_WORKTREE_ID, true, false, false, 'ssh:target-a')

      expect(provider.listWorktrees).toHaveBeenCalledWith(REMOTE_REPO_PATH)
      expect(provider.removeWorktree).toHaveBeenCalledWith(TEST_WORKTREE_PATH, true)
      expect(listWorktreesStrict).not.toHaveBeenCalled()
      expect(removeWorktree).not.toHaveBeenCalled()
      expect(removeWorktreeMeta).toHaveBeenCalledWith(TEST_WORKTREE_ID, 'ssh:target-a')
      expect(metaById[TEST_WORKTREE_ID]).toBeUndefined()
    } finally {
      unregisterSshGitProvider('target-a')
    }
  })

  it('runs the cleanup path for a migrated-spelling row entirely on its host', async () => {
    // #18358 made an `executionHostId`-only row a removable cleanup candidate. Every step of the
    // removal it starts — list, existence probe, delete, prune — must name the same host.
    const { runtimeStore, removeWorktreeMeta } = makeRemoteRepoStore('ssh:target-a')
    const provider = makeGitProvider([REPO_ROOT_ENTRY])
    const fsProvider = { stat: vi.fn(missingPath), deletePath: vi.fn() }
    registerSshGitProvider('target-a', provider as never)
    registerSshFilesystemProvider('target-a', fsProvider as never)
    const runtime = createWorktreeRemovalRuntime(runtimeStore)

    try {
      await expect(
        runtime.removeManagedWorktree(TEST_WORKTREE_ID, true, false, false, 'ssh:target-a')
      ).resolves.toEqual({})

      expect(provider.listWorktrees).toHaveBeenCalledWith(REMOTE_REPO_PATH)
      expect(fsProvider.stat).toHaveBeenCalledWith(TEST_WORKTREE_PATH)
      expect(listWorktreesStrict).not.toHaveBeenCalled()
      expect(removeWorktree).not.toHaveBeenCalled()
      expect(fsProvider.deletePath).not.toHaveBeenCalled()
      expect(removeWorktreeMeta).toHaveBeenCalledWith(TEST_WORKTREE_ID, 'ssh:target-a')
    } finally {
      unregisterSshFilesystemProvider('target-a')
      unregisterSshGitProvider('target-a')
    }
  })

  it('keeps two simultaneously registered SSH hosts off each other paths', async () => {
    const { runtimeStore } = makeRemoteRepoStore('ssh:target-b')
    const providerA = makeGitProvider([REPO_ROOT_ENTRY, REGISTERED_ENTRY])
    const providerB = makeGitProvider([REPO_ROOT_ENTRY, REGISTERED_ENTRY])
    registerSshGitProvider('target-a', providerA as never)
    registerSshGitProvider('target-b', providerB as never)
    const runtime = createWorktreeRemovalRuntime(runtimeStore)
    vi.spyOn(runtime, 'acquireFileWatcherRemoval').mockResolvedValue({ finish: vi.fn() })

    try {
      await runtime.removeManagedWorktree(TEST_WORKTREE_ID, true, false, false, 'ssh:target-b')

      expect(providerB.removeWorktree).toHaveBeenCalledWith(TEST_WORKTREE_PATH, true)
      expect(providerA.listWorktrees).not.toHaveBeenCalled()
      expect(providerA.removeWorktree).not.toHaveBeenCalled()
    } finally {
      unregisterSshGitProvider('target-b')
      unregisterSshGitProvider('target-a')
    }
  })

  it('refuses an SSH row whose host is unreachable instead of deleting here', async () => {
    const { runtimeStore, metaById } = makeRemoteRepoStore('ssh:target-a')
    const runtime = createWorktreeRemovalRuntime(runtimeStore)

    await expect(
      runtime.removeManagedWorktree(TEST_WORKTREE_ID, true, false, false, 'ssh:target-a')
    ).rejects.toThrow('Remote connection dropped')

    expect(listWorktreesStrict).not.toHaveBeenCalled()
    expect(removeWorktree).not.toHaveBeenCalled()
    expect(metaById[TEST_WORKTREE_ID]).toBeDefined()
  })

  it('refuses a runtime row with no nested SSH target rather than deleting locally', async () => {
    const { runtimeStore, metaById } = makeRemoteRepoStore('runtime:env-1')
    const runtime = createWorktreeRemovalRuntime(runtimeStore)

    await expect(
      runtime.removeManagedWorktree(TEST_WORKTREE_ID, true, false, false, 'runtime:env-1')
    ).rejects.toThrow('not dispatched by this process')

    expect(listWorktreesStrict).not.toHaveBeenCalled()
    expect(removeWorktree).not.toHaveBeenCalled()
    expect(metaById[TEST_WORKTREE_ID]).toBeDefined()
  })

  it('refuses a runtime row whose nested SSH target is dialable in this namespace', async () => {
    // `connectionId: 'target-a'` names a target inside env-1, not the one registered here. The raw
    // read dialled this client's same-named host and removed a worktree on the wrong machine.
    const { runtimeStore, metaById } = makeRemoteRepoStore('runtime:env-1', {
      connectionId: 'target-a'
    })
    const provider = makeGitProvider([REPO_ROOT_ENTRY, REGISTERED_ENTRY])
    registerSshGitProvider('target-a', provider as never)
    const runtime = createWorktreeRemovalRuntime(runtimeStore)

    try {
      await expect(
        runtime.removeManagedWorktree(TEST_WORKTREE_ID, true, false, false, 'runtime:env-1')
      ).rejects.toThrow('not dispatched by this process')

      // Selector resolution still lists through the raw field before removal begins — a read on
      // the wrong namespace, tracked separately. Nothing destructive reaches it.
      expect(provider.removeWorktree).not.toHaveBeenCalled()
      expect(removeWorktree).not.toHaveBeenCalled()
      expect(metaById[TEST_WORKTREE_ID]).toBeDefined()
    } finally {
      unregisterSshGitProvider('target-a')
    }
  })
})
