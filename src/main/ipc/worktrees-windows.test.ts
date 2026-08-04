import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GitUsernameModule from '../git/git-username'

const {
  handleMock,
  removeHandlerMock,
  listWorktreesMock,
  assertWorktreeCleanForRemovalMock,
  addWorktreeMock,
  removeWorktreeMock,
  resolveLocalGitUsernameMock,
  getDefaultBaseRefMock,
  resolveDefaultBaseRefWithLocalGitMock,
  resolveDefaultBaseRefViaExecMock,
  getBranchConflictKindMock,
  getPRForBranchMock,
  createGitHubPullRequestMock,
  getEffectiveHooksMock,
  getEffectiveHooksFromConfigMock,
  getDefaultTabsLaunchMock,
  createIssueCommandRunnerScriptMock,
  createSetupRunnerScriptMock,
  resolveSetupRunnerShellMock,
  shouldRunSetupForCreateMock,
  runHookMock,
  hasHooksFileMock,
  loadHooksMock,
  computeWorktreePathMock,
  ensurePathWithinWorkspaceMock,
  killAllProcessesForWorktreeMock,
  clearProviderPtyStateMock,
  getLocalPtyProviderMock,
  deleteWorktreeHistoryDirMock
} = vi.hoisted(() => ({
  handleMock: vi.fn(),
  removeHandlerMock: vi.fn(),
  listWorktreesMock: vi.fn(),
  assertWorktreeCleanForRemovalMock: vi.fn(),
  addWorktreeMock: vi.fn(),
  removeWorktreeMock: vi.fn(),
  resolveLocalGitUsernameMock: vi.fn(),
  getDefaultBaseRefMock: vi.fn(),
  resolveDefaultBaseRefWithLocalGitMock: vi.fn(),
  resolveDefaultBaseRefViaExecMock: vi.fn(),
  getBranchConflictKindMock: vi.fn(),
  getPRForBranchMock: vi.fn(),
  createGitHubPullRequestMock: vi.fn(),
  getEffectiveHooksMock: vi.fn(),
  getEffectiveHooksFromConfigMock: vi.fn(),
  getDefaultTabsLaunchMock: vi.fn(),
  createIssueCommandRunnerScriptMock: vi.fn(),
  createSetupRunnerScriptMock: vi.fn(),
  resolveSetupRunnerShellMock: vi.fn(),
  shouldRunSetupForCreateMock: vi.fn(),
  runHookMock: vi.fn(),
  hasHooksFileMock: vi.fn(),
  loadHooksMock: vi.fn(),
  computeWorktreePathMock: vi.fn(),
  ensurePathWithinWorkspaceMock: vi.fn(),
  killAllProcessesForWorktreeMock: vi.fn(),
  clearProviderPtyStateMock: vi.fn(),
  getLocalPtyProviderMock: vi.fn(),
  deleteWorktreeHistoryDirMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: handleMock,
    removeHandler: removeHandlerMock
  }
}))

vi.mock('../git/worktree', () => ({
  listWorktrees: listWorktreesMock,
  listWorktreesStrict: listWorktreesMock,
  assertWorktreeCleanForRemoval: assertWorktreeCleanForRemovalMock,
  addWorktree: addWorktreeMock,
  removeWorktree: removeWorktreeMock
}))

vi.mock('../git/runner', () => ({
  // Why: createLocalWorktree now fires `git fetch` via gitExecFileAsync in the
  // background. Return a resolved promise so the fire-and-forget `.catch()`
  // chain has a valid Promise to attach to.
  gitExecFileAsync: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
  gitExecFileSync: vi.fn()
}))

vi.mock('../git/repo', () => ({
  getDefaultBaseRef: getDefaultBaseRefMock,
  resolveDefaultBaseRefWithLocalGit: resolveDefaultBaseRefWithLocalGitMock,
  resolveDefaultBaseRefViaExec: resolveDefaultBaseRefViaExecMock,
  getBranchConflictKind: getBranchConflictKindMock
}))

