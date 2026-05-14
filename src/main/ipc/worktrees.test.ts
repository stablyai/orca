/* eslint-disable max-lines */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  handleMock,
  removeHandlerMock,
  listWorktreesMock,
  addWorktreeMock,
  addSparseWorktreeMock,
  removeWorktreeMock,
  getGitUsernameMock,
  getDefaultBaseRefMock,
  getDefaultRemoteMock,
  getBranchConflictKindMock,
  getPRForBranchMock,
  getWorkItemMock,
  getPullRequestPushTargetMock,
  getEffectiveHooksMock,
  createIssueCommandRunnerScriptMock,
  createSetupRunnerScriptMock,
  shouldRunSetupForCreateMock,
  runHookMock,
  hasHooksFileMock,
  loadHooksMock,
  computeWorktreePathMock,
  ensurePathWithinWorkspaceMock,
  gitExecFileAsyncMock,
  getSshGitProviderMock,
  getActiveMultiplexerMock
} = vi.hoisted(() => ({
  handleMock: vi.fn(),
  removeHandlerMock: vi.fn(),
  listWorktreesMock: vi.fn(),
  addWorktreeMock: vi.fn(),
  addSparseWorktreeMock: vi.fn(),
  removeWorktreeMock: vi.fn(),
  getGitUsernameMock: vi.fn(),
  getDefaultBaseRefMock: vi.fn(),
  getDefaultRemoteMock: vi.fn(),
  getBranchConflictKindMock: vi.fn(),
  getPRForBranchMock: vi.fn(),
  getWorkItemMock: vi.fn(),
  getPullRequestPushTargetMock: vi.fn(),
  getEffectiveHooksMock: vi.fn(),
  createIssueCommandRunnerScriptMock: vi.fn(),
  createSetupRunnerScriptMock: vi.fn(),
  shouldRunSetupForCreateMock: vi.fn(),
  runHookMock: vi.fn(),
  hasHooksFileMock: vi.fn(),
  loadHooksMock: vi.fn(),
  computeWorktreePathMock: vi.fn(),
  ensurePathWithinWorkspaceMock: vi.fn(),
  gitExecFileAsyncMock: vi.fn(),
  getSshGitProviderMock: vi.fn(),
  getActiveMultiplexerMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: handleMock,
    removeHandler: removeHandlerMock
  }
}))

vi.mock('../git/worktree', () => ({
  listWorktrees: listWorktreesMock,
  addWorktree: addWorktreeMock,
  addSparseWorktree: addSparseWorktreeMock,
  removeWorktree: removeWorktreeMock
}))

vi.mock('../git/runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock,
  gitExecFileSync: vi.fn()
}))

vi.mock('../git/repo', () => ({
  getGitUsername: getGitUsernameMock,
  getDefaultBaseRef: getDefaultBaseRefMock,
  getDefaultRemote: getDefaultRemoteMock,
  getBranchConflictKind: getBranchConflictKindMock
}))

vi.mock('../github/client', () => ({
  getPRForBranch: getPRForBranchMock,
  getWorkItem: getWorkItemMock,
  getPullRequestPushTarget: getPullRequestPushTargetMock
}))

vi.mock('../providers/ssh-git-dispatch', () => ({
  getSshGitProvider: getSshGitProviderMock
}))

vi.mock('./ssh', () => ({
  getActiveMultiplexer: getActiveMultiplexerMock
}))

vi.mock('../hooks', () => ({
  createIssueCommandRunnerScript: createIssueCommandRunnerScriptMock,
  createSetupRunnerScript: createSetupRunnerScriptMock,
  getEffectiveHooks: getEffectiveHooksMock,
  loadHooks: loadHooksMock,
  runHook: runHookMock,
  hasHooksFile: hasHooksFileMock,
  shouldRunSetupForCreate: shouldRunSetupForCreateMock
}))

vi.mock('./worktree-logic', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    computeWorktreePath: computeWorktreePathMock,
    ensurePathWithinWorkspace: ensurePathWithinWorkspaceMock
  }
})

const { deleteWorktreeHistoryDirMock } = vi.hoisted(() => ({
  deleteWorktreeHistoryDirMock: vi.fn()
}))

vi.mock('../terminal-history', () => ({
  deleteWorktreeHistoryDir: deleteWorktreeHistoryDirMock
}))

const { killAllProcessesForWorktreeMock, getLocalPtyProviderMock } = vi.hoisted(() => ({
  killAllProcessesForWorktreeMock: vi.fn(),
  getLocalPtyProviderMock: vi.fn()
}))

vi.mock('../runtime/worktree-teardown', () => ({
  killAllProcessesForWorktree: killAllProcessesForWorktreeMock
}))

vi.mock('./pty', () => ({
  getLocalPtyProvider: getLocalPtyProviderMock
}))

import { registerWorktreeHandlers } from './worktrees'

type HandlerMap = Record<string, (_event: unknown, args: unknown) => unknown>

