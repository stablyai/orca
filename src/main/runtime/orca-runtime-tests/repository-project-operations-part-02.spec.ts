import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_REPO_BADGE_COLOR,
  EventEmitter,
  OrcaRuntimeService,
  clearSubmodulePathsCacheForTests,
  execFileSync,
  getRepoUpstreamMock,
  gitRunner,
  invalidateAuthorizedRootsCacheMock,
  join,
  listSubmodulePaths,
  lstat,
  mkdir,
  mkdirSync,
  mkdtemp,
  prepareLocalWorktreeRootForRepoMock,
  projectHostSetupProjectionFromRepos,
  rm,
  tmpdir,
  writeFile
} from '../orca-runtime-test-mocks.spec'
import {
  TEST_REPO_ID,
  TEST_REPO_PATH,
  createRuntime,
  store
} from '../orca-runtime-test-fixtures.spec'

describe('OrcaRuntimeService', () => {
  it('adopts public clone repos into host-qualified project setup', async () => {
    const destination = await mkdtemp(join(tmpdir(), 'orca-runtime-project-clone-'))
    const clonePath = join(destination, 'orca')
    const spawnSpy = vi.spyOn(gitRunner, 'gitSpawnAfterWindowsEnvironmentReady')
    const repos: Record<string, unknown>[] = []
    getRepoUpstreamMock.mockResolvedValue({ owner: 'stablyai', repo: 'orca' })
    const runtimeStore = {
      ...store,
      getRepos: () => [...repos] as never,
      addRepo: (repo: Record<string, unknown>) => {
        repos.push(repo)
      },
      getRepo: (id: string) => repos.find((repo) => repo.id === id) as never,
      updateRepo: (id: string, updates: Record<string, unknown>) => {
        const index = repos.findIndex((repo) => repo.id === id)
        if (index === -1) {
          return null
        }
        repos[index] = { ...repos[index], ...updates }
        return repos[index] as never
      },
      getProjects: () => projectHostSetupProjectionFromRepos(repos as never).projects as never,
      getProjectHostSetups: () =>
        projectHostSetupProjectionFromRepos(repos as never).setups as never
    }
    spawnSpy.mockImplementation(() => {
      const proc = new EventEmitter() as EventEmitter & { stderr: EventEmitter }
      proc.stderr = new EventEmitter()
      setImmediate(() => {
        mkdirSync(clonePath, { recursive: true })
        execFileSync('git', ['init'], { cwd: clonePath, stdio: 'ignore' })
        proc.emit('close', 0, null)
      })
      return proc as never
    })
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    try {
      const cloned = await runtime.cloneRepo('https://example.com/orca.git', destination)
      expect(cloned).toMatchObject({
        path: clonePath
      })
      expect(cloned).not.toHaveProperty('executionHostId')

      const result = await runtime.setupProjectExistingFolder({
        projectId: 'github:stablyai/orca',
        hostId: 'runtime:env-1',
        path: clonePath,
        kind: 'git',
        setupMethod: 'cloned'
      })

      expect(repos).toHaveLength(1)
      expect(result.repo).toMatchObject({
        id: cloned.id,
        path: clonePath,
        executionHostId: 'runtime:env-1',
        projectHostSetupMethod: 'cloned'
      })
      expect(result.setup).toMatchObject({
        repoId: cloned.id,
        hostId: 'runtime:env-1',
        setupMethod: 'cloned'
      })
    } finally {
      spawnSpy.mockRestore()
      await rm(destination, { recursive: true, force: true })
    }
  })

  it('keeps project clone repos split by runtime host on the same clone path', async () => {
    const destination = await mkdtemp(join(tmpdir(), 'orca-runtime-project-clone-'))
    const clonePath = join(destination, 'orca')
    const spawnSpy = vi.spyOn(gitRunner, 'gitSpawnAfterWindowsEnvironmentReady')
    const repos: Record<string, unknown>[] = [
      {
        id: 'repo-host-a',
        path: clonePath,
        displayName: 'orca',
        badgeColor: 'blue',
        addedAt: 1,
        kind: 'git',
        executionHostId: 'runtime:env-1'
      }
    ]
    getRepoUpstreamMock.mockResolvedValue({ owner: 'stablyai', repo: 'orca' })
    const runtimeStore = {
      ...store,
      getRepos: () => [...repos] as never,
      addRepo: (repo: Record<string, unknown>) => {
        repos.push(repo)
      },
      getRepo: (id: string) => repos.find((repo) => repo.id === id) as never,
      updateRepo: (id: string, updates: Record<string, unknown>) => {
        const index = repos.findIndex((repo) => repo.id === id)
        if (index === -1) {
          return null
        }
        repos[index] = { ...repos[index], ...updates }
        return repos[index] as never
      },
      getProjects: () => projectHostSetupProjectionFromRepos(repos as never).projects as never,
      getProjectHostSetups: () =>
        projectHostSetupProjectionFromRepos(repos as never).setups as never
    }
    spawnSpy.mockImplementation(() => {
      const proc = new EventEmitter() as EventEmitter & { stderr: EventEmitter }
      proc.stderr = new EventEmitter()
      setImmediate(() => {
        mkdirSync(clonePath, { recursive: true })
        execFileSync('git', ['init'], { cwd: clonePath, stdio: 'ignore' })
        proc.emit('close', 0, null)
      })
      return proc as never
    })
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    try {
      const result = await runtime.setupProjectClone({
        projectId: 'github:stablyai/orca',
        hostId: 'runtime:env-2',
        url: 'https://example.com/orca.git',
        destination
      })

      expect(repos).toHaveLength(2)
      expect(repos[0]).toMatchObject({
        id: 'repo-host-a',
        executionHostId: 'runtime:env-1'
      })
      expect(result.repo).toMatchObject({
        path: clonePath,
        executionHostId: 'runtime:env-2'
      })
      expect(result.repo.id).not.toBe('repo-host-a')
      expect(result.setup).toMatchObject({
        repoId: result.repo.id,
        hostId: 'runtime:env-2',
        setupMethod: 'cloned'
      })
    } finally {
      spawnSpy.mockRestore()
      await rm(destination, { recursive: true, force: true })
    }
  })

  it('defaults runtime createRepo badgeColor to DEFAULT_REPO_BADGE_COLOR', async () => {
    const added: Record<string, unknown>[] = []
    const colorStore = {
      ...store,
      getRepos: () => [...added] as never,
      addRepo: (repo: Record<string, unknown>) => {
        added.push(repo)
      },
      getRepo: (id: string) => added.find((repo) => repo.id === id) as never
    }
    const runtime = new OrcaRuntimeService(colorStore as never)
    const parentDir = await mkdtemp('/tmp/orca-runtime-create-')
    try {
      const result = await runtime.createRepo(parentDir, 'runtime-create-default', 'folder')
      if ('error' in result) {
        throw new Error(result.error)
      }

      expect(result).toHaveProperty('repo.badgeColor', DEFAULT_REPO_BADGE_COLOR)
      expect(added).toEqual([expect.objectContaining({ badgeColor: DEFAULT_REPO_BADGE_COLOR })])
    } finally {
      await rm(parentDir, { recursive: true, force: true })
    }
  })

  it('creates a missing runtime parent before creating the project directory', async () => {
    const added: Record<string, unknown>[] = []
    const createStore = {
      ...store,
      getRepos: () => [...added] as never,
      addRepo: (repo: Record<string, unknown>) => {
        added.push(repo)
      },
      getRepo: (id: string) => added.find((repo) => repo.id === id) as never
    }
    const runtime = new OrcaRuntimeService(createStore as never)
    const tempRoot = await mkdtemp(join(tmpdir(), 'orca-runtime-create-parent-'))
    const parentDir = join(tempRoot, 'orca', 'projects')
    try {
      const result = await runtime.createRepo(parentDir, 'first-project', 'folder')
      if ('error' in result) {
        throw new Error(result.error)
      }

      expect((await lstat(parentDir)).isDirectory()).toBe(true)
      expect((await lstat(join(parentDir, 'first-project'))).isDirectory()).toBe(true)
      expect(result).toHaveProperty('repo.path', join(parentDir, 'first-project'))
    } finally {
      await rm(tempRoot, { recursive: true, force: true })
    }
  })

  it('prepares the runtime worktree root when creating a repo', async () => {
    const added: Record<string, unknown>[] = []
    const runtimeStore = {
      ...store,
      getRepos: () => [...added] as never,
      addRepo: (repo: Record<string, unknown>) => {
        added.push(repo)
      },
      getRepo: (id: string) => added.find((repo) => repo.id === id) as never
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const parentDir = await mkdtemp(join(tmpdir(), 'orca-runtime-create-root-prep-'))
    try {
      const result = await runtime.createRepo(parentDir, 'runtime-create-root-prep', 'folder')
      if ('error' in result) {
        throw new Error(result.error)
      }

      expect(prepareLocalWorktreeRootForRepoMock).toHaveBeenCalledWith(runtimeStore, result.repo)
    } finally {
      await rm(parentDir, { recursive: true, force: true })
    }
  })

  it('preserves existing badgeColor on runtime createRepo dedupe', async () => {
    const repoName = 'runtime-existing-create'
    const existing = {
      id: repoName,
      path: join(tmpdir(), repoName),
      displayName: repoName,
      badgeColor: '#14b8a6',
      addedAt: 1,
      kind: 'folder' as const
    }
    const colorStore = {
      ...store,
      getRepos: () => [existing]
    }
    const runtime = new OrcaRuntimeService(colorStore as never)

    const result = await runtime.createRepo(tmpdir(), repoName, 'folder')

    expect(result).toEqual({ repo: existing })
    expect(result).toHaveProperty('repo.badgeColor', '#14b8a6')
  })

  it('defaults runtime cloneRepo badgeColor to DEFAULT_REPO_BADGE_COLOR', async () => {
    const spawnSpy = vi.spyOn(gitRunner, 'gitSpawnAfterWindowsEnvironmentReady')
    const added: Record<string, unknown>[] = []
    const colorStore = {
      ...store,
      getRepos: () => [...added] as never,
      addRepo: (repo: Record<string, unknown>) => {
        added.push(repo)
      },
      getRepo: (id: string) => added.find((repo) => repo.id === id) as never
    }
    spawnSpy.mockImplementation(() => {
      const proc = new EventEmitter() as EventEmitter & { stderr: EventEmitter }
      proc.stderr = new EventEmitter()
      setImmediate(() => proc.emit('close', 0, null))
      return proc as never
    })
    const runtime = new OrcaRuntimeService(colorStore as never)

    try {
      const repo = await runtime.cloneRepo('https://example.com/repo-badge-color.git', '/tmp')
      expect(spawnSpy).toHaveBeenCalledWith(
        expect.arrayContaining(['clone']),
        expect.objectContaining({ admissionTier: 'interactive' })
      )
      expect(repo.badgeColor).toBe(DEFAULT_REPO_BADGE_COLOR)
      expect(added).toEqual([
        expect.objectContaining({
          badgeColor: DEFAULT_REPO_BADGE_COLOR,
          externalWorktreeVisibilityLegacy: false
        })
      ])
      expect(repo.externalWorktreeVisibility).toBeUndefined()
      expect(prepareLocalWorktreeRootForRepoMock).toHaveBeenCalledWith(colorStore, repo)
    } finally {
      spawnSpy.mockRestore()
    }
  })

  it('drops a same-path negative submodule cache before runtime cloneRepo', async () => {
    const spawnSpy = vi.spyOn(gitRunner, 'gitSpawnAfterWindowsEnvironmentReady')
    const destination = await mkdtemp(join(tmpdir(), 'orca-runtime-reclone-'))
    const clonePath = join(destination, 'reclone')
    const added: Record<string, unknown>[] = []
    const cloneStore = {
      ...store,
      getRepos: () => [...added] as never,
      addRepo: (repo: Record<string, unknown>) => added.push(repo),
      getRepo: (id: string) => added.find((repo) => repo.id === id) as never
    }
    spawnSpy.mockImplementation(() => {
      const proc = new EventEmitter() as EventEmitter & { stderr: EventEmitter }
      proc.stderr = new EventEmitter()
      setImmediate(() => {
        void mkdir(clonePath, { recursive: true })
          .then(() =>
            writeFile(join(clonePath, '.gitmodules'), '[submodule "lib"]\n\tpath = vendor/lib\n')
          )
          .then(() => proc.emit('close', 0, null))
      })
      return proc as never
    })
    const runtime = new OrcaRuntimeService(cloneStore as never)

    try {
      clearSubmodulePathsCacheForTests()
      await expect(listSubmodulePaths(clonePath)).resolves.toEqual([])
      await runtime.cloneRepo('https://example.com/reclone.git', destination)
      await expect(listSubmodulePaths(clonePath)).resolves.toEqual(['vendor/lib'])
    } finally {
      clearSubmodulePathsCacheForTests()
      spawnSpy.mockRestore()
      await rm(destination, { recursive: true, force: true })
    }
  })

  it('preserves existing badgeColor on runtime cloneRepo folder->git dedupe upgrade', async () => {
    const spawnSpy = vi.spyOn(gitRunner, 'gitSpawnAfterWindowsEnvironmentReady')
    spawnSpy.mockImplementation(() => {
      const proc = new EventEmitter() as EventEmitter & { stderr: EventEmitter }
      proc.stderr = new EventEmitter()
      setImmediate(() => proc.emit('close', 0, null))
      return proc as never
    })
    const existing = {
      id: 'runtime-folder-upgrade',
      path: '/tmp/repo-badge-color',
      displayName: 'repo-badge-color',
      badgeColor: '#ec4899',
      addedAt: 1,
      kind: 'folder' as const
    }
    const updates: { id: string; updates: Record<string, unknown> }[] = []
    const upgraded = { ...existing, kind: 'git' as const }
    const colorStore = {
      ...store,
      getRepos: () => [existing],
      updateRepo: (id: string, repoUpdates: Record<string, unknown>) => {
        updates.push({ id, updates: repoUpdates })
        return upgraded as never
      }
    }
    const runtime = new OrcaRuntimeService(colorStore as never)

    try {
      const repo = await runtime.cloneRepo('https://example.com/repo-badge-color.git', '/tmp')
      expect(updates).toEqual([{ id: existing.id, updates: { kind: 'git' } }])
      expect(repo).toEqual(upgraded)
      expect(repo.badgeColor).toBe('#ec4899')
      expect(prepareLocalWorktreeRootForRepoMock).toHaveBeenCalledWith(colorStore, upgraded)
      expect(invalidateAuthorizedRootsCacheMock).toHaveBeenCalled()
    } finally {
      spawnSpy.mockRestore()
    }
  })

  it('prepares the runtime worktree root when worktree base path changes', async () => {
    const repo = {
      id: TEST_REPO_ID,
      path: TEST_REPO_PATH,
      displayName: 'repo',
      badgeColor: 'blue',
      addedAt: 1,
      kind: 'git' as const
    }
    const updated = { ...repo, worktreeBasePath: '../worktrees' }
    const runtimeStore = {
      ...store,
      getRepos: () => [repo],
      getRepo: (id: string) => (id === repo.id ? repo : undefined) as never,
      updateRepo: vi.fn(() => updated as never)
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    await expect(runtime.updateRepo(repo.id, { worktreeBasePath: '../worktrees' })).resolves.toBe(
      updated
    )

    expect(prepareLocalWorktreeRootForRepoMock).toHaveBeenCalledWith(runtimeStore, updated)
    expect(invalidateAuthorizedRootsCacheMock).toHaveBeenCalled()
  })

  it('prepares the runtime worktree root when repo-backed project host setup base path changes', () => {
    const repo = {
      id: TEST_REPO_ID,
      path: TEST_REPO_PATH,
      displayName: 'repo',
      badgeColor: 'blue',
      addedAt: 1,
      kind: 'git' as const,
      worktreeBasePath: '../worktrees'
    }
    const result = {
      project: { id: 'project-1', displayName: 'Repo' },
      setup: { id: 'setup-1', projectId: 'project-1', repoId: repo.id, hostId: 'local' },
      repo
    }
    const runtimeStore = {
      ...store,
      updateProjectHostSetup: vi.fn(() => result as never)
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    expect(
      runtime.updateProjectHostSetup({
        setupId: 'setup-1',
        updates: { worktreeBasePath: '../worktrees' }
      })
    ).toBe(result)

    expect(prepareLocalWorktreeRootForRepoMock).toHaveBeenCalledWith(runtimeStore, repo)
    expect(invalidateAuthorizedRootsCacheMock).toHaveBeenCalled()
  })

  it('rejects runtime cloneRepo dot-segment URLs before spawning git', async () => {
    const spawnSpy = vi.spyOn(gitRunner, 'gitSpawnAfterWindowsEnvironmentReady')
    const runtime = createRuntime()
    const tempRoot = await mkdtemp(join(tmpdir(), 'orca-runtime-clone-'))
    const destination = join(tempRoot, 'destination')

    try {
      await expect(runtime.cloneRepo('file:///tmp/source/.', destination)).rejects.toThrow(
        'Invalid repository name derived from URL'
      )
      expect(spawnSpy).not.toHaveBeenCalled()
    } finally {
      spawnSpy.mockRestore()
      await rm(tempRoot, { recursive: true, force: true })
    }
  })

  it('rejects runtime cloneRepo parent-segment URLs before spawning git', async () => {
    const spawnSpy = vi.spyOn(gitRunner, 'gitSpawnAfterWindowsEnvironmentReady')
    const runtime = createRuntime()
    const tempRoot = await mkdtemp(join(tmpdir(), 'orca-runtime-clone-'))
    const destination = join(tempRoot, 'destination')

    try {
      await expect(runtime.cloneRepo('file:///tmp/source/..', destination)).rejects.toThrow(
        'Invalid repository name derived from URL'
      )
      expect(spawnSpy).not.toHaveBeenCalled()
    } finally {
      spawnSpy.mockRestore()
      await rm(tempRoot, { recursive: true, force: true })
    }
  })

  it('removes an owned runtime clone target when git exits unsuccessfully', async () => {
    const spawnSpy = vi.spyOn(gitRunner, 'gitSpawnAfterWindowsEnvironmentReady')
    const proc = new EventEmitter() as EventEmitter & { stderr: EventEmitter }
    proc.stderr = new EventEmitter()
    spawnSpy.mockResolvedValue(proc as never)
    const runtime = createRuntime()
    const destination = await mkdtemp(join(tmpdir(), 'orca-runtime-clone-'))
    const clonePath = join(destination, 'repo-badge-color')

    try {
      const clonePromise = runtime.cloneRepo(
        'https://example.com/repo-badge-color.git',
        destination
      )
      await vi.waitFor(() => expect(spawnSpy).toHaveBeenCalledTimes(1))
      await writeFile(join(clonePath, 'partial.txt'), 'git wrote this before failing')
      proc.stderr.emit('data', Buffer.from('fatal: repository not found\n'))
      proc.emit('close', 128, null)

      await expect(clonePromise).rejects.toThrow('Clone failed: fatal: repository not found')
      await expect(lstat(clonePath)).rejects.toThrow()
    } finally {
      spawnSpy.mockRestore()
      await rm(destination, { recursive: true, force: true })
    }
  })

  it('preserves an existing runtime clone target when git exits unsuccessfully', async () => {
    const spawnSpy = vi.spyOn(gitRunner, 'gitSpawnAfterWindowsEnvironmentReady')
    const proc = new EventEmitter() as EventEmitter & { stderr: EventEmitter }
    proc.stderr = new EventEmitter()
    spawnSpy.mockResolvedValue(proc as never)
    const runtime = createRuntime()
    const destination = await mkdtemp(join(tmpdir(), 'orca-runtime-clone-'))
    const clonePath = join(destination, 'repo-badge-color')

    try {
      await mkdir(clonePath)
      await writeFile(join(clonePath, 'user-file.txt'), 'keep me')
      const clonePromise = runtime.cloneRepo(
        'https://example.com/repo-badge-color.git',
        destination
      )
      await vi.waitFor(() => expect(spawnSpy).toHaveBeenCalledTimes(1))
      proc.emit('close', 128, null)

      await expect(clonePromise).rejects.toThrow('Clone failed')
      await expect(lstat(join(clonePath, 'user-file.txt'))).resolves.toBeTruthy()
    } finally {
      spawnSpy.mockRestore()
      await rm(destination, { recursive: true, force: true })
    }
  })

  it('skips runtime clone failure cleanup when the owned target is replaced', async () => {
    const spawnSpy = vi.spyOn(gitRunner, 'gitSpawnAfterWindowsEnvironmentReady')
    const proc = new EventEmitter() as EventEmitter & { stderr: EventEmitter }
    proc.stderr = new EventEmitter()
    spawnSpy.mockResolvedValue(proc as never)
    const runtime = createRuntime()
    const destination = await mkdtemp(join(tmpdir(), 'orca-runtime-clone-'))
    const clonePath = join(destination, 'repo-badge-color')
    const replacementFile = join(clonePath, 'replacement.txt')

    try {
      const clonePromise = runtime.cloneRepo(
        'https://example.com/repo-badge-color.git',
        destination
      )
      await vi.waitFor(() => expect(spawnSpy).toHaveBeenCalledTimes(1))
      await rm(clonePath, { recursive: true, force: true })
      await mkdir(clonePath)
      await writeFile(replacementFile, 'new owner')
      proc.emit('close', 128, null)

      await expect(clonePromise).rejects.toThrow('Clone failed')
      await expect(lstat(replacementFile)).resolves.toBeTruthy()
    } finally {
      spawnSpy.mockRestore()
      await rm(destination, { recursive: true, force: true })
    }
  })

  it('serializes concurrent runtime clones for the same target', async () => {
    const spawnSpy = vi.spyOn(gitRunner, 'gitSpawnAfterWindowsEnvironmentReady')
    const firstProc = new EventEmitter() as EventEmitter & { stderr: EventEmitter }
    firstProc.stderr = new EventEmitter()
    spawnSpy.mockResolvedValueOnce(firstProc as never)
    const added: Record<string, unknown>[] = []
    const colorStore = {
      ...store,
      getRepos: () => [...added] as never,
      addRepo: (repo: Record<string, unknown>) => {
        added.push(repo)
      },
      getRepo: (id: string) => added.find((repo) => repo.id === id) as never
    }
    const runtime = new OrcaRuntimeService(colorStore as never)
    const destination = await mkdtemp(join(tmpdir(), 'orca-runtime-clone-'))

    try {
      const firstClonePromise = runtime.cloneRepo(
        'https://example.com/repo-badge-color.git',
        destination
      )
      const secondClonePromise = runtime.cloneRepo(
        'https://example.com/repo-badge-color.git',
        destination
      )
      await vi.waitFor(() => expect(spawnSpy).toHaveBeenCalledTimes(1))
      await new Promise((resolve) => setImmediate(resolve))
      expect(spawnSpy).toHaveBeenCalledTimes(1)

      firstProc.emit('close', 0, null)
      await expect(firstClonePromise).resolves.toMatchObject({
        path: join(destination, 'repo-badge-color')
      })
      await expect(secondClonePromise).resolves.toMatchObject({
        path: join(destination, 'repo-badge-color')
      })
      expect(spawnSpy).toHaveBeenCalledTimes(1)
    } finally {
      spawnSpy.mockRestore()
      await rm(destination, { recursive: true, force: true })
    }
  })
})
