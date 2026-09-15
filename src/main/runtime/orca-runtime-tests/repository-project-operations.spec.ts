import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_REPO_BADGE_COLOR,
  EventEmitter,
  OrcaRuntimeService,
  execFileSync,
  getRepoUpstreamMock,
  gitRunner,
  join,
  mkdir,
  mkdirSync,
  mkdtemp,
  prepareLocalWorktreeRootForRepoMock,
  projectHostSetupProjectionFromRepos,
  rm,
  tmpdir,
  win32,
  writeFile
} from '../orca-runtime-test-mocks.spec'
import { store } from '../orca-runtime-test-fixtures.spec'

describe('OrcaRuntimeService', () => {
  it('deduplicates runtime repo paths with Windows/UNC comparison semantics', async () => {
    const added: Record<string, unknown>[] = []
    const uncStore = {
      ...store,
      getRepos: () => [
        {
          id: 'repo-unc',
          path: '//Server/Share/Repo',
          displayName: 'repo',
          badgeColor: 'blue',
          addedAt: 1,
          kind: 'folder'
        },
        ...added
      ],
      addRepo: (repo: Record<string, unknown>) => {
        added.push(repo)
      },
      getRepo: (id: string) => [...uncStore.getRepos()].find((repo) => repo.id === id) as never
    }
    const runtime = new OrcaRuntimeService(uncStore as never)

    const repo = await runtime.addRepo('//server/share/repo', 'folder')

    expect(repo).toMatchObject({ id: 'repo-unc', path: '//Server/Share/Repo' })
    expect(added).toHaveLength(0)
  })

  it('browses runtime server directories before projects are added', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'orca-runtime-browse-'))
    try {
      await mkdir(join(tempRoot, 'zeta'))
      await mkdir(join(tempRoot, 'alpha'))
      await writeFile(join(tempRoot, 'readme.md'), '# Readme\n')
      const runtime = new OrcaRuntimeService(store)

      const result = await runtime.browseServerDir(tempRoot)

      expect(result.resolvedPath).toBe(tempRoot)
      expect(result.pathFlavor).toBe(process.platform === 'win32' ? 'win32' : 'posix')
      expect(result.entries).toEqual([
        { name: 'alpha', isDirectory: true, isSymlink: false },
        { name: 'zeta', isDirectory: true, isSymlink: false },
        { name: 'readme.md', isDirectory: false, isSymlink: false }
      ])
    } finally {
      await rm(tempRoot, { recursive: true, force: true })
    }
  })

  it.runIf(process.platform === 'win32')('lists drive roots for a server-root browse', async () => {
    const runtime = new OrcaRuntimeService(store)

    const result = await runtime.browseServerDir('/')

    expect(result.resolvedPath).toBe('/')
    expect(result.pathFlavor).toBe('win32')
    expect(result.entries).toContainEqual({
      name: win32.parse(tmpdir()).root.toUpperCase(),
      isDirectory: true,
      isSymlink: false
    })
  })

  it('defaults runtime addRepo badgeColor to DEFAULT_REPO_BADGE_COLOR', async () => {
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

    const repo = await runtime.addRepo('/tmp/runtime-add-default', 'folder')

    expect(repo.badgeColor).toBe(DEFAULT_REPO_BADGE_COLOR)
    expect(added).toEqual([expect.objectContaining({ badgeColor: DEFAULT_REPO_BADGE_COLOR })])
  })

  it('prepares the runtime worktree root when adding a repo', async () => {
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

    const repo = await runtime.addRepo('/tmp/runtime-add-root-prep', 'folder')

    expect(prepareLocalWorktreeRootForRepoMock).toHaveBeenCalledWith(runtimeStore, repo)
  })

  it('sets up an existing folder on a fresh runtime after importing the repo project', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'orca-runtime-project-setup-'))
    const repos: Record<string, unknown>[] = []
    getRepoUpstreamMock.mockResolvedValueOnce({ owner: 'stablyai', repo: 'orca' })
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
      getProjects: () =>
        repos
          .map((repo) => {
            const upstream = repo.upstream as { owner: string; repo: string } | undefined
            if (!upstream) {
              return null
            }
            return {
              id: `github:${upstream.owner}/${upstream.repo}`,
              displayName: repo.displayName,
              badgeColor: repo.badgeColor,
              providerIdentity: { provider: 'github', owner: upstream.owner, repo: upstream.repo },
              sourceRepoIds: [repo.id],
              createdAt: repo.addedAt,
              updatedAt: repo.addedAt
            }
          })
          .filter(Boolean) as never,
      getProjectHostSetups: () =>
        repos.map((repo) => {
          const upstream = repo.upstream as { owner: string; repo: string } | undefined
          return {
            id: repo.id,
            projectId: upstream ? `github:${upstream.owner}/${upstream.repo}` : repo.id,
            hostId: 'local',
            repoId: repo.id,
            path: repo.path,
            displayName: repo.displayName,
            kind: repo.kind,
            setupState: 'ready',
            setupMethod: repo.projectHostSetupMethod ?? 'legacy-repo',
            createdAt: repo.addedAt,
            updatedAt: repo.addedAt
          }
        }) as never
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    try {
      execFileSync('git', ['init'], { cwd: tempRoot, stdio: 'ignore' })
      const result = await runtime.setupProjectExistingFolder({
        projectId: 'github:stablyai/orca',
        hostId: 'runtime:env-1',
        path: tempRoot,
        kind: 'git',
        setupMethod: 'imported-existing-folder'
      })

      expect(result.project.id).toBe('github:stablyai/orca')
      expect(result.repo.path).toBe(tempRoot)
      expect(result.setup).toMatchObject({
        projectId: 'github:stablyai/orca',
        path: tempRoot,
        setupMethod: 'imported-existing-folder'
      })
    } finally {
      await rm(tempRoot, { recursive: true, force: true })
    }
  })

  it('sets up a project whose identity exists only on the requesting host', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'orca-runtime-cross-host-project-'))
    const repos: Record<string, unknown>[] = []
    getRepoUpstreamMock.mockResolvedValueOnce(null)
    const runtimeStore = {
      ...store,
      getRepos: () => [...repos] as never,
      addRepo: (repo: Record<string, unknown>) => repos.push(repo),
      getRepo: (id: string) => repos.find((repo) => repo.id === id) as never,
      updateRepo: (id: string, updates: Record<string, unknown>) => {
        const repo = repos.find((entry) => entry.id === id)
        if (!repo) {
          return null
        }
        Object.assign(repo, updates)
        return { ...repo } as never
      },
      getProjects: () => projectHostSetupProjectionFromRepos(repos as never).projects as never,
      getProjectHostSetups: () =>
        projectHostSetupProjectionFromRepos(repos as never).setups as never
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    try {
      execFileSync('git', ['init'], { cwd: tempRoot, stdio: 'ignore' })
      const result = await runtime.setupProjectExistingFolder({
        projectId: 'github:github.acme.test/acme/orca',
        projectProviderIdentity: {
          provider: 'github',
          owner: 'acme',
          repo: 'orca',
          host: 'github.acme.test'
        },
        hostId: 'runtime:env-1',
        path: tempRoot,
        kind: 'git'
      })

      expect(result.project).toMatchObject({
        id: 'github:github.acme.test/acme/orca',
        providerIdentity: {
          provider: 'github',
          owner: 'acme',
          repo: 'orca',
          host: 'github.acme.test'
        }
      })
    } finally {
      await rm(tempRoot, { recursive: true, force: true })
    }
  })

  it('rolls back a new runtime repo when project alignment fails', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'orca-runtime-project-rollback-'))
    const repos: Record<string, unknown>[] = []
    getRepoUpstreamMock.mockResolvedValueOnce(null)
    const runtimeStore = {
      ...store,
      getRepos: () => [...repos] as never,
      addRepo: (repo: Record<string, unknown>) => repos.push(repo),
      getRepo: (id: string) => repos.find((repo) => repo.id === id) as never,
      updateRepo: (id: string, updates: Record<string, unknown>) => {
        const repo = repos.find((entry) => entry.id === id)
        if (!repo) {
          return null
        }
        Object.assign(repo, updates)
        return { ...repo } as never
      },
      removeProject: (id: string) => {
        const index = repos.findIndex((repo) => repo.id === id)
        if (index !== -1) {
          repos.splice(index, 1)
        }
      },
      getProjects: () => projectHostSetupProjectionFromRepos(repos as never).projects as never,
      getProjectHostSetups: () =>
        projectHostSetupProjectionFromRepos(repos as never).setups as never
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    try {
      execFileSync('git', ['init'], { cwd: tempRoot, stdio: 'ignore' })
      await expect(
        runtime.setupProjectExistingFolder({
          projectId: 'git:git.example.test/acme/orca',
          hostId: 'runtime:env-1',
          path: tempRoot,
          kind: 'git'
        })
      ).rejects.toThrow('Imported folder does not match the selected project identity.')

      expect(repos).toHaveLength(0)
    } finally {
      await rm(tempRoot, { recursive: true, force: true })
    }
  })

  it('rolls back a newly cloned repo when project alignment fails', async () => {
    const repos: Record<string, unknown>[] = []
    const clonedRepo = {
      id: 'cloned-repo',
      path: '/tmp/cloned-repo',
      displayName: 'cloned-repo',
      badgeColor: '#737373',
      addedAt: 1,
      kind: 'git'
    }
    const runtimeStore = {
      ...store,
      getRepos: () => [...repos] as never,
      removeProject: (id: string) => {
        const index = repos.findIndex((repo) => repo.id === id)
        if (index !== -1) {
          repos.splice(index, 1)
        }
      },
      getProjects: () => projectHostSetupProjectionFromRepos(repos as never).projects as never,
      getProjectHostSetups: () =>
        projectHostSetupProjectionFromRepos(repos as never).setups as never
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    vi.spyOn(runtime, 'cloneRepo').mockImplementation(async () => {
      repos.push(clonedRepo)
      return clonedRepo as never
    })

    await expect(
      runtime.setupProjectClone({
        projectId: 'git:git.example.test/acme/orca',
        hostId: 'runtime:env-1',
        url: 'https://git.example.test/acme/orca.git',
        destination: '/tmp'
      })
    ).rejects.toThrow('Imported folder does not match the selected project identity.')

    expect(repos).toHaveLength(0)
  })

  it('keeps existing-folder imports split by runtime host on the same normalized path', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'orca-runtime-project-host-'))
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
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    try {
      execFileSync('git', ['init'], { cwd: tempRoot, stdio: 'ignore' })
      const first = await runtime.setupProjectExistingFolder({
        projectId: 'github:stablyai/orca',
        hostId: 'runtime:env-1',
        path: tempRoot,
        kind: 'git',
        setupMethod: 'imported-existing-folder'
      })
      const second = await runtime.setupProjectExistingFolder({
        projectId: 'github:stablyai/orca',
        hostId: 'runtime:env-2',
        path: tempRoot,
        kind: 'git',
        setupMethod: 'imported-existing-folder'
      })

      expect(repos).toHaveLength(2)
      expect(repos).toEqual([
        expect.objectContaining({
          path: tempRoot,
          executionHostId: 'runtime:env-1'
        }),
        expect.objectContaining({
          path: tempRoot,
          executionHostId: 'runtime:env-2'
        })
      ])
      expect(first.repo).toMatchObject({
        path: tempRoot,
        executionHostId: 'runtime:env-1'
      })
      expect(first.setup).toMatchObject({
        repoId: first.repo.id,
        hostId: 'runtime:env-1'
      })
      expect(second.repo).toMatchObject({
        path: tempRoot,
        executionHostId: 'runtime:env-2'
      })
      expect(second.setup).toMatchObject({
        repoId: second.repo.id,
        hostId: 'runtime:env-2'
      })
      expect(first.repo.id).not.toBe(second.repo.id)
      expect(first.setup.repoId).not.toBe(second.setup.repoId)
    } finally {
      await rm(tempRoot, { recursive: true, force: true })
    }
  })

  it('keeps path-only runtime addRepo reuse working when a host-qualified repo already exists', async () => {
    const repos: Record<string, unknown>[] = [
      {
        id: 'repo-runtime-1',
        path: '/tmp/runtime-shared',
        displayName: 'repo',
        badgeColor: 'blue',
        addedAt: 1,
        kind: 'folder',
        executionHostId: 'runtime:env-1'
      }
    ]
    const runtimeStore = {
      ...store,
      getRepos: () => [...repos] as never,
      addRepo: (repo: Record<string, unknown>) => {
        repos.push(repo)
      },
      getRepo: (id: string) => repos.find((repo) => repo.id === id) as never
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    const repo = await runtime.addRepo('/tmp/runtime-shared', 'folder')

    expect(repo).toMatchObject({
      id: 'repo-runtime-1',
      path: '/tmp/runtime-shared',
      executionHostId: 'runtime:env-1'
    })
    expect(repos).toHaveLength(1)
  })

  it('does not hijack a legacy SSH repo at the same path into a runtime host', async () => {
    // A legacy SSH repo resolves to `ssh:<connectionId>` even with null executionHostId, so a same-path runtime import creates a new repo instead of adopting it.
    const repos: Record<string, unknown>[] = [
      {
        id: 'repo-ssh-1',
        path: '/workspace',
        displayName: 'workspace',
        badgeColor: 'blue',
        addedAt: 1,
        kind: 'folder',
        connectionId: 'ssh-target-1'
      }
    ]
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
      }
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    const repo = await runtime.addRepo('/workspace', 'folder', 'runtime:env-1')

    expect(repos).toHaveLength(2)
    expect(repo.id).not.toBe('repo-ssh-1')
    expect(repo).toMatchObject({ path: '/workspace', executionHostId: 'runtime:env-1' })
    // The legacy SSH repo must be untouched (no executionHostId stamped onto it).
    expect(repos[0]).toMatchObject({ id: 'repo-ssh-1', connectionId: 'ssh-target-1' })
    expect(repos[0]).not.toHaveProperty('executionHostId')
  })

  it('only a runtime host adopts an unstamped repo; local/ssh imports never stamp it', async () => {
    // Local and legacy runtime repos both have null executionHostId/connectionId, so only a runtime host may backfill; local/ssh imports leave it untouched.
    for (const importHostId of ['local', 'ssh:ssh-target-9'] as const) {
      const repos: Record<string, unknown>[] = [
        {
          id: 'repo-local-1',
          path: '/workspace',
          displayName: 'workspace',
          badgeColor: 'blue',
          addedAt: 1,
          kind: 'folder'
        }
      ]
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
        }
      }
      const runtime = new OrcaRuntimeService(runtimeStore as never)

      const repo = await runtime.addRepo('/workspace', 'folder', importHostId)

      // The matched repo is returned unchanged — no new repo, no executionHostId stamped.
      expect(repos).toHaveLength(1)
      expect(repo.id).toBe('repo-local-1')
      expect(repos[0]).not.toHaveProperty('executionHostId')
    }
  })

  it('keeps project clone setup on the cloned host-qualified repo', async () => {
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
      const result = await runtime.setupProjectClone({
        projectId: 'github:stablyai/orca',
        hostId: 'runtime:env-1',
        url: 'https://example.com/orca.git',
        destination
      })

      expect(repos).toHaveLength(1)
      expect(result.repo).toMatchObject({
        path: clonePath,
        executionHostId: 'runtime:env-1',
        projectHostSetupMethod: 'cloned'
      })
      expect(result.setup).toMatchObject({
        repoId: result.repo.id,
        hostId: 'runtime:env-1',
        setupMethod: 'cloned'
      })
    } finally {
      spawnSpy.mockRestore()
      await rm(destination, { recursive: true, force: true })
    }
  })

  it('never sets an SSH-hosted project up on the local machine', async () => {
    // Why: both inputs must be paths the pre-guard code would have accepted. An unwritable
    // destination fails at mkdir and a non-repo path fails at isGitRepo, which would leave the
    // side-effect assertions below unable to observe the local clone/probe they exist to catch.
    const destination = await mkdtemp(join(tmpdir(), 'orca-runtime-ssh-guard-'))
    const existingFolder = join(destination, 'orca')
    mkdirSync(existingFolder, { recursive: true })
    execFileSync('git', ['init'], { cwd: existingFolder, stdio: 'ignore' })
    const spawnSpy = vi
      .spyOn(gitRunner, 'gitSpawnAfterWindowsEnvironmentReady')
      .mockImplementation(() => {
        // Why: unreachable while the guard holds; stubbed so a regression records the call
        // instead of shelling out to a real network clone.
        const proc = new EventEmitter() as EventEmitter & { stderr: EventEmitter }
        proc.stderr = new EventEmitter()
        setImmediate(() => proc.emit('close', 1, null))
        return proc as never
      })
    const repos: Record<string, unknown>[] = []
    const runtimeStore = {
      ...store,
      getRepos: () => [...repos] as never,
      addRepo: (repo: Record<string, unknown>) => {
        repos.push(repo)
      }
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    try {
      const cloneError = await runtime
        .setupProjectClone({
          projectId: 'github:stablyai/orca',
          hostId: 'ssh:openclaw',
          url: 'https://example.com/orca.git',
          destination
        })
        .catch((error: unknown) => error)
      const existingFolderError = await runtime
        .setupProjectExistingFolder({
          projectId: 'github:stablyai/orca',
          hostId: 'ssh:openclaw',
          path: existingFolder,
          kind: 'git'
        })
        .catch((error: unknown) => error)

      // Why: the defect was a silent local clone/probe recorded as remote, not a bad message,
      // so the absent side effects are asserted before the wording. Both calls are awaited
      // first so a regression reports the corruption rather than stopping at the first throw.
      expect(spawnSpy).not.toHaveBeenCalled()
      expect(repos).toHaveLength(0)
      // Cloning onto an SSH host has no implementation here, so it still refuses outright.
      expect(cloneError).toMatchObject({
        message: expect.stringMatching(/Cloning onto an SSH host is not supported/)
      })
      // Registering an existing remote path does have one, so this now fails on the host's own
      // terms — the SSH connection is not registered — rather than on a categorical refusal.
      expect(existingFolderError).toMatchObject({
        message: expect.stringMatching(/SSH connection "openclaw" not found or not connected/)
      })
    } finally {
      spawnSpy.mockRestore()
      await rm(destination, { recursive: true, force: true })
    }
  })
})