vi.mock('../git/git-username', async () => {
  const actual = await vi.importActual<typeof GitUsernameModule>('../git/git-username')
  return { ...actual, resolveLocalGitUsername: resolveLocalGitUsernameMock }
})

vi.mock('../github/client', () => ({
  getPRForBranch: getPRForBranchMock,
  createGitHubPullRequest: createGitHubPullRequestMock
}))

vi.mock('../hooks', () => ({
  createIssueCommandRunnerScript: createIssueCommandRunnerScriptMock,
  createSetupRunnerScript: createSetupRunnerScriptMock,
  getEffectiveHooks: getEffectiveHooksMock,
  getEffectiveHooksThroughFilesystemHost: getEffectiveHooksMock,
  getEffectiveHooksFromConfig: getEffectiveHooksFromConfigMock,
  getDefaultTabsLaunch: getDefaultTabsLaunchMock,
  loadHooks: loadHooksMock,
  loadHooksThroughFilesystemHost: loadHooksMock,
  runHook: runHookMock,
  hasHooksFile: hasHooksFileMock,
  resolveSetupRunnerShell: resolveSetupRunnerShellMock,
  shouldRunSetupForCreate: shouldRunSetupForCreateMock
}))

vi.mock('../runtime/worktree-teardown', () => ({
  killAllProcessesForWorktree: killAllProcessesForWorktreeMock
}))

vi.mock('./pty', () => ({
  clearProviderPtyState: clearProviderPtyStateMock,
  getLocalPtyProvider: getLocalPtyProviderMock
}))

vi.mock('../terminal-history-deletion', () => ({
  deleteWorktreeHistoryDir: deleteWorktreeHistoryDirMock
}))

vi.mock('./worktree-logic', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    computeWorktreePath: computeWorktreePathMock,
    ensurePathWithinWorkspace: ensurePathWithinWorkspaceMock
  }
})

import { registerWorktreeHandlers } from './worktrees'

type HandlerMap = Record<string, (_event: unknown, args: unknown) => unknown>

