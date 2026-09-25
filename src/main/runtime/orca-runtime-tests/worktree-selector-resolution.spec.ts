import { describe, expect, it, vi } from 'vitest'
import {
  FLOATING_TERMINAL_WORKTREE_ID,
  MOCK_GIT_WORKTREES,
  OrcaRuntimeService,
  RpcDispatcher,
  TERMINAL_METHODS,
  addSparseWorktree,
  addWorktree,
  computeWorktreePathMock,
  ensurePathWithinWorkspaceMock,
  getSshGitProviderMock,
  join,
  listWorktrees,
  mkdir,
  mkdtemp,
  registerSshFilesystemProvider,
  registerSshGitProvider,
  tmpdir,
  unregisterSshFilesystemProvider,
  unregisterSshGitProvider,
  writeFile
} from '../orca-runtime-test-mocks.spec'
import type { WorktreeMeta } from '../orca-runtime-test-mocks.spec'
import {
  TEST_FOLDER_WORKSPACE_KEY,
  TEST_REPO_ID,
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  createFolderWorkspaceRuntimeStore,
  deferred,
  makeFolderProjectGroup,
  makeFolderWorkspace,
  makeRpcRequest,
  makeWorktreeMeta,
  store
} from '../orca-runtime-test-fixtures.spec'

