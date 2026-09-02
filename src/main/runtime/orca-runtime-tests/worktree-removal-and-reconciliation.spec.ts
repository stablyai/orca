import { describe, expect, it, vi } from 'vitest'
import {
  OrcaRuntimeService,
  addWorktree,
  assertWorktreeCleanForRemoval,
  closeLocalWatcherForWorktreePathMock,
  computeWorktreePathMock,
  deleteWorktreeHistoryDirMock,
  ensurePathWithinWorkspaceMock,
  findExistingWorktreeSymlinkPathsMock,
  forgetLocalWatcherRemovalSnapshotMock,
  getBranchConflictKind,
  getEffectiveHooks,
  getPRForBranchMock,
  gitRunner,
  invalidateAuthorizedRootsCacheMock,
  listWorktrees,
  loadHooks,
  registerLocalPtyMemoryRow,
  removeWorktree,
  removeWorktreeLinkedPathsMock,
  restoreLocalWatcherAfterFailedRemovalMock,
  runHook,
  setPlatform,
  unregisterLocalPtyMemoryRow
} from '../orca-runtime-test-mocks.spec'
import {
  TEST_REPO_ID,
  TEST_REPO_PATH,
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  createStaleRuntimeWorktreeStore,
  store,
  syncSinglePty
} from '../orca-runtime-test-fixtures.spec'
import { createWorktreeRemovalRuntime } from '../orca-runtime-test-scenario-builders.spec'

