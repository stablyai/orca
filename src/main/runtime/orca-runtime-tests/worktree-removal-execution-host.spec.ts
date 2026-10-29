import {
  OrcaRuntimeService,
  listWorktrees,
  listWorktreesStrict,
  removeWorktree
} from '../orca-runtime-test-mocks.spec'
import type { WorktreeMeta } from '../orca-runtime-test-mocks.spec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  TEST_REPO_ID,
  TEST_REPO_PATH,
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  makeWorktreeMeta,
  store
} from '../orca-runtime-test-fixtures.spec'
import { createWorktreeRemovalRuntime } from '../orca-runtime-test-scenario-builders.spec'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { RuntimeStore } from '../runtime-store-contract'
import type { WorktreeRemovalRecord } from '../../worktree-removal-records'
import { failedWorktreeRemovals, pendingWorktreeRemovals } from '../../worktree-removal-table'
import {
  _resetPendingWorktreeRemovalsForTests,
  _settlePendingWorktreeRemovalsForTests
} from '../../worktree-background-removal'
import { RuntimeWorktreeRemovalInFlight } from '../runtime-worktree-removal-in-flight'
import type { HostWorktreeTarget } from '../../../shared/worktree/host-qualified-identity'

const REMOTE_REPO_PATH = '/remote/repo'

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
  const removeWorktreeMeta = vi.fn(({ id: worktreeId, hostId }: HostWorktreeTarget) => {
    if (metaById[worktreeId]?.hostId === hostId) {
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
      setWorktreeMeta: ({ id: worktreeId }: HostWorktreeTarget, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
        return metaById[worktreeId]
      },
      removeWorktreeMeta
    }
  }
}

describe('OrcaRuntimeService worktree removal execution host', () => {
  beforeEach(() => {
    vi.mocked(listWorktrees).mockClear()
    vi.mocked(listWorktreesStrict).mockClear()
    vi.mocked(removeWorktree).mockClear()
  })

  it('refuses an SSH row whose host is unreachable instead of deleting here', async () => {
    const { runtimeStore, metaById } = makeRemoteRepoStore('ssh:target-a')
    const runtime = createWorktreeRemovalRuntime(runtimeStore)

    await expect(
      runtime.removeManagedWorktree(TEST_WORKTREE_ID, {
        force: true,
        runHooks: false,
        allowUnverifiedPtyStop: false,
        hostId: 'ssh:target-a'
      })
    ).rejects.toThrow('isn’t served by Orca’s server')

    expect(listWorktreesStrict).not.toHaveBeenCalled()
    expect(removeWorktree).not.toHaveBeenCalled()
    expect(metaById[TEST_WORKTREE_ID]).toBeDefined()
  })

  it('refuses a runtime row with no nested SSH target rather than deleting locally', async () => {
    const { runtimeStore, metaById } = makeRemoteRepoStore('runtime:env-1')
    const runtime = createWorktreeRemovalRuntime(runtimeStore)

    await expect(
      runtime.removeManagedWorktree(TEST_WORKTREE_ID, {
        force: true,
        runHooks: false,
        allowUnverifiedPtyStop: false,
        hostId: 'runtime:env-1'
      })
    ).rejects.toThrow('not dispatched by this process')

    expect(listWorktreesStrict).not.toHaveBeenCalled()
    expect(removeWorktree).not.toHaveBeenCalled()
    expect(metaById[TEST_WORKTREE_ID]).toBeDefined()
  })

  it('refuses a runtime row that also names a nested SSH target', async () => {
    // `connectionId: 'target-a'` names a target inside env-1, never one on this machine.
    const { runtimeStore, metaById } = makeRemoteRepoStore('runtime:env-1', {
      connectionId: 'target-a'
    })
    const runtime = createWorktreeRemovalRuntime(runtimeStore)

    await expect(
      runtime.removeManagedWorktree(TEST_WORKTREE_ID, {
        force: true,
        runHooks: false,
        allowUnverifiedPtyStop: false,
        hostId: 'runtime:env-1'
      })
    ).rejects.toThrow('not dispatched by this process')

    expect(removeWorktree).not.toHaveBeenCalled()
    expect(metaById[TEST_WORKTREE_ID]).toBeDefined()
  })
})