describe('OrcaRuntimeService', () => {
  it('resolves branch selectors when worktrees store refs/heads-prefixed branches', async () => {
    vi.mocked(listWorktrees).mockResolvedValueOnce([
      {
        path: '/tmp/worktree-a',
        head: 'abc',
        branch: 'refs/heads/Jinwoo-H/test-3a',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const runtime = new OrcaRuntimeService(store)

    const worktree = await runtime.showManagedWorktree('branch:Jinwoo-H/test-3a')
    expect(worktree).toMatchObject({
      branch: 'refs/heads/Jinwoo-H/test-3a',
      path: '/tmp/worktree-a'
    })
  })

  it('resolves name selectors against worktree display names', async () => {
    vi.mocked(listWorktrees).mockResolvedValueOnce([
      {
        path: TEST_WORKTREE_PATH,
        head: 'abc',
        branch: 'refs/heads/wolfiesch/orca-skill-smoke',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const runtime = new OrcaRuntimeService(store)

    const worktree = await runtime.showManagedWorktree('name:foo')
    expect(worktree).toMatchObject({
      displayName: 'foo',
      path: TEST_WORKTREE_PATH
    })
  })

  it('routes SSH-backed forward-slash UNC file and git paths without collapsing the root', async () => {
    vi.mocked(listWorktrees).mockClear()
    vi.mocked(listWorktrees).mockRejectedValue(new Error('local git should not run for SSH repos'))
    const remoteStore = {
      ...store,
      getRepos: () => [
        {
          id: TEST_REPO_ID,
          path: '//Server/Share/Repo',
          displayName: 'repo',
          badgeColor: 'blue',
          addedAt: 1,
          connectionId: 'ssh-1'
        }
      ],
      getRepo: () => ({
        id: TEST_REPO_ID,
        path: '//Server/Share/Repo',
        displayName: 'repo',
        badgeColor: 'blue',
        addedAt: 1,
        connectionId: 'ssh-1'
      })
    }
    const fsProvider = { readDir: vi.fn().mockResolvedValue([]) }
    const gitProvider = {
      listWorktrees: vi.fn().mockResolvedValue([
        {
          path: '//Server/Share/Repo',
          head: 'abc',
          branch: 'feature/foo',
          isBare: false,
          isMainWorktree: false
        }
      ]),
      getStatus: vi.fn().mockResolvedValue({
        branch: 'feature/foo',
        files: [],
        ahead: 0,
        behind: 0,
        hasConflicts: false
      })
    }
    registerSshFilesystemProvider('ssh-1', fsProvider as never)
    registerSshGitProvider('ssh-1', gitProvider as never)
    const runtime = new OrcaRuntimeService(remoteStore as never)

    try {
      await runtime.readFileExplorerDir('path://server/share/repo', 'src')
      await runtime.getRuntimeGitStatus('path://server/share/repo')
      await expect(runtime.showRepo('path://server/share/repo')).resolves.toMatchObject({
        path: '//Server/Share/Repo'
      })
    } finally {
      unregisterSshFilesystemProvider('ssh-1')
      unregisterSshGitProvider('ssh-1')
    }

    expect(listWorktrees).not.toHaveBeenCalled()
    expect(gitProvider.listWorktrees).toHaveBeenCalledWith('//Server/Share/Repo')
    expect(fsProvider.readDir).toHaveBeenCalledWith('\\\\Server\\Share\\Repo\\src')
    expect(gitProvider.getStatus).toHaveBeenCalledWith('//Server/Share/Repo')
  })

  it.each([
    { label: 'canonical folder workspace selector', selector: TEST_FOLDER_WORKSPACE_KEY },
    { label: 'id-prefixed folder workspace selector', selector: `id:${TEST_FOLDER_WORKSPACE_KEY}` }
  ])('reads file explorer paths for a $label', async ({ selector }) => {
    const folderPath = await mkdtemp(join(tmpdir(), 'orca-runtime-folder-files-'))
    await mkdir(join(folderPath, 'src'))
    await writeFile(join(folderPath, 'src', 'app.ts'), 'export {}\n')
    const folderWorkspace = makeFolderWorkspace({ folderPath })
    const projectGroup = makeFolderProjectGroup({ parentPath: folderPath })
    const runtime = new OrcaRuntimeService(
      createFolderWorkspaceRuntimeStore(folderWorkspace, projectGroup) as never
    )

    await expect(runtime.readFileExplorerDir(selector, 'src')).resolves.toContainEqual({
      name: 'app.ts',
      isDirectory: false,
      isSymlink: false
    })
    await expect(runtime.readFileExplorerPreview(selector, 'src/app.ts')).resolves.toMatchObject({
      content: 'export {}\n',
      isBinary: false
    })
  })

  it('routes SSH folder workspace file explorer paths through the filesystem provider', async () => {
    const folderPath = '/srv/platform'
    const fsProvider = {
      stat: vi.fn(async (pathValue: string) => ({
        size: pathValue.endsWith('/app.ts') ? 8 : 0,
        type: pathValue.endsWith('/app.ts') ? 'file' : 'directory',
        mtime: 1
      })),
      readDir: vi.fn().mockResolvedValue([
        {
          name: 'app.ts',
          isDirectory: false,
          isSymlink: false
        }
      ]),
      readFile: vi.fn().mockResolvedValue({ content: 'remote\n', isBinary: false })
    }
    const folderWorkspace = makeFolderWorkspace({ folderPath, connectionId: 'ssh-folder' })
    const projectGroup = makeFolderProjectGroup({ parentPath: folderPath })
    const runtime = new OrcaRuntimeService(
      createFolderWorkspaceRuntimeStore(folderWorkspace, projectGroup) as never
    )
    registerSshFilesystemProvider('ssh-folder', fsProvider as never)

    try {
      await expect(
        runtime.readFileExplorerDir(`id:${TEST_FOLDER_WORKSPACE_KEY}`, 'src')
      ).resolves.toHaveLength(1)
      await expect(
        runtime.readFileExplorerPreview(`id:${TEST_FOLDER_WORKSPACE_KEY}`, 'src/app.ts')
      ).resolves.toMatchObject({
        content: 'remote\n',
        isBinary: false
      })
    } finally {
      unregisterSshFilesystemProvider('ssh-folder')
    }

    expect(fsProvider.stat).toHaveBeenCalledWith(folderPath)
    expect(fsProvider.readDir).toHaveBeenCalledWith('/srv/platform/src')
    expect(fsProvider.stat).toHaveBeenCalledWith('/srv/platform/src/app.ts')
    expect(fsProvider.readFile).toHaveBeenCalledWith('/srv/platform/src/app.ts', {
      maxBinaryBytes: 10 * 1024 * 1024,
      maxTextBytes: 512 * 1024
    })
  })

  it('lists persisted SSH worktrees while the git provider is unavailable', async () => {
    vi.mocked(listWorktrees).mockClear()
    const remoteRepo = {
      id: 'remote-repo',
      path: '/home/user/repo',
      displayName: 'remote',
      badgeColor: 'blue',
      addedAt: 1,
      connectionId: 'ssh-missing'
    }
    const mainId = `${remoteRepo.id}::/home/user/repo`
    const childId = `${remoteRepo.id}::/home/user/repo-child`
    const metaById: Record<string, WorktreeMeta> = {
      [mainId]: makeWorktreeMeta({ displayName: 'Remote main' }),
      [childId]: makeWorktreeMeta({ displayName: 'Remote child', linkedPR: 42 })
    }
    const runtimeStore = {
      ...store,
      getRepos: () => [remoteRepo],
      getRepo: () => remoteRepo,
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...metaById[worktreeId], ...meta }
        return metaById[worktreeId]
      }
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    const listed = await runtime.listManagedWorktrees('id:remote-repo')

    expect(listWorktrees).not.toHaveBeenCalled()
    expect(getSshGitProviderMock).toHaveBeenCalledWith('ssh-missing')
    expect(listed).toMatchObject({
      totalCount: 2,
      truncated: false,
      worktrees: [
        {
          id: mainId,
          hostId: 'ssh:ssh-missing',
          path: '/home/user/repo',
          branch: '',
          isMainWorktree: true,
          displayName: 'Remote main'
        },
        {
          id: childId,
          hostId: 'ssh:ssh-missing',
          path: '/home/user/repo-child',
          branch: '',
          isMainWorktree: false,
          displayName: 'Remote child',
          linkedPR: 42
        }
      ]
    })
  })

  it('does not interpret active as a runtime-global worktree selector', async () => {
    const runtime = new OrcaRuntimeService(store)

    await expect(runtime.showManagedWorktree('active')).rejects.toThrow('selector_not_found')
  })

  it('does not resolve the floating-terminal sentinel as a managed worktree', async () => {
    const runtime = new OrcaRuntimeService(store)

    await expect(runtime.showManagedWorktree(FLOATING_TERMINAL_WORKTREE_ID)).rejects.toThrow(
      'selector_not_found'
    )
    await expect(
      runtime.showManagedWorktree(`id:${FLOATING_TERMINAL_WORKTREE_ID}`)
    ).rejects.toThrow('selector_not_found')
  })

  it('guides bare repo-id worktree selectors to the full id shape', async () => {
    vi.mocked(listWorktrees).mockClear()
    vi.mocked(listWorktrees).mockRejectedValue(new Error('bare repo ids should not scan worktrees'))
    const runtime = new OrcaRuntimeService(store)

    await expect(runtime.showManagedWorktree(`id:${TEST_REPO_ID}`)).rejects.toThrow(
      'Worktree id selectors must use the full <repo-id>::<path> value.'
    )
    expect(listWorktrees).not.toHaveBeenCalled()
  })

  it('guides registered SSH repo ids without probing the provider', async () => {
    const remoteRepo = { ...store.getRepos()[0], connectionId: 'ssh-1' }
    const remoteStore = {
      ...store,
      getRepos: () => [remoteRepo],
      getRepo: (id: string) => (id === remoteRepo.id ? remoteRepo : undefined)
    }
    vi.mocked(listWorktrees).mockClear()
    getSshGitProviderMock.mockClear()
    const runtime = new OrcaRuntimeService(remoteStore)

    await expect(runtime.showManagedWorktree(`id:${TEST_REPO_ID}`)).rejects.toMatchObject({
      code: 'worktree_id_requires_full_path'
    })
    expect(listWorktrees).not.toHaveBeenCalled()
    expect(getSshGitProviderMock).not.toHaveBeenCalled()
  })

  it('rejects bare repo ids through terminal list RPC with the structured code', async () => {
    vi.mocked(listWorktrees).mockClear()
    const runtime = new OrcaRuntimeService(store)
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    const response = await dispatcher.dispatch(
      makeRpcRequest('terminal.list', { worktree: `id:${TEST_REPO_ID}` })
    )

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: 'worktree_id_requires_full_path',
        message: expect.stringContaining('full <repo-id>::<path> value')
      }
    })
    expect(listWorktrees).not.toHaveBeenCalled()
  })

  it('rejects bare repo ids through the mobile session exact-id fast path', async () => {
    vi.mocked(listWorktrees).mockClear()
    const runtime = new OrcaRuntimeService(store)

    await expect(runtime.listMobileSessionTabs(`id:${TEST_REPO_ID}`)).rejects.toMatchObject({
      code: 'worktree_id_requires_full_path'
    })
    expect(listWorktrees).not.toHaveBeenCalled()
  })

  it('still resolves the full worktree id selector', async () => {
    const runtime = new OrcaRuntimeService(store)

    await expect(runtime.showManagedWorktree(`id:${TEST_WORKTREE_ID}`)).resolves.toMatchObject({
      id: TEST_WORKTREE_ID
    })
  })

  it('still throws selector_not_found for an unknown id selector', async () => {
    const runtime = new OrcaRuntimeService(store)

    await expect(runtime.showManagedWorktree('id:does-not-exist')).rejects.toThrow(
      'selector_not_found'
    )
  })

  it('still throws selector_not_found for unknown bare ids', async () => {
    const runtime = new OrcaRuntimeService(store)

    await expect(runtime.showManagedWorktree('id:not-a-repo')).rejects.toThrow('selector_not_found')
  })

  it('does not treat partial repo ids as full worktree ids', async () => {
    const runtime = new OrcaRuntimeService(store)

    await expect(runtime.showManagedWorktree('id:repo')).rejects.toThrow('selector_not_found')
  })

  it('preserves full-id guidance for explicit parent-worktree lineage selectors', async () => {
    const runtime = new OrcaRuntimeService(store)
    const resolveLineage = runtime['resolveLineageForWorktreeCreate'].bind(runtime)

    await expect(resolveLineage({ parentWorktree: `id:${TEST_REPO_ID}` })).rejects.toThrow(
      'Worktree id selectors must use the full <repo-id>::<path> value.'
    )
  })

  it('does not reuse stale in-flight worktree scans after creating a worktree', async () => {
    const addRetiredWorktreeName = vi.fn()
    const runtime = new OrcaRuntimeService({
      ...store,
      addRetiredWorktreeName,
      getRetiredWorktreeNameRegistry: () => ({
        exhaustedTiers: 0,
        names: Array.from({ length: 100 }, (_unused, index) =>
          index === 0 ? 'nautilus' : `nautilus-${index + 1}`
        )
      })
    })
    const staleScan = deferred<typeof MOCK_GIT_WORKTREES>()
    const createdWorktree = {
      path: '/tmp/workspaces/repo-nautilus-101',
      head: 'def',
      branch: 'nautilus-101',
      isBare: false,
      isMainWorktree: false
    }
    computeWorktreePathMock.mockReturnValue(createdWorktree.path)
    ensurePathWithinWorkspaceMock.mockReturnValue(createdWorktree.path)
    vi.mocked(listWorktrees)
      .mockImplementationOnce(() => staleScan.promise)
      .mockResolvedValueOnce([createdWorktree])
      .mockResolvedValueOnce([...MOCK_GIT_WORKTREES, createdWorktree])

    const staleLookup = runtime.showManagedWorktree(TEST_WORKTREE_ID)
    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'nautilus',
      nameWasGenerated: true
    })
    const freshLookup = runtime.showManagedWorktree(result.worktree.id)

    staleScan.resolve(MOCK_GIT_WORKTREES)

    await expect(staleLookup).resolves.toMatchObject({ id: TEST_WORKTREE_ID })
    await expect(freshLookup).resolves.toMatchObject({
      id: result.worktree.id,
      path: createdWorktree.path
    })
    await expect(runtime.listDetectedManagedWorktrees(`id:${TEST_REPO_ID}`)).resolves.toMatchObject(
      {
        worktrees: expect.arrayContaining([expect.objectContaining({ path: createdWorktree.path })])
      }
    )
    expect(addRetiredWorktreeName).toHaveBeenCalledWith(TEST_REPO_ID, 'nautilus-101')
  })

  it('retires a generated name before a post-create listing failure', async () => {
    const addRetiredWorktreeName = vi.fn()
    const runtime = new OrcaRuntimeService({ ...store, addRetiredWorktreeName })
    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/nautilus')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/nautilus')
    vi.mocked(listWorktrees).mockRejectedValueOnce(new Error('listing unavailable'))

    await expect(
      runtime.createManagedWorktree({
        repoSelector: 'id:repo-1',
        name: 'nautilus',
        nameWasGenerated: true
      })
    ).rejects.toThrow('listing unavailable')

    expect(addWorktree).toHaveBeenCalled()
    expect(addRetiredWorktreeName).toHaveBeenCalledWith(TEST_REPO_ID, 'nautilus')
  })

  it('retires a generated sparse name when creation rollback also fails', async () => {
    const addRetiredWorktreeName = vi.fn()
    const runtime = new OrcaRuntimeService({ ...store, addRetiredWorktreeName })
    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/nautilus')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/nautilus')
    vi.mocked(addSparseWorktree).mockRejectedValueOnce(
      Object.assign(new Error('sparse setup failed'), { cleanupFailed: true })
    )

    await expect(
      runtime.createManagedWorktree({
        repoSelector: 'id:repo-1',
        name: 'nautilus',
        nameWasGenerated: true,
        sparseCheckout: { directories: ['packages/web'] }
      })
    ).rejects.toThrow('sparse setup failed')

    expect(addRetiredWorktreeName).toHaveBeenCalledWith(TEST_REPO_ID, 'nautilus')
  })

  it('neither skips nor retires a name the user typed', async () => {
    // Why: the pool contains ordinary words. Retirement only ever applies to generated names.
    const addRetiredWorktreeName = vi.fn()
    const runtime = new OrcaRuntimeService({
      ...store,
      addRetiredWorktreeName,
      getRetiredWorktreeNameRegistry: () => ({ exhaustedTiers: 0, names: ['nautilus'] })
    })
    const createdWorktree = {
      path: '/tmp/workspaces/nautilus',
      head: 'def',
      branch: 'nautilus',
      isBare: false,
      isMainWorktree: false
    }
    computeWorktreePathMock.mockReturnValue(createdWorktree.path)
    ensurePathWithinWorkspaceMock.mockReturnValue(createdWorktree.path)
    // Not `...Once`: the shared beforeEach re-stubs the resolved value but cannot drain a queue,
    // so leftover one-shots would poison later tests in this file.
    vi.mocked(listWorktrees).mockResolvedValue([...MOCK_GIT_WORKTREES, createdWorktree])

    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'nautilus'
    })

    expect(result.worktree.path).toBe(createdWorktree.path)
    expect(addRetiredWorktreeName).not.toHaveBeenCalled()
  })
})