describe('OrcaRuntimeService', () => {
  it('creates the first terminal by id when duplicate repo entries expose the same path', async () => {
    const runtime = new OrcaRuntimeService(store)
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-duplicate-path' })
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      revealTerminalSession: vi.fn().mockResolvedValue({ tabId: 'tab-duplicate-path' }),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)

    const duplicatePath = '/tmp/workspaces/runtime-duplicate-terminal'
    const getRepos = vi.spyOn(store, 'getRepos').mockReturnValue([
      {
        id: TEST_REPO_ID,
        path: TEST_REPO_PATH,
        displayName: 'repo',
        badgeColor: 'blue',
        addedAt: 1
      },
      {
        id: 'repo-duplicate-entry',
        path: '/tmp/repo-secondary-worktree',
        displayName: 'repo-secondary-worktree',
        badgeColor: 'red',
        addedAt: 2
      }
    ])
    computeWorktreePathMock.mockReturnValue(duplicatePath)
    ensurePathWithinWorkspaceMock.mockReturnValue(duplicatePath)
    vi.mocked(getEffectiveHooks).mockReturnValue(null)
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: duplicatePath,
        head: 'def',
        branch: 'runtime-duplicate-terminal',
        isBare: false,
        isMainWorktree: false
      }
    ])

    try {
      const result = await runtime.createManagedWorktree({
        repoSelector: 'id:repo-1',
        name: 'runtime-duplicate-terminal'
      })

      expect(result.warning).toBeUndefined()
      expect(spawn).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: duplicatePath,
          worktreeId: result.worktree.id
        })
      )
    } finally {
      getRepos.mockRestore()
    }
  })

  it('resolves an exact path selector when duplicate repo entries expose the same path', async () => {
    const runtime = new OrcaRuntimeService(store)
    const duplicatePath = '/tmp/workspaces/runtime-duplicate-selector'
    const getRepos = vi.spyOn(store, 'getRepos').mockReturnValue([
      {
        id: TEST_REPO_ID,
        path: TEST_REPO_PATH,
        displayName: 'repo',
        badgeColor: 'blue',
        addedAt: 1
      },
      {
        id: 'repo-duplicate-entry',
        path: '/tmp/repo-secondary-worktree',
        displayName: 'repo-secondary-worktree',
        badgeColor: 'red',
        addedAt: 2
      }
    ])
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: duplicatePath,
        head: 'def',
        branch: 'runtime-duplicate-selector',
        isBare: false,
        isMainWorktree: false
      }
    ])

    try {
      const worktree = await runtime.showManagedWorktree(`path:${duplicatePath}`)

      expect(worktree.id).toBe(`${TEST_REPO_ID}::${duplicatePath}`)
      expect(worktree.path).toBe(duplicatePath)
    } finally {
      getRepos.mockRestore()
    }
  })

  it('keeps CLI-created worktrees successful when initial terminal creation fails', async () => {
    const runtime = new OrcaRuntimeService(store)
    const spawn = vi.fn().mockRejectedValue(new Error('pty unavailable'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)

    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-terminal-fail')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-terminal-fail')
    vi.mocked(getEffectiveHooks).mockReturnValue(null)
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: '/tmp/workspaces/runtime-terminal-fail',
        head: 'def',
        branch: 'runtime-terminal-fail',
        isBare: false,
        isMainWorktree: false
      }
    ])

    try {
      await expect(
        runtime.createManagedWorktree({
          repoSelector: 'id:repo-1',
          name: 'runtime-terminal-fail'
        })
      ).resolves.toMatchObject({
        worktree: expect.objectContaining({
          path: '/tmp/workspaces/runtime-terminal-fail'
        }),
        warning:
          'Failed to create the initial terminal for /tmp/workspaces/runtime-terminal-fail: pty unavailable'
      })
      expect(spawn).toHaveBeenCalled()
      expect(warn).toHaveBeenCalledWith(
        '[worktree-create] Failed to create the initial terminal for /tmp/workspaces/runtime-terminal-fail: pty unavailable'
      )
    } finally {
      warn.mockRestore()
    }
  })

  it('activates CLI-created worktrees only when explicitly requested', async () => {
    const runtime = new OrcaRuntimeService(store)
    const activateWorktree = vi.fn()
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree,
      createTerminal: vi.fn(),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)

    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-activate')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-activate')
    vi.mocked(getEffectiveHooks).mockReturnValue(null)
    vi.mocked(listWorktrees).mockResolvedValueOnce([
      {
        path: '/tmp/workspaces/runtime-activate',
        head: 'def',
        branch: 'runtime-activate',
        isBare: false,
        isMainWorktree: false
      }
    ])

    await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'runtime-activate',
      activate: true
    })

    expect(activateWorktree).toHaveBeenCalledWith(
      'repo-1',
      expect.any(String),
      undefined,
      undefined,
      undefined
    )
  })

  it('stamps createdAt alongside lastActivityAt so CLI-created worktrees get the Recent-sort grace window', async () => {
    // Why: without createdAt, ambient PTY bumps in other worktrees can push the new one below them in Recent sort.
    const runtime = new OrcaRuntimeService(store)
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)

    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-grace')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-grace')
    vi.mocked(getEffectiveHooks).mockReturnValue({ scripts: {} })
    vi.mocked(listWorktrees).mockResolvedValueOnce([
      {
        path: '/tmp/workspaces/runtime-grace',
        head: 'def',
        branch: 'runtime-grace',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const before = Date.now()
    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'runtime-grace'
    })
    const after = Date.now()

    expect(result.worktree.createdAt).toBeDefined()
    expect(result.worktree.createdAt).toBeGreaterThanOrEqual(before)
    expect(result.worktree.createdAt).toBeLessThanOrEqual(after)
    // Both fields must share the same now so grace-window math (max(lastActivityAt, createdAt + GRACE_MS)) is well-defined.
    expect(result.worktree.createdAt).toBe(result.worktree.lastActivityAt)
  })

  it('routes runtime worktree creation through the selected WSL project runtime', async () => {
    setPlatform('win32')
    const runtimeStore = {
      ...store,
      getProjects: () => [
        {
          id: 'project-1',
          displayName: 'repo',
          badgeColor: 'blue',
          sourceRepoIds: [TEST_REPO_ID],
          localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' },
          createdAt: 0,
          updatedAt: 0
        }
      ],
      getSettings: () => ({
        ...store.getSettings(),
        localWindowsRuntimeDefault: { kind: 'windows-host' }
      })
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const createdWorktree = {
      path: '/tmp/workspaces/runtime-wsl',
      head: 'def',
      branch: 'refs/heads/runtime-wsl',
      isBare: false,
      isMainWorktree: false
    }
    computeWorktreePathMock.mockReturnValue(createdWorktree.path)
    ensurePathWithinWorkspaceMock.mockReturnValue(createdWorktree.path)
    vi.mocked(listWorktrees).mockResolvedValue([createdWorktree])
    const gitSpy = vi.spyOn(gitRunner, 'gitExecFileAsync').mockImplementation(async (args) => {
      if (args[0] === 'symbolic-ref') {
        return { stdout: 'refs/remotes/origin/main\n', stderr: '' }
      }
      if (args[0] === 'rev-parse' && args.includes('refs/heads/runtime-wsl^{commit}')) {
        throw new Error('missing local branch')
      }
      if (args[0] === 'rev-parse' && args[1] === '--path-format=absolute') {
        return { stdout: `${TEST_REPO_PATH}/.git\n`, stderr: '' }
      }
      if (args[0] === 'rev-parse' && args.includes('refs/remotes/origin/main^{commit}')) {
        return { stdout: 'base-sha\n', stderr: '' }
      }
      if (args[0] === 'remote' && args.length === 1) {
        return { stdout: 'origin\n', stderr: '' }
      }
      if (args[0] === 'remote' && args[1] === 'get-url') {
        return { stdout: 'git@github.com:stablyai/orca.git\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })

    try {
      const result = await runtime.createManagedWorktree({
        repoSelector: 'id:repo-1',
        name: 'runtime-wsl',
        pushTarget: {
          remoteName: 'pr-contributor-orca',
          branchName: 'contributor/runtime-wsl',
          remoteUrl: 'git@github.com:contributor/orca.git'
        }
      })

      expect(result.worktree).toMatchObject({
        path: createdWorktree.path,
        branch: 'refs/heads/runtime-wsl'
      })
      expect(gitSpy).toHaveBeenCalledWith(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], {
        cwd: TEST_REPO_PATH,
        timeout: 15_000,
        wslDistro: 'Ubuntu'
      })
      expect(getBranchConflictKind).toHaveBeenCalledWith(
        TEST_REPO_PATH,
        'runtime-wsl',
        'origin/main',
        { wslDistro: 'Ubuntu' }
      )
      expect(getPRForBranchMock).toHaveBeenCalledWith(
        TEST_REPO_PATH,
        'runtime-wsl',
        null,
        null,
        null,
        { localGitExecOptions: { wslDistro: 'Ubuntu' } }
      )
      expect(addWorktree).toHaveBeenCalledWith(
        TEST_REPO_PATH,
        createdWorktree.path,
        'runtime-wsl',
        'origin/main',
        false,
        false,
        {
          remoteTrackingBase: {
            base: 'origin/main',
            branch: 'main',
            ref: 'refs/remotes/origin/main',
            remote: 'origin'
          },
          suggestLocalBaseRefUpdate: true,
          wslDistro: 'Ubuntu'
        }
      )
      // Why: a fork remote is deferred to first push/pull/fetch/fast-forward
      // (#17828) instead of being added/fetched at create time, so the create
      // path must not run check-ref-format, the fork fetch, or set-upstream-to
      // -- the metadata is persisted untouched for on-demand materialization.
      expect(gitSpy).not.toHaveBeenCalledWith(
        ['check-ref-format', '--branch', 'contributor/runtime-wsl'],
        expect.anything()
      )
      expect(gitSpy).not.toHaveBeenCalledWith(
        [
          'fetch',
          'pr-contributor-orca',
          '+refs/heads/contributor/runtime-wsl*:refs/remotes/pr-contributor-orca/contributor/runtime-wsl*'
        ],
        expect.anything()
      )
      expect(gitSpy).not.toHaveBeenCalledWith(
        [
          'branch',
          '--set-upstream-to',
          'pr-contributor-orca/contributor/runtime-wsl',
          'runtime-wsl'
        ],
        expect.anything()
      )
      expect(result.worktree.pushTarget).toEqual({
        remoteName: 'pr-contributor-orca',
        branchName: 'contributor/runtime-wsl',
        remoteUrl: 'git@github.com:contributor/orca.git'
      })
      expect(listWorktrees).toHaveBeenCalledWith(TEST_REPO_PATH, { wslDistro: 'Ubuntu' })
    } finally {
      gitSpy.mockRestore()
    }
  })

  it('skips archive hooks for CLI worktree removal by default', async () => {
    const runtime = createWorktreeRemovalRuntime()
    vi.mocked(getEffectiveHooks).mockReturnValue({
      scripts: {
        archive: 'pnpm worktree:archive'
      }
    })
    vi.mocked(removeWorktree).mockResolvedValue({})

    const result = await runtime.removeManagedWorktree(TEST_WORKTREE_ID)

    expect(runHook).not.toHaveBeenCalled()
    expect(removeWorktree).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      TEST_WORKTREE_PATH,
      false,
      expect.objectContaining({
        knownRemovedWorktree: expect.objectContaining({ path: TEST_WORKTREE_PATH })
      })
    )
    expect(deleteWorktreeHistoryDirMock).toHaveBeenCalledWith(TEST_WORKTREE_ID)
    expect(result.warning).toBe(
      `orca.yaml archive hook skipped for ${TEST_WORKTREE_PATH}; pass --run-hooks to run it.`
    )
  })

  it('passes project shared links through the runtime removal preflight and cleanup', async () => {
    const runtime = createWorktreeRemovalRuntime()
    vi.mocked(loadHooks).mockReturnValue({
      scripts: {},
      worktree: { sharedDirectories: ['node_modules'] }
    })
    findExistingWorktreeSymlinkPathsMock.mockResolvedValue(['node_modules'])
    vi.mocked(removeWorktree).mockResolvedValue({})

    await runtime.removeManagedWorktree(TEST_WORKTREE_ID)

    expect(findExistingWorktreeSymlinkPathsMock).toHaveBeenCalledWith(TEST_WORKTREE_PATH, [
      'node_modules'
    ])
    expect(assertWorktreeCleanForRemoval).toHaveBeenCalledWith(TEST_WORKTREE_PATH, false, {
      ignoredUntrackedPaths: ['node_modules']
    })
    expect(removeWorktreeLinkedPathsMock).toHaveBeenCalledWith(TEST_WORKTREE_PATH, ['node_modules'])
  })

  it('forgets exact-id orphan metadata when the parent repo is already gone', async () => {
    const { runtimeStore, removeWorktreeMeta } = createStaleRuntimeWorktreeStore(TEST_WORKTREE_ID, {
      hostId: 'runtime:env-1'
    })
    const orphanStore = {
      ...runtimeStore,
      getRepos: () => [],
      getRepo: () => undefined
    }
    const runtime = createWorktreeRemovalRuntime(orphanStore)

    // Nothing left the disk, so non-desktop callers must be able to tell "forgotten" from "deleted".
    await expect(runtime.removeManagedWorktree(TEST_WORKTREE_ID)).resolves.toEqual({
      warning: expect.stringContaining(TEST_WORKTREE_PATH)
    })

    expect(removeWorktreeMeta).toHaveBeenCalledWith(TEST_WORKTREE_ID, 'runtime:env-1')
    expect(deleteWorktreeHistoryDirMock).toHaveBeenCalledWith(TEST_WORKTREE_ID)
    expect(invalidateAuthorizedRootsCacheMock).toHaveBeenCalled()
    expect(removeWorktree).not.toHaveBeenCalled()
    // Nothing is deleted on disk here, so the surviving directory's watchers must still be released.
    expect(closeLocalWatcherForWorktreePathMock).toHaveBeenCalledWith(
      TEST_WORKTREE_PATH,
      expect.objectContaining({ remainingMs: expect.any(Function) })
    )
    // Regression: the directory survives, so its watchers must be restored rather than forgotten.
    expect(restoreLocalWatcherAfterFailedRemovalMock).toHaveBeenCalledWith(TEST_WORKTREE_PATH)
    expect(forgetLocalWatcherRemovalSnapshotMock).not.toHaveBeenCalled()
  })

  it('scopes a runtime-host orphan PTY sweep to its environment, not the local host', async () => {
    const { runtimeStore } = createStaleRuntimeWorktreeStore(TEST_WORKTREE_ID, {
      hostId: 'runtime:env-1'
    })
    const orphanStore = {
      ...runtimeStore,
      getRepos: () => [],
      getRepo: () => undefined
    }
    const localProvider = {
      listProcesses: vi.fn(async () => [{ id: `${TEST_WORKTREE_ID}@@1` }]),
      shutdown: vi.fn(async () => {})
    }
    const runtime = new OrcaRuntimeService(orphanStore as never, undefined, {
      getLocalProvider: () => localProvider as never
    })
    const stopAndWait = vi.fn().mockResolvedValue(true)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      stopAndWait,
      getForegroundProcess: async () => null
    })
    syncSinglePty(runtime, 'local-pty-1')
    runtime.registerPty('local-pty-1', TEST_WORKTREE_ID)
    registerLocalPtyMemoryRow({
      ptyId: 'local-pty-1',
      worktreeId: TEST_WORKTREE_ID,
      sessionId: null,
      paneKey: null,
      pid: null
    })

    try {
      await runtime.removeManagedWorktree(TEST_WORKTREE_ID)
    } finally {
      unregisterLocalPtyMemoryRow('local-pty-1')
    }

    // Regression: `repoId::path` collides across hosts, so a runtime-owned orphan
    // must never kill the live PTYs of a same-id LOCAL workspace.
    expect(localProvider.listProcesses).not.toHaveBeenCalled()
    expect(localProvider.shutdown).not.toHaveBeenCalled()
    expect(stopAndWait).not.toHaveBeenCalled()
  })

  it('fails closed before teardown when a qualified target loses its host owner', async () => {
    const { runtimeStore, removeWorktreeMeta } = createStaleRuntimeWorktreeStore(TEST_WORKTREE_ID, {
      hostId: 'local'
    })
    const orphanStore = {
      ...runtimeStore,
      getRepos: () => [],
      getRepo: () => undefined
    }
    const localProvider = {
      listProcesses: vi.fn(async () => [{ id: `${TEST_WORKTREE_ID}@@1` }]),
      shutdown: vi.fn(async () => {})
    }
    const runtime = new OrcaRuntimeService(orphanStore as never, undefined, {
      getLocalProvider: () => localProvider as never
    })
    const stopAndWait = vi.fn().mockResolvedValue(true)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      stopAndWait,
      getForegroundProcess: async () => null
    })
    syncSinglePty(runtime, 'local-pty-1')
    runtime.registerPty('local-pty-1', TEST_WORKTREE_ID)
    const internals = runtime as unknown as {
      resolveWorktreeRemovalTarget: () => Promise<{
        id: string
        repoId: string
        path: string
      }>
    }
    internals.resolveWorktreeRemovalTarget = vi.fn().mockResolvedValue({
      id: TEST_WORKTREE_ID,
      repoId: TEST_REPO_ID,
      path: TEST_WORKTREE_PATH
    })

    await expect(
      runtime.removeManagedWorktree(TEST_WORKTREE_ID, false, false, false, 'runtime:env-b')
    ).rejects.toThrow('no longer belongs to runtime:env-b')

    expect(localProvider.listProcesses).not.toHaveBeenCalled()
    expect(localProvider.shutdown).not.toHaveBeenCalled()
    expect(stopAndWait).not.toHaveBeenCalled()
    expect(removeWorktreeMeta).not.toHaveBeenCalled()
    expect(closeLocalWatcherForWorktreePathMock).not.toHaveBeenCalled()
  })

  it('still sweeps the local host for an ownerless orphan', async () => {
    const { runtimeStore } = createStaleRuntimeWorktreeStore(TEST_WORKTREE_ID)
    const orphanStore = {
      ...runtimeStore,
      getRepos: () => [],
      getRepo: () => undefined
    }
    const localProvider = {
      listProcesses: vi.fn(async () => []),
      shutdown: vi.fn(async () => {})
    }
    const runtime = new OrcaRuntimeService(orphanStore as never, undefined, {
      getLocalProvider: () => localProvider as never
    })
    const stopAndWait = vi.fn().mockResolvedValue(true)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      stopAndWait,
      getForegroundProcess: async () => null
    })
    syncSinglePty(runtime, 'local-pty-1')
    runtime.registerPty('local-pty-1', TEST_WORKTREE_ID)

    await runtime.removeManagedWorktree(TEST_WORKTREE_ID)

    expect(localProvider.listProcesses).toHaveBeenCalled()
    expect(stopAndWait).toHaveBeenCalledWith('local-pty-1', expect.anything())
  })

  it('restores rather than forgets watchers for the orphan directory that survives', async () => {
    const { runtimeStore } = createStaleRuntimeWorktreeStore(TEST_WORKTREE_ID, {
      hostId: 'runtime:env-1'
    })
    const orphanStore = {
      ...runtimeStore,
      getRepos: () => [],
      getRepo: () => undefined
    }
    const runtime = createWorktreeRemovalRuntime(orphanStore)

    await runtime.removeManagedWorktree(TEST_WORKTREE_ID)

    // Regression: the gate must finish(false) — forgetting watchers would silently deafen a
    // folder workspace or File Explorer pane rooted at this still-present directory.
    expect(closeLocalWatcherForWorktreePathMock).toHaveBeenCalledWith(
      TEST_WORKTREE_PATH,
      expect.objectContaining({ remainingMs: expect.any(Function) })
    )
    expect(restoreLocalWatcherAfterFailedRemovalMock).toHaveBeenCalledWith(TEST_WORKTREE_PATH)
    expect(forgetLocalWatcherRemovalSnapshotMock).not.toHaveBeenCalled()
    expect(removeWorktree).not.toHaveBeenCalled()
  })
})