describe('registerWorktreeHandlers – Windows path handling', () => {
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
    getProjects: vi.fn(),
    getProjectHostSetups: vi.fn(),
    getSettings: vi.fn(),
    getWorktreeMeta: vi.fn(),
    setWorktreeMeta: vi.fn(),
    removeWorktreeMeta: vi.fn()
  }

  beforeEach(() => {
    handleMock.mockReset()
    removeHandlerMock.mockReset()
    listWorktreesMock.mockReset()
    assertWorktreeCleanForRemovalMock.mockReset()
    addWorktreeMock.mockReset()
    removeWorktreeMock.mockReset()
    resolveLocalGitUsernameMock.mockReset()
    getDefaultBaseRefMock.mockReset()
    resolveDefaultBaseRefWithLocalGitMock.mockReset()
    resolveDefaultBaseRefViaExecMock.mockReset()
    getBranchConflictKindMock.mockReset()
    getPRForBranchMock.mockReset()
    createGitHubPullRequestMock.mockReset()
    getEffectiveHooksMock.mockReset()
    getEffectiveHooksFromConfigMock.mockReset()
    getDefaultTabsLaunchMock.mockReset()
    createIssueCommandRunnerScriptMock.mockReset()
    createSetupRunnerScriptMock.mockReset()
    resolveSetupRunnerShellMock.mockReset()
    shouldRunSetupForCreateMock.mockReset()
    runHookMock.mockReset()
    hasHooksFileMock.mockReset()
    loadHooksMock.mockReset()
    computeWorktreePathMock.mockReset()
    ensurePathWithinWorkspaceMock.mockReset()
    killAllProcessesForWorktreeMock.mockReset()
    clearProviderPtyStateMock.mockReset()
    getLocalPtyProviderMock.mockReset()
    deleteWorktreeHistoryDirMock.mockReset()
    mainWindow.webContents.send.mockReset()
    store.getRepos.mockReset()
    store.getRepo.mockReset()
    store.getProjects.mockReset()
    store.getProjectHostSetups.mockReset()
    store.getSettings.mockReset()
    store.getWorktreeMeta.mockReset()
    store.setWorktreeMeta.mockReset()
    store.removeWorktreeMeta.mockReset()

    for (const key of Object.keys(handlers)) {
      delete handlers[key]
    }

    handleMock.mockImplementation((channel, handler) => {
      handlers[channel] = handler
    })

    store.getRepos.mockReturnValue([
      {
        id: 'repo-1',
        path: 'C:\\repo',
        displayName: 'repo',
        badgeColor: '#000',
        addedAt: 0
      }
    ])
    store.getRepo.mockReturnValue({
      id: 'repo-1',
      path: 'C:\\repo',
      displayName: 'repo',
      badgeColor: '#000',
      addedAt: 0,
      worktreeBaseRef: null
    })
    store.getProjects.mockReturnValue([])
    store.getProjectHostSetups.mockReturnValue([])
    store.getSettings.mockReturnValue({
      branchPrefix: 'none',
      nestWorkspaces: false,
      refreshLocalBaseRefOnWorktreeCreate: false,
      workspaceDir: 'C:\\workspaces'
    })
    resolveSetupRunnerShellMock.mockReturnValue(undefined)
    store.getWorktreeMeta.mockReturnValue(undefined)
    store.setWorktreeMeta.mockReturnValue({})
    resolveLocalGitUsernameMock.mockResolvedValue('')
    getDefaultBaseRefMock.mockReturnValue('origin/main')
    resolveDefaultBaseRefWithLocalGitMock.mockResolvedValue('origin/main')
    resolveDefaultBaseRefViaExecMock.mockResolvedValue('origin/main')
    getBranchConflictKindMock.mockResolvedValue(null)
    getPRForBranchMock.mockResolvedValue(null)
    getEffectiveHooksMock.mockReturnValue(null)
    getEffectiveHooksFromConfigMock.mockReturnValue(null)
    getDefaultTabsLaunchMock.mockReturnValue(undefined)
    shouldRunSetupForCreateMock.mockReturnValue(false)
    computeWorktreePathMock.mockReturnValue('C:\\workspaces\\improve-dashboard')
    ensurePathWithinWorkspaceMock.mockReturnValue('C:\\workspaces\\improve-dashboard')
    listWorktreesMock.mockResolvedValue([])
    assertWorktreeCleanForRemovalMock.mockResolvedValue(undefined)
    killAllProcessesForWorktreeMock.mockResolvedValue({
      runtimeStopped: 0,
      providerStopped: 0,
      registryStopped: 0
    })
    getLocalPtyProviderMock.mockReturnValue({})

    // Why: createLocalWorktree routes `git fetch` through
    // `runtime.fetchRemoteWithCache` (§3.3 Lifecycle). Stub it for path tests.
    const runtimeStub = {
      resolveRemoteTrackingBase: vi.fn().mockResolvedValue(null),
      hasRemoteTrackingRef: vi.fn().mockResolvedValue(false),
      getOrStartRemoteTrackingBaseRefresh: vi.fn().mockResolvedValue({ ok: true }),
      getOrStartRemoteFetch: vi.fn().mockResolvedValue({ ok: true }),
      fetchRemoteWithCache: vi.fn().mockResolvedValue(undefined),
      emitWorktreeBaseStatus: vi.fn(),
      recordOptimisticReconcileToken: vi.fn().mockReturnValue('token-1'),
      reconcileWorktreeBaseStatus: vi.fn(),
      clearOptimisticReconcileToken: vi.fn(),
      closeFileWatchersForRemoval: vi.fn().mockResolvedValue(undefined),
      acquireFileWatcherRemoval: vi.fn().mockResolvedValue({
        finish: vi.fn().mockResolvedValue(undefined)
      })
    }
    registerWorktreeHandlers(mainWindow as never, store as never, runtimeStub as never)
  })

  it('accepts a newly created Windows worktree when git lists the same path with different separators', async () => {
    listWorktreesMock.mockResolvedValue([
      {
        path: 'C:/workspaces/improve-dashboard',
        head: 'abc123',
        branch: 'refs/heads/improve-dashboard',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const result = await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'improve-dashboard'
    })

    expect(addWorktreeMock).toHaveBeenCalledWith(
      'C:\\repo',
      'C:\\workspaces\\improve-dashboard',
      'improve-dashboard',
      'origin/main',
      false
    )
    expect(resolveLocalGitUsernameMock).not.toHaveBeenCalled()
    expect(store.setWorktreeMeta).toHaveBeenCalledWith(
      'repo-1::C:/workspaces/improve-dashboard',
      expect.objectContaining({
        lastActivityAt: expect.any(Number)
      })
    )
    expect(result).toMatchObject({
      worktree: expect.objectContaining({
        id: 'repo-1::C:/workspaces/improve-dashboard',
        path: 'C:/workspaces/improve-dashboard',
        branch: 'refs/heads/improve-dashboard'
      })
    })
  })

  it('resolves the Git username when the configured prefix consumes it', async () => {
    store.getSettings.mockReturnValue({
      branchPrefix: 'git-username',
      nestWorkspaces: false,
      refreshLocalBaseRefOnWorktreeCreate: false,
      workspaceDir: 'C:\\workspaces'
    })
    resolveLocalGitUsernameMock.mockResolvedValue('octocat')
    listWorktreesMock.mockResolvedValue([
      {
        path: 'C:/workspaces/improve-dashboard',
        head: 'abc123',
        branch: 'refs/heads/octocat/improve-dashboard',
        isBare: false,
        isMainWorktree: false
      }
    ])

    await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'improve-dashboard'
    })

    expect(resolveLocalGitUsernameMock).toHaveBeenCalledWith('C:\\repo')
    expect(addWorktreeMock).toHaveBeenCalledWith(
      'C:\\repo',
      'C:\\workspaces\\improve-dashboard',
      'octocat/improve-dashboard',
      'origin/main',
      false
    )
  })

  it('passes the configured Windows setup shell into local setup runner generation', async () => {
    const setupShell = { family: 'posix' as const }
    store.getSettings.mockReturnValue({
      branchPrefix: 'none',
      nestWorkspaces: false,
      refreshLocalBaseRefOnWorktreeCreate: false,
      terminalWindowsShell: 'git-bash',
      workspaceDir: 'C:\\workspaces'
    })
    resolveSetupRunnerShellMock.mockReturnValue(setupShell)
    listWorktreesMock.mockResolvedValue([
      {
        path: 'C:/workspaces/improve-dashboard',
        head: 'abc123',
        branch: 'refs/heads/improve-dashboard',
        isBare: false,
        isMainWorktree: false
      }
    ])
    getEffectiveHooksMock.mockReturnValue({ scripts: { setup: 'pnpm install' } })
    getEffectiveHooksFromConfigMock.mockReturnValue({ scripts: { setup: 'pnpm install' } })
    shouldRunSetupForCreateMock.mockReturnValue(true)
    createSetupRunnerScriptMock.mockReturnValue({
      runnerScriptPath: 'C:\\repo\\.git\\orca\\setup-runner.sh',
      shell: setupShell,
      envVars: {
        ORCA_ROOT_PATH: 'C:\\repo',
        ORCA_WORKTREE_PATH: 'C:\\workspaces\\improve-dashboard'
      }
    })

    const result = await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'improve-dashboard',
      setupDecision: 'run'
    })

    expect(resolveSetupRunnerShellMock).toHaveBeenCalledWith(
      expect.objectContaining({ terminalWindowsShell: 'git-bash' })
    )
    expect(createSetupRunnerScriptMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'repo-1' }),
      'C:\\workspaces\\improve-dashboard',
      'pnpm install',
      undefined,
      setupShell
    )
    expect(result).toMatchObject({
      setup: {
        runnerScriptPath: 'C:\\repo\\.git\\orca\\setup-runner.sh',
        shell: setupShell
      }
    })
  })

  it('preserves create-time metadata on the next list when Windows path formatting differs', async () => {
    const worktreeEntry = {
      path: 'C:/workspaces/improve-dashboard',
      head: 'abc123',
      branch: 'refs/heads/improve-dashboard',
      isBare: false,
      isMainWorktree: false
    }
    // Two calls: (1) worktrees:create finds the new worktree,
    // (2) worktrees:list enumerates worktrees again.
    listWorktreesMock.mockResolvedValueOnce([worktreeEntry]).mockResolvedValueOnce([worktreeEntry])
    store.setWorktreeMeta.mockReturnValue({
      lastActivityAt: 123,
      displayName: 'Improve Dashboard',
      linkedIssue: 123,
      linkedPR: 456
    })
    store.getWorktreeMeta.mockImplementation((worktreeId: string) =>
      worktreeId === 'repo-1::C:/workspaces/improve-dashboard'
        ? {
            lastActivityAt: 123,
            displayName: 'Improve Dashboard',
            linkedIssue: 123,
            linkedPR: 456
          }
        : undefined
    )

    await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'Improve Dashboard',
      linkedIssue: 123,
      linkedPR: 456
    })
    const listed = await handlers['worktrees:list'](null, {
      repoId: 'repo-1'
    })

    expect(listed).toMatchObject([
      {
        id: 'repo-1::C:/workspaces/improve-dashboard',
        displayName: 'Improve Dashboard',
        linkedIssue: 123,
        linkedPR: 456,
        lastActivityAt: 123
      }
    ])
  })

  it('deletes a Windows worktree when the requested path uses different separators and drive casing', async () => {
    const registeredWorktree = {
      path: 'c:\\workspaces\\Improve-Dashboard',
      head: 'feature-head',
      branch: 'refs/heads/improve-dashboard',
      isBare: false,
      isMainWorktree: false
    }
    listWorktreesMock.mockResolvedValue([
      {
        path: 'C:\\repo',
        head: 'main-head',
        branch: 'refs/heads/main',
        isBare: false,
        isMainWorktree: true
      },
      registeredWorktree
    ])
    removeWorktreeMock.mockResolvedValue({})

    await handlers['worktrees:remove'](null, {
      worktreeId: 'repo-1::C:/workspaces/improve-dashboard'
    })

    expect(assertWorktreeCleanForRemovalMock).toHaveBeenCalledWith(registeredWorktree.path, false)
    expect(removeWorktreeMock).toHaveBeenCalledWith(
      'C:\\repo',
      registeredWorktree.path,
      false,
      expect.objectContaining({
        knownRemovedWorktree: registeredWorktree
      })
    )
    expect(store.removeWorktreeMeta).toHaveBeenCalledWith(
      'repo-1::C:/workspaces/improve-dashboard',
      'local'
    )
    // Windows history lives under a path-derived hash, so scheduling must not regress on this path only.
    expect(deleteWorktreeHistoryDirMock).toHaveBeenCalledWith(
      'repo-1::C:/workspaces/improve-dashboard'
    )
    expect(mainWindow.webContents.send).toHaveBeenCalledWith('worktrees:changed', {
      repoId: 'repo-1'
    })
  })
  it('gives the issue-command runner the same setup shell as the setup runner', () => {
    // Regression (C4): native Windows issue runners stayed .cmd even when setup
    // resolved to Git Bash, so same-session bash issue templates broke.
    resolveSetupRunnerShellMock.mockReturnValue({ family: 'posix' })
    createIssueCommandRunnerScriptMock.mockReturnValue({
      runnerScriptPath: 'C:\\repo\\.git\\orca\\issue-command-runner.sh',
      envVars: {},
      shell: { family: 'posix' }
    })

    handlers['hooks:createIssueCommandRunner'](null, {
      repoId: 'repo-1',
      worktreePath: 'C:\\workspaces\\improve-dashboard',
      command: 'gh issue view 42'
    })

    expect(resolveSetupRunnerShellMock).toHaveBeenCalledWith(store.getSettings())
    expect(createIssueCommandRunnerScriptMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'repo-1' }),
      'C:\\workspaces\\improve-dashboard',
      'gh issue view 42',
      expect.anything(),
      { family: 'posix' }
    )
  })
})
