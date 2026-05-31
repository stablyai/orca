/* eslint-disable max-lines */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { lstat, mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

const {
  handleMock,
  removeHandlerMock,
  listWorktreesMock,
  parseWorktreeListMock,
  assertWorktreeCleanForRemovalMock,
  addWorktreeMock,
  addSparseWorktreeMock,
  removeWorktreeMock,
  forceDeleteLocalBranchMock,
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
  getEffectiveHooksFromConfigMock,
  getDefaultTabsLaunchMock,
  parseOrcaYamlMock,
  shouldRunSetupForCreateMock,
  buildPosixRunnerScriptMock,
  buildWindowsRunnerScriptMock,
  getSetupRunnerEnvVarsMock,
  runHookMock,
  hasHooksFileMock,
  loadHooksMock,
  computeWorktreePathMock,
  ensurePathWithinWorkspaceMock,
  gitExecFileAsyncMock,
  getSshGitProviderMock,
  getSshFilesystemProviderMock,
  getActiveMultiplexerMock
} = vi.hoisted(() => ({
  handleMock: vi.fn(),
  removeHandlerMock: vi.fn(),
  listWorktreesMock: vi.fn(),
  parseWorktreeListMock: vi.fn((output: string) =>
    output
      .trim()
      .split(/\n\s*\n/)
      .filter(Boolean)
      .map((block, index) => {
        const lines = block.split(/\r?\n/)
        const path = lines.find((line) => line.startsWith('worktree '))?.slice(9) ?? ''
        const branch = lines.find((line) => line.startsWith('branch '))?.slice(7) ?? ''
        return { path, branch, head: String(index), isBare: false, isMainWorktree: index === 0 }
      })
  ),
  assertWorktreeCleanForRemovalMock: vi.fn(),
  addWorktreeMock: vi.fn(),
  addSparseWorktreeMock: vi.fn(),
  removeWorktreeMock: vi.fn(),
  forceDeleteLocalBranchMock: vi.fn(),
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
  getEffectiveHooksFromConfigMock: vi.fn(),
  getDefaultTabsLaunchMock: vi.fn(),
  parseOrcaYamlMock: vi.fn(),
  shouldRunSetupForCreateMock: vi.fn(),
  buildPosixRunnerScriptMock: vi.fn(),
  buildWindowsRunnerScriptMock: vi.fn(),
  getSetupRunnerEnvVarsMock: vi.fn(),
  runHookMock: vi.fn(),
  hasHooksFileMock: vi.fn(),
  loadHooksMock: vi.fn(),
  computeWorktreePathMock: vi.fn(),
  ensurePathWithinWorkspaceMock: vi.fn(),
  gitExecFileAsyncMock: vi.fn(),
  getSshGitProviderMock: vi.fn(),
  getSshFilesystemProviderMock: vi.fn(),
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
  parseWorktreeList: parseWorktreeListMock,
  assertWorktreeCleanForRemoval: assertWorktreeCleanForRemovalMock,
  addWorktree: addWorktreeMock,
  addSparseWorktree: addSparseWorktreeMock,
  removeWorktree: removeWorktreeMock,
  forceDeleteLocalBranch: forceDeleteLocalBranchMock
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
  getSshGitProvider: getSshGitProviderMock,
  SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE:
    'Remote connection dropped. Click Reconnect on the SSH target before retrying.',
  requireSshGitProvider: (connectionId: string) => {
    const provider = getSshGitProviderMock(connectionId)
    if (!provider) {
      throw new Error(
        'Remote connection dropped. Click Reconnect on the SSH target before retrying.'
      )
    }
    return provider
  }
}))

vi.mock('../providers/ssh-filesystem-dispatch', () => ({
  getSshFilesystemProvider: getSshFilesystemProviderMock
}))

vi.mock('./ssh', () => ({
  getActiveMultiplexer: getActiveMultiplexerMock
}))

vi.mock('../hooks', () => ({
  buildPosixRunnerScript: buildPosixRunnerScriptMock,
  buildWindowsRunnerScript: buildWindowsRunnerScriptMock,
  createIssueCommandRunnerScript: createIssueCommandRunnerScriptMock,
  createSetupRunnerScript: createSetupRunnerScriptMock,
  getEffectiveHooks: getEffectiveHooksMock,
  getEffectiveHooksFromConfig: getEffectiveHooksFromConfigMock,
  getDefaultTabsLaunch: getDefaultTabsLaunchMock,
  getSetupRunnerEnvVars: getSetupRunnerEnvVarsMock,
  loadHooks: loadHooksMock,
  parseOrcaYaml: parseOrcaYamlMock,
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

const { advertisedUrlWatcherForgetWorktreeMock } = vi.hoisted(() => ({
  advertisedUrlWatcherForgetWorktreeMock: vi.fn()
}))

vi.mock('../ports/advertised-url-watcher', () => ({
  advertisedUrlWatcher: {
    forgetWorktree: advertisedUrlWatcherForgetWorktreeMock
  }
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
    getAllWorktreeMeta: vi.fn(),
    setWorktreeMeta: vi.fn(),
    removeWorktreeMeta: vi.fn(),
    getAllWorktreeLineage: vi.fn(),
    removeWorktreeLineage: vi.fn()
  }
  let runtimeStub: {
    resolveRemoteTrackingBase: ReturnType<typeof vi.fn>
    hasRemoteTrackingRef: ReturnType<typeof vi.fn>
    getOrStartRemoteTrackingBaseRefresh: ReturnType<typeof vi.fn>
    getOrStartRemoteFetch: ReturnType<typeof vi.fn>
    fetchRemoteWithCache: ReturnType<typeof vi.fn>
    emitWorktreeBaseStatus: ReturnType<typeof vi.fn>
    recordOptimisticReconcileToken: ReturnType<typeof vi.fn>
    reconcileWorktreeBaseStatus: ReturnType<typeof vi.fn>
    clearOptimisticReconcileToken: ReturnType<typeof vi.fn>
    resolveManagedMrBase: ReturnType<typeof vi.fn>
  }

  beforeEach(() => {
    for (const m of [
      handleMock,
      removeHandlerMock,
      listWorktreesMock,
      assertWorktreeCleanForRemovalMock,
      addWorktreeMock,
      addSparseWorktreeMock,
      removeWorktreeMock,
      forceDeleteLocalBranchMock,
      getGitUsernameMock,
      getDefaultBaseRefMock,
      getDefaultRemoteMock,
      getBranchConflictKindMock,
      getPRForBranchMock,
      getWorkItemMock,
      getPullRequestPushTargetMock,
      getEffectiveHooksMock,
      getEffectiveHooksFromConfigMock,
      getDefaultTabsLaunchMock,
      parseOrcaYamlMock,
      createIssueCommandRunnerScriptMock,
      createSetupRunnerScriptMock,
      buildPosixRunnerScriptMock,
      buildWindowsRunnerScriptMock,
      getSetupRunnerEnvVarsMock,
      shouldRunSetupForCreateMock,
      runHookMock,
      hasHooksFileMock,
      loadHooksMock,
      computeWorktreePathMock,
      ensurePathWithinWorkspaceMock,
      gitExecFileAsyncMock,
      getSshGitProviderMock,
      getSshFilesystemProviderMock,
      getActiveMultiplexerMock,
      mainWindow.webContents.send,
      store.getRepos,
      store.getRepo,
      store.getSparsePresets,
      store.getSettings,
      store.getWorktreeMeta,
      store.getAllWorktreeMeta,
      store.setWorktreeMeta,
      store.removeWorktreeMeta,
      store.getAllWorktreeLineage,
      store.removeWorktreeLineage,
      killAllProcessesForWorktreeMock,
      getLocalPtyProviderMock,
      deleteWorktreeHistoryDirMock,
      advertisedUrlWatcherForgetWorktreeMock
    ]) {
      m.mockReset()
    }
    killAllProcessesForWorktreeMock.mockResolvedValue({
      runtimeStopped: 0,
      providerStopped: 0,
      registryStopped: 0
    })
    assertWorktreeCleanForRemovalMock.mockResolvedValue(undefined)
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
    store.getAllWorktreeMeta.mockReturnValue({})
    store.setWorktreeMeta.mockReturnValue({})
    store.getAllWorktreeLineage.mockReturnValue({})
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
    getEffectiveHooksFromConfigMock.mockImplementation(() => getEffectiveHooksMock())
    getDefaultTabsLaunchMock.mockReturnValue(undefined)
    parseOrcaYamlMock.mockReturnValue(null)
    shouldRunSetupForCreateMock.mockReturnValue(false)
    buildPosixRunnerScriptMock.mockImplementation(
      (script: string) => `#!/usr/bin/env bash\nset -e\n${script.replace(/\r\n/g, '\n')}\n`
    )
    buildWindowsRunnerScriptMock.mockImplementation((script: string) => script)
    getSetupRunnerEnvVarsMock.mockImplementation(
      (repoArg: { path: string }, worktreePath: string) => ({
        ORCA_ROOT_PATH: repoArg.path,
        ORCA_WORKTREE_PATH: worktreePath,
        ORCA_WORKSPACE_NAME: worktreePath.split('/').at(-1) ?? '',
        CONDUCTOR_ROOT_PATH: repoArg.path,
        GHOSTX_ROOT_PATH: repoArg.path
      })
    )
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
    forceDeleteLocalBranchMock.mockResolvedValue(undefined)

    // Why: createLocalWorktree routes `git fetch` through
    // `runtime.fetchRemoteWithCache` (§3.3 Lifecycle). A minimal stub
    // keeps these tests focused on create-flow semantics; the full
    // cache behavior is covered by fetch-remote-cache.test.ts.
    runtimeStub = {
      resolveRemoteTrackingBase: vi.fn().mockResolvedValue(null),
      hasRemoteTrackingRef: vi.fn().mockResolvedValue(false),
      getOrStartRemoteTrackingBaseRefresh: vi.fn().mockResolvedValue({ ok: true }),
      getOrStartRemoteFetch: vi.fn().mockResolvedValue({ ok: true }),
      fetchRemoteWithCache: vi.fn().mockResolvedValue(undefined),
      emitWorktreeBaseStatus: vi.fn(),
      recordOptimisticReconcileToken: vi.fn().mockReturnValue('token-1'),
      reconcileWorktreeBaseStatus: vi.fn(),
      clearOptimisticReconcileToken: vi.fn(),
      resolveManagedMrBase: vi.fn().mockResolvedValue({ baseBranch: 'origin/mr-branch' })
    }
    registerWorktreeHandlers(mainWindow as never, store as never, runtimeStub as never)
  })

  it('clears the GitLab MR base handler before re-registering IPC handlers', () => {
    expect(removeHandlerMock).toHaveBeenCalledWith('worktrees:resolveMrBase')
    expect(handlers['worktrees:resolveMrBase']).toBeDefined()
  })

  function mockKnownFeatureWorktree(
    path = '/workspace/feature-wt',
    repoPath = '/workspace/repo'
  ): void {
    listWorktreesMock.mockResolvedValue([
      {
        path: repoPath,
        head: 'main',
        branch: 'main',
        isBare: false,
        isMainWorktree: true
      },
      {
        path,
        head: 'feature',
        branch: 'feature',
        isBare: false,
        isMainWorktree: false
      }
    ])
  }

  function makeWorktreeMeta(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      displayName: '',
      comment: '',
      linkedIssue: null,
      linkedPR: null,
      linkedLinearIssue: null,
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 0,
      ...overrides
    }
  }

  it('strips Orca provenance fields from renderer metadata updates', () => {
    store.setWorktreeMeta.mockImplementation((_worktreeId, meta) => meta)

    const result = handlers['worktrees:updateMeta'](null, {
      worktreeId: 'repo-1::/workspace/feature-wt',
      updates: {
        comment: 'keep me',
        isPinned: true,
        orcaCreatedAt: 123,
        orcaCreationSource: 'desktop',
        orcaCreationWorkspaceLayout: { path: '/workspace', nestWorkspaces: false }
      }
    })

    expect(store.setWorktreeMeta).toHaveBeenCalledWith('repo-1::/workspace/feature-wt', {
      comment: 'keep me',
      isPinned: true
    })
    expect(result).toEqual({ comment: 'keep me', isPinned: true })
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

  it('uses a repo-specific worktree base path when creating local worktrees', async () => {
    store.getRepo.mockReturnValue({
      id: 'repo-1',
      path: '/workspace/repo',
      displayName: 'repo',
      badgeColor: '#000',
      addedAt: 0,
      worktreeBaseRef: null,
      worktreeBasePath: '../worktrees'
    })
    listWorktreesMock.mockResolvedValue([
      {
        path: '../worktrees/feature',
        head: 'abc123',
        branch: 'feature',
        isBare: false,
        isMainWorktree: false
      }
    ])

    await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'feature'
    })

    expect(computeWorktreePathMock).toHaveBeenCalledWith('feature', '/workspace/repo', {
      nestWorkspaces: false,
      workspaceDir: '../worktrees'
    })
    expect(addWorktreeMock).toHaveBeenCalledWith(
      '/workspace/repo',
      '../worktrees/feature',
      'feature',
      'origin/main',
      false
    )
    expect(store.setWorktreeMeta).toHaveBeenCalledWith(
      'repo-1::../worktrees/feature',
      expect.objectContaining({
        orcaCreationWorkspaceLayout: { path: '../worktrees', nestWorkspaces: false }
      })
    )
  })

  it('uses branchNameOverride for the git branch while keeping the sanitized worktree path', async () => {
    listWorktreesMock.mockResolvedValue([
      {
        path: '/workspace/feature-something',
        head: 'abc123',
        branch: 'feature/something',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const result = await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'feature/something',
      branchNameOverride: 'feature/something'
    })

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['check-ref-format', '--branch', 'feature/something'],
      { cwd: '/workspace/repo' }
    )
    expect(addWorktreeMock).toHaveBeenCalledWith(
      '/workspace/repo',
      '/workspace/feature-something',
      'feature/something',
      'origin/main',
      false
    )
    expect(result).toEqual({
      worktree: expect.objectContaining({
        path: '/workspace/feature-something',
        branch: 'feature/something'
      })
    })
  })

  it('creates an additional workspace for folder-mode repos without git worktree add', async () => {
    const repo = {
      id: 'repo-folder',
      path: '/workspace/folder',
      displayName: 'folder',
      badgeColor: '#000',
      addedAt: 0,
      kind: 'folder' as const
    }
    store.getRepo.mockReturnValue(repo)
    store.setWorktreeMeta.mockImplementation((_worktreeId, meta) => ({
      displayName: '',
      comment: '',
      linkedIssue: null,
      linkedPR: null,
      linkedLinearIssue: null,
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 0,
      ...meta
    }))

    const result = (await handlers['worktrees:create'](null, {
      repoId: 'repo-folder',
      name: 'folder-session',
      createdWithAgent: 'codex'
    })) as { worktree: { id: string } }

    expect(addWorktreeMock).not.toHaveBeenCalled()
    expect(result.worktree).toEqual(
      expect.objectContaining({
        id: expect.stringMatching(/^repo-folder::\/workspace\/folder::workspace:[0-9a-f-]{36}$/),
        repoId: 'repo-folder',
        path: '/workspace/folder',
        displayName: 'folder-session',
        instanceId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        createdWithAgent: 'codex'
      })
    )
    expect(mainWindow.webContents.send).toHaveBeenCalledWith('worktrees:changed', {
      repoId: 'repo-folder'
    })
  })

  it('checks out a selected existing local branch exactly', async () => {
    listWorktreesMock
      .mockResolvedValueOnce([
        {
          path: '/workspace/repo',
          head: 'main',
          branch: 'refs/heads/main',
          isBare: false,
          isMainWorktree: true
        }
      ])
      .mockResolvedValueOnce([
        {
          path: '/workspace/repo',
          head: 'main',
          branch: 'refs/heads/main',
          isBare: false,
          isMainWorktree: true
        },
        {
          path: '/workspace/fix-bug-0',
          head: 'abc123',
          branch: 'refs/heads/fix/bug-0',
          isBare: false,
          isMainWorktree: false
        }
      ])

    const result = await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'fix/bug-0',
      baseBranch: 'fix/bug-0',
      branchNameOverride: 'fix/bug-0'
    })

    expect(getBranchConflictKindMock).not.toHaveBeenCalled()
    expect(addWorktreeMock).toHaveBeenCalledWith(
      '/workspace/repo',
      '/workspace/fix-bug-0',
      'fix/bug-0',
      'fix/bug-0',
      false,
      false,
      { checkoutExistingBranch: true }
    )
    expect(store.setWorktreeMeta).toHaveBeenCalledWith(
      'repo-1::/workspace/fix-bug-0',
      expect.objectContaining({ preserveBranchOnDelete: true })
    )
    expect(result).toEqual({
      worktree: expect.objectContaining({
        path: '/workspace/fix-bug-0',
        branch: 'refs/heads/fix/bug-0'
      })
    })
  })

  it('suffixes only the path when an existing local branch checkout path already exists', async () => {
    const mainWorktree = {
      path: '/workspace/repo',
      head: 'main',
      branch: 'refs/heads/main',
      isBare: false,
      isMainWorktree: true
    }
    computeWorktreePathMock.mockImplementation((sanitizedName: string) =>
      sanitizedName === 'fix-bug-0' ? process.cwd() : `/workspace/${sanitizedName}`
    )
    listWorktreesMock
      .mockResolvedValueOnce([mainWorktree])
      .mockResolvedValueOnce([mainWorktree])
      .mockResolvedValueOnce([
        mainWorktree,
        {
          path: '/workspace/fix-bug-0-2',
          head: 'abc123',
          branch: 'refs/heads/fix/bug-0',
          isBare: false,
          isMainWorktree: false
        }
      ])

    const result = await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'fix/bug-0',
      baseBranch: 'fix/bug-0',
      branchNameOverride: 'fix/bug-0'
    })

    expect(getBranchConflictKindMock).not.toHaveBeenCalled()
    expect(getPRForBranchMock).not.toHaveBeenCalled()
    expect(addWorktreeMock).toHaveBeenCalledWith(
      '/workspace/repo',
      '/workspace/fix-bug-0-2',
      'fix/bug-0',
      'fix/bug-0',
      false,
      false,
      { checkoutExistingBranch: true }
    )
    expect(result).toEqual({
      worktree: expect.objectContaining({
        path: '/workspace/fix-bug-0-2',
        branch: 'refs/heads/fix/bug-0'
      })
    })
  })

  it('does not suffix branchNameOverride when the requested branch collides', async () => {
    getBranchConflictKindMock.mockImplementation(async (_repoPath: string, branch: string) =>
      branch === 'feature/something' ? 'remote' : null
    )

    await expect(
      handlers['worktrees:create'](null, {
        repoId: 'repo-1',
        name: 'feature/something',
        branchNameOverride: 'feature/something'
      })
    ).rejects.toThrow(
      'Branch "feature/something" already exists on a remote. Pick a different worktree name.'
    )

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['check-ref-format', '--branch', 'feature/something'],
      { cwd: '/workspace/repo' }
    )
    expect(addWorktreeMock).not.toHaveBeenCalled()
  })

  it('allows a resolver-provided PR branch override to match its remote push target', async () => {
    getBranchConflictKindMock.mockImplementation(async (_repoPath: string, branch: string) =>
      branch === 'feature/fix' ? 'remote' : null
    )
    listWorktreesMock.mockResolvedValue([
      {
        path: '/workspace/fix-title',
        head: 'abc123',
        branch: 'refs/heads/feature/fix',
        isBare: false,
        isMainWorktree: false
      }
    ])
    store.setWorktreeMeta.mockImplementation((_worktreeId, meta) => meta)
    getPRForBranchMock.mockResolvedValueOnce({
      number: 42,
      title: 'Selected PR',
      state: 'open',
      url: 'https://example.com/pr/42',
      checksStatus: 'success',
      updatedAt: '2026-05-21T00:00:00Z',
      mergeable: 'UNKNOWN'
    })

    await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'fix-title',
      baseBranch: 'abc123',
      branchNameOverride: 'feature/fix',
      linkedPR: 42,
      pushTarget: { remoteName: 'origin', branchName: 'feature/fix' }
    })

    expect(addWorktreeMock).toHaveBeenCalledWith(
      '/workspace/repo',
      '/workspace/fix-title',
      'feature/fix',
      'abc123',
      false
    )
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['branch', '--set-upstream-to', 'origin/feature/fix', 'feature/fix'],
      { cwd: '/workspace/fix-title' }
    )
    expect(getPRForBranchMock).toHaveBeenCalledWith('/workspace/repo', 'feature/fix')
  })

  it('rejects a matching push target branch without selected PR metadata', async () => {
    getBranchConflictKindMock.mockImplementation(async (_repoPath: string, branch: string) =>
      branch === 'feature/fix' ? 'remote' : null
    )

    await expect(
      handlers['worktrees:create'](null, {
        repoId: 'repo-1',
        name: 'fix-title',
        baseBranch: 'abc123',
        branchNameOverride: 'feature/fix',
        pushTarget: { remoteName: 'origin', branchName: 'feature/fix' }
      })
    ).rejects.toThrow(
      'Branch "feature/fix" already exists on a remote. Pick a different worktree name.'
    )

    expect(addWorktreeMock).not.toHaveBeenCalled()
  })

  it('rejects a matching push target branch when selected PR metadata has no PR number', async () => {
    getBranchConflictKindMock.mockImplementation(async (_repoPath: string, branch: string) =>
      branch === 'feature/fix' ? 'remote' : null
    )

    await expect(
      handlers['worktrees:create'](null, {
        repoId: 'repo-1',
        name: 'fix-title',
        baseBranch: 'abc123',
        branchNameOverride: 'feature/fix',
        linkedPR: null,
        pushTarget: { remoteName: 'origin', branchName: 'feature/fix' }
      })
    ).rejects.toThrow(
      'Branch "feature/fix" already exists on a remote. Pick a different worktree name.'
    )

    expect(addWorktreeMock).not.toHaveBeenCalled()
  })

  it('rejects a matching push target branch when the existing PR is different', async () => {
    getBranchConflictKindMock.mockImplementation(async (_repoPath: string, branch: string) =>
      branch === 'feature/fix' ? 'remote' : null
    )
    getPRForBranchMock.mockResolvedValueOnce({
      number: 43,
      title: 'Different PR',
      state: 'open',
      url: 'https://example.com/pr/43',
      checksStatus: 'success',
      updatedAt: '2026-05-21T00:00:00Z',
      mergeable: 'UNKNOWN'
    })

    await expect(
      handlers['worktrees:create'](null, {
        repoId: 'repo-1',
        name: 'fix-title',
        baseBranch: 'abc123',
        branchNameOverride: 'feature/fix',
        linkedPR: 42,
        pushTarget: { remoteName: 'origin', branchName: 'feature/fix' }
      })
    ).rejects.toThrow('Branch "feature/fix" already has PR #43. Pick a different worktree name.')

    expect(getPRForBranchMock).toHaveBeenCalledWith('/workspace/repo', 'feature/fix')
    expect(addWorktreeMock).not.toHaveBeenCalled()
  })

  it('rejects a selected PR remote conflict when the PR lookup fails', async () => {
    getBranchConflictKindMock.mockImplementation(async (_repoPath: string, branch: string) =>
      branch === 'feature/fix' ? 'remote' : null
    )
    getPRForBranchMock.mockRejectedValueOnce(new Error('gh unavailable'))

    await expect(
      handlers['worktrees:create'](null, {
        repoId: 'repo-1',
        name: 'fix-title',
        baseBranch: 'abc123',
        branchNameOverride: 'feature/fix',
        linkedPR: 42,
        pushTarget: { remoteName: 'origin', branchName: 'feature/fix' }
      })
    ).rejects.toThrow(
      'Branch "feature/fix" already exists on a remote. Pick a different worktree name.'
    )

    expect(getPRForBranchMock).toHaveBeenCalledWith('/workspace/repo', 'feature/fix')
    expect(addWorktreeMock).not.toHaveBeenCalled()
  })

  it('checks out an unused existing PR branch only when it is at the resolved head SHA', async () => {
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'rev-parse' && args.includes('refs/heads/feature/fix^{commit}')) {
        return { stdout: 'abc123\n', stderr: '' }
      }
      if (args[0] === 'rev-parse' && args.includes('abc123^{commit}')) {
        return { stdout: 'abc123\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })
    listWorktreesMock
      .mockResolvedValueOnce([
        {
          path: '/workspace/repo',
          head: 'main',
          branch: 'refs/heads/main',
          isBare: false,
          isMainWorktree: true
        }
      ])
      .mockResolvedValueOnce([
        {
          path: '/workspace/repo',
          head: 'main',
          branch: 'refs/heads/main',
          isBare: false,
          isMainWorktree: true
        },
        {
          path: '/workspace/fix-title',
          head: 'abc123',
          branch: 'refs/heads/feature/fix',
          isBare: false,
          isMainWorktree: false
        }
      ])

    await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'fix-title',
      baseBranch: 'abc123',
      branchNameOverride: 'feature/fix'
    })

    expect(getBranchConflictKindMock).not.toHaveBeenCalled()
    expect(addWorktreeMock).toHaveBeenCalledWith(
      '/workspace/repo',
      '/workspace/fix-title',
      'feature/fix',
      'abc123',
      false,
      false,
      { checkoutExistingBranch: true }
    )
  })

  it('rejects an existing PR branch when its tip differs from the resolved head SHA', async () => {
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'rev-parse' && args.includes('refs/heads/feature/fix^{commit}')) {
        return { stdout: 'old123\n', stderr: '' }
      }
      if (args[0] === 'rev-parse' && args.includes('abc123^{commit}')) {
        return { stdout: 'abc123\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })
    getBranchConflictKindMock.mockResolvedValueOnce('local')

    await expect(
      handlers['worktrees:create'](null, {
        repoId: 'repo-1',
        name: 'fix-title',
        baseBranch: 'abc123',
        branchNameOverride: 'feature/fix'
      })
    ).rejects.toThrow(
      'Branch "feature/fix" already exists locally. Pick a different worktree name.'
    )

    expect(addWorktreeMock).not.toHaveBeenCalled()
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
      linkedPR: 456,
      linkedLinearIssue: 'ENG-123',
      manualOrder: 123_456
    })

    expect(store.setWorktreeMeta).toHaveBeenCalledWith(
      'repo-1::/workspace/improve-dashboard',
      expect.objectContaining({
        linkedIssue: 123,
        linkedPR: 456,
        linkedLinearIssue: 'ENG-123',
        manualOrder: 123_456
      })
    )
    expect(result).toEqual({
      worktree: expect.objectContaining({
        linkedIssue: 123,
        linkedPR: 456,
        linkedLinearIssue: 'ENG-123',
        manualOrder: 123_456
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
        pushTarget: expect.objectContaining({
          remoteName: 'pr-prateek-orca',
          branchName: 'prateek/fix-sidebar-agents-toggle',
          remoteUrl: 'git@github.com:prateek/orca.git',
          remoteCreated: true
        })
      })
    )
  })

  it('keeps the Orca-created marker when a new worktree reuses an Orca-created fork remote', async () => {
    listWorktreesMock.mockResolvedValue([
      {
        path: '/workspace/improve-dashboard',
        head: 'abc123',
        branch: 'refs/heads/improve-dashboard',
        isBare: false,
        isMainWorktree: false
      }
    ])
    const existingPushTarget = {
      remoteName: 'pr-contributor-orca',
      branchName: 'contributor/previous-fix',
      remoteUrl: 'https://github.com/contributor/orca.git',
      remoteCreated: true
    }
    store.getAllWorktreeMeta.mockReturnValue({
      'repo-1::/workspace/previous-fix': makeWorktreeMeta({ pushTarget: existingPushTarget })
    })
    store.setWorktreeMeta.mockImplementation((_worktreeId, meta) => meta)
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'remote' && args.length === 1) {
        return { stdout: 'pr-contributor-orca\n', stderr: '' }
      }
      if (args[0] === 'remote' && args[1] === 'get-url') {
        return { stdout: 'https://github.com/contributor/orca.git\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })

    await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'improve-dashboard',
      pushTarget: {
        remoteName: 'pr-contributor-orca',
        branchName: 'contributor/new-fix',
        remoteUrl: 'https://github.com/contributor/orca.git'
      }
    })

    expect(gitExecFileAsyncMock).not.toHaveBeenCalledWith(
      ['remote', 'add', expect.any(String), expect.any(String)],
      expect.any(Object)
    )
    expect(store.setWorktreeMeta).toHaveBeenCalledWith(
      'repo-1::/workspace/improve-dashboard',
      expect.objectContaining({
        pushTarget: expect.objectContaining({
          remoteName: 'pr-contributor-orca',
          branchName: 'contributor/new-fix',
          remoteUrl: 'https://github.com/contributor/orca.git',
          remoteCreated: true
        })
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

  it('returns the same-repo PR head SHA and exact branch override when resolving a PR base', async () => {
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'rev-parse') {
        return { stdout: 'def456\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })

    const result = await handlers['worktrees:resolvePrBase'](null, {
      repoId: 'repo-1',
      prNumber: 42,
      headRefName: 'feature/add-feature',
      isCrossRepository: false
    })

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      [
        'fetch',
        'origin',
        '+refs/heads/feature/add-feature:refs/remotes/origin/feature/add-feature'
      ],
      { cwd: '/workspace/repo' }
    )
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['rev-parse', '--verify', 'origin/feature/add-feature'],
      { cwd: '/workspace/repo' }
    )
    expect(result).toEqual({
      baseBranch: 'def456',
      headSha: 'def456',
      branchNameOverride: 'feature/add-feature',
      pushTarget: { remoteName: 'origin', branchName: 'feature/add-feature' }
    })
  })

  it('resolves a fork PR base even when push-target discovery fails', async () => {
    getPullRequestPushTargetMock.mockRejectedValueOnce(new Error('lookup failed'))
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'rev-parse') {
        return { stdout: 'abc123\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })

    const result = await handlers['worktrees:resolvePrBase'](null, {
      repoId: 'repo-1',
      prNumber: 1849,
      headRefName: 'feat/onboarding-model-choice-782',
      isCrossRepository: true
    })

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(['fetch', 'origin', 'refs/pull/1849/head'], {
      cwd: '/workspace/repo'
    })
    expect(result).toEqual({ baseBranch: 'abc123' })
  })

  it('falls back to refs/pull/<N>/head when branch fetch fails for a PR', async () => {
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (
        args[0] === 'fetch' &&
        args[2] ===
          '+refs/heads/feat/onboarding-model-choice-782:refs/remotes/origin/feat/onboarding-model-choice-782'
      ) {
        throw new Error(
          'fatal: could not find remote ref refs/heads/feat/onboarding-model-choice-782'
        )
      }
      if (args[0] === 'rev-parse') {
        return { stdout: 'abc123\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })

    const result = await handlers['worktrees:resolvePrBase'](null, {
      repoId: 'repo-1',
      prNumber: 1849,
      headRefName: 'feat/onboarding-model-choice-782'
    })

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      [
        'fetch',
        'origin',
        '+refs/heads/feat/onboarding-model-choice-782:refs/remotes/origin/feat/onboarding-model-choice-782'
      ],
      { cwd: '/workspace/repo' }
    )
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(['fetch', 'origin', 'refs/pull/1849/head'], {
      cwd: '/workspace/repo'
    })
    expect(result).toEqual({ baseBranch: 'abc123' })
  })

  it('does not fall back to refs/pull/<N>/head when branch fetch hits a network failure', async () => {
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (
        args[0] === 'fetch' &&
        args[2] ===
          '+refs/heads/feat/onboarding-model-choice-782:refs/remotes/origin/feat/onboarding-model-choice-782'
      ) {
        throw new Error('fatal: unable to access repo: Could not resolve host: github.com')
      }
      return { stdout: '', stderr: '' }
    })

    const result = await handlers['worktrees:resolvePrBase'](null, {
      repoId: 'repo-1',
      prNumber: 1849,
      headRefName: 'feat/onboarding-model-choice-782'
    })

    expect(gitExecFileAsyncMock).not.toHaveBeenCalledWith(
      ['fetch', 'origin', 'refs/pull/1849/head'],
      expect.anything()
    )
    expect(result).toEqual({
      error:
        'Failed to fetch origin/feat/onboarding-model-choice-782: fatal: unable to access repo: Could not resolve host: github.com'
    })
  })

  it('delegates GitLab MR base resolution through the runtime implementation', async () => {
    runtimeStub.resolveManagedMrBase.mockResolvedValueOnce({
      baseBranch: 'fork-mr-sha',
      pushTarget: { remoteName: 'origin', branchName: 'feature/mr' }
    })

    const result = await handlers['worktrees:resolveMrBase'](null, {
      repoId: 'repo-1',
      mrIid: 42,
      sourceBranch: 'feature/mr',
      isCrossRepository: true
    })

    expect(runtimeStub.resolveManagedMrBase).toHaveBeenCalledWith({
      repoSelector: 'id:repo-1',
      mrIid: 42,
      sourceBranch: 'feature/mr',
      isCrossRepository: true
    })
    expect(result).toEqual({
      baseBranch: 'fork-mr-sha',
      pushTarget: { remoteName: 'origin', branchName: 'feature/mr' }
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
      exec: vi.fn().mockImplementation(async (args: string[]) => {
        if (args[0] === 'remote') {
          return { stdout: 'origin\n', stderr: '' }
        }
        return { stdout: '', stderr: '' }
      }),
      fetchRemoteTrackingRef: vi.fn().mockResolvedValue(undefined),
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
      createdWithAgent: 'codex',
      linkedLinearIssue: 'ENG-123',
      manualOrder: 123_456
    })

    expect(store.setWorktreeMeta).toHaveBeenCalledWith(
      'repo-ssh::/remote/improve-dashboard',
      expect.objectContaining({
        linkedIssue: 123,
        linkedPR: 456,
        createdWithAgent: 'codex',
        linkedLinearIssue: 'ENG-123',
        manualOrder: 123_456
      })
    )
    expect(result).toEqual({
      worktree: expect.objectContaining({
        linkedIssue: 123,
        linkedPR: 456,
        createdWithAgent: 'codex',
        linkedLinearIssue: 'ENG-123',
        manualOrder: 123_456
      })
    })
  })

  it('returns SSH local base refresh skip status when the owning worktree is dirty', async () => {
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
      exec: vi.fn().mockImplementation(async (args: string[]) => {
        if (args[0] === 'remote') {
          return { stdout: 'origin\n', stderr: '' }
        }
        if (args[0] === 'worktree' && args[1] === 'list') {
          return {
            stdout: 'worktree /remote/repo\nHEAD abc123\nbranch refs/heads/main\n',
            stderr: ''
          }
        }
        if (args[0] === 'status') {
          return { stdout: ' M package.json\n', stderr: '' }
        }
        return { stdout: '', stderr: '' }
      }),
      fetchRemoteTrackingRef: vi.fn().mockResolvedValue(undefined),
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
    store.getSettings.mockReturnValue({
      branchPrefix: 'none',
      nestWorkspaces: false,
      refreshLocalBaseRefOnWorktreeCreate: true,
      workspaceDir: '/workspace'
    })
    store.getRepos.mockReturnValue([repo])
    store.getRepo.mockReturnValue(repo)
    getSshGitProviderMock.mockReturnValue(provider)
    getActiveMultiplexerMock.mockReturnValue(mux)
    store.setWorktreeMeta.mockImplementation((_worktreeId, meta) => meta)

    const result = await handlers['worktrees:create'](null, {
      repoId: 'repo-ssh',
      name: 'improve-dashboard'
    })

    expect(provider.exec).toHaveBeenCalledWith(
      ['merge-base', '--is-ancestor', 'main', 'refs/remotes/origin/main'],
      '/remote/repo'
    )
    expect(provider.exec).toHaveBeenCalledWith(['worktree', 'list', '--porcelain'], '/remote/repo')
    expect(provider.exec).toHaveBeenCalledWith(
      ['status', '--porcelain', '--untracked-files=no'],
      '/remote/repo'
    )
    expect(provider.exec).not.toHaveBeenCalledWith(
      ['reset', '--hard', 'refs/remotes/origin/main'],
      expect.any(String)
    )
    expect(result).toEqual(
      expect.objectContaining({
        localBaseRefRefresh: {
          status: 'skipped_dirty_worktree',
          baseRef: 'origin/main',
          localBranch: 'main',
          ownerWorktreePath: '/remote/repo'
        }
      })
    )
  })

  it('reads remote orca.yaml and returns a setup launch payload during SSH create', async () => {
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
      exec: vi.fn().mockImplementation(async (args: string[]) => {
        if (args[0] === 'remote') {
          return { stdout: 'origin\n', stderr: '' }
        }
        if (args[0] === 'rev-parse') {
          return {
            stdout: '/remote/repo/.git/worktrees/improve-dashboard/orca/setup-runner.sh\n',
            stderr: ''
          }
        }
        return { stdout: '', stderr: '' }
      }),
      fetchRemoteTrackingRef: vi.fn().mockResolvedValue(undefined),
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
    const fsProvider = {
      readFile: vi.fn().mockResolvedValue({
        content: 'scripts:\n  setup: pnpm install\n',
        isBinary: false
      }),
      createDir: vi.fn().mockResolvedValue(undefined),
      writeFile: vi.fn().mockResolvedValue(undefined)
    }
    const mux = {
      request: vi.fn().mockResolvedValue(undefined),
      notify: vi.fn()
    }
    store.getRepos.mockReturnValue([repo])
    store.getRepo.mockReturnValue(repo)
    getSshGitProviderMock.mockReturnValue(provider)
    getSshFilesystemProviderMock.mockReturnValue(fsProvider)
    getActiveMultiplexerMock.mockReturnValue(mux)
    store.setWorktreeMeta.mockImplementation((_worktreeId, meta) => meta)
    parseOrcaYamlMock.mockReturnValue({ scripts: { setup: 'pnpm install' } })
    getEffectiveHooksFromConfigMock.mockReturnValue({ scripts: { setup: 'pnpm install' } })
    shouldRunSetupForCreateMock.mockReturnValue(true)

    const result = await handlers['worktrees:create'](null, {
      repoId: 'repo-ssh',
      name: 'improve-dashboard',
      setupDecision: 'run'
    })

    expect(fsProvider.readFile).toHaveBeenCalledWith('/remote/repo/orca.yaml')
    expect(fsProvider.readFile).toHaveBeenCalledWith('/remote/improve-dashboard/orca.yaml')
    expect(provider.exec).toHaveBeenCalledWith(
      ['rev-parse', '--git-path', 'orca/setup-runner.sh'],
      '/remote/improve-dashboard'
    )
    expect(fsProvider.createDir).toHaveBeenCalledWith(
      '/remote/repo/.git/worktrees/improve-dashboard/orca'
    )
    expect(fsProvider.writeFile).toHaveBeenCalledWith(
      '/remote/repo/.git/worktrees/improve-dashboard/orca/setup-runner.sh',
      '#!/usr/bin/env bash\nset -e\npnpm install\n'
    )
    expect(result).toEqual(
      expect.objectContaining({
        setup: {
          runnerScriptPath: '/remote/repo/.git/worktrees/improve-dashboard/orca/setup-runner.sh',
          envVars: expect.objectContaining({
            ORCA_ROOT_PATH: '/remote/repo',
            ORCA_WORKTREE_PATH: '/remote/improve-dashboard'
          })
        }
      })
    )
  })

  it('creates sparse checkout metadata and remote sparse config for SSH worktrees', async () => {
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
      exec: vi.fn().mockImplementation(async (args: string[]) => {
        if (args[0] === 'remote') {
          return { stdout: 'origin\n', stderr: '' }
        }
        return { stdout: '', stderr: '' }
      }),
      fetchRemoteTrackingRef: vi.fn().mockResolvedValue(undefined),
      addWorktree: vi.fn().mockResolvedValue(undefined),
      removeWorktree: vi.fn().mockResolvedValue(undefined),
      listWorktrees: vi.fn().mockResolvedValue([
        {
          path: '/remote/sparse-dashboard',
          head: 'abc123',
          branch: 'refs/heads/sparse-dashboard',
          isBare: false,
          isSparse: true,
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
    store.getSparsePresets.mockReturnValue([
      {
        id: 'preset-1',
        repoId: 'repo-ssh',
        name: 'App',
        directories: ['apps/mobile', 'packages/shared'],
        createdAt: 1,
        updatedAt: 1
      }
    ])
    getSshGitProviderMock.mockReturnValue(provider)
    getActiveMultiplexerMock.mockReturnValue(mux)
    store.setWorktreeMeta.mockImplementation((_worktreeId, meta) => meta)

    const result = await handlers['worktrees:create'](null, {
      repoId: 'repo-ssh',
      name: 'sparse-dashboard',
      sparseCheckout: {
        directories: [' apps/mobile ', 'packages/shared', 'apps/mobile'],
        presetId: 'preset-1'
      }
    })

    expect(provider.addWorktree).toHaveBeenCalledWith(
      '/remote/repo',
      'sparse-dashboard',
      '/remote/sparse-dashboard',
      { base: 'origin/main', noCheckout: true }
    )
    expect(provider.exec).toHaveBeenCalledWith(
      ['sparse-checkout', 'init', '--cone'],
      '/remote/sparse-dashboard'
    )
    expect(provider.exec).toHaveBeenCalledWith(
      ['sparse-checkout', 'set', '--', 'apps/mobile', 'packages/shared'],
      '/remote/sparse-dashboard'
    )
    expect(provider.exec).toHaveBeenCalledWith(
      ['checkout', 'sparse-dashboard'],
      '/remote/sparse-dashboard'
    )
    expect(store.setWorktreeMeta).toHaveBeenCalledWith(
      'repo-ssh::/remote/sparse-dashboard',
      expect.objectContaining({
        sparseDirectories: ['apps/mobile', 'packages/shared'],
        sparseBaseRef: 'origin/main',
        sparsePresetId: 'preset-1'
      })
    )
    expect(result).toEqual({
      worktree: expect.objectContaining({
        isSparse: true,
        sparseDirectories: ['apps/mobile', 'packages/shared'],
        sparseBaseRef: 'origin/main',
        sparsePresetId: 'preset-1'
      })
    })
  })

  it('suffixes only the SSH worktree path when an exact PR branch checkout path exists', async () => {
    const repo = {
      id: 'repo-ssh',
      path: '/remote/repo',
      displayName: 'ssh',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'conn-1',
      worktreeBaseRef: 'abc123'
    }
    const provider = {
      exec: vi.fn().mockImplementation(async (args: string[]) => {
        if (args[0] === 'remote') {
          return { stdout: 'origin\n', stderr: '' }
        }
        if (args[0] === 'rev-parse' && args.includes('refs/heads/feature/fix^{commit}')) {
          return { stdout: 'abc123\n', stderr: '' }
        }
        if (args[0] === 'rev-parse' && args.includes('abc123^{commit}')) {
          return { stdout: 'abc123\n', stderr: '' }
        }
        return { stdout: '', stderr: '' }
      }),
      fetchRemoteTrackingRef: vi.fn().mockResolvedValue(undefined),
      addWorktree: vi.fn().mockResolvedValue(undefined),
      removeWorktree: vi.fn().mockResolvedValue(undefined),
      listWorktrees: vi
        .fn()
        .mockResolvedValueOnce([
          {
            path: '/remote/repo',
            head: 'main',
            branch: 'refs/heads/main',
            isBare: false,
            isMainWorktree: true
          }
        ])
        .mockResolvedValueOnce([
          {
            path: '/remote/fix-title-2',
            head: 'abc123',
            branch: 'refs/heads/feature/fix',
            isBare: false,
            isMainWorktree: false
          }
        ])
    }
    const fsProvider = {
      stat: vi.fn().mockImplementation(async (pathValue: string) => {
        if (pathValue === '/remote/fix-title') {
          return { size: 0, type: 'directory', mtime: 0 }
        }
        const error = new Error('missing') as Error & { code: string }
        error.code = 'ENOENT'
        throw error
      }),
      readFile: vi.fn().mockRejectedValue(new Error('missing'))
    }
    const mux = {
      request: vi.fn().mockResolvedValue(undefined),
      notify: vi.fn()
    }
    store.getRepos.mockReturnValue([repo])
    store.getRepo.mockReturnValue(repo)
    getSshGitProviderMock.mockReturnValue(provider)
    getSshFilesystemProviderMock.mockReturnValue(fsProvider)
    getActiveMultiplexerMock.mockReturnValue(mux)

    await handlers['worktrees:create'](null, {
      repoId: 'repo-ssh',
      name: 'fix-title',
      baseBranch: 'abc123',
      branchNameOverride: 'feature/fix'
    })

    expect(provider.addWorktree).toHaveBeenCalledWith(
      '/remote/repo',
      'feature/fix',
      '/remote/fix-title-2',
      { checkoutExistingBranch: true }
    )
    expect(mux.request).toHaveBeenCalledWith('session.registerRoot', {
      rootPath: '/remote/fix-title-2'
    })
  })

  it('blocks SSH worktree creation when the requested branch already exists on a remote', async () => {
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
      exec: vi.fn().mockImplementation(async (args: string[]) => {
        if (args[0] === 'remote') {
          return { stdout: 'origin\n', stderr: '' }
        }
        if (args[0] === 'branch' && args.includes('feature/something')) {
          return { stdout: '', stderr: '' }
        }
        if (args[0] === 'for-each-ref') {
          return { stdout: 'refs/remotes/origin/feature/something\n', stderr: '' }
        }
        if (args[0] === 'rev-parse' && args.includes('refs/heads/feature/something^{commit}')) {
          throw new Error('missing local branch')
        }
        return { stdout: '', stderr: '' }
      }),
      fetchRemoteTrackingRef: vi.fn().mockResolvedValue(undefined),
      addWorktree: vi.fn().mockResolvedValue(undefined),
      removeWorktree: vi.fn().mockResolvedValue(undefined),
      listWorktrees: vi.fn().mockResolvedValue([
        {
          path: '/remote/feature-something',
          head: 'abc123',
          branch: 'refs/heads/feature/something',
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

    await expect(
      handlers['worktrees:create'](null, {
        repoId: 'repo-ssh',
        name: 'feature-something',
        branchNameOverride: 'feature/something'
      })
    ).rejects.toThrow('Branch "feature/something" already exists on a remote.')

    expect(provider.addWorktree).not.toHaveBeenCalled()
  })

  it('blocks SSH worktree creation when a slashed remote owns the requested branch', async () => {
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
      exec: vi.fn().mockImplementation(async (args: string[]) => {
        if (args[0] === 'remote') {
          return { stdout: 'origin\nfoo/bar\n', stderr: '' }
        }
        if (args[0] === 'for-each-ref') {
          return { stdout: 'refs/remotes/foo/bar/feature/something\n', stderr: '' }
        }
        if (args[0] === 'rev-parse' && args.includes('refs/heads/feature/something^{commit}')) {
          throw new Error('missing local branch')
        }
        return { stdout: '', stderr: '' }
      }),
      fetchRemoteTrackingRef: vi.fn().mockResolvedValue(undefined),
      addWorktree: vi.fn().mockResolvedValue(undefined),
      removeWorktree: vi.fn().mockResolvedValue(undefined),
      listWorktrees: vi.fn().mockResolvedValue([])
    }
    const mux = {
      request: vi.fn().mockResolvedValue(undefined),
      notify: vi.fn()
    }
    store.getRepos.mockReturnValue([repo])
    store.getRepo.mockReturnValue(repo)
    getSshGitProviderMock.mockReturnValue(provider)
    getActiveMultiplexerMock.mockReturnValue(mux)

    await expect(
      handlers['worktrees:create'](null, {
        repoId: 'repo-ssh',
        name: 'feature-something',
        branchNameOverride: 'feature/something'
      })
    ).rejects.toThrow('Branch "feature/something" already exists on a remote.')

    expect(provider.addWorktree).not.toHaveBeenCalled()
  })

  it('unsets SSH branch base config before removing a sparse worktree after setup failure', async () => {
    const repo = {
      id: 'repo-ssh',
      path: '/remote/repo',
      displayName: 'ssh',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'conn-1',
      worktreeBaseRef: 'origin/main'
    }
    const setupError = new Error('sparse init failed')
    const provider = {
      exec: vi.fn().mockImplementation(async (args: string[]) => {
        if (args[0] === 'remote') {
          return { stdout: 'origin\n', stderr: '' }
        }
        if (args[0] === 'sparse-checkout' && args[1] === 'init') {
          throw setupError
        }
        return { stdout: '', stderr: '' }
      }),
      fetchRemoteTrackingRef: vi.fn().mockResolvedValue(undefined),
      addWorktree: vi.fn().mockResolvedValue(undefined),
      removeWorktree: vi.fn().mockResolvedValue(undefined),
      listWorktrees: vi.fn()
    }
    const mux = {
      request: vi.fn().mockResolvedValue(undefined),
      notify: vi.fn()
    }
    store.getRepos.mockReturnValue([repo])
    store.getRepo.mockReturnValue(repo)
    store.getSparsePresets.mockReturnValue([])
    getSshGitProviderMock.mockReturnValue(provider)
    getActiveMultiplexerMock.mockReturnValue(mux)

    await expect(
      handlers['worktrees:create'](null, {
        repoId: 'repo-ssh',
        name: 'sparse-dashboard',
        sparseCheckout: {
          directories: ['apps/mobile']
        }
      })
    ).rejects.toThrow('sparse init failed')

    expect(provider.exec).toHaveBeenCalledWith(
      ['config', '--local', '--unset-all', 'branch.sparse-dashboard.base'],
      '/remote/sparse-dashboard'
    )
    expect(provider.removeWorktree).toHaveBeenCalledWith('/remote/sparse-dashboard', true, {
      deleteBranch: true,
      forceBranchDelete: true
    })
  })

  it('does not create an SSH worktree when remote-tracking base refresh fails', async () => {
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
      exec: vi.fn().mockImplementation(async (args: string[]) => {
        if (args[0] === 'remote') {
          return { stdout: 'origin\n', stderr: '' }
        }
        if (args[0] === 'fetch') {
          throw new Error('network unavailable')
        }
        return { stdout: '', stderr: '' }
      }),
      fetchRemoteTrackingRef: vi.fn().mockRejectedValue(new Error('network unavailable')),
      addWorktree: vi.fn(),
      listWorktrees: vi.fn()
    }
    const mux = {
      request: vi.fn().mockResolvedValue(undefined),
      notify: vi.fn()
    }
    store.getRepos.mockReturnValue([repo])
    store.getRepo.mockReturnValue(repo)
    getSshGitProviderMock.mockReturnValue(provider)
    getActiveMultiplexerMock.mockReturnValue(mux)

    await expect(
      handlers['worktrees:create'](null, {
        repoId: 'repo-ssh',
        name: 'improve-dashboard'
      })
    ).rejects.toThrow(
      'Could not refresh base ref "origin/main" from "origin". Check your network and try again.'
    )

    expect(provider.addWorktree).not.toHaveBeenCalled()
    expect(provider.fetchRemoteTrackingRef).toHaveBeenCalledWith(
      '/remote/repo',
      'origin',
      'main',
      'refs/remotes/origin/main'
    )
  })

  it('prunes stale child lineage after a successful SSH worktree scan proves the child is missing', async () => {
    const repo = {
      id: 'repo-ssh',
      path: '/remote/repo',
      displayName: 'ssh',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'conn-1'
    }
    const provider = {
      listWorktrees: vi.fn().mockResolvedValue([
        {
          path: '/remote/live',
          head: 'abc123',
          branch: 'refs/heads/live',
          isBare: false,
          isMainWorktree: false
        },
        {
          path: '/remote/live-child',
          head: 'def456',
          branch: 'refs/heads/live-child',
          isBare: false,
          isMainWorktree: false
        }
      ])
    }
    store.getRepos.mockReturnValue([repo])
    store.getRepo.mockReturnValue(repo)
    getSshGitProviderMock.mockReturnValue(provider)
    store.getAllWorktreeLineage.mockReturnValue({
      'repo-ssh::/remote/missing-child': {
        parentWorktreeId: 'repo-ssh::/remote/live'
      },
      'repo-ssh::/remote/live-child': {
        parentWorktreeId: 'repo-ssh::/remote/missing-parent',
        parentWorktreeInstanceId: 'old-parent-instance'
      },
      'repo-ssh::/remote/live': {
        parentWorktreeId: 'other-repo::/elsewhere'
      }
    })
    store.getWorktreeMeta.mockImplementation((worktreeId: string) =>
      worktreeId === 'repo-ssh::/remote/missing-parent'
        ? { instanceId: 'old-parent-instance' }
        : undefined
    )

    await handlers['worktrees:list'](null, { repoId: 'repo-ssh' })

    expect(store.removeWorktreeLineage).toHaveBeenCalledWith('repo-ssh::/remote/missing-child')
    expect(store.removeWorktreeLineage).not.toHaveBeenCalledWith('repo-ssh::/remote/live-child')
    expect(store.removeWorktreeLineage).not.toHaveBeenCalledWith('repo-ssh::/remote/live')
    expect(store.setWorktreeMeta).toHaveBeenCalledWith(
      'repo-ssh::/remote/missing-parent',
      expect.objectContaining({ instanceId: expect.any(String) })
    )
  })

  it('does not repeatedly rotate already-invalid missing parent metadata', async () => {
    const repo = {
      id: 'repo-ssh',
      path: '/remote/repo',
      displayName: 'ssh',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'conn-1'
    }
    const provider = {
      listWorktrees: vi.fn().mockResolvedValue([
        {
          path: '/remote/live-child',
          head: 'def456',
          branch: 'refs/heads/live-child',
          isBare: false,
          isMainWorktree: false
        }
      ])
    }
    store.getRepos.mockReturnValue([repo])
    store.getRepo.mockReturnValue(repo)
    getSshGitProviderMock.mockReturnValue(provider)
    store.getAllWorktreeLineage.mockReturnValue({
      'repo-ssh::/remote/live-child': {
        parentWorktreeId: 'repo-ssh::/remote/missing-parent',
        parentWorktreeInstanceId: 'old-parent-instance'
      }
    })
    store.getWorktreeMeta.mockReturnValue({ instanceId: 'rotated-parent-instance' })

    await handlers['worktrees:list'](null, { repoId: 'repo-ssh' })

    expect(store.setWorktreeMeta).not.toHaveBeenCalledWith(
      'repo-ssh::/remote/missing-parent',
      expect.objectContaining({ instanceId: expect.any(String) })
    )
  })

  it('awaits a cold refresh before creating from an existing remote-tracking base', async () => {
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
    runtimeStub.getOrStartRemoteTrackingBaseRefresh.mockReturnValue(pendingFetch)
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

    const earlyResult = await Promise.race([
      createPromise.then(() => 'resolved'),
      new Promise((resolve) => setTimeout(() => resolve('pending'), 0))
    ])
    expect(earlyResult).toBe('pending')
    expect(addWorktreeMock).not.toHaveBeenCalled()

    expect(runtimeStub.getOrStartRemoteTrackingBaseRefresh).toHaveBeenCalledWith(
      '/workspace/repo',
      remoteBase
    )
    expect(runtimeStub.fetchRemoteWithCache).not.toHaveBeenCalled()
    resolveFetch()
    const result = await createPromise
    expect(addWorktreeMock).toHaveBeenCalled()
    expect(result).toEqual(
      expect.objectContaining({
        worktree: expect.objectContaining({ id: 'repo-1::/workspace/improve-dashboard' })
      })
    )
  })

  it('does not create when the pre-create remote-tracking refresh fails', async () => {
    const remoteBase = {
      remote: 'origin',
      branch: 'main',
      ref: 'refs/remotes/origin/main',
      base: 'origin/main'
    }
    runtimeStub.resolveRemoteTrackingBase.mockResolvedValue(remoteBase)
    runtimeStub.hasRemoteTrackingRef.mockResolvedValue(true)
    runtimeStub.getOrStartRemoteTrackingBaseRefresh.mockResolvedValue({
      ok: false,
      errorKind: 'git_error'
    })

    await expect(
      handlers['worktrees:create'](null, {
        repoId: 'repo-1',
        name: 'improve-dashboard'
      })
    ).rejects.toThrow(
      'Could not refresh base ref "origin/main" from "origin". Check your network and try again.'
    )

    expect(addWorktreeMock).not.toHaveBeenCalled()
  })

  it('refreshes before create even when the remote-tracking base was recently fetched', async () => {
    const remoteBase = {
      remote: 'origin',
      branch: 'main',
      ref: 'refs/remotes/origin/main',
      base: 'origin/main'
    }
    runtimeStub.resolveRemoteTrackingBase.mockResolvedValue(remoteBase)
    runtimeStub.hasRemoteTrackingRef.mockResolvedValue(true)
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

    const result = await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'improve-dashboard'
    })

    expect(runtimeStub.getOrStartRemoteTrackingBaseRefresh).toHaveBeenCalledWith(
      '/workspace/repo',
      remoteBase
    )
    expect(result).toEqual(
      expect.objectContaining({
        worktree: expect.objectContaining({ id: 'repo-1::/workspace/improve-dashboard' })
      })
    )
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

  it('returns reconstructed rows when an SSH provider is unavailable', async () => {
    const repo = {
      id: 'repo-ssh',
      path: '/remote/repo',
      displayName: 'SSH Repo',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'conn-1'
    }
    store.getRepo.mockReturnValue(repo)
    store.getAllWorktreeMeta.mockReturnValue({
      'repo-ssh::/remote/feature-wt': makeWorktreeMeta({
        displayName: 'Feature workspace',
        comment: 'persisted comment',
        linkedIssue: 123,
        linkedPR: 456,
        linkedLinearIssue: 'LIN-123',
        isArchived: true,
        isUnread: true,
        isPinned: true,
        sortOrder: 7,
        lastActivityAt: 42,
        workspaceStatus: 'blocked',
        diffComments: [
          {
            id: 'comment-1',
            worktreeId: 'repo-ssh::/remote/feature-wt',
            filePath: 'src/app.ts',
            lineNumber: 10,
            body: 'check this',
            createdAt: 1,
            updatedAt: 1
          }
        ],
        sparseDirectories: ['packages/web'],
        sparseBaseRef: 'origin/main',
        sparsePresetId: 'preset-1'
      })
    })

    const listed = await handlers['worktrees:list'](null, { repoId: 'repo-ssh' })

    expect(listed).toEqual([
      expect.objectContaining({
        id: 'repo-ssh::/remote/feature-wt',
        repoId: 'repo-ssh',
        path: '/remote/feature-wt',
        head: '',
        branch: '',
        isBare: false,
        isMainWorktree: false,
        isSparse: true,
        displayName: 'Feature workspace',
        comment: 'persisted comment',
        linkedIssue: 123,
        linkedPR: 456,
        linkedLinearIssue: 'LIN-123',
        isArchived: true,
        isUnread: true,
        isPinned: true,
        sortOrder: 7,
        lastActivityAt: 42,
        workspaceStatus: 'blocked',
        sparseDirectories: ['packages/web'],
        sparseBaseRef: 'origin/main',
        sparsePresetId: 'preset-1',
        diffComments: [
          expect.objectContaining({
            id: 'comment-1',
            filePath: 'src/app.ts'
          })
        ]
      })
    ])
    expect(store.getWorktreeMeta).not.toHaveBeenCalled()
    expect(store.setWorktreeMeta).not.toHaveBeenCalled()
  })

  it('falls back to reconstructed SSH rows when provider listing throws', async () => {
    const repo = {
      id: 'repo-ssh',
      path: '/remote/repo',
      displayName: 'SSH Repo',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'conn-1'
    }
    const provider = {
      listWorktrees: vi.fn().mockRejectedValue(new Error('connection lost'))
    }
    store.getRepo.mockReturnValue(repo)
    getSshGitProviderMock.mockReturnValue(provider)
    store.getAllWorktreeMeta.mockReturnValue({
      'repo-ssh::/remote/feature-wt': makeWorktreeMeta({
        displayName: 'Feature workspace',
        lastActivityAt: 42
      })
    })

    const listed = await handlers['worktrees:list'](null, { repoId: 'repo-ssh' })

    expect(provider.listWorktrees).toHaveBeenCalledWith('/remote/repo')
    expect(listed).toEqual([
      expect.objectContaining({
        id: 'repo-ssh::/remote/feature-wt',
        displayName: 'Feature workspace',
        lastActivityAt: 42
      })
    ])
  })

  it('keeps local listing failure behavior as an empty list', async () => {
    listWorktreesMock.mockRejectedValue(new Error('filesystem denied'))
    store.getAllWorktreeMeta.mockReturnValue({
      'repo-1::/workspace/feature-wt': makeWorktreeMeta({
        displayName: 'Should not appear'
      })
    })

    const listed = await handlers['worktrees:list'](null, { repoId: 'repo-1' })

    expect(listed).toEqual([])
    expect(store.getAllWorktreeMeta).not.toHaveBeenCalled()
  })

  it('ignores malformed metadata keys during SSH fallback', async () => {
    const repo = {
      id: 'repo-ssh',
      path: '/remote/repo',
      displayName: 'SSH Repo',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'conn-1'
    }
    store.getRepo.mockReturnValue(repo)
    store.getAllWorktreeMeta.mockReturnValue({
      'not-a-worktree-id': makeWorktreeMeta({ displayName: 'Bad row' }),
      'repo-ssh::/remote/feature-wt': makeWorktreeMeta({ displayName: 'Good row' })
    })

    const listed = await handlers['worktrees:list'](null, { repoId: 'repo-ssh' })

    expect(listed).toEqual([
      expect.objectContaining({
        id: 'repo-ssh::/remote/feature-wt',
        displayName: 'Good row'
      })
    ])
  })

  it('does not use the repo display name for sparse fallback rows with empty branches', async () => {
    const repo = {
      id: 'repo-ssh',
      path: '/remote/repo',
      displayName: 'SSH Repo',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'conn-1'
    }
    store.getRepo.mockReturnValue(repo)
    store.getAllWorktreeMeta.mockReturnValue({
      'repo-ssh::/remote/custom-name': makeWorktreeMeta({
        sparseDirectories: ['packages/web']
      })
    })

    const listed = (await handlers['worktrees:list'](null, { repoId: 'repo-ssh' })) as {
      displayName: string
      isSparse?: boolean
      sparseDirectories?: string[]
    }[]

    expect(listed[0]).toMatchObject({
      displayName: 'custom-name',
      isSparse: true,
      sparseDirectories: ['packages/web']
    })
  })

  it('uses path equivalence to mark the reconstructed SSH main worktree', async () => {
    const repo = {
      id: 'repo-ssh',
      path: 'C:\\Remote\\Repo',
      displayName: 'SSH Repo',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'conn-1'
    }
    store.getRepo.mockReturnValue(repo)
    store.getAllWorktreeMeta.mockReturnValue({
      'repo-ssh::c:/remote/repo': makeWorktreeMeta()
    })

    const listed = (await handlers['worktrees:list'](null, { repoId: 'repo-ssh' })) as {
      isMainWorktree: boolean
    }[]

    expect(listed[0].isMainWorktree).toBe(true)
  })

  it('includes SSH fallback rows in listAll alongside healthy local rows', async () => {
    const sshRepo = {
      id: 'repo-ssh',
      path: '/remote/repo',
      displayName: 'SSH Repo',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'conn-1'
    }
    const localRepo = {
      id: 'repo-local',
      path: '/workspace/local',
      displayName: 'Local Repo',
      badgeColor: '#111',
      addedAt: 0
    }
    store.getRepos.mockReturnValue([sshRepo, localRepo])
    store.getAllWorktreeMeta.mockReturnValue({
      'repo-ssh::/remote/feature-wt': makeWorktreeMeta({ displayName: 'Remote cached' })
    })
    listWorktreesMock.mockResolvedValue([
      {
        path: '/workspace/local',
        head: 'abc123',
        branch: 'refs/heads/main',
        isBare: false,
        isMainWorktree: true
      }
    ])

    const listed = await handlers['worktrees:listAll'](null, undefined)

    expect(store.getAllWorktreeMeta).toHaveBeenCalledTimes(1)
    expect(listed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'repo-ssh::/remote/feature-wt',
          displayName: 'Remote cached'
        }),
        expect.objectContaining({
          id: 'repo-local::/workspace/local',
          branch: 'refs/heads/main'
        })
      ])
    )
  })

  it('snapshots SSH fallback metadata once for listAll', async () => {
    const sshRepoA = {
      id: 'repo-ssh-a',
      path: '/remote/a',
      displayName: 'SSH A',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'conn-1'
    }
    const sshRepoB = {
      id: 'repo-ssh-b',
      path: '/remote/b',
      displayName: 'SSH B',
      badgeColor: '#111',
      addedAt: 0,
      connectionId: 'conn-2'
    }
    store.getRepos.mockReturnValue([sshRepoA, sshRepoB])
    store.getAllWorktreeMeta.mockReturnValue({
      'repo-ssh-a::/remote/a/one': makeWorktreeMeta({ displayName: 'One' }),
      'repo-ssh-b::/remote/b/two': makeWorktreeMeta({ displayName: 'Two' })
    })

    const listed = await handlers['worktrees:listAll'](null, undefined)

    expect(store.getAllWorktreeMeta).toHaveBeenCalledTimes(1)
    expect(listed).toEqual([
      expect.objectContaining({ id: 'repo-ssh-a::/remote/a/one' }),
      expect.objectContaining({ id: 'repo-ssh-b::/remote/b/two' })
    ])
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
      instanceId: 'existing-instance',
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

  it('backfills instanceId on discovery for persisted metadata from older profiles', async () => {
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
    store.setWorktreeMeta.mockReturnValue({
      instanceId: 'new-instance',
      lastActivityAt: 42
    })

    const listed = (await handlers['worktrees:list'](null, { repoId: 'repo-1' })) as {
      id: string
      instanceId?: string
    }[]

    expect(store.setWorktreeMeta).toHaveBeenCalledWith(
      'repo-1::/workspace/existing-wt',
      expect.objectContaining({ instanceId: expect.any(String) })
    )
    expect(listed[0].instanceId).toBe('new-instance')
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

  it('limits concurrent repo scans in worktrees:listAll while preserving order', async () => {
    const repos = Array.from({ length: 10 }, (_, index) => ({
      id: `repo-${index}`,
      path: `/workspace/repo-${index}`,
      displayName: `repo-${index}`,
      badgeColor: '#000',
      addedAt: 0
    }))
    store.getRepos.mockReturnValue(repos)
    let activeScans = 0
    let maxActiveScans = 0
    let notifyScanStarted: (() => void) | undefined
    const waitForScanCount = async (count: number): Promise<void> => {
      while (listWorktreesMock.mock.calls.length < count) {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error(`Timed out waiting for ${count} scans`)),
            1000
          )
          notifyScanStarted = () => {
            clearTimeout(timeout)
            resolve()
          }
        })
      }
    }
    const pendingScans: (() => void)[] = []
    listWorktreesMock.mockImplementation(
      async (
        repoPath: string
      ): Promise<
        { path: string; head: string; branch: string; isBare: false; isMainWorktree: true }[]
      > => {
        activeScans += 1
        maxActiveScans = Math.max(maxActiveScans, activeScans)
        await new Promise<void>((resolve) => {
          pendingScans.push(resolve)
          notifyScanStarted?.()
          notifyScanStarted = undefined
        })
        activeScans -= 1
        return [
          {
            path: repoPath,
            head: 'abc123',
            branch: 'refs/heads/main',
            isBare: false,
            isMainWorktree: true
          }
        ]
      }
    )

    const listPromise = handlers['worktrees:listAll'](null, undefined) as Promise<
      { path: string }[]
    >
    await Promise.resolve()

    expect(listWorktreesMock).toHaveBeenCalledTimes(8)
    expect(maxActiveScans).toBe(8)

    for (const resolve of pendingScans.splice(0)) {
      resolve()
    }
    await waitForScanCount(10)

    expect(listWorktreesMock).toHaveBeenCalledTimes(10)

    for (const resolve of pendingScans.splice(0)) {
      resolve()
    }
    const listed = await listPromise

    expect(maxActiveScans).toBe(8)
    expect(listed.map((worktree) => worktree.path)).toEqual(repos.map((repo) => repo.path))
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
    getEffectiveHooksFromConfigMock.mockReturnValue({
      scripts: {
        setup: 'pnpm worktree:setup # worktree'
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
    mockKnownFeatureWorktree()
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

  it('refuses to delete the root workspace for folder-mode repos', async () => {
    store.getRepo.mockReturnValue({
      id: 'repo-folder',
      path: '/workspace/folder',
      displayName: 'folder',
      badgeColor: '#000',
      addedAt: 0,
      kind: 'folder'
    })

    await expect(
      handlers['worktrees:remove'](null, {
        worktreeId: 'repo-folder::/workspace/folder'
      })
    ).rejects.toThrow('Cannot delete the project root workspace')

    expect(store.removeWorktreeMeta).not.toHaveBeenCalled()
    expect(deleteWorktreeHistoryDirMock).not.toHaveBeenCalled()
  })

  it('kills PTYs before removing additional folder workspace metadata', async () => {
    const ptyProvider = {} as never
    const worktreeId = 'repo-folder::/workspace/folder::workspace:child-1'
    store.getRepo.mockReturnValue({
      id: 'repo-folder',
      path: '/workspace/folder',
      displayName: 'folder',
      badgeColor: '#000',
      addedAt: 0,
      kind: 'folder'
    })
    getLocalPtyProviderMock.mockReturnValue(ptyProvider)

    await handlers['worktrees:remove'](null, { worktreeId })

    expect(killAllProcessesForWorktreeMock).toHaveBeenCalledWith(worktreeId, {
      runtime: runtimeStub,
      localProvider: ptyProvider
    })
    expect(killAllProcessesForWorktreeMock.mock.invocationCallOrder[0]).toBeLessThan(
      store.removeWorktreeMeta.mock.invocationCallOrder[0]
    )
    expect(store.removeWorktreeMeta).toHaveBeenCalledWith(worktreeId)
    expect(advertisedUrlWatcherForgetWorktreeMock).toHaveBeenCalledWith(worktreeId)
    expect(deleteWorktreeHistoryDirMock).toHaveBeenCalledWith(worktreeId)
    expect(mainWindow.webContents.send).toHaveBeenCalledWith('worktrees:changed', {
      repoId: 'repo-folder'
    })
  })

  it('runs the archive hook on remove when skipArchive is not set', async () => {
    mockKnownFeatureWorktree()
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
    mockKnownFeatureWorktree()
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

  it('runs the archive hook before removing an SSH worktree', async () => {
    const repo = {
      id: 'repo-ssh',
      path: '/remote/repo',
      displayName: 'ssh',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'conn-1',
      worktreeBaseRef: null
    }
    const callOrder: string[] = []
    const provider = {
      listWorktrees: vi.fn().mockResolvedValue([
        {
          path: '/remote/repo',
          head: 'main',
          branch: 'main',
          isBare: false,
          isMainWorktree: true
        },
        {
          path: '/remote/feature-wt',
          head: 'feature',
          branch: 'feature',
          isBare: false,
          isMainWorktree: false
        }
      ]),
      removeWorktree: vi.fn().mockImplementation(async () => {
        callOrder.push('remove')
      }),
      worktreeIsClean: vi.fn().mockImplementation(async () => {
        callOrder.push('preflight')
        return { clean: true }
      }),
      execNonInteractive: vi.fn().mockImplementation(async () => {
        callOrder.push('archive')
        return { stdout: '', stderr: '', exitCode: 0, timedOut: false }
      })
    }
    const fsProvider = {
      readFile: vi.fn().mockResolvedValue({
        content: 'scripts:\n  archive: echo archived\n',
        isBinary: false
      })
    }
    store.getRepos.mockReturnValue([repo])
    store.getRepo.mockReturnValue(repo)
    getSshGitProviderMock.mockReturnValue(provider)
    getSshFilesystemProviderMock.mockReturnValue(fsProvider)
    getEffectiveHooksFromConfigMock.mockReturnValue({ scripts: { archive: 'echo archived' } })

    await handlers['worktrees:remove'](null, {
      worktreeId: 'repo-ssh::/remote/feature-wt'
    })

    expect(fsProvider.readFile).toHaveBeenCalledWith('/remote/repo/orca.yaml')
    expect(provider.execNonInteractive).toHaveBeenCalledWith(
      '/bin/bash',
      ['-lc', 'echo archived'],
      '/remote/feature-wt',
      120_000,
      undefined,
      expect.objectContaining({
        ORCA_ROOT_PATH: '/remote/repo',
        ORCA_WORKTREE_PATH: '/remote/feature-wt'
      })
    )
    expect(provider.removeWorktree).toHaveBeenCalledWith('/remote/feature-wt', undefined)
    expect(callOrder).toEqual(['archive', 'preflight', 'remove'])
    expect(runHookMock).not.toHaveBeenCalled()
  })

  it('runs SSH archive hooks before failing dirty non-force removal', async () => {
    const repo = {
      id: 'repo-ssh',
      path: '/remote/repo',
      displayName: 'ssh',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'conn-1',
      worktreeBaseRef: null
    }
    const callOrder: string[] = []
    const provider = {
      listWorktrees: vi.fn().mockResolvedValue([
        {
          path: '/remote/repo',
          head: 'main',
          branch: 'main',
          isBare: false,
          isMainWorktree: true
        },
        {
          path: '/remote/feature-wt',
          head: 'feature',
          branch: 'feature',
          isBare: false,
          isMainWorktree: false
        }
      ]),
      removeWorktree: vi.fn().mockImplementation(async () => {
        callOrder.push('remove')
      }),
      worktreeIsClean: vi.fn().mockImplementation(async () => {
        callOrder.push('preflight')
        return { clean: false, stdout: ' M src/file.ts\n?? scratch.txt\n' }
      }),
      execNonInteractive: vi.fn().mockImplementation(async () => {
        callOrder.push('archive')
        return { stdout: '', stderr: '', exitCode: 0, timedOut: false }
      })
    }
    const fsProvider = {
      readFile: vi.fn().mockResolvedValue({
        content: 'scripts:\n  archive: echo archived\n',
        isBinary: false
      })
    }
    store.getRepos.mockReturnValue([repo])
    store.getRepo.mockReturnValue(repo)
    getSshGitProviderMock.mockReturnValue(provider)
    getSshFilesystemProviderMock.mockReturnValue(fsProvider)
    getEffectiveHooksFromConfigMock.mockReturnValue({ scripts: { archive: 'echo archived' } })

    await expect(
      handlers['worktrees:remove'](null, {
        worktreeId: 'repo-ssh::/remote/feature-wt'
      })
    ).rejects.toThrow('Worktree has uncommitted or untracked changes.')

    expect(callOrder).toEqual(['archive', 'preflight'])
    expect(provider.removeWorktree).not.toHaveBeenCalled()
    expect(store.removeWorktreeMeta).not.toHaveBeenCalled()
  })

  it('skips SSH dirty preflight for force removal', async () => {
    const repo = {
      id: 'repo-ssh',
      path: '/remote/repo',
      displayName: 'ssh',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'conn-1',
      worktreeBaseRef: null
    }
    const provider = {
      listWorktrees: vi.fn().mockResolvedValue([
        {
          path: '/remote/repo',
          head: 'main',
          branch: 'main',
          isBare: false,
          isMainWorktree: true
        },
        {
          path: '/remote/feature-wt',
          head: 'feature',
          branch: 'feature',
          isBare: false,
          isMainWorktree: false
        }
      ]),
      removeWorktree: vi.fn().mockResolvedValue(undefined),
      worktreeIsClean: vi.fn(),
      execNonInteractive: vi.fn().mockResolvedValue({
        stdout: '',
        stderr: '',
        exitCode: 0,
        timedOut: false
      })
    }
    const fsProvider = {
      readFile: vi.fn().mockResolvedValue({
        content: 'scripts:\n  archive: echo archived\n',
        isBinary: false
      })
    }
    store.getRepos.mockReturnValue([repo])
    store.getRepo.mockReturnValue(repo)
    getSshGitProviderMock.mockReturnValue(provider)
    getSshFilesystemProviderMock.mockReturnValue(fsProvider)
    getEffectiveHooksFromConfigMock.mockReturnValue({ scripts: { archive: 'echo archived' } })

    await handlers['worktrees:remove'](null, {
      worktreeId: 'repo-ssh::/remote/feature-wt',
      force: true
    })

    expect(provider.worktreeIsClean).not.toHaveBeenCalled()
    expect(provider.removeWorktree).toHaveBeenCalledWith('/remote/feature-wt', true)
  })

  it('continues SSH worktree removal when the archive hook fails', async () => {
    const repo = {
      id: 'repo-ssh',
      path: '/remote/repo',
      displayName: 'ssh',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'conn-1',
      worktreeBaseRef: null
    }
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const provider = {
      listWorktrees: vi.fn().mockResolvedValue([
        {
          path: '/remote/repo',
          head: 'main',
          branch: 'main',
          isBare: false,
          isMainWorktree: true
        },
        {
          path: '/remote/feature-wt',
          head: 'feature',
          branch: 'feature',
          isBare: false,
          isMainWorktree: false
        }
      ]),
      removeWorktree: vi.fn().mockResolvedValue(undefined),
      worktreeIsClean: vi.fn().mockResolvedValue({ clean: true }),
      execNonInteractive: vi.fn().mockResolvedValue({
        stdout: '',
        stderr: 'cleanup failed',
        exitCode: 7,
        timedOut: false
      })
    }
    const fsProvider = {
      readFile: vi.fn().mockResolvedValue({
        content: 'scripts:\n  archive: exit 7\n',
        isBinary: false
      })
    }
    store.getRepos.mockReturnValue([repo])
    store.getRepo.mockReturnValue(repo)
    getSshGitProviderMock.mockReturnValue(provider)
    getSshFilesystemProviderMock.mockReturnValue(fsProvider)
    getEffectiveHooksFromConfigMock.mockReturnValue({ scripts: { archive: 'exit 7' } })

    try {
      await handlers['worktrees:remove'](null, {
        worktreeId: 'repo-ssh::/remote/feature-wt'
      })
      expect(provider.removeWorktree).toHaveBeenCalledWith('/remote/feature-wt', undefined)
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '[hooks] archive hook failed for /remote/feature-wt:',
        expect.stringContaining('archive hook exited 7')
      )
    } finally {
      consoleErrorSpy.mockRestore()
    }
  })

  it('continues SSH worktree removal when archive hook execution rejects', async () => {
    const repo = {
      id: 'repo-ssh',
      path: '/remote/repo',
      displayName: 'ssh',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'conn-1',
      worktreeBaseRef: null
    }
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const provider = {
      listWorktrees: vi.fn().mockResolvedValue([
        {
          path: '/remote/repo',
          head: 'main',
          branch: 'main',
          isBare: false,
          isMainWorktree: true
        },
        {
          path: '/remote/feature-wt',
          head: 'feature',
          branch: 'feature',
          isBare: false,
          isMainWorktree: false
        }
      ]),
      removeWorktree: vi.fn().mockResolvedValue(undefined),
      worktreeIsClean: vi.fn().mockResolvedValue({ clean: true }),
      execNonInteractive: vi.fn().mockRejectedValue(new Error('relay disconnected'))
    }
    const fsProvider = {
      readFile: vi.fn().mockResolvedValue({
        content: 'scripts:\n  archive: echo archived\n',
        isBinary: false
      })
    }
    store.getRepos.mockReturnValue([repo])
    store.getRepo.mockReturnValue(repo)
    getSshGitProviderMock.mockReturnValue(provider)
    getSshFilesystemProviderMock.mockReturnValue(fsProvider)
    getEffectiveHooksFromConfigMock.mockReturnValue({ scripts: { archive: 'echo archived' } })

    try {
      await handlers['worktrees:remove'](null, {
        worktreeId: 'repo-ssh::/remote/feature-wt'
      })
      expect(provider.removeWorktree).toHaveBeenCalledWith('/remote/feature-wt', undefined)
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '[hooks] archive hook failed for /remote/feature-wt:',
        'relay disconnected'
      )
    } finally {
      consoleErrorSpy.mockRestore()
    }
  })

  it('uses cmd.exe for archive hooks on Windows-like SSH worktree paths', async () => {
    const repo = {
      id: 'repo-ssh',
      path: 'C:\\remote\\repo',
      displayName: 'ssh',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'conn-1',
      worktreeBaseRef: null
    }
    const provider = {
      listWorktrees: vi.fn().mockResolvedValue([
        {
          path: 'C:\\remote\\repo',
          head: 'main',
          branch: 'main',
          isBare: false,
          isMainWorktree: true
        },
        {
          path: 'C:\\remote\\feature-wt',
          head: 'feature',
          branch: 'feature',
          isBare: false,
          isMainWorktree: false
        }
      ]),
      removeWorktree: vi.fn().mockResolvedValue(undefined),
      worktreeIsClean: vi.fn().mockResolvedValue({ clean: true }),
      execNonInteractive: vi.fn().mockResolvedValue({
        stdout: '',
        stderr: '',
        exitCode: 0,
        timedOut: false
      })
    }
    const fsProvider = {
      readFile: vi.fn().mockResolvedValue({
        content: 'scripts:\n  archive: echo archived\n',
        isBinary: false
      })
    }
    store.getRepos.mockReturnValue([repo])
    store.getRepo.mockReturnValue(repo)
    getSshGitProviderMock.mockReturnValue(provider)
    getSshFilesystemProviderMock.mockReturnValue(fsProvider)
    getEffectiveHooksFromConfigMock.mockReturnValue({ scripts: { archive: 'echo archived' } })

    await handlers['worktrees:remove'](null, {
      worktreeId: 'repo-ssh::C:\\remote\\feature-wt'
    })

    expect(fsProvider.readFile).toHaveBeenCalledWith('C:\\remote\\repo\\orca.yaml')
    expect(provider.execNonInteractive).toHaveBeenCalledWith(
      'cmd.exe',
      ['/d', '/s', '/c', 'echo archived'],
      'C:\\remote\\feature-wt',
      120_000,
      undefined,
      expect.objectContaining({
        ORCA_ROOT_PATH: 'C:\\remote\\repo',
        ORCA_WORKTREE_PATH: 'C:\\remote\\feature-wt'
      })
    )
  })

  it('skips the archive hook before removing an SSH worktree when skipArchive is true', async () => {
    const repo = {
      id: 'repo-ssh',
      path: '/remote/repo',
      displayName: 'ssh',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'conn-1',
      worktreeBaseRef: null
    }
    const provider = {
      listWorktrees: vi.fn().mockResolvedValue([
        {
          path: '/remote/repo',
          head: 'main',
          branch: 'main',
          isBare: false,
          isMainWorktree: true
        },
        {
          path: '/remote/feature-wt',
          head: 'feature',
          branch: 'feature',
          isBare: false,
          isMainWorktree: false
        }
      ]),
      removeWorktree: vi.fn().mockResolvedValue(undefined),
      worktreeIsClean: vi.fn().mockResolvedValue({ clean: true }),
      execNonInteractive: vi.fn()
    }
    const fsProvider = {
      readFile: vi.fn().mockResolvedValue({
        content: 'scripts:\n  archive: echo archived\n',
        isBinary: false
      })
    }
    store.getRepos.mockReturnValue([repo])
    store.getRepo.mockReturnValue(repo)
    getSshGitProviderMock.mockReturnValue(provider)
    getSshFilesystemProviderMock.mockReturnValue(fsProvider)
    getEffectiveHooksFromConfigMock.mockReturnValue({ scripts: { archive: 'echo archived' } })

    await handlers['worktrees:remove'](null, {
      worktreeId: 'repo-ssh::/remote/feature-wt',
      skipArchive: true
    })

    expect(provider.execNonInteractive).not.toHaveBeenCalled()
    expect(provider.removeWorktree).toHaveBeenCalledWith('/remote/feature-wt', undefined)
  })

  it('preserves the branch on remove for worktrees created from an existing local branch', async () => {
    mockKnownFeatureWorktree()
    removeWorktreeMock.mockResolvedValue(undefined)
    store.getWorktreeMeta.mockReturnValue(makeWorktreeMeta({ preserveBranchOnDelete: true }))

    await handlers['worktrees:remove'](null, {
      worktreeId: 'repo-1::/workspace/feature-wt'
    })

    expect(removeWorktreeMock).toHaveBeenCalledWith(
      '/workspace/repo',
      '/workspace/feature-wt',
      false,
      { deleteBranch: false }
    )
  })

  it('force-deletes a branch that was preserved by safe worktree removal', async () => {
    mockKnownFeatureWorktree()
    removeWorktreeMock.mockResolvedValue({
      preservedBranch: { branchName: 'feature/test', head: 'def456' }
    })

    await handlers['worktrees:remove'](null, {
      worktreeId: 'repo-1::/workspace/feature-wt'
    })
    const result = await handlers['worktrees:forceDeletePreservedBranch'](null, {
      worktreeId: 'repo-1::/workspace/feature-wt',
      branchName: 'feature/test',
      expectedHead: 'def456'
    })

    expect(result).toEqual({ deleted: true })
    expect(forceDeleteLocalBranchMock).toHaveBeenCalledWith(
      '/workspace/repo',
      'feature/test',
      'def456'
    )
  })

  it('rejects stale preserved-branch cleanup actions with an old head', async () => {
    mockKnownFeatureWorktree()
    removeWorktreeMock.mockResolvedValue({
      preservedBranch: { branchName: 'feature/test', head: 'new456' }
    })

    await handlers['worktrees:remove'](null, {
      worktreeId: 'repo-1::/workspace/feature-wt'
    })

    await expect(
      handlers['worktrees:forceDeletePreservedBranch'](null, {
        worktreeId: 'repo-1::/workspace/feature-wt',
        branchName: 'feature/test',
        expectedHead: 'old123'
      })
    ).rejects.toThrow('No preserved branch cleanup is pending')
    expect(forceDeleteLocalBranchMock).not.toHaveBeenCalled()
  })

  it('removes an unused Orca-created fork remote after deleting its worktree', async () => {
    mockKnownFeatureWorktree()
    removeWorktreeMock.mockResolvedValue(undefined)
    const pushTarget = {
      remoteName: 'pr-contributor-orca',
      branchName: 'feature/from-fork',
      remoteUrl: 'https://github.com/contributor/orca.git',
      remoteCreated: true
    }
    store.getWorktreeMeta.mockReturnValue(makeWorktreeMeta({ pushTarget }))
    store.getAllWorktreeMeta.mockReturnValue({
      'repo-1::/workspace/feature-wt': makeWorktreeMeta({ pushTarget })
    })
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'config') {
        throw new Error('no branch config')
      }
      if (args[0] === 'remote' && args[1] === 'get-url') {
        return { stdout: 'https://github.com/contributor/orca.git\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })

    await handlers['worktrees:remove'](null, {
      worktreeId: 'repo-1::/workspace/feature-wt'
    })

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(['remote', 'remove', 'pr-contributor-orca'], {
      cwd: '/workspace/repo'
    })
  })

  it('keeps an Orca-created fork remote while another worktree still uses it', async () => {
    mockKnownFeatureWorktree()
    removeWorktreeMock.mockResolvedValue(undefined)
    const pushTarget = {
      remoteName: 'pr-contributor-orca',
      branchName: 'feature/from-fork',
      remoteUrl: 'https://github.com/contributor/orca.git',
      remoteCreated: true
    }
    store.getWorktreeMeta.mockReturnValue(makeWorktreeMeta({ pushTarget }))
    store.getAllWorktreeMeta.mockReturnValue({
      'repo-1::/workspace/feature-wt': makeWorktreeMeta({ pushTarget }),
      'repo-1::/workspace/other-wt': makeWorktreeMeta({
        pushTarget: {
          ...pushTarget,
          branchName: 'other-branch'
        }
      })
    })

    await handlers['worktrees:remove'](null, {
      worktreeId: 'repo-1::/workspace/feature-wt'
    })

    expect(gitExecFileAsyncMock).not.toHaveBeenCalledWith(
      ['remote', 'remove', 'pr-contributor-orca'],
      expect.any(Object)
    )
  })

  it('ignores matching push targets from other repos when deciding fork remote cleanup', async () => {
    mockKnownFeatureWorktree()
    removeWorktreeMock.mockResolvedValue(undefined)
    const pushTarget = {
      remoteName: 'pr-contributor-orca',
      branchName: 'feature/from-fork',
      remoteUrl: 'https://github.com/contributor/orca.git',
      remoteCreated: true
    }
    store.getWorktreeMeta.mockReturnValue(makeWorktreeMeta({ pushTarget }))
    store.getAllWorktreeMeta.mockReturnValue({
      'repo-1::/workspace/feature-wt': makeWorktreeMeta({ pushTarget }),
      'repo-2::/workspace/other-wt': makeWorktreeMeta({
        pushTarget: {
          ...pushTarget,
          branchName: 'other-branch'
        }
      })
    })
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'config') {
        throw new Error('no branch config')
      }
      if (args[0] === 'remote' && args[1] === 'get-url') {
        return { stdout: 'https://github.com/contributor/orca.git\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })

    await handlers['worktrees:remove'](null, {
      worktreeId: 'repo-1::/workspace/feature-wt'
    })

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(['remote', 'remove', 'pr-contributor-orca'], {
      cwd: '/workspace/repo'
    })
  })

  it('rejects unregistered delete paths before teardown, hooks, or git removal', async () => {
    mockKnownFeatureWorktree('/workspace/real-feature')
    getEffectiveHooksMock.mockReturnValue({
      scripts: {
        archive: 'echo archived'
      }
    })

    await expect(
      handlers['worktrees:remove'](null, {
        worktreeId: 'repo-1::/workspace/not-a-worktree'
      })
    ).rejects.toThrow('Refusing to delete unregistered worktree path')

    expect(killAllProcessesForWorktreeMock).not.toHaveBeenCalled()
    expect(runHookMock).not.toHaveBeenCalled()
    expect(removeWorktreeMock).not.toHaveBeenCalled()
    expect(store.removeWorktreeMeta).not.toHaveBeenCalled()
  })

  it('treats forced deletion of an already-missing unregistered worktree as cleanup', async () => {
    mockKnownFeatureWorktree('/workspace/real-feature')

    await handlers['worktrees:remove'](null, {
      worktreeId: 'repo-1::/workspace/already-deleted-wt',
      force: true
    })

    expect(killAllProcessesForWorktreeMock).not.toHaveBeenCalled()
    expect(runHookMock).not.toHaveBeenCalled()
    expect(removeWorktreeMock).not.toHaveBeenCalled()
    expect(runtimeStub.clearOptimisticReconcileToken).toHaveBeenCalledWith(
      'repo-1::/workspace/already-deleted-wt'
    )
    expect(store.removeWorktreeMeta).toHaveBeenCalledWith('repo-1::/workspace/already-deleted-wt')
    expect(deleteWorktreeHistoryDirMock).toHaveBeenCalledWith(
      'repo-1::/workspace/already-deleted-wt'
    )
    expect(mainWindow.webContents.send).toHaveBeenCalledWith('worktrees:changed', {
      repoId: 'repo-1'
    })
  })

  it('force-removes a legacy Orca-created orphaned worktree directory after Git tracking is gone', async () => {
    const parentDir = await mkdtemp(join(tmpdir(), 'orca-ipc-orphan-'))
    const repoPath = join(parentDir, 'repo')
    const orphanPath = join(parentDir, 'orphan')
    const adminWorktreePath = join(repoPath, '.git', 'worktrees', 'orphan')
    const worktreeId = `repo-1::${orphanPath}`
    await mkdir(orphanPath, { recursive: true })
    await mkdir(adminWorktreePath, { recursive: true })
    await writeFile(join(orphanPath, '.git'), `gitdir: ${adminWorktreePath}\n`)
    await writeFile(join(adminWorktreePath, 'gitdir'), `${join(orphanPath, '.git')}\n`)
    store.getRepo.mockReturnValue({
      id: 'repo-1',
      path: repoPath,
      displayName: 'repo',
      badgeColor: '#000',
      addedAt: 0,
      worktreeBaseRef: null
    })
    mockKnownFeatureWorktree(join(parentDir, 'real-feature'), repoPath)
    store.getWorktreeMeta.mockReturnValue(makeWorktreeMeta({ createdAt: Date.now() }))

    try {
      await handlers['worktrees:remove'](null, {
        worktreeId,
        force: true
      })

      await expect(lstat(orphanPath)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(killAllProcessesForWorktreeMock).not.toHaveBeenCalled()
      expect(runHookMock).not.toHaveBeenCalled()
      expect(removeWorktreeMock).not.toHaveBeenCalled()
      expect(runtimeStub.clearOptimisticReconcileToken).toHaveBeenCalledWith(worktreeId)
      expect(store.removeWorktreeMeta).toHaveBeenCalledWith(worktreeId)
      expect(deleteWorktreeHistoryDirMock).toHaveBeenCalledWith(worktreeId)
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('worktrees:changed', {
        repoId: 'repo-1'
      })
    } finally {
      await rm(parentDir, { recursive: true, force: true })
    }
  })

  it('prompts for force before removing an Orca-created orphaned worktree directory', async () => {
    const parentDir = await mkdtemp(join(tmpdir(), 'orca-ipc-orphan-'))
    const repoPath = join(parentDir, 'repo')
    const orphanPath = join(parentDir, 'orphan')
    const adminWorktreePath = join(repoPath, '.git', 'worktrees', 'orphan')
    await mkdir(orphanPath, { recursive: true })
    await mkdir(adminWorktreePath, { recursive: true })
    await writeFile(join(orphanPath, '.git'), `gitdir: ${adminWorktreePath}\n`)
    await writeFile(join(adminWorktreePath, 'gitdir'), `${join(orphanPath, '.git')}\n`)
    store.getRepo.mockReturnValue({
      id: 'repo-1',
      path: repoPath,
      displayName: 'repo',
      badgeColor: '#000',
      addedAt: 0,
      worktreeBaseRef: null
    })
    mockKnownFeatureWorktree(join(parentDir, 'real-feature'), repoPath)
    store.getWorktreeMeta.mockReturnValue(
      makeWorktreeMeta({ orcaCreatedAt: Date.now(), orcaCreationSource: 'runtime' })
    )

    try {
      await expect(
        handlers['worktrees:remove'](null, {
          worktreeId: `repo-1::${orphanPath}`
        })
      ).rejects.toThrow('Worktree is no longer registered with Git but its directory remains.')

      await expect(lstat(orphanPath)).resolves.toBeTruthy()
      expect(removeWorktreeMock).not.toHaveBeenCalled()
      expect(store.removeWorktreeMeta).not.toHaveBeenCalled()
    } finally {
      await rm(parentDir, { recursive: true, force: true })
    }
  })

  it('does not inspect or delete a local path when SSH orphan cleanup has no filesystem provider', async () => {
    const localPath = await mkdtemp(join(tmpdir(), 'orca-ipc-ssh-missing-fs-'))
    const repo = {
      id: 'repo-ssh-missing-fs',
      path: '/remote/repo',
      displayName: 'ssh',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'conn-missing-fs'
    }
    const provider = {
      listWorktrees: vi.fn().mockResolvedValue([
        {
          path: '/remote/repo',
          head: 'main',
          branch: 'refs/heads/main',
          isBare: false,
          isMainWorktree: true
        }
      ]),
      worktreeIsClean: vi.fn().mockResolvedValue({ clean: true })
    }
    store.getRepo.mockReturnValue(repo)
    store.getWorktreeMeta.mockReturnValue(
      makeWorktreeMeta({ orcaCreatedAt: Date.now(), orcaCreationSource: 'ssh' })
    )
    getSshGitProviderMock.mockReturnValue(provider)
    getSshFilesystemProviderMock.mockReturnValue(undefined)

    try {
      await expect(
        handlers['worktrees:remove'](null, {
          worktreeId: `${repo.id}::${localPath}`,
          force: true
        })
      ).rejects.toThrow('SSH filesystem provider unavailable')

      await expect(lstat(localPath)).resolves.toBeTruthy()
      expect(removeWorktreeMock).not.toHaveBeenCalled()
      expect(store.removeWorktreeMeta).not.toHaveBeenCalled()
    } finally {
      await rm(localPath, { recursive: true, force: true })
    }
  })

  it('refuses SSH orphan cleanup when remote .git is a symlink', async () => {
    const repo = {
      id: 'repo-ssh-symlink-git',
      path: '/remote/repo',
      displayName: 'ssh',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'conn-symlink-git'
    }
    const worktreePath = '/remote/orphan'
    const provider = {
      listWorktrees: vi.fn().mockResolvedValue([
        {
          path: '/remote/repo',
          head: 'main',
          branch: 'refs/heads/main',
          isBare: false,
          isMainWorktree: true
        }
      ]),
      worktreeIsClean: vi.fn().mockResolvedValue({ clean: true })
    }
    const fsProvider = {
      lstat: vi.fn().mockResolvedValue({ type: 'symlink' }),
      stat: vi.fn().mockResolvedValue({ type: 'directory' }),
      readFile: vi.fn(),
      deletePath: vi.fn()
    }
    store.getRepo.mockReturnValue(repo)
    store.getWorktreeMeta.mockReturnValue(
      makeWorktreeMeta({ orcaCreatedAt: Date.now(), orcaCreationSource: 'ssh' })
    )
    getSshGitProviderMock.mockReturnValue(provider)
    getSshFilesystemProviderMock.mockReturnValue(fsProvider)

    await expect(
      handlers['worktrees:remove'](null, {
        worktreeId: `${repo.id}::${worktreePath}`,
        force: true
      })
    ).rejects.toThrow(`Refusing to delete unregistered worktree path: ${worktreePath}`)

    expect(fsProvider.lstat).toHaveBeenCalledWith(`${worktreePath}/.git`)
    expect(fsProvider.readFile).not.toHaveBeenCalled()
    expect(fsProvider.deletePath).not.toHaveBeenCalled()
  })

  it('coalesces concurrent deletes for the same worktree id', async () => {
    mockKnownFeatureWorktree()
    deleteWorktreeHistoryDirMock.mockClear()
    let removalStarted!: () => void
    let finishRemoval!: () => void
    const started = new Promise<void>((resolve) => {
      removalStarted = resolve
    })
    removeWorktreeMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          removalStarted()
          finishRemoval = resolve
        })
    )

    const first = handlers['worktrees:remove'](null, {
      worktreeId: 'repo-1::/workspace/feature-wt',
      force: true
    }) as Promise<unknown>
    const second = handlers['worktrees:remove'](null, {
      worktreeId: 'repo-1::/workspace/feature-wt',
      force: true
    }) as Promise<unknown>

    await started
    await Promise.resolve()
    expect(removeWorktreeMock).toHaveBeenCalledTimes(1)

    finishRemoval()
    await expect(Promise.all([first, second])).resolves.toEqual([{}, {}])
    expect(store.removeWorktreeMeta).toHaveBeenCalledTimes(1)
    expect(deleteWorktreeHistoryDirMock).toHaveBeenCalledTimes(1)
    expect(mainWindow.webContents.send).toHaveBeenCalledTimes(1)
  })

  it('rejects concurrent deletes for the same worktree id with different options', async () => {
    mockKnownFeatureWorktree()
    let removalStarted!: () => void
    let finishRemoval!: () => void
    const started = new Promise<void>((resolve) => {
      removalStarted = resolve
    })
    removeWorktreeMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          removalStarted()
          finishRemoval = resolve
        })
    )

    const first = handlers['worktrees:remove'](null, {
      worktreeId: 'repo-1::/workspace/feature-wt'
    }) as Promise<unknown>

    await started
    await expect(
      handlers['worktrees:remove'](null, {
        worktreeId: 'repo-1::/workspace/feature-wt',
        force: true
      })
    ).rejects.toThrow('Worktree deletion already in progress')

    expect(removeWorktreeMock).toHaveBeenCalledTimes(1)
    finishRemoval()
    await expect(first).resolves.toEqual({})
  })

  it('still rejects forced unregistered delete paths that exist on disk', async () => {
    mockKnownFeatureWorktree('/workspace/real-feature')

    await expect(
      handlers['worktrees:remove'](null, {
        worktreeId: `repo-1::${process.cwd()}`,
        force: true
      })
    ).rejects.toThrow('Refusing to delete unregistered worktree path')

    expect(killAllProcessesForWorktreeMock).not.toHaveBeenCalled()
    expect(runHookMock).not.toHaveBeenCalled()
    expect(removeWorktreeMock).not.toHaveBeenCalled()
    expect(store.removeWorktreeMeta).not.toHaveBeenCalled()
  })

  it('rejects the main worktree before teardown, hooks, or git removal', async () => {
    mockKnownFeatureWorktree()

    await expect(
      handlers['worktrees:remove'](null, {
        worktreeId: 'repo-1::/workspace/repo'
      })
    ).rejects.toThrow('Refusing to delete protected worktree path')

    expect(killAllProcessesForWorktreeMock).not.toHaveBeenCalled()
    expect(runHookMock).not.toHaveBeenCalled()
    expect(removeWorktreeMock).not.toHaveBeenCalled()
    expect(store.removeWorktreeMeta).not.toHaveBeenCalled()
  })

  it('rejects deleting a worktree that contains another registered worktree before teardown, hooks, or git removal', async () => {
    listWorktreesMock.mockResolvedValue([
      {
        path: '/workspace/repo',
        head: 'main',
        branch: 'main',
        isBare: false,
        isMainWorktree: true
      },
      {
        path: '/workspace/parent',
        head: 'parent',
        branch: 'parent',
        isBare: false,
        isMainWorktree: false
      },
      {
        path: '/workspace/parent/child',
        head: 'child',
        branch: 'child',
        isBare: false,
        isMainWorktree: false
      }
    ])
    getEffectiveHooksMock.mockReturnValue({
      scripts: {
        archive: 'echo archived'
      }
    })

    await expect(
      handlers['worktrees:remove'](null, {
        worktreeId: 'repo-1::/workspace/parent',
        force: true
      })
    ).rejects.toThrow(
      'Refusing to delete worktree because it contains another registered worktree: /workspace/parent/child'
    )

    expect(killAllProcessesForWorktreeMock).not.toHaveBeenCalled()
    expect(runHookMock).not.toHaveBeenCalled()
    expect(removeWorktreeMock).not.toHaveBeenCalled()
    expect(store.removeWorktreeMeta).not.toHaveBeenCalled()
  })

  it('IPC-initiated delete kills PTYs BEFORE git-level removal (design §4.3)', async () => {
    mockKnownFeatureWorktree()
    getEffectiveHooksMock.mockReturnValue(null)
    const callOrder: string[] = []
    assertWorktreeCleanForRemovalMock.mockImplementation(async () => {
      callOrder.push('preflight')
    })
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
    expect(callOrder).toEqual(['preflight', 'kill', 'git'])
  })

  it('fails dirty non-force deletes before PTY teardown', async () => {
    mockKnownFeatureWorktree()
    getEffectiveHooksMock.mockReturnValue(null)
    assertWorktreeCleanForRemovalMock.mockRejectedValue(
      Object.assign(new Error('Worktree has uncommitted or untracked changes.'), {
        stdout: '?? scratch.txt\n'
      })
    )

    await expect(
      handlers['worktrees:remove'](null, {
        worktreeId: 'repo-1::/workspace/feature-wt'
      })
    ).rejects.toThrow('Failed to delete worktree at /workspace/feature-wt. ?? scratch.txt')

    expect(killAllProcessesForWorktreeMock).not.toHaveBeenCalled()
    expect(removeWorktreeMock).not.toHaveBeenCalled()
  })

  it('formats preflight subprocess failures and does not tear down PTYs', async () => {
    mockKnownFeatureWorktree()
    getEffectiveHooksMock.mockReturnValue(null)
    assertWorktreeCleanForRemovalMock.mockRejectedValue(
      Object.assign(new Error('status failed'), {
        stderr: 'fatal: unable to read current working directory\n'
      })
    )

    await expect(
      handlers['worktrees:remove'](null, {
        worktreeId: 'repo-1::/workspace/feature-wt'
      })
    ).rejects.toThrow(
      'Failed to delete worktree at /workspace/feature-wt. fatal: unable to read current working directory'
    )

    expect(killAllProcessesForWorktreeMock).not.toHaveBeenCalled()
    expect(removeWorktreeMock).not.toHaveBeenCalled()
  })

  it('falls through to orphan cleanup when preflight reports missing/non-repo worktree', async () => {
    mockKnownFeatureWorktree()
    getEffectiveHooksMock.mockReturnValue(null)
    assertWorktreeCleanForRemovalMock.mockRejectedValue(
      Object.assign(new Error('status failed'), {
        stderr: 'fatal: not a git repository (or any of the parent directories): .git\n'
      })
    )
    removeWorktreeMock.mockRejectedValue(
      Object.assign(new Error('git worktree remove failed'), {
        stderr: "fatal: '/workspace/feature-wt' is not a working tree"
      })
    )
    gitExecFileAsyncMock.mockResolvedValue({ stdout: '', stderr: '' })

    await handlers['worktrees:remove'](null, {
      worktreeId: 'repo-1::/workspace/feature-wt'
    })

    expect(killAllProcessesForWorktreeMock).not.toHaveBeenCalled()
    expect(removeWorktreeMock).toHaveBeenCalled()
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(['worktree', 'prune'], {
      cwd: '/workspace/repo'
    })
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

  it('keeps SSH issue-command local overrides usable when shared read fails', async () => {
    const repo = {
      id: 'repo-ssh',
      path: '/remote/repo',
      displayName: 'ssh',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'conn-1',
      worktreeBaseRef: null
    }
    const fsProvider = {
      readFile: vi.fn(async (filePath: string) => {
        if (filePath.endsWith('/.orca/issue-command')) {
          return { content: 'local command\n', isBinary: false }
        }
        throw new Error('shared read failed')
      })
    }
    store.getRepo.mockReturnValue(repo)
    getSshFilesystemProviderMock.mockReturnValue(fsProvider)

    await expect(
      handlers['hooks:readIssueCommand'](null, {
        repoId: 'repo-ssh'
      })
    ).resolves.toMatchObject({
      status: 'ok',
      localContent: 'local command',
      sharedContent: null,
      effectiveContent: 'local command',
      source: 'local'
    })
  })

  it('writes SSH issue-command overrides without clobbering .gitignore on read failure', async () => {
    const repo = {
      id: 'repo-ssh',
      path: '/remote/repo',
      displayName: 'ssh',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'conn-1',
      worktreeBaseRef: null
    }
    const fsProvider = {
      createDir: vi.fn().mockResolvedValue(undefined),
      readFile: vi.fn().mockRejectedValue(new Error('ssh read failed')),
      writeFile: vi.fn().mockResolvedValue(undefined),
      deletePath: vi.fn().mockResolvedValue(undefined)
    }
    store.getRepo.mockReturnValue(repo)
    getSshFilesystemProviderMock.mockReturnValue(fsProvider)

    await expect(
      handlers['hooks:writeIssueCommand'](null, {
        repoId: 'repo-ssh',
        content: 'orca issue command'
      })
    ).rejects.toThrow('ssh read failed')

    expect(fsProvider.writeFile).not.toHaveBeenCalled()
  })

  it('creates remote .gitignore only when it is missing while writing SSH issue commands', async () => {
    const repo = {
      id: 'repo-ssh',
      path: '/remote/repo',
      displayName: 'ssh',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'conn-1',
      worktreeBaseRef: null
    }
    const enoent = Object.assign(new Error('missing'), { code: 'ENOENT' })
    const fsProvider = {
      createDir: vi.fn().mockResolvedValue(undefined),
      readFile: vi.fn().mockRejectedValue(enoent),
      writeFile: vi.fn().mockResolvedValue(undefined),
      deletePath: vi.fn().mockResolvedValue(undefined)
    }
    store.getRepo.mockReturnValue(repo)
    getSshFilesystemProviderMock.mockReturnValue(fsProvider)

    await handlers['hooks:writeIssueCommand'](null, {
      repoId: 'repo-ssh',
      content: 'orca issue command'
    })

    expect(fsProvider.writeFile).toHaveBeenNthCalledWith(1, '/remote/repo/.gitignore', '.orca\n')
    expect(fsProvider.writeFile).toHaveBeenNthCalledWith(
      2,
      '/remote/repo/.orca/issue-command',
      'orca issue command\n'
    )
  })

  it('rejects SSH issue-command writes when the remote filesystem provider is unavailable', async () => {
    const repo = {
      id: 'repo-ssh',
      path: '/remote/repo',
      displayName: 'ssh',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'conn-1',
      worktreeBaseRef: null
    }
    store.getRepo.mockReturnValue(repo)
    getSshFilesystemProviderMock.mockReturnValue(null)

    await expect(
      handlers['hooks:writeIssueCommand'](null, {
        repoId: 'repo-ssh',
        content: 'orca issue command'
      })
    ).rejects.toThrow('Remote filesystem unavailable')
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
