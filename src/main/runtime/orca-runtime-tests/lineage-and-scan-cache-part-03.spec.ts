import { describe, expect, it, vi } from 'vitest'
import {
  MOCK_GIT_WORKTREES,
  OrcaRuntimeService,
  listWorktrees,
  registerSshGitProvider,
  unregisterSshGitProvider
} from '../orca-runtime-test-mocks.spec'
import type { Worktree, WorktreeLineage, WorktreeMeta } from '../orca-runtime-test-mocks.spec'
import {
  TEST_REPO_ID,
  TEST_REPO_PATH,
  TEST_WORKTREE_PATH,
  createRuntime,
  deferred,
  makeWorktreeInfo,
  makeWorktreeMeta,
  store,
  withPlatform
} from '../orca-runtime-test-fixtures.spec'

describe('OrcaRuntimeService', () => {
  it('hides agent scratch created inside a linked checkout from runtime listings', async () => {
    const linkedCheckoutPath = '/tmp/worktree-a'
    const scratchPath = `${linkedCheckoutPath}/.claude/worktrees/agent-a04ccaaa`
    vi.mocked(listWorktrees).mockClear()
    vi.mocked(listWorktrees).mockResolvedValue([
      makeWorktreeInfo(TEST_REPO_PATH),
      makeWorktreeInfo(linkedCheckoutPath),
      makeWorktreeInfo(scratchPath)
    ])
    const runtime = createRuntime()

    const detected = await runtime.listDetectedManagedWorktrees(`id:${TEST_REPO_ID}`)
    const listed = await runtime.listManagedWorktrees(`id:${TEST_REPO_ID}`)

    expect(detected.worktrees.find((worktree) => worktree.path === scratchPath)).toMatchObject({
      ownership: 'agent-scratch',
      visible: false
    })
    expect(listed.worktrees.map((worktree) => worktree.path)).toEqual([
      TEST_REPO_PATH,
      linkedCheckoutPath
    ])
    expect(listWorktrees).toHaveBeenCalledTimes(1)
  })

  it('bounds repeated detected worktree scans across the reported 15-repo shape', async () => {
    vi.mocked(listWorktrees).mockReset()
    const repos = Array.from({ length: 15 }, (_, index) => ({
      id: `repo-${index + 1}`,
      path: `/tmp/repo-${index + 1}`,
      displayName: `repo-${index + 1}`,
      badgeColor: 'blue' as const,
      addedAt: 1
    }))
    const runtime = new OrcaRuntimeService({
      ...store,
      getRepos: () => repos,
      getRepo: (id: string) => repos.find((repo) => repo.id === id),
      getAllWorktreeMeta: () => ({}),
      getWorktreeMeta: () => undefined
    } as never)
    vi.mocked(listWorktrees).mockImplementation(async (repoPath) => [
      {
        path: `${repoPath}/main`,
        head: repoPath,
        branch: 'main',
        isBare: false,
        isMainWorktree: true
      }
    ])

    const poll = async () =>
      Promise.all(repos.map((repo) => runtime.listDetectedManagedWorktrees(`id:${repo.id}`)))
    const first = await poll()
    expect(listWorktrees).toHaveBeenCalledTimes(15)
    const second = await poll()

    expect(first.flatMap((result) => result.worktrees)).toHaveLength(15)
    expect(second.flatMap((result) => result.worktrees)).toHaveLength(15)
    expect(second.flatMap((result) => result.worktrees).map((worktree) => worktree.path)).toEqual(
      repos.map((repo) => `${repo.path}/main`)
    )
    expect(listWorktrees).toHaveBeenCalledTimes(15)
  })

  it('worktree scan cache: shares one in-flight repo scan across concurrent consumers', async () => {
    vi.mocked(listWorktrees).mockClear()
    const pending = deferred<ReturnType<typeof makeWorktreeInfo>[]>()
    vi.mocked(listWorktrees).mockReturnValueOnce(pending.promise)
    const runtime = createRuntime()

    const detected = runtime.listDetectedManagedWorktrees(`id:${TEST_REPO_ID}`)
    const resolved = runtime.listManagedWorktrees()
    await Promise.resolve()
    expect(listWorktrees).toHaveBeenCalledTimes(1)

    pending.resolve([makeWorktreeInfo(TEST_WORKTREE_PATH)])
    await expect(Promise.all([detected, resolved])).resolves.toBeTruthy()
    expect(listWorktrees).toHaveBeenCalledTimes(1)
  })

  it('worktree scan cache: keeps colliding local and SSH owners warm independently', async () => {
    vi.mocked(listWorktrees).mockClear()
    const localRepo = store.getRepo(TEST_REPO_ID)!
    const remoteRepo = { ...localRepo, path: '/remote/repo', connectionId: 'ssh-1' }
    const provider = {
      listWorktrees: vi.fn().mockResolvedValue([makeWorktreeInfo('/remote/worktree')])
    }
    registerSshGitProvider('ssh-1', provider as never)
    const runtime = new OrcaRuntimeService({
      ...store,
      getRepos: () => [localRepo, remoteRepo]
    } as never)
    vi.mocked(listWorktrees).mockResolvedValue([makeWorktreeInfo(TEST_WORKTREE_PATH)])

    try {
      await runtime.listManagedWorktrees()
      runtime.notifyWorktreesChangedForRemoteClients(TEST_REPO_ID)
      await runtime.listManagedWorktrees()

      expect(listWorktrees).toHaveBeenCalledTimes(1)
      expect(provider.listWorktrees).toHaveBeenCalledTimes(1)

      unregisterSshGitProvider('ssh-1')
      const replacementProvider = {
        listWorktrees: vi.fn().mockResolvedValue([makeWorktreeInfo('/remote/replacement')])
      }
      registerSshGitProvider('ssh-1', replacementProvider as never)
      runtime.notifyWorktreesChangedForRemoteClients(TEST_REPO_ID)
      await runtime.listManagedWorktrees()

      expect(listWorktrees).toHaveBeenCalledTimes(1)
      expect(replacementProvider.listWorktrees).toHaveBeenCalledTimes(1)
    } finally {
      unregisterSshGitProvider('ssh-1')
    }
  })

  it('keeps detected metadata scoped to the selected colliding host', async () => {
    const localRepo = store.getRepo(TEST_REPO_ID)!
    const remoteRepo = { ...localRepo, path: '/remote/repo', connectionId: 'ssh-1' }
    const worktreePath = '/same/worktree'
    const worktreeId = `${TEST_REPO_ID}::${worktreePath}`
    const localMeta = makeWorktreeMeta({
      hostId: 'local',
      displayName: 'local-only-name',
      comment: 'local-only-comment',
      isPinned: true
    })
    const runtimeStore = {
      ...store,
      getRepos: () => [localRepo, remoteRepo],
      getRepo: (id: string) => (id === localRepo.id ? localRepo : undefined),
      getAllWorktreeMeta: () => ({ [worktreeId]: localMeta }),
      getWorktreeMeta: (id: string) => (id === worktreeId ? localMeta : undefined)
    }
    const provider = { listWorktrees: vi.fn().mockResolvedValue([makeWorktreeInfo(worktreePath)]) }
    registerSshGitProvider('ssh-1', provider as never)
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    try {
      const result = await runtime.listDetectedManagedWorktrees(`id:${TEST_REPO_ID}`, 'ssh-1')

      expect(result.worktrees).toEqual([
        expect.objectContaining({
          id: worktreeId,
          hostId: 'ssh:ssh-1',
          comment: '',
          isPinned: false
        })
      ])
      expect(result.worktrees[0]?.displayName).not.toBe('local-only-name')
    } finally {
      unregisterSshGitProvider('ssh-1')
    }
  })

  it('does not project one colliding host lineage onto another host rows', async () => {
    const localRepo = store.getRepo(TEST_REPO_ID)!
    const remoteRepo = { ...localRepo, connectionId: 'ssh-1' }
    const parentPath = '/same/parent'
    const childPath = '/same/child'
    const parentId = `${TEST_REPO_ID}::${parentPath}`
    const childId = `${TEST_REPO_ID}::${childPath}`
    const metaById: Record<string, WorktreeMeta> = {
      [parentId]: makeWorktreeMeta({ hostId: 'ssh:ssh-1', instanceId: 'remote-parent' }),
      [childId]: makeWorktreeMeta({ hostId: 'ssh:ssh-1', instanceId: 'remote-child' })
    }
    const lineageById: Record<string, WorktreeLineage> = {
      [childId]: {
        worktreeId: childId,
        worktreeInstanceId: 'remote-child',
        parentWorktreeId: parentId,
        parentWorktreeInstanceId: 'remote-parent',
        origin: 'manual',
        capture: { source: 'manual-action', confidence: 'explicit' },
        createdAt: 1
      }
    }
    const runtimeStore = {
      ...store,
      getRepos: () => [localRepo, remoteRepo],
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (id: string) => metaById[id],
      getAllWorktreeLineage: () => lineageById
    }
    const rows = [makeWorktreeInfo(childPath), makeWorktreeInfo(parentPath)]
    vi.mocked(listWorktrees).mockResolvedValue(rows)
    const provider = { listWorktrees: vi.fn().mockResolvedValue(rows) }
    registerSshGitProvider('ssh-1', provider as never)
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    try {
      const resolved = await (
        runtime as unknown as { listResolvedWorktrees: () => Promise<Worktree[]> }
      ).listResolvedWorktrees()
      const localChild = resolved.find(
        (worktree) => worktree.id === childId && worktree.hostId === 'local'
      )
      const remoteChild = resolved.find(
        (worktree) => worktree.id === childId && worktree.hostId === 'ssh:ssh-1'
      )

      expect(localChild).toMatchObject({ parentWorktreeId: null, lineage: null })
      expect(remoteChild).toMatchObject({ parentWorktreeId: parentId })
    } finally {
      unregisterSshGitProvider('ssh-1')
    }
  })

  it('worktree scan cache: rescans immediately after worktree invalidation', async () => {
    vi.mocked(listWorktrees).mockClear()
    const runtime = createRuntime()
    await runtime.listDetectedManagedWorktrees(`id:${TEST_REPO_ID}`)
    runtime.notifyBranchRenamed(TEST_REPO_ID)
    await runtime.listDetectedManagedWorktrees(`id:${TEST_REPO_ID}`)

    expect(listWorktrees).toHaveBeenCalledTimes(2)
  })

  it('worktree scan cache: repo invalidation preserves sibling raw scans', async () => {
    vi.mocked(listWorktrees).mockClear()
    const repos = [
      { ...store.getRepos()[0], id: 'repo-a', path: '/tmp/repo-a' },
      { ...store.getRepos()[0], id: 'repo-b', path: '/tmp/repo-b' }
    ]
    const runtime = new OrcaRuntimeService({
      ...store,
      getRepos: () => repos,
      getRepo: (id: string) => repos.find((repo) => repo.id === id)
    } as never)
    vi.mocked(listWorktrees).mockImplementation(async (repoPath) => [makeWorktreeInfo(repoPath)])

    await runtime.listDetectedManagedWorktrees('id:repo-a')
    await runtime.listDetectedManagedWorktrees('id:repo-b')
    runtime.notifyBranchRenamed('repo-a')
    await runtime.listDetectedManagedWorktrees('id:repo-b')
    await runtime.listDetectedManagedWorktrees('id:repo-a')

    expect(listWorktrees).toHaveBeenCalledTimes(3)
    expect(listWorktrees).toHaveBeenNthCalledWith(3, '/tmp/repo-a')
  })

  it('worktree scan cache: metadata invalidation preserves raw scans', async () => {
    vi.mocked(listWorktrees).mockClear()
    const runtime = createRuntime()
    await runtime.listDetectedManagedWorktrees(`id:${TEST_REPO_ID}`)
    runtime.notifyWorktreesChangedForRemoteClients(TEST_REPO_ID)
    await runtime.listDetectedManagedWorktrees(`id:${TEST_REPO_ID}`)

    expect(listWorktrees).toHaveBeenCalledTimes(1)
  })

  // #11994: the host renderer already applied its own repos:changed, so re-notifying it
  // would re-sort the sidebar; only the client-event stream may fire here.
  it('notifyReposChangedForRemoteClients emits to clients without re-notifying the host', () => {
    const runtime = createRuntime()
    const reposChanged = vi.fn()
    runtime.setNotifier({ reposChanged } as never)
    const events: { type: string }[] = []
    const unsubscribe = runtime.onClientEvent((event) => events.push(event))

    runtime.notifyReposChangedForRemoteClients()
    unsubscribe()

    expect(events).toEqual([{ type: 'reposChanged' }])
    expect(reposChanged).not.toHaveBeenCalled()
  })

  it('persists changed worktree order once and emits targeted invalidations', () => {
    const firstId = `${TEST_REPO_ID}::/tmp/first`
    const secondId = `${TEST_REPO_ID}::/tmp/second`
    const metaById: Record<string, Partial<WorktreeMeta>> = {
      [firstId]: { sortOrder: 200 },
      [secondId]: { sortOrder: 100 }
    }
    const setWorktreeMeta = vi.fn((id: string, updates: Partial<WorktreeMeta>) => {
      metaById[id] = { ...metaById[id], ...updates }
    })
    const runtime = new OrcaRuntimeService({
      ...store,
      getWorktreeMeta: (id: string) => metaById[id],
      setWorktreeMeta
    } as never)
    const events: { type: string; repoId?: string }[] = []
    const unsubscribe = runtime.onClientEvent((event) => events.push(event))

    expect(runtime.persistManagedWorktreeSortOrder([firstId, secondId])).toEqual({ updated: 0 })
    expect(setWorktreeMeta).not.toHaveBeenCalled()
    expect(events).toEqual([])

    expect(runtime.persistManagedWorktreeSortOrder([secondId, firstId])).toEqual({ updated: 2 })
    unsubscribe()

    expect(setWorktreeMeta).toHaveBeenCalledTimes(2)
    expect(events).toEqual([{ type: 'worktreesChanged', repoId: TEST_REPO_ID }])
  })

  it('worktree scan cache: folder metadata invalidation preserves raw scans', async () => {
    vi.mocked(listWorktrees).mockClear()
    const runtime = createRuntime()
    await runtime.listDetectedManagedWorktrees(`id:${TEST_REPO_ID}`)
    runtime.notifyFolderWorkspaceChanged()
    await runtime.listDetectedManagedWorktrees(`id:${TEST_REPO_ID}`)

    expect(listWorktrees).toHaveBeenCalledTimes(1)
  })

  it('worktree scan cache: expires scans per repo without coupling sibling repos', async () => {
    vi.mocked(listWorktrees).mockClear()
    vi.useFakeTimers({ now: 0 })
    try {
      const repos = [
        { ...store.getRepos()[0], id: 'repo-a', path: '/tmp/repo-a' },
        { ...store.getRepos()[0], id: 'repo-b', path: '/tmp/repo-b' }
      ]
      const runtime = new OrcaRuntimeService({
        ...store,
        getRepos: () => repos,
        getRepo: (id: string) => repos.find((repo) => repo.id === id)
      } as never)
      vi.mocked(listWorktrees).mockImplementation(async (repoPath) => [makeWorktreeInfo(repoPath)])

      await runtime.listDetectedManagedWorktrees('id:repo-a')
      await vi.advanceTimersByTimeAsync(10_000)
      await runtime.listDetectedManagedWorktrees('id:repo-b')
      await vi.advanceTimersByTimeAsync(20_000)
      await runtime.listDetectedManagedWorktrees('id:repo-a')
      await runtime.listDetectedManagedWorktrees('id:repo-b')

      expect(listWorktrees).toHaveBeenCalledTimes(3)
      expect(listWorktrees).toHaveBeenNthCalledWith(3, '/tmp/repo-a')
    } finally {
      vi.useRealTimers()
    }
  })

  it('worktree scan cache: does not cache non-authoritative SSH scan failures', async () => {
    const remoteRepo = { ...store.getRepo(TEST_REPO_ID)!, connectionId: 'ssh-1' }
    const remoteStore = {
      ...store,
      getRepo: (id: string) => (id === remoteRepo.id ? remoteRepo : undefined),
      getRepos: () => [remoteRepo]
    }
    const provider = { listWorktrees: vi.fn() }
    provider.listWorktrees
      .mockRejectedValueOnce(new Error('git unavailable'))
      .mockResolvedValueOnce([makeWorktreeInfo(TEST_WORKTREE_PATH)])
    registerSshGitProvider('ssh-1', provider as never)
    const runtime = new OrcaRuntimeService(remoteStore as never)

    try {
      await expect(
        runtime.listDetectedManagedWorktrees(`id:${TEST_REPO_ID}`)
      ).resolves.toMatchObject({ authoritative: false })
      await expect(
        runtime.listDetectedManagedWorktrees(`id:${TEST_REPO_ID}`)
      ).resolves.toMatchObject({ authoritative: true })
      expect(provider.listWorktrees).toHaveBeenCalledTimes(2)
    } finally {
      unregisterSshGitProvider('ssh-1')
    }
  })

  it('worktree scan cache: invalidates when SSH availability changes', async () => {
    const remoteRepo = { ...store.getRepo(TEST_REPO_ID)!, connectionId: 'ssh-1' }
    const remoteStore = {
      ...store,
      getRepo: (id: string) => (id === remoteRepo.id ? remoteRepo : undefined),
      getRepos: () => [remoteRepo]
    }
    const provider = { listWorktrees: vi.fn().mockResolvedValue(MOCK_GIT_WORKTREES) }
    registerSshGitProvider('ssh-1', provider as never)
    const runtime = new OrcaRuntimeService(remoteStore as never)

    try {
      await expect(
        runtime.listDetectedManagedWorktrees(`id:${TEST_REPO_ID}`)
      ).resolves.toMatchObject({ authoritative: true })
      unregisterSshGitProvider('ssh-1')
      await expect(
        runtime.listDetectedManagedWorktrees(`id:${TEST_REPO_ID}`)
      ).resolves.toMatchObject({ authoritative: false })
      expect(provider.listWorktrees).toHaveBeenCalledTimes(1)
    } finally {
      unregisterSshGitProvider('ssh-1')
    }
  })

  it('worktree scan cache: SSH state changes do not evict local repo scans', async () => {
    vi.mocked(listWorktrees).mockClear()
    const localRepo = { ...store.getRepo(TEST_REPO_ID)!, id: 'local-repo' }
    const remoteRepo = { ...store.getRepo(TEST_REPO_ID)!, id: 'remote-repo', connectionId: 'ssh-1' }
    const repos = [localRepo, remoteRepo]
    const remoteStore = {
      ...store,
      getRepo: (id: string) => repos.find((repo) => repo.id === id),
      getRepos: () => repos
    }
    const provider = { listWorktrees: vi.fn().mockResolvedValue(MOCK_GIT_WORKTREES) }
    registerSshGitProvider('ssh-1', provider as never)
    const runtime = new OrcaRuntimeService(remoteStore as never)

    try {
      await runtime.listDetectedManagedWorktrees('id:local-repo')
      await runtime.listDetectedManagedWorktrees('id:remote-repo')
      runtime.notifySshStateChanged('ssh-1', {
        targetId: 'ssh-1',
        status: 'disconnected',
        error: null,
        reconnectAttempt: 0
      })
      await runtime.listDetectedManagedWorktrees('id:local-repo')
      await runtime.listDetectedManagedWorktrees('id:remote-repo')

      expect(listWorktrees).toHaveBeenCalledTimes(1)
      expect(provider.listWorktrees).toHaveBeenCalledTimes(2)
    } finally {
      unregisterSshGitProvider('ssh-1')
    }
  })

  it('worktree scan cache: SSH state changes invalidate empty resolved snapshots', async () => {
    const remoteRepo = { ...store.getRepo(TEST_REPO_ID)!, connectionId: 'ssh-empty' }
    const remoteStore = {
      ...store,
      getRepo: (id: string) => (id === remoteRepo.id ? remoteRepo : undefined),
      getRepos: () => [remoteRepo]
    }
    const provider = { listWorktrees: vi.fn().mockResolvedValue([]) }
    registerSshGitProvider('ssh-empty', provider as never)
    const runtime = new OrcaRuntimeService(remoteStore as never)

    try {
      await expect(runtime.listManagedWorktrees()).resolves.toMatchObject({ totalCount: 0 })
      runtime.notifySshStateChanged('ssh-empty', {
        targetId: 'ssh-empty',
        status: 'connected',
        error: null,
        reconnectAttempt: 0
      })
      await expect(runtime.listManagedWorktrees()).resolves.toMatchObject({ totalCount: 0 })
      expect(provider.listWorktrees).toHaveBeenCalledTimes(2)
    } finally {
      unregisterSshGitProvider('ssh-empty')
    }
  })

  it('worktree scan cache: SSH state changes for unknown targets keep local snapshots in flight', async () => {
    vi.mocked(listWorktrees).mockClear()
    const pending = deferred<ReturnType<typeof makeWorktreeInfo>[]>()
    vi.mocked(listWorktrees).mockReturnValueOnce(pending.promise)
    const runtime = new OrcaRuntimeService(store)

    const first = runtime.listManagedWorktrees()
    await Promise.resolve()
    runtime.notifySshStateChanged('ssh-unknown', {
      targetId: 'ssh-unknown',
      status: 'disconnected',
      error: null,
      reconnectAttempt: 0
    })
    pending.resolve([makeWorktreeInfo(TEST_WORKTREE_PATH)])
    await expect(first).resolves.toMatchObject({ totalCount: 1 })
    await expect(runtime.listManagedWorktrees()).resolves.toMatchObject({ totalCount: 1 })

    expect(listWorktrees).toHaveBeenCalledTimes(1)
  })

  it('worktree scan cache: separates local project runtime changes', async () => {
    vi.mocked(listWorktrees).mockClear()
    let runtimeDefault: unknown = { kind: 'windows-host' }
    const runtimeStore = {
      ...store,
      getProjects: () => [{ id: 'project-1', sourceRepoIds: [TEST_REPO_ID] }],
      getSettings: () => ({ ...store.getSettings(), localWindowsRuntimeDefault: runtimeDefault })
    }

    await withPlatform('win32', async () => {
      const runtime = new OrcaRuntimeService(runtimeStore as never)
      await runtime.listDetectedManagedWorktrees(`id:${TEST_REPO_ID}`)
      runtimeDefault = { kind: 'wsl', distro: 'Ubuntu' }
      await runtime.listDetectedManagedWorktrees(`id:${TEST_REPO_ID}`)
    })

    expect(listWorktrees).toHaveBeenCalledTimes(2)
  })

  it('worktree scan cache: ignores a late result from an older runtime key', async () => {
    vi.mocked(listWorktrees).mockClear()
    let runtimeDefault: unknown = { kind: 'windows-host' }
    const runtimeStore = {
      ...store,
      getProjects: () => [{ id: 'project-1', sourceRepoIds: [TEST_REPO_ID] }],
      getSettings: () => ({ ...store.getSettings(), localWindowsRuntimeDefault: runtimeDefault })
    }
    const firstScan = deferred<ReturnType<typeof makeWorktreeInfo>[]>()
    const secondScan = deferred<ReturnType<typeof makeWorktreeInfo>[]>()
    vi.mocked(listWorktrees)
      .mockReturnValueOnce(firstScan.promise)
      .mockReturnValueOnce(secondScan.promise)

    await withPlatform('win32', async () => {
      const runtime = new OrcaRuntimeService(runtimeStore as never)
      const first = runtime.listDetectedManagedWorktrees(`id:${TEST_REPO_ID}`)
      await Promise.resolve()
      expect(listWorktrees).toHaveBeenCalledTimes(1)

      runtimeDefault = { kind: 'wsl', distro: 'Ubuntu' }
      const second = runtime.listDetectedManagedWorktrees(`id:${TEST_REPO_ID}`)
      await Promise.resolve()
      expect(listWorktrees).toHaveBeenCalledTimes(2)

      secondScan.resolve([makeWorktreeInfo(TEST_WORKTREE_PATH)])
      await second
      firstScan.resolve([makeWorktreeInfo(TEST_WORKTREE_PATH)])
      await first
      await runtime.listDetectedManagedWorktrees(`id:${TEST_REPO_ID}`)
    })

    expect(listWorktrees).toHaveBeenCalledTimes(2)
  })

  it('worktree scan cache: keeps lineage shaping outside the raw scan cache', async () => {
    vi.mocked(listWorktrees).mockClear()
    const paths = ['orchestration', 'cli', 'manual']
    const metaById: Record<string, WorktreeMeta> = {}
    const lineageById: Record<string, WorktreeLineage> = {}
    const worktrees = paths.flatMap((origin, index) => {
      const parentPath = `/tmp/${origin}-parent`
      const childPath = `/tmp/${origin}-child`
      const parentId = `${TEST_REPO_ID}::${parentPath}`
      const childId = `${TEST_REPO_ID}::${childPath}`
      metaById[parentId] = makeWorktreeMeta({ instanceId: `parent-${index}` })
      metaById[childId] = makeWorktreeMeta({ instanceId: `child-${index}` })
      lineageById[childId] = {
        worktreeId: childId,
        worktreeInstanceId: `child-${index}`,
        parentWorktreeId: parentId,
        parentWorktreeInstanceId: `parent-${index}`,
        origin: origin === 'orchestration' ? 'orchestration' : origin === 'cli' ? 'cli' : 'manual',
        capture: { source: 'manual-action', confidence: 'explicit' },
        createdAt: 1
      }
      return [
        { path: parentPath, head: 'parent', branch: origin, isBare: false, isMainWorktree: false },
        {
          path: childPath,
          head: 'child',
          branch: `${origin}-child`,
          isBare: false,
          isMainWorktree: false
        }
      ]
    })
    const runtimeStore = {
      ...store,
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...metaById[worktreeId], ...meta }
        return metaById[worktreeId]
      },
      getAllWorktreeLineage: () => lineageById
    }
    vi.mocked(listWorktrees).mockResolvedValue(worktrees)
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    await runtime.listDetectedManagedWorktrees(`id:${TEST_REPO_ID}`)
    const listed = await runtime.listManagedWorktrees(`id:${TEST_REPO_ID}`)

    expect(
      listed.worktrees
        .filter((worktree) => worktree.lineage)
        .map((worktree) => worktree.lineage?.origin)
    ).toEqual(paths)
    expect(listWorktrees).toHaveBeenCalledTimes(1)
  })

  it('does not prune lineage when an SSH runtime provider is unavailable', async () => {
    const remoteRepo = {
      id: 'remote-repo',
      path: '/home/user/repo',
      displayName: 'remote',
      badgeColor: 'blue',
      addedAt: 1,
      connectionId: 'ssh-1'
    }
    const parentId = `${remoteRepo.id}::/home/user/repo-parent`
    const childId = `${remoteRepo.id}::/home/user/repo-child`
    const metaById: Record<string, WorktreeMeta> = {
      [parentId]: makeWorktreeMeta({ instanceId: 'parent-instance' }),
      [childId]: makeWorktreeMeta({ instanceId: 'child-instance' })
    }
    const lineageById: Record<string, WorktreeLineage> = {
      [childId]: {
        worktreeId: childId,
        worktreeInstanceId: 'child-instance',
        parentWorktreeId: parentId,
        parentWorktreeInstanceId: 'parent-instance',
        origin: 'manual',
        capture: { source: 'manual-action', confidence: 'explicit' },
        createdAt: 1
      }
    }
    const removeWorktreeLineage = vi.fn((worktreeId: string) => {
      delete lineageById[worktreeId]
    })
    const runtimeStore = {
      ...store,
      getRepo: (id: string) => (id === remoteRepo.id ? remoteRepo : undefined),
      getRepos: () => [remoteRepo],
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: vi.fn((worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...metaById[worktreeId], ...meta }
        return metaById[worktreeId]
      }),
      getAllWorktreeLineage: () => lineageById,
      removeWorktreeLineage
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    await expect(runtime.showManagedWorktree(`id:${childId}`)).resolves.toMatchObject({
      id: childId,
      parentWorktreeId: parentId,
      lineage: lineageById[childId]
    })

    expect(removeWorktreeLineage).not.toHaveBeenCalled()
    expect(runtimeStore.setWorktreeMeta).not.toHaveBeenCalled()
    expect(lineageById[childId]).toBeTruthy()
    expect(metaById[parentId].instanceId).toBe('parent-instance')
  })
})