describe('registerWorktreeHandlers', () => {
  const handlers: HandlerMap = {}
  const mainWindow = {
    isDestroyed: () => false,
    webContents: {
      send: vi.fn()
    }
  }
  const store = {
    getRepos: vi.fn(),
    getRepo: vi.fn(),
    getSparsePresets: vi.fn(),
    getSettings: vi.fn(),
    getWorktreeMeta: vi.fn(),
    setWorktreeMeta: vi.fn(),
    removeWorktreeMeta: vi.fn()
  }
  let runtimeStub: {
    resolveRemoteTrackingBase: ReturnType<typeof vi.fn>
    hasRemoteTrackingRef: ReturnType<typeof vi.fn>
    isRemoteFetchFresh: ReturnType<typeof vi.fn>
    getOrStartRemoteFetch: ReturnType<typeof vi.fn>
    fetchRemoteWithCache: ReturnType<typeof vi.fn>
    emitWorktreeBaseStatus: ReturnType<typeof vi.fn>
    recordOptimisticReconcileToken: ReturnType<typeof vi.fn>
    reconcileWorktreeBaseStatus: ReturnType<typeof vi.fn>
    clearOptimisticReconcileToken: ReturnType<typeof vi.fn>
  }

  beforeEach(() => {
    for (const m of [
      handleMock,
      removeHandlerMock,
      listWorktreesMock,
      addWorktreeMock,
      addSparseWorktreeMock,
      removeWorktreeMock,
      getGitUsernameMock,
      getDefaultBaseRefMock,
      getDefaultRemoteMock,
      getBranchConflictKindMock,
      getPRForBranchMock,
      getWorkItemMock,
      getPullRequestPushTargetMock,
      getEffectiveHooksMock,
      createIssueCommandRunnerScriptMock,
      createSetupRunnerScriptMock,
      shouldRunSetupForCreateMock,
      runHookMock,
      hasHooksFileMock,
      loadHooksMock,
      computeWorktreePathMock,
      ensurePathWithinWorkspaceMock,
      gitExecFileAsyncMock,
      getSshGitProviderMock,
      getActiveMultiplexerMock,
      mainWindow.webContents.send,
      store.getRepos,
      store.getRepo,
      store.getSparsePresets,
      store.getSettings,
      store.getWorktreeMeta,
      store.setWorktreeMeta,
      store.removeWorktreeMeta,
      killAllProcessesForWorktreeMock,
      getLocalPtyProviderMock
    ]) {
      m.mockReset()
    }
    killAllProcessesForWorktreeMock.mockResolvedValue({
      runtimeStopped: 0,
      providerStopped: 0,
      registryStopped: 0
    })
    getLocalPtyProviderMock.mockReturnValue({} as never)

    for (const key of Object.keys(handlers)) {
      delete handlers[key]
    }

    handleMock.mockImplementation((channel, handler) => {
      handlers[channel] = handler
    })

    const repo = {
      id: 'repo-1',
      path: '/workspace/repo',
      displayName: 'repo',
      badgeColor: '#000',
      addedAt: 0
    }
    store.getRepos.mockReturnValue([repo])
    store.getRepo.mockReturnValue({ ...repo, worktreeBaseRef: null })
    store.getSparsePresets.mockReturnValue([])
    store.getSettings.mockReturnValue({
      branchPrefix: 'none',
      nestWorkspaces: false,
      refreshLocalBaseRefOnWorktreeCreate: false,
      workspaceDir: '/workspace'
    })
    store.getWorktreeMeta.mockReturnValue(undefined)
    store.setWorktreeMeta.mockReturnValue({})
    getGitUsernameMock.mockReturnValue('')
    getDefaultBaseRefMock.mockReturnValue('origin/main')
    getDefaultRemoteMock.mockResolvedValue('origin')
    getBranchConflictKindMock.mockResolvedValue(null)
    getPRForBranchMock.mockResolvedValue(null)
    getWorkItemMock.mockResolvedValue(null)
    getPullRequestPushTargetMock.mockResolvedValue(null)
    // Why: createLocalWorktree can still hit legacy git fetch fallback in
    // narrow unit harnesses. Return a resolved promise so catch/then chains
    // don't trip on undefined.
    gitExecFileAsyncMock.mockResolvedValue({ stdout: '', stderr: '' })
    getEffectiveHooksMock.mockReturnValue(null)
    shouldRunSetupForCreateMock.mockReturnValue(false)
    createSetupRunnerScriptMock.mockReturnValue({
      runnerScriptPath: '/workspace/repo/.git/orca/setup-runner.sh',
      envVars: {
        ORCA_ROOT_PATH: '/workspace/repo',
        ORCA_WORKTREE_PATH: '/workspace/improve-dashboard'
      }
    })
    createIssueCommandRunnerScriptMock.mockReturnValue({
      runnerScriptPath: '/workspace/repo/.git/orca/issue-command-runner.sh',
      envVars: {
        ORCA_ROOT_PATH: '/workspace/repo',
        ORCA_WORKTREE_PATH: '/workspace/improve-dashboard'
      }
    })
    computeWorktreePathMock.mockImplementation(
      (
        sanitizedName: string,
        repoPath: string,
        settings: { nestWorkspaces: boolean; workspaceDir: string }
      ) => {
        if (settings.nestWorkspaces) {
          const repoName =
            repoPath
              .split(/[\\/]/)
              .at(-1)
              ?.replace(/\.git$/, '') ?? 'repo'
          return `${settings.workspaceDir}/${repoName}/${sanitizedName}`
        }
        return `${settings.workspaceDir}/${sanitizedName}`
      }
    )
    ensurePathWithinWorkspaceMock.mockImplementation((targetPath: string) => targetPath)
    listWorktreesMock.mockResolvedValue([])

    // Why: createLocalWorktree routes `git fetch` through
    // `runtime.fetchRemoteWithCache` (§3.3 Lifecycle). A minimal stub
    // keeps these tests focused on create-flow semantics; the full
    // cache behavior is covered by fetch-remote-cache.test.ts.
    runtimeStub = {
      resolveRemoteTrackingBase: vi.fn().mockResolvedValue(null),
      hasRemoteTrackingRef: vi.fn().mockResolvedValue(false),
      isRemoteFetchFresh: vi.fn().mockResolvedValue(false),
      getOrStartRemoteFetch: vi.fn().mockResolvedValue({ ok: true }),
      fetchRemoteWithCache: vi.fn().mockResolvedValue(undefined),
      emitWorktreeBaseStatus: vi.fn(),
      recordOptimisticReconcileToken: vi.fn().mockReturnValue('token-1'),
      reconcileWorktreeBaseStatus: vi.fn(),
      clearOptimisticReconcileToken: vi.fn()
    }
    registerWorktreeHandlers(mainWindow as never, store as never, runtimeStub as never)
  })

  it('auto-suffixes the branch name when the first choice collides with a remote branch', async () => {
    // Why: new-workspace flow should silently try improve-dashboard-2, -3, ...
    // rather than failing and forcing the user back to the name picker.
    getBranchConflictKindMock.mockImplementation(async (_repoPath: string, branch: string) =>
      branch === 'improve-dashboard' ? 'remote' : null
    )
    listWorktreesMock.mockResolvedValue([
      {
        path: '/workspace/improve-dashboard-2',
        head: 'abc123',
        branch: 'improve-dashboard-2',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const result = await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'improve-dashboard'
    })

    expect(addWorktreeMock).toHaveBeenCalledWith(
      '/workspace/repo',
      '/workspace/improve-dashboard-2',
      'improve-dashboard-2',
      'origin/main',
      false
    )
    expect(result).toEqual({
      worktree: expect.objectContaining({
        path: '/workspace/improve-dashboard-2',
        branch: 'improve-dashboard-2'
      })
    })
  })

  it('persists a sanitized artifact title as the worktree display name', async () => {
    listWorktreesMock.mockResolvedValue([
      {
        path: '/workspace/improve-dashboard',
        head: 'abc123',
        branch: 'improve-dashboard',
        isBare: false,
        isMainWorktree: false
      }
    ])
    store.setWorktreeMeta.mockImplementation((_worktreeId, meta) => meta)

    const result = await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'improve-dashboard',
      displayName: '  Fix: dashboards\nfor PRs\u0000  '
    })

    expect(store.setWorktreeMeta).toHaveBeenCalledWith(
      'repo-1::/workspace/improve-dashboard',
      expect.objectContaining({
        displayName: 'Fix: dashboards for PRs'
      })
    )
    expect(result).toEqual({
      worktree: expect.objectContaining({
        displayName: 'Fix: dashboards for PRs'
      })
    })
  })

  it('persists linked issue and PR metadata during local create', async () => {
    listWorktreesMock.mockResolvedValue([
      {
        path: '/workspace/improve-dashboard',
        head: 'abc123',
        branch: 'improve-dashboard',
        isBare: false,
        isMainWorktree: false
      }
    ])
    store.setWorktreeMeta.mockImplementation((_worktreeId, meta) => meta)

    const result = await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'improve-dashboard',
      linkedIssue: 123,
      linkedPR: 456
    })

    expect(store.setWorktreeMeta).toHaveBeenCalledWith(
      'repo-1::/workspace/improve-dashboard',
      expect.objectContaining({
        linkedIssue: 123,
        linkedPR: 456
      })
    )
    expect(result).toEqual({
      worktree: expect.objectContaining({
        linkedIssue: 123,
        linkedPR: 456
      })
    })
  })

  it('persists the selected creation agent during local create', async () => {
    listWorktreesMock.mockResolvedValue([
      {
        path: '/workspace/improve-dashboard',
        head: 'abc123',
        branch: 'improve-dashboard',
        isBare: false,
        isMainWorktree: false
      }
    ])
    store.setWorktreeMeta.mockImplementation((_worktreeId, meta) => meta)

    const result = await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'improve-dashboard',
      createdWithAgent: 'codex'
    })

    expect(store.setWorktreeMeta).toHaveBeenCalledWith(
      'repo-1::/workspace/improve-dashboard',
      expect.objectContaining({
        createdWithAgent: 'codex'
      })
    )
    expect(result).toEqual({
      worktree: expect.objectContaining({
        createdWithAgent: 'codex'
      })
    })
  })

  it('configures a PR push target during local create', async () => {
    listWorktreesMock.mockResolvedValue([
      {
        path: '/workspace/improve-dashboard',
        head: 'abc123',
        branch: 'refs/heads/improve-dashboard',
        isBare: false,
        isMainWorktree: false
      }
    ])
    store.setWorktreeMeta.mockImplementation((_worktreeId, meta) => meta)

    await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'improve-dashboard',
      pushTarget: {
        remoteName: 'pr-prateek-orca',
        branchName: 'prateek/fix-sidebar-agents-toggle',
        remoteUrl: 'git@github.com:prateek/orca.git'
      }
    })

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['remote', 'add', 'pr-prateek-orca', 'git@github.com:prateek/orca.git'],
      { cwd: '/workspace/repo' }
    )
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      [
        'fetch',
        'pr-prateek-orca',
        '+refs/heads/prateek/fix-sidebar-agents-toggle:refs/remotes/pr-prateek-orca/prateek/fix-sidebar-agents-toggle'
      ],
      { cwd: '/workspace/repo' }
    )
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      [
        'branch',
        '--set-upstream-to',
        'pr-prateek-orca/prateek/fix-sidebar-agents-toggle',
        'improve-dashboard'
      ],
      { cwd: '/workspace/improve-dashboard' }
    )
    expect(store.setWorktreeMeta).toHaveBeenCalledWith(
      'repo-1::/workspace/improve-dashboard',
      expect.objectContaining({
        pushTarget: {
          remoteName: 'pr-prateek-orca',
          branchName: 'prateek/fix-sidebar-agents-toggle',
          remoteUrl: 'git@github.com:prateek/orca.git'
        }
      })
    )
  })

  it('returns the PR head push target when resolving a fork PR base', async () => {
    getPullRequestPushTargetMock.mockResolvedValue({
      remoteName: 'pr-prateek-orca',
      branchName: 'prateek/fix-sidebar-agents-toggle',
      remoteUrl: 'git@github.com:prateek/orca.git'
    })
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'rev-parse') {
        return { stdout: 'abc123\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })

    const result = await handlers['worktrees:resolvePrBase'](null, {
      repoId: 'repo-1',
      prNumber: 1738,
      headRefName: 'prateek/fix-sidebar-agents-toggle',
      isCrossRepository: true
    })

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(['fetch', 'origin', 'refs/pull/1738/head'], {
      cwd: '/workspace/repo'
    })
    expect(result).toEqual({
      baseBranch: 'abc123',
      pushTarget: {
        remoteName: 'pr-prateek-orca',
        branchName: 'prateek/fix-sidebar-agents-toggle',
        remoteUrl: 'git@github.com:prateek/orca.git'
      }
    })
  })

  it('persists linked issue, PR, and selected agent metadata during remote create', async () => {
    const repo = {
      id: 'repo-ssh',
      path: '/remote/repo',
      displayName: 'ssh',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'conn-1',
      worktreeBaseRef: 'origin/main'
    }
    const provider = {
      exec: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
      addWorktree: vi.fn().mockResolvedValue(undefined),
      listWorktrees: vi.fn().mockResolvedValue([
        {
          path: '/remote/improve-dashboard',
          head: 'abc123',
          branch: 'refs/heads/improve-dashboard',
          isBare: false,
          isMainWorktree: false
        }
      ])
    }
    const mux = {
      request: vi.fn().mockResolvedValue(undefined),
      notify: vi.fn()
    }
    store.getRepos.mockReturnValue([repo])
    store.getRepo.mockReturnValue(repo)
    getSshGitProviderMock.mockReturnValue(provider)
    getActiveMultiplexerMock.mockReturnValue(mux)
    store.setWorktreeMeta.mockImplementation((_worktreeId, meta) => meta)

    const result = await handlers['worktrees:create'](null, {
      repoId: 'repo-ssh',
      name: 'improve-dashboard',
      linkedIssue: 123,
      linkedPR: 456,
      createdWithAgent: 'codex'
    })

    expect(store.setWorktreeMeta).toHaveBeenCalledWith(
      'repo-ssh::/remote/improve-dashboard',
      expect.objectContaining({
        linkedIssue: 123,
        linkedPR: 456,
        createdWithAgent: 'codex'
      })
    )
    expect(result).toEqual({
      worktree: expect.objectContaining({
        linkedIssue: 123,
        linkedPR: 456,
        createdWithAgent: 'codex'
      })
    })
  })

  it('does not await a cold fetch when the remote-tracking base exists locally', async () => {
    const remoteBase = {
      remote: 'origin',
      branch: 'main',
      ref: 'refs/remotes/origin/main',
      base: 'origin/main'
    }
    let resolveFetch!: () => void
    const pendingFetch = new Promise<{ ok: true }>((resolve) => {
      resolveFetch = () => resolve({ ok: true })
    })
    runtimeStub.resolveRemoteTrackingBase.mockResolvedValue(remoteBase)
    runtimeStub.hasRemoteTrackingRef.mockResolvedValue(true)
    runtimeStub.getOrStartRemoteFetch.mockReturnValue(pendingFetch)
    listWorktreesMock.mockResolvedValue([
      {
        path: '/workspace/improve-dashboard',
        head: 'created-sha',
        branch: 'improve-dashboard',
        isBare: false,
        isMainWorktree: false
      }
    ])
    gitExecFileAsyncMock.mockResolvedValue({ stdout: 'created-sha\n', stderr: '' })

    const createPromise = handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'improve-dashboard'
    }) as Promise<unknown>

    const result = await Promise.race([
      createPromise,
      new Promise((resolve) => setTimeout(() => resolve('timed-out'), 0))
    ])
    expect(result).not.toBe('timed-out')

    expect(runtimeStub.getOrStartRemoteFetch).toHaveBeenCalledWith('/workspace/repo', 'origin')
    expect(runtimeStub.fetchRemoteWithCache).not.toHaveBeenCalled()
    expect(runtimeStub.emitWorktreeBaseStatus).toHaveBeenCalledWith({
      repoId: 'repo-1',
      worktreeId: 'repo-1::/workspace/improve-dashboard',
      status: 'checking',
      base: 'origin/main',
      remote: 'origin'
    })
    expect(runtimeStub.reconcileWorktreeBaseStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        createdBaseSha: 'created-sha',
        fetchPromise: pendingFetch
      })
    )
    expect(result).toEqual(
      expect.objectContaining({
        initialBaseStatus: expect.objectContaining({ status: 'checking', base: 'origin/main' })
      })
    )
    resolveFetch()
  })

  it('throws a clear error when no default base ref can be resolved', async () => {
    // Why: guard against regressing to a silent 'origin/main' fallback. When
    // getDefaultBaseRef returns null (e.g. a fresh repo with no origin/HEAD,
    // no origin/main, no origin/master, and no local main/master), we must
    // fail loudly with a message that prompts the user to pick a base
    // branch, not hand a non-existent ref to `git worktree add`.
    getDefaultBaseRefMock.mockReturnValue(null)
    store.getRepo.mockReturnValue({
      id: 'repo-1',
      path: '/workspace/repo',
      displayName: 'repo',
      badgeColor: '#000',
      addedAt: 0,
      worktreeBaseRef: null
    })

    await expect(
      handlers['worktrees:create'](null, {
        repoId: 'repo-1',
        name: 'improve-dashboard'
      })
    ).rejects.toThrow(/Could not resolve a default base ref/)
    expect(addWorktreeMock).not.toHaveBeenCalled()
  })

  it('creates an issue-command runner for an existing repo/worktree pair', async () => {
    const result = await handlers['hooks:createIssueCommandRunner'](null, {
      repoId: 'repo-1',
      worktreePath: '/workspace/improve-dashboard',
      command: 'codex exec "long command"'
    })

    expect(createIssueCommandRunnerScriptMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'repo-1' }),
      '/workspace/improve-dashboard',
      'codex exec "long command"'
    )
    expect(result).toEqual({
      runnerScriptPath: '/workspace/repo/.git/orca/issue-command-runner.sh',
      envVars: {
        ORCA_ROOT_PATH: '/workspace/repo',
        ORCA_WORKTREE_PATH: '/workspace/improve-dashboard'
      }
    })
  })

  it('lists a synthetic worktree for folder-mode repos', async () => {
    store.getRepos.mockReturnValue([
      {
        id: 'repo-1',
        path: '/workspace/folder',
        displayName: 'folder',
        badgeColor: '#000',
        addedAt: 0,
        kind: 'folder'
      }
    ])
    store.getRepo.mockReturnValue({
      id: 'repo-1',
      path: '/workspace/folder',
      displayName: 'folder',
      badgeColor: '#000',
      addedAt: 0,
      kind: 'folder'
    })

    const listed = await handlers['worktrees:list'](null, { repoId: 'repo-1' })

    expect(listed).toEqual([
      expect.objectContaining({
        id: 'repo-1::/workspace/folder',
        repoId: 'repo-1',
        path: '/workspace/folder',
        displayName: 'folder',
        branch: '',
        head: '',
        isMainWorktree: true
      })
    ])
    expect(listWorktreesMock).not.toHaveBeenCalled()
  })

  it('stamps lastActivityAt on first discovery so newly-added worktrees sort to the top of Recent', async () => {
    // Why: a worktree that exists on disk but has no persisted WorktreeMeta
    // (e.g. a folder repo just added, or a pre-existing worktree in a
    // newly-added git repo) would otherwise fall back to `lastActivityAt: 0`
    // and rank dead last in the Recent sort.
    listWorktreesMock.mockResolvedValue([
      {
        path: '/workspace/discovered-wt',
        head: 'abc123',
        branch: 'refs/heads/feature',
        isBare: false,
        isMainWorktree: false
      }
    ])
    store.getWorktreeMeta.mockReturnValue(undefined)
    const stampedMeta = { lastActivityAt: 1_700_000_000_000 }
    store.setWorktreeMeta.mockReturnValue(stampedMeta)

    const listed = (await handlers['worktrees:list'](null, { repoId: 'repo-1' })) as {
      id: string
      lastActivityAt: number
    }[]

    expect(store.setWorktreeMeta).toHaveBeenCalledWith(
      'repo-1::/workspace/discovered-wt',
      expect.objectContaining({ lastActivityAt: expect.any(Number) })
    )
    expect(listed[0]).toMatchObject({
      id: 'repo-1::/workspace/discovered-wt',
      lastActivityAt: 1_700_000_000_000
    })
  })

  it('does not re-stamp lastActivityAt when a worktree already has persisted meta', async () => {
    // Why: only the *first* discovery should stamp. Re-stamping on every list
    // would overwrite real activity and reshuffle the sidebar on refresh.
    listWorktreesMock.mockResolvedValue([
      {
        path: '/workspace/existing-wt',
        head: 'abc123',
        branch: 'refs/heads/feature',
        isBare: false,
        isMainWorktree: false
      }
    ])
    store.getWorktreeMeta.mockReturnValue({
      displayName: '',
      comment: '',
      linkedIssue: null,
      linkedPR: null,
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 42
    })

    const listed = (await handlers['worktrees:list'](null, { repoId: 'repo-1' })) as {
      id: string
      lastActivityAt: number
    }[]

    expect(store.setWorktreeMeta).not.toHaveBeenCalled()
    expect(listed[0].lastActivityAt).toBe(42)
  })

  it('stamps lastActivityAt on first discovery for folder-mode repos', async () => {
    // Why: folder repos produce a synthetic worktree that flows through the
    // same list path. Without the stamp, adding a folder puts its card at the
    // bottom of Recent even though the user just added it.
    store.getRepos.mockReturnValue([
      {
        id: 'repo-1',
        path: '/workspace/folder',
        displayName: 'folder',
        badgeColor: '#000',
        addedAt: 0,
        kind: 'folder'
      }
    ])
    store.getRepo.mockReturnValue({
      id: 'repo-1',
      path: '/workspace/folder',
      displayName: 'folder',
      badgeColor: '#000',
      addedAt: 0,
      kind: 'folder'
    })
    store.getWorktreeMeta.mockReturnValue(undefined)
    store.setWorktreeMeta.mockReturnValue({ lastActivityAt: 1_700_000_000_000 })

    await handlers['worktrees:list'](null, { repoId: 'repo-1' })

    expect(store.setWorktreeMeta).toHaveBeenCalledWith(
      'repo-1::/workspace/folder',
      expect.objectContaining({ lastActivityAt: expect.any(Number) })
    )
  })

  it('stamps lastActivityAt on first discovery via worktrees:listAll', async () => {
    // Why: the stamping logic lives in both worktrees:list and worktrees:listAll.
    // Without a dedicated test, a regression in the listAll loop would silently
    // bury newly-discovered worktrees from the multi-repo sidebar view.
    listWorktreesMock.mockResolvedValue([
      {
        path: '/workspace/discovered-wt',
        head: 'abc123',
        branch: 'refs/heads/feature',
        isBare: false,
        isMainWorktree: false
      }
    ])
    store.getWorktreeMeta.mockReturnValue(undefined)
    store.setWorktreeMeta.mockReturnValue({ lastActivityAt: 1_700_000_000_000 })

    const listed = (await handlers['worktrees:listAll'](null, undefined)) as {
      id: string
      lastActivityAt: number
    }[]

    expect(store.setWorktreeMeta).toHaveBeenCalledWith(
      'repo-1::/workspace/discovered-wt',
      expect.objectContaining({ lastActivityAt: expect.any(Number) })
    )
    expect(listed[0]).toMatchObject({
      id: 'repo-1::/workspace/discovered-wt',
      lastActivityAt: 1_700_000_000_000
    })
  })

  it('skips past a suffix that already belongs to a PR after an initial branch conflict', async () => {
    // Why: `gh pr list` is network-bound and previously fired on every single
    // create, adding 1–3s to the happy path. We now only probe PR conflicts
    // from suffix=2 onward — once a local/remote branch collision has already
    // forced us past the first candidate and uniqueness matters enough to
    // justify the GitHub round-trip. This test covers that delayed path:
    // suffix=1 is a branch conflict, suffix=2 is owned by an old PR, so the
    // loop lands on suffix=3.
    getBranchConflictKindMock.mockImplementation(async (_repoPath: string, branch: string) =>
      branch === 'improve-dashboard' ? 'remote' : null
    )
    getPRForBranchMock.mockImplementation(async (_repoPath: string, branch: string) =>
      branch === 'improve-dashboard-2'
        ? {
            number: 3127,
            title: 'Existing PR',
            state: 'merged',
            url: 'https://example.com/pr/3127',
            checksStatus: 'success',
            updatedAt: '2026-04-01T00:00:00Z',
            mergeable: 'UNKNOWN'
          }
        : null
    )
    listWorktreesMock.mockResolvedValue([
      {
        path: '/workspace/improve-dashboard-3',
        head: 'abc123',
        branch: 'improve-dashboard-3',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const result = await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'improve-dashboard'
    })

    expect(addWorktreeMock).toHaveBeenCalledWith(
      '/workspace/repo',
      '/workspace/improve-dashboard-3',
      'improve-dashboard-3',
      'origin/main',
      false
    )
    expect(result).toEqual({
      worktree: expect.objectContaining({
        path: '/workspace/improve-dashboard-3',
        branch: 'improve-dashboard-3'
      })
    })
  })

  it('does not call `gh pr list` on the happy path (no branch conflict)', async () => {
    // Why: guards the speed optimization. If a future refactor accidentally
    // reintroduces the PR probe on the first iteration, the happy path will
    // silently regain a 1–3s GitHub round-trip per click; this test fails
    // loudly instead.
    listWorktreesMock.mockResolvedValue([
      {
        path: '/workspace/improve-dashboard',
        head: 'abc123',
        branch: 'improve-dashboard',
        isBare: false,
        isMainWorktree: false
      }
    ])

    await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'improve-dashboard'
    })

    expect(getPRForBranchMock).not.toHaveBeenCalled()
  })

  const createdWorktreeList = [
    {
      path: '/workspace/improve-dashboard',
      head: 'abc123',
      branch: 'improve-dashboard',
      isBare: false,
      isMainWorktree: false
    }
  ]

  it('returns a setup launch payload when setup should run', async () => {
    listWorktreesMock.mockResolvedValue(createdWorktreeList)
    getEffectiveHooksMock.mockReturnValue({
      scripts: {
        setup: 'pnpm worktree:setup'
      }
    })
    shouldRunSetupForCreateMock.mockReturnValue(true)

    const result = await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'improve-dashboard',
      setupDecision: 'run'
    })

    expect(createSetupRunnerScriptMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'repo-1' }),
      '/workspace/improve-dashboard',
      'pnpm worktree:setup'
    )
    expect(result).toEqual({
      worktree: expect.objectContaining({
        repoId: 'repo-1',
        path: '/workspace/improve-dashboard',
        branch: 'improve-dashboard'
      }),
      setup: {
        runnerScriptPath: '/workspace/repo/.git/orca/setup-runner.sh',
        envVars: {
          ORCA_ROOT_PATH: '/workspace/repo',
          ORCA_WORKTREE_PATH: '/workspace/improve-dashboard'
        }
      }
    })
    expect(addWorktreeMock).toHaveBeenCalledWith(
      '/workspace/repo',
      '/workspace/improve-dashboard',
      'improve-dashboard',
      'origin/main',
      false
    )
  })

  it('launches setup even when primary and worktree orca.yaml scripts diverge', async () => {
    // Why: regression for a silent skip introduced by the #1280 content-equality
    // gate. Benign divergence (whitespace, comments, or any setup edit that
    // landed on the base branch but not yet in the primary checkout) must not
    // disable setup — repo-level trust already gates execution.
    listWorktreesMock.mockResolvedValue(createdWorktreeList)
    getEffectiveHooksMock.mockImplementation((_repo, worktreePath?: string) => ({
      scripts: {
        setup: worktreePath ? 'pnpm worktree:setup # worktree' : 'pnpm worktree:setup'
      }
    }))
    shouldRunSetupForCreateMock.mockReturnValue(true)

    const result = await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'improve-dashboard',
      setupDecision: 'run'
    })

    expect(createSetupRunnerScriptMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'repo-1' }),
      '/workspace/improve-dashboard',
      'pnpm worktree:setup # worktree'
    )
    expect(result).toEqual(
      expect.objectContaining({
        setup: expect.objectContaining({
          runnerScriptPath: '/workspace/repo/.git/orca/setup-runner.sh'
        })
      })
    )
  })

  it('creates a sparse worktree and persists its sparse metadata', async () => {
    listWorktreesMock.mockResolvedValue([
      {
        ...createdWorktreeList[0],
        isSparse: true
      }
    ])
    store.setWorktreeMeta.mockReturnValue({
      sparseDirectories: ['packages/web', 'apps/api'],
      sparseBaseRef: 'origin/main',
      sparsePresetId: 'preset-1'
    })
    store.getSparsePresets.mockReturnValue([
      {
        id: 'preset-1',
        repoId: 'repo-1',
        name: 'Frontend and API',
        directories: ['packages/web', 'apps/api'],
        createdAt: 1,
        updatedAt: 1
      }
    ])

    const result = await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'improve-dashboard',
      sparseCheckout: {
        directories: [' packages/web ', 'apps\\api\\', 'packages/web/'],
        presetId: 'preset-1'
      }
    })

    expect(addWorktreeMock).not.toHaveBeenCalled()
    expect(addSparseWorktreeMock).toHaveBeenCalledWith(
      '/workspace/repo',
      '/workspace/improve-dashboard',
      'improve-dashboard',
      ['packages/web', 'apps/api'],
      'origin/main',
      false
    )
    expect(store.setWorktreeMeta).toHaveBeenCalledWith(
      'repo-1::/workspace/improve-dashboard',
      expect.objectContaining({
        sparseDirectories: ['packages/web', 'apps/api'],
        sparseBaseRef: 'origin/main',
        sparsePresetId: 'preset-1'
      })
    )
    expect(result).toEqual({
      worktree: expect.objectContaining({
        repoId: 'repo-1',
        path: '/workspace/improve-dashboard',
        sparseDirectories: ['packages/web', 'apps/api'],
        sparseBaseRef: 'origin/main',
        sparsePresetId: 'preset-1'
      })
    })
  })

  it('clears sparse preset attribution when the preset id does not belong to the repo', async () => {
    listWorktreesMock.mockResolvedValue([
      {
        ...createdWorktreeList[0],
        isSparse: true
      }
    ])
    store.getSparsePresets.mockReturnValue([
      {
        id: 'preset-2',
        repoId: 'repo-1',
        name: 'Other preset',
        directories: ['packages/web'],
        createdAt: 1,
        updatedAt: 1
      }
    ])

    await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'improve-dashboard',
      sparseCheckout: {
        directories: ['packages/web'],
        presetId: 'preset-1'
      }
    })

    expect(store.setWorktreeMeta).toHaveBeenCalledWith(
      'repo-1::/workspace/improve-dashboard',
      expect.objectContaining({
        sparseDirectories: ['packages/web'],
        sparseBaseRef: 'origin/main',
        sparsePresetId: undefined
      })
    )
  })

  it('clears sparse preset attribution when normalized directories do not match', async () => {
    listWorktreesMock.mockResolvedValue([
      {
        ...createdWorktreeList[0],
        isSparse: true
      }
    ])
    store.getSparsePresets.mockReturnValue([
      {
        id: 'preset-1',
        repoId: 'repo-1',
        name: 'Frontend and API',
        directories: ['packages/web', 'apps/api'],
        createdAt: 1,
        updatedAt: 1
      }
    ])

    await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'improve-dashboard',
      sparseCheckout: {
        directories: ['packages/web'],
        presetId: 'preset-1'
      }
    })

    expect(store.setWorktreeMeta).toHaveBeenCalledWith(
      'repo-1::/workspace/improve-dashboard',
      expect.objectContaining({
        sparseDirectories: ['packages/web'],
        sparseBaseRef: 'origin/main',
        sparsePresetId: undefined
      })
    )
  })

  it('rejects sparse checkout directories that traverse above the repo root', async () => {
    await expect(
      handlers['worktrees:create'](null, {
        repoId: 'repo-1',
        name: 'improve-dashboard',
        sparseCheckout: {
          directories: ['packages/web', '../secrets']
        }
      })
    ).rejects.toThrow('Sparse checkout directories must be repo-relative paths.')

    expect(addSparseWorktreeMock).not.toHaveBeenCalled()
    expect(addWorktreeMock).not.toHaveBeenCalled()
  })

  it.each(['/Users/me/repo/packages/web', 'C:\\repo\\packages\\web', '\\\\server\\share\\repo'])(
    'rejects absolute sparse checkout directory before normalization: %s',
    async (directory) => {
      await expect(
        handlers['worktrees:create'](null, {
          repoId: 'repo-1',
          name: 'improve-dashboard',
          sparseCheckout: {
            directories: ['packages/web', directory]
          }
        })
      ).rejects.toThrow('Sparse checkout directories must be repo-relative paths.')

      expect(addSparseWorktreeMock).not.toHaveBeenCalled()
      expect(addWorktreeMock).not.toHaveBeenCalled()
    }
  )

  it('still returns the created worktree when setup runner generation fails', async () => {
    listWorktreesMock.mockResolvedValue(createdWorktreeList)
    getEffectiveHooksMock.mockReturnValue({
      scripts: {
        setup: 'pnpm worktree:setup'
      }
    })
    shouldRunSetupForCreateMock.mockReturnValue(true)
    createSetupRunnerScriptMock.mockImplementation(() => {
      throw new Error('disk full')
    })

    const result = await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'improve-dashboard',
      setupDecision: 'run'
    })

    expect(result).toEqual({
      worktree: expect.objectContaining({
        repoId: 'repo-1',
        path: '/workspace/improve-dashboard',
        branch: 'improve-dashboard'
      })
    })
    expect(mainWindow.webContents.send).toHaveBeenCalledWith('worktrees:changed', {
      repoId: 'repo-1'
    })
  })

  it('prunes git worktree tracking when removing an orphaned worktree', async () => {
    const orphanError = Object.assign(new Error('git worktree remove failed'), {
      stderr: "fatal: '/workspace/feature-wt' is not a working tree"
    })
    removeWorktreeMock.mockRejectedValue(orphanError)
    getEffectiveHooksMock.mockReturnValue(null)
    gitExecFileAsyncMock.mockResolvedValue({ stdout: '', stderr: '' })

    await handlers['worktrees:remove'](null, {
      worktreeId: 'repo-1::/workspace/feature-wt'
    })

    // Should have called git worktree prune to clean up stale tracking
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(['worktree', 'prune'], {
      cwd: '/workspace/repo'
    })
    expect(store.removeWorktreeMeta).toHaveBeenCalledWith('repo-1::/workspace/feature-wt')
    expect(deleteWorktreeHistoryDirMock).toHaveBeenCalledWith('repo-1::/workspace/feature-wt')
    expect(mainWindow.webContents.send).toHaveBeenCalledWith('worktrees:changed', {
      repoId: 'repo-1'
    })
  })

  it('runs the archive hook on remove when skipArchive is not set', async () => {
    listWorktreesMock.mockResolvedValue([])
    removeWorktreeMock.mockResolvedValue(undefined)
    getEffectiveHooksMock.mockReturnValue({
      scripts: {
        archive: 'echo archived'
      }
    })
    runHookMock.mockResolvedValue({ success: true, output: '' })

    await handlers['worktrees:remove'](null, {
      worktreeId: 'repo-1::/workspace/feature-wt'
    })

    expect(runHookMock).toHaveBeenCalledWith(
      'archive',
      '/workspace/feature-wt',
      expect.objectContaining({ id: 'repo-1' })
    )
    expect(removeWorktreeMock).toHaveBeenCalledWith(
      '/workspace/repo',
      '/workspace/feature-wt',
      false
    )
  })

  it('skips the archive hook on remove when skipArchive is true', async () => {
    listWorktreesMock.mockResolvedValue([])
    removeWorktreeMock.mockResolvedValue(undefined)
    getEffectiveHooksMock.mockReturnValue({
      scripts: {
        archive: 'echo archived'
      }
    })
    runHookMock.mockResolvedValue({ success: true, output: '' })

    await handlers['worktrees:remove'](null, {
      worktreeId: 'repo-1::/workspace/feature-wt',
      skipArchive: true
    })

    expect(runHookMock).not.toHaveBeenCalled()
    expect(removeWorktreeMock).toHaveBeenCalledWith(
      '/workspace/repo',
      '/workspace/feature-wt',
      false
    )
  })

  it('IPC-initiated delete kills PTYs BEFORE git-level removal (design §4.3)', async () => {
    listWorktreesMock.mockResolvedValue([])
    getEffectiveHooksMock.mockReturnValue(null)
    const callOrder: string[] = []
    killAllProcessesForWorktreeMock.mockImplementation(async () => {
      callOrder.push('kill')
      return { runtimeStopped: 1, providerStopped: 0, registryStopped: 0 }
    })
    removeWorktreeMock.mockImplementation(async () => {
      callOrder.push('git')
    })

    await handlers['worktrees:remove'](null, {
      worktreeId: 'repo-1::/workspace/feature-wt'
    })

    expect(killAllProcessesForWorktreeMock).toHaveBeenCalledWith(
      'repo-1::/workspace/feature-wt',
      expect.objectContaining({
        localProvider: expect.anything()
      })
    )
    expect(removeWorktreeMock).toHaveBeenCalled()
    expect(callOrder).toEqual(['kill', 'git'])
  })

  it('skips the PTY teardown for SSH-backed repos (design §6 out-of-scope)', async () => {
    // Why: SSH-backed PTYs live on the remote host and are handled by the
    // remote provider's own teardown. The local-host helper must not run for
    // SSH repos, because it would sweep registry entries for other worktrees.
    const repo = {
      id: 'repo-ssh',
      path: '/remote/repo',
      displayName: 'ssh',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'conn-1',
      worktreeBaseRef: null
    }
    store.getRepos.mockReturnValue([repo])
    store.getRepo.mockReturnValue(repo)

    // The test can't easily mock the SSH provider without more plumbing — the
    // call will throw about 'no git provider for connection'. What matters
    // here is that the kill helper was NOT called for the SSH branch.
    await (
      handlers['worktrees:remove'](null, {
        worktreeId: 'repo-ssh::/remote/feature-wt'
      }) as Promise<unknown>
    ).catch(() => {})

    expect(killAllProcessesForWorktreeMock).not.toHaveBeenCalled()
  })

  it('rejects ask-policy creates before mutating git state when setup decision is missing', async () => {
    getEffectiveHooksMock.mockReturnValue({
      scripts: {
        setup: 'pnpm worktree:setup'
      }
    })
    shouldRunSetupForCreateMock.mockImplementation(() => {
      throw new Error('Setup decision required for this repository')
    })

    await expect(
      handlers['worktrees:create'](null, {
        repoId: 'repo-1',
        name: 'improve-dashboard'
      })
    ).rejects.toThrow('Setup decision required for this repository')

    expect(addWorktreeMock).not.toHaveBeenCalled()
    expect(store.setWorktreeMeta).not.toHaveBeenCalled()
    expect(createSetupRunnerScriptMock).not.toHaveBeenCalled()
  })
})