class RemovalRuntime extends OrcaRuntimeService {
  protected override readonly removeManagedWorktreeInFlight = new RuntimeWorktreeRemovalInFlight()
  readonly helperFailure = new Error('runtime helper override')
  stopAtHelper = false
  stopAtStore = false
  readonly purges: {
    store: RuntimeStore
    worktreeId: string
    repoId: string
    hostId?: ExecutionHostId
  }[] = []

  protected override localRemovalJobHost(runtimeStore: RuntimeStore) {
    if (this.stopAtHelper) {
      throw this.helperFailure
    }
    return super.localRemovalJobHost(runtimeStore)
  }

  override requireStore(): RuntimeStore {
    if (this.stopAtStore) {
      throw this.helperFailure
    }
    return super.requireStore()
  }

  currentRemovalQueue() {
    return this.removeManagedWorktreeInFlight
  }

  protected override purgeRemovedWorktree(
    runtimeStore: RuntimeStore,
    worktreeId: string,
    repoId: string,
    hostId?: ExecutionHostId
  ): void {
    this.purges.push({ store: runtimeStore, worktreeId, repoId, hostId })
  }

  recoveryJobHost() {
    return this.localRemovalJobHost(store)
  }

  retryRemoval(record: WorktreeRemovalRecord) {
    return this.retryFailedRemoval(
      { kind: 'local' },
      { id: record.worktreeId, path: record.worktreePath },
      [],
      {},
      {}
    )
  }
}

describe('workspace removal runtime dispatch', () => {
  let runtime: RemovalRuntime
  let record: WorktreeRemovalRecord

  beforeEach(() => {
    _resetPendingWorktreeRemovalsForTests()
    runtime = new RemovalRuntime(store)
    record = {
      worktreeId: TEST_WORKTREE_ID,
      repoId: TEST_REPO_ID,
      repoPath: TEST_REPO_PATH,
      worktreePath: TEST_WORKTREE_PATH,
      branch: 'feature',
      head: '',
      deleteBranch: false,
      force: false,
      requestedAt: Date.now()
    }
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(async () => {
    await _settlePendingWorktreeRemovalsForTests()
    _resetPendingWorktreeRemovalsForTests()
    vi.restoreAllMocks()
  })

  it('retains runtime purge dispatch in a recovery job', () => {
    runtime.recoveryJobHost().purge(record)
    expect(runtime.purges).toEqual([
      { store, worktreeId: record.worktreeId, repoId: record.repoId, hostId: 'local' }
    ])
  })

  it('uses the runtime helper override before resuming an interrupted removal', () => {
    runtime.stopAtHelper = true
    pendingWorktreeRemovals.set(record.worktreeId, record)
    expect(() => runtime.finishInterruptedWorktreeRemovals()).toThrow(runtime.helperFailure)
  })

  it('uses the runtime helper override before retrying a failed removal', async () => {
    runtime.stopAtHelper = true
    failedWorktreeRemovals.set(record.worktreeId, record)
    await expect(runtime.retryRemoval(record)).rejects.toThrow(runtime.helperFailure)
  })

  it('captures the watcher callback and retains its job-host receiver', async () => {
    const calls: { receiver: unknown; path: string }[] = []
    runtime.acquireFileWatcherRemoval = async function (this: unknown, path: string) {
      calls.push({ receiver: this, path })
      return { finish: async () => {} }
    }
    const captured = runtime.acquireFileWatcherRemoval
    const host = runtime.recoveryJobHost()
    runtime.acquireFileWatcherRemoval = async () => {
      throw new Error('replacement callback')
    }
    await host.acquireWatcherRemoval(record.worktreePath)
    expect(host.acquireWatcherRemoval).toBe(captured)
    expect(calls).toEqual([{ receiver: host, path: record.worktreePath }])
  })

  it('reads the current runtime removal queue', async () => {
    const replacement = runtime.currentRemovalQueue()
    const failure = new Error('current removal queue')
    const get = vi.spyOn(replacement, 'get').mockImplementation(() => {
      throw failure
    })
    runtime.stopAtStore = true
    runtime['resolveWorktreeRemovalTarget'] = async () => ({
      id: TEST_WORKTREE_ID,
      repoId: TEST_REPO_ID,
      path: TEST_WORKTREE_PATH
    })
    runtime['joinPendingWorktreeRemoval'] = () => undefined
    await expect(runtime.removeManagedWorktree(TEST_WORKTREE_ID)).rejects.toBe(failure)
    expect(get).toHaveBeenCalledOnce()
  })
})
