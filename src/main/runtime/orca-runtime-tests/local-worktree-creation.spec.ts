import { describe, expect, it, vi } from 'vitest'
import {
  OrcaRuntimeService,
  addWorktree,
  addWorktreeMock,
  computeWorktreePathMock,
  deleteWorktreeHistoryDirMock,
  ensurePathWithinWorkspaceMock,
  getBaseRefDefault,
  getBranchConflictKind,
  getPRForBranchMock,
  gitRunner,
  listWorktrees,
  resolveLocalGitUsernameMock
} from '../orca-runtime-test-mocks.spec'
import type { WorktreeMeta } from '../orca-runtime-test-mocks.spec'
import {
  TEST_REPO_PATH,
  deferred,
  makeWorktreeMeta,
  store
} from '../orca-runtime-test-fixtures.spec'

describe('OrcaRuntimeService', () => {
  it('creates additional workspace metadata for folder-mode repos through runtime create', async () => {
    const folderRepo = {
      id: 'folder-repo',
      path: '/workspace/folder',
      displayName: 'Folder',
      badgeColor: 'blue',
      addedAt: 1,
      kind: 'folder' as const,
      // removeManagedWorktree executes inside this selected runtime, where PTYs are local ids.
      executionHostId: 'runtime:env-1' as const
    }
    const rootWorktreeId = 'folder-repo::/workspace/folder'
    const rootPriorWorktreeIds = ['folder-repo::/workspace/old-folder']
    const metaById: Record<string, WorktreeMeta> = {
      [rootWorktreeId]: makeWorktreeMeta({
        instanceId: 'root-instance',
        priorWorktreeIds: rootPriorWorktreeIds
      })
    }
    const runtimeStore = {
      ...store,
      getRepos: () => [folderRepo],
      getRepo: (id: string) => (id === folderRepo.id ? folderRepo : undefined),
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
        return metaById[worktreeId]
      },
      removeWorktreeMeta: (worktreeId: string) => {
        delete metaById[worktreeId]
      }
    }
    let deletedWorktreeId = ''
    const localProvider = {
      listProcesses: vi.fn(async () => [{ id: `${deletedWorktreeId}@@pty-1` }]),
      shutdown: vi.fn(async () => undefined)
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never, undefined, {
      getLocalProvider: () => localProvider as never
    })
    runtime.setPtyController({
      spawn: vi.fn(),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const createTerminal = vi.spyOn(runtime, 'createTerminal').mockResolvedValue({
      handle: 'term_folder_startup',
      tabId: 'tab-folder-startup',
      worktreeId: '',
      title: null,
      surface: 'background'
    })
    const notifier = { worktreesChanged: vi.fn() }
    runtime.setNotifier(notifier as never)

    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:folder-repo',
      name: 'folder-session',
      displayName: '\u0000\u202e',
      displayNameKind: 'user',
      createdWithAgent: 'codex',
      startup: { command: 'codex', viewMode: 'chat' }
    })

    expect(addWorktreeMock).not.toHaveBeenCalled()
    expect(createTerminal).toHaveBeenCalledWith(
      `id:${result.worktree.id}`,
      expect.objectContaining({ command: 'codex', viewMode: 'chat' })
    )
    expect(result.worktree).toEqual(
      expect.objectContaining({
        id: expect.stringMatching(/^folder-repo::\/workspace\/folder::workspace:[0-9a-f-]{36}$/),
        repoId: 'folder-repo',
        path: '/workspace/folder',
        displayName: 'folder-session',
        isMainWorktree: false,
        createdWithAgent: 'codex'
      })
    )
    expect(metaById[result.worktree.id]).toMatchObject({
      instanceId: result.worktree.instanceId,
      displayName: 'folder-session',
      orcaCreationSource: 'runtime',
      createdWithAgent: 'codex'
    })
    expect(metaById[result.worktree.id]).not.toHaveProperty('displayNameIsPinned')
    await expect(runtime.showManagedWorktree(`id:${result.worktree.id}`)).resolves.toMatchObject({
      id: result.worktree.id,
      repoId: 'folder-repo',
      path: '/workspace/folder',
      displayName: 'folder-session'
    })
    await expect(runtime.listManagedWorktrees('id:folder-repo')).resolves.toMatchObject({
      totalCount: 2,
      worktrees: [
        expect.objectContaining({
          id: rootWorktreeId,
          isMainWorktree: true,
          priorWorktreeIds: rootPriorWorktreeIds
        }),
        expect.objectContaining({
          id: result.worktree.id,
          isMainWorktree: false
        })
      ]
    })
    await expect(
      runtime.updateManagedWorktreeMeta(`id:${result.worktree.id}`, { comment: 'note' })
    ).resolves.toMatchObject({
      id: result.worktree.id,
      comment: 'note'
    })
    await expect(
      runtime.removeManagedWorktree('id:folder-repo::/workspace/folder')
    ).rejects.toThrow('Cannot delete the project root workspace')
    deletedWorktreeId = result.worktree.id
    await expect(runtime.removeManagedWorktree(`id:${result.worktree.id}`)).resolves.toEqual({})
    expect(localProvider.shutdown).toHaveBeenCalledWith(
      `${result.worktree.id}@@pty-1`,
      expect.objectContaining({ immediate: true })
    )
    expect(metaById[result.worktree.id]).toBeUndefined()
    expect(deleteWorktreeHistoryDirMock).toHaveBeenCalledWith(result.worktree.id)
    expect(notifier.worktreesChanged).toHaveBeenCalledWith('folder-repo')
  })

  it('refreshes runtime remote-tracking bases before creating local worktrees', async () => {
    const runtime = new OrcaRuntimeService(store)
    const refresh = deferred<{ stdout: string; stderr: string }>()
    const createdWorktree = {
      path: '/tmp/workspaces/cli-fresh-base',
      head: 'def',
      branch: 'cli-fresh-base',
      isBare: false,
      isMainWorktree: false
    }
    computeWorktreePathMock.mockReturnValue(createdWorktree.path)
    ensurePathWithinWorkspaceMock.mockReturnValue(createdWorktree.path)
    vi.mocked(listWorktrees).mockResolvedValueOnce([createdWorktree])
    const gitSpy = vi.spyOn(gitRunner, 'gitExecFileAsync').mockImplementation(async (args) => {
      if (args[0] === 'rev-parse' && args.includes('refs/heads/cli-fresh-base^{commit}')) {
        throw new Error('branch not found')
      }
      if (args[0] === 'remote') {
        return { stdout: 'origin\n', stderr: '' }
      }
      if (args[0] === 'rev-parse' && args.includes('--git-common-dir')) {
        return { stdout: '/tmp/repo/.git\n', stderr: '' }
      }
      if (args[0] === 'rev-parse' && args[1] === '--verify') {
        return { stdout: 'base-sha\n', stderr: '' }
      }
      if (args.includes('fetch')) {
        return refresh.promise
      }
      return { stdout: '', stderr: '' }
    })
    try {
      const createPromise = runtime.createManagedWorktree({
        repoSelector: 'id:repo-1',
        name: 'cli-fresh-base'
      })

      await vi.waitFor(() => {
        expect(gitSpy).toHaveBeenCalledWith(
          [
            '-c',
            'maintenance.auto=false',
            '-c',
            'maintenance.commit-graph.auto=0',
            '-c',
            'gc.auto=0',
            'fetch',
            '--no-tags',
            'origin',
            '+refs/heads/main:refs/remotes/origin/main'
          ],
          {
            cwd: TEST_REPO_PATH,
            useConfiguredSshCommandForNetwork: true,
            timeout: 60_000
          }
        )
      })
      expect(addWorktree).not.toHaveBeenCalled()

      refresh.resolve({ stdout: '', stderr: '' })
      const result = await createPromise

      expect(addWorktree).toHaveBeenCalledWith(
        TEST_REPO_PATH,
        createdWorktree.path,
        'cli-fresh-base',
        'origin/main',
        false,
        false,
        {
          suggestLocalBaseRefUpdate: true,
          remoteTrackingBase: {
            remote: 'origin',
            branch: 'main',
            ref: 'refs/remotes/origin/main',
            base: 'origin/main'
          }
        }
      )
      expect(result.worktree).toMatchObject({
        path: createdWorktree.path,
        baseRef: 'refs/remotes/origin/main'
      })
    } finally {
      gitSpy.mockRestore()
    }
  })

  it('returns runtime local base update suggestions from addWorktree', async () => {
    const runtime = new OrcaRuntimeService(store)
    const createdWorktree = {
      path: '/tmp/workspaces/cli-stale-main',
      head: 'def',
      branch: 'cli-stale-main',
      isBare: false,
      isMainWorktree: false
    }
    computeWorktreePathMock.mockReturnValue(createdWorktree.path)
    ensurePathWithinWorkspaceMock.mockReturnValue(createdWorktree.path)
    vi.mocked(addWorktree).mockResolvedValueOnce({
      localBaseRefUpdateSuggestion: {
        baseRef: 'origin/main',
        localBranch: 'main',
        behind: 5
      }
    })
    vi.mocked(listWorktrees).mockResolvedValueOnce([createdWorktree])
    const gitSpy = vi.spyOn(gitRunner, 'gitExecFileAsync').mockImplementation(async (args) => {
      if (args[0] === 'rev-parse' && args.includes('refs/heads/cli-stale-main^{commit}')) {
        throw new Error('branch not found')
      }
      if (args[0] === 'remote') {
        return { stdout: 'origin\n', stderr: '' }
      }
      if (args[0] === 'rev-parse' && args.includes('--git-common-dir')) {
        return { stdout: '/tmp/repo/.git\n', stderr: '' }
      }
      if (args[0] === 'rev-parse' && args[1] === '--verify') {
        return { stdout: 'base-sha\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })
    try {
      const result = await runtime.createManagedWorktree({
        repoSelector: 'id:repo-1',
        name: 'cli-stale-main'
      })

      expect(result.localBaseRefUpdateSuggestion).toEqual({
        baseRef: 'origin/main',
        localBranch: 'main',
        behind: 5
      })
    } finally {
      gitSpy.mockRestore()
    }
  })

  it('creates a runtime local worktree from the detected default when the persisted base is stale', async () => {
    // Regression: a stale persisted repo base must fall back to the detected default.
    const runtime = new OrcaRuntimeService(store)
    const createdWorktree = {
      path: '/tmp/workspaces/cli-refresh-fails',
      head: 'base-sha',
      branch: 'cli-refresh-fails',
      isBare: false,
      isMainWorktree: false
    }
    const repo = { ...store.getRepos()[0], worktreeBaseRef: 'origin/master' }
    const getReposSpy = vi.spyOn(store, 'getRepos').mockReturnValue([repo] as never)
    computeWorktreePathMock.mockReturnValue(createdWorktree.path)
    ensurePathWithinWorkspaceMock.mockReturnValue(createdWorktree.path)
    vi.mocked(addWorktree).mockResolvedValueOnce({})
    vi.mocked(listWorktrees).mockResolvedValue([createdWorktree])
    const gitSpy = vi.spyOn(gitRunner, 'gitExecFileAsync').mockImplementation(async (args) => {
      if (args[0] === 'remote') {
        return { stdout: 'origin\n', stderr: '' }
      }
      if (args[0] === 'rev-parse' && args.includes('--git-common-dir')) {
        return { stdout: '/tmp/repo/.git\n', stderr: '' }
      }
      if (args[0] === 'rev-parse' && args.includes('refs/remotes/origin/master^{commit}')) {
        throw new Error('missing ref')
      }
      if (args[0] === 'rev-parse' && args.includes('refs/remotes/origin/main^{commit}')) {
        return { stdout: 'base-sha\n', stderr: '' }
      }
      if (args.includes('fetch')) {
        throw new Error('network unavailable')
      }
      return { stdout: '', stderr: '' }
    })
    try {
      await expect(
        runtime.createManagedWorktree({
          repoSelector: 'id:repo-1',
          name: 'cli-refresh-fails'
        })
      ).resolves.toBeDefined()

      expect(addWorktree).toHaveBeenCalledWith(
        TEST_REPO_PATH,
        createdWorktree.path,
        'cli-refresh-fails',
        'origin/main',
        false,
        false,
        {
          remoteTrackingBase: {
            remote: 'origin',
            branch: 'main',
            ref: 'refs/remotes/origin/main',
            base: 'origin/main'
          },
          suggestLocalBaseRefUpdate: true
        }
      )
      expect(getBaseRefDefault).toHaveBeenCalled()
    } finally {
      getReposSpy.mockRestore()
      gitSpy.mockRestore()
    }
  })

  it('creates a runtime local worktree from a usable persisted local branch base', async () => {
    const runtime = new OrcaRuntimeService(store)
    const createdWorktree = {
      path: '/tmp/workspaces/local-branch-base',
      head: 'develop-sha',
      branch: 'local-branch-base',
      isBare: false,
      isMainWorktree: false
    }
    const repo = { ...store.getRepos()[0], worktreeBaseRef: 'develop' }
    const getReposSpy = vi.spyOn(store, 'getRepos').mockReturnValue([repo] as never)
    computeWorktreePathMock.mockReturnValue(createdWorktree.path)
    ensurePathWithinWorkspaceMock.mockReturnValue(createdWorktree.path)
    vi.mocked(addWorktree).mockResolvedValueOnce({})
    vi.mocked(listWorktrees).mockResolvedValue([createdWorktree])
    const gitSpy = vi.spyOn(gitRunner, 'gitExecFileAsync').mockImplementation(async (args) => {
      if (args[0] === 'remote') {
        return { stdout: 'origin\n', stderr: '' }
      }
      if (args[0] === 'rev-parse' && args.includes('--git-common-dir')) {
        return { stdout: '/tmp/repo/.git\n', stderr: '' }
      }
      if (args[0] === 'rev-parse' && args.includes('refs/heads/develop^{commit}')) {
        return { stdout: 'develop-sha\n', stderr: '' }
      }
      if (args.includes('fetch')) {
        throw new Error('network unavailable')
      }
      return { stdout: '', stderr: '' }
    })
    try {
      await expect(
        runtime.createManagedWorktree({
          repoSelector: 'id:repo-1',
          name: 'local-branch-base'
        })
      ).resolves.toBeDefined()

      expect(addWorktree).toHaveBeenCalledWith(
        TEST_REPO_PATH,
        createdWorktree.path,
        'local-branch-base',
        'develop',
        false
      )
    } finally {
      getReposSpy.mockRestore()
      gitSpy.mockRestore()
    }
  })

  it('creates a runtime local worktree from a slash-named local branch matching a remote prefix', async () => {
    const runtime = new OrcaRuntimeService(store)
    const createdWorktree = {
      path: '/tmp/workspaces/slash-local-base',
      head: 'team-feature-sha',
      branch: 'slash-local-base',
      isBare: false,
      isMainWorktree: false
    }
    const repo = { ...store.getRepos()[0], worktreeBaseRef: 'team/feature' }
    const getReposSpy = vi.spyOn(store, 'getRepos').mockReturnValue([repo] as never)
    computeWorktreePathMock.mockReturnValue(createdWorktree.path)
    ensurePathWithinWorkspaceMock.mockReturnValue(createdWorktree.path)
    vi.mocked(addWorktree).mockResolvedValueOnce({})
    vi.mocked(listWorktrees).mockResolvedValue([createdWorktree])
    const gitSpy = vi.spyOn(gitRunner, 'gitExecFileAsync').mockImplementation(async (args) => {
      if (args[0] === 'remote') {
        return { stdout: 'team\norigin\n', stderr: '' }
      }
      if (args[0] === 'rev-parse' && args.includes('--git-common-dir')) {
        return { stdout: '/tmp/repo/.git\n', stderr: '' }
      }
      if (args[0] === 'rev-parse' && args.includes('refs/remotes/team/feature^{commit}')) {
        throw new Error('missing remote-tracking ref')
      }
      if (args[0] === 'rev-parse' && args.includes('refs/heads/team/feature^{commit}')) {
        return { stdout: 'team-feature-sha\n', stderr: '' }
      }
      if (args.includes('fetch')) {
        throw new Error('network unavailable')
      }
      return { stdout: '', stderr: '' }
    })
    try {
      await expect(
        runtime.createManagedWorktree({
          repoSelector: 'id:repo-1',
          name: 'slash-local-base'
        })
      ).resolves.toBeDefined()

      expect(addWorktree).toHaveBeenCalledWith(
        TEST_REPO_PATH,
        createdWorktree.path,
        'slash-local-base',
        'team/feature',
        false
      )
      expect(gitSpy).not.toHaveBeenCalledWith(
        [
          '-c',
          'maintenance.auto=false',
          '-c',
          'maintenance.commit-graph.auto=0',
          '-c',
          'gc.auto=0',
          'fetch',
          '--no-tags',
          'team',
          '+refs/heads/feature:refs/remotes/team/feature'
        ],
        expect.any(Object)
      )
    } finally {
      getReposSpy.mockRestore()
      gitSpy.mockRestore()
    }
  })

  it('does not create a runtime local worktree when the refresh fails and no local base ref exists', async () => {
    const runtime = new OrcaRuntimeService(store)
    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/cli-refresh-no-local')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/cli-refresh-no-local')
    const gitSpy = vi.spyOn(gitRunner, 'gitExecFileAsync').mockImplementation(async (args) => {
      if (args[0] === 'remote') {
        return { stdout: 'origin\n', stderr: '' }
      }
      if (args[0] === 'rev-parse' && args.includes('--git-common-dir')) {
        return { stdout: '/tmp/repo/.git\n', stderr: '' }
      }
      // No local remote-tracking base ref -> nothing to fall back on.
      if (args[0] === 'rev-parse' && args[1] === '--verify') {
        throw new Error('missing ref')
      }
      if (args.includes('fetch')) {
        throw new Error('network unavailable')
      }
      return { stdout: '', stderr: '' }
    })
    try {
      await expect(
        runtime.createManagedWorktree({
          repoSelector: 'id:repo-1',
          name: 'cli-refresh-no-local'
        })
      ).rejects.toThrow(
        'Could not refresh base ref "origin/main" from "origin". Check your network and try again.'
      )

      expect(addWorktree).not.toHaveBeenCalled()
    } finally {
      gitSpy.mockRestore()
    }
  })

  it('creates a branchNameOverride worktree from the selected matching remote base ref', async () => {
    const runtime = new OrcaRuntimeService(store)
    vi.spyOn(gitRunner, 'gitExecFileAsync').mockResolvedValue({ stdout: '', stderr: '' })
    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/feature-something')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/feature-something')
    vi.mocked(listWorktrees).mockResolvedValueOnce([
      {
        path: '/tmp/workspaces/feature-something',
        head: 'def',
        branch: 'feature/something',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'feature/something',
      baseBranch: 'origin/feature/something',
      branchNameOverride: 'feature/something'
    })

    expect(getBranchConflictKind).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      'feature/something',
      'origin/feature/something'
    )
    expect(addWorktree).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      '/tmp/workspaces/feature-something',
      'feature/something',
      'origin/feature/something',
      false
    )
    expect(resolveLocalGitUsernameMock).not.toHaveBeenCalled()
    expect(result.worktree).toMatchObject({
      path: '/tmp/workspaces/feature-something',
      branch: 'feature/something'
    })
  })

  it('checks out a selected existing local branch even when that branch already has a PR', async () => {
    const runtime = new OrcaRuntimeService(store)
    const createdWorktree = {
      path: '/tmp/workspaces/fix-bug-0',
      head: 'def',
      branch: 'refs/heads/fix/bug-0',
      isBare: false,
      isMainWorktree: false
    }
    computeWorktreePathMock.mockReturnValue(createdWorktree.path)
    ensurePathWithinWorkspaceMock.mockReturnValue(createdWorktree.path)
    vi.mocked(getBranchConflictKind).mockClear()
    getPRForBranchMock.mockResolvedValue({
      number: 42,
      title: 'Existing PR',
      state: 'open',
      url: 'https://example.com/pr/42',
      checksStatus: 'success',
      updatedAt: '2026-05-21T00:00:00Z',
      mergeable: 'UNKNOWN'
    })
    vi.mocked(listWorktrees)
      .mockResolvedValueOnce([
        {
          path: TEST_REPO_PATH,
          head: 'main',
          branch: 'refs/heads/main',
          isBare: false,
          isMainWorktree: true
        }
      ])
      .mockResolvedValueOnce([createdWorktree])
    const gitSpy = vi.spyOn(gitRunner, 'gitExecFileAsync').mockImplementation(async (args) => {
      if (args[0] === 'rev-parse' && args[1] === '--verify') {
        return { stdout: 'branch-sha\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })

    try {
      const result = await runtime.createManagedWorktree({
        repoSelector: 'id:repo-1',
        name: 'fix/bug-0',
        baseBranch: 'fix/bug-0',
        branchNameOverride: 'fix/bug-0'
      })

      expect(getBranchConflictKind).not.toHaveBeenCalled()
      expect(getPRForBranchMock).not.toHaveBeenCalled()
      expect(addWorktree).toHaveBeenCalledWith(
        TEST_REPO_PATH,
        createdWorktree.path,
        'fix/bug-0',
        'fix/bug-0',
        false,
        false,
        { checkoutExistingBranch: true }
      )
      expect(result.worktree).toMatchObject({
        path: createdWorktree.path,
        branch: 'refs/heads/fix/bug-0'
      })
    } finally {
      gitSpy.mockRestore()
    }
  })
})
