import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GitUsernameModule from '../git/git-username'
import type { DetectedWorktreeListResult, GitWorktreeInfo } from '../../shared/types'

const {
  handleMock,
  removeHandlerMock,
  listWorktreesMock,
  listWorktreesStrictMock,
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
  listWorktreesStrictMock: vi.fn(),
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
  listWorktreesStrict: listWorktreesStrictMock,
  assertWorktreeCleanForRemoval: assertWorktreeCleanForRemovalMock,
  addWorktree: addWorktreeMock,
  removeWorktree: removeWorktreeMock
}))

vi.mock('../git/runner', () => ({
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
  getEffectiveHooksFromConfig: getEffectiveHooksFromConfigMock,
  getDefaultTabsLaunch: getDefaultTabsLaunchMock,
  loadHooks: loadHooksMock,
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

import {
  __getDetectedWorktreeScanCacheStatsForTests,
  __resetDetectedWorktreeScanCacheForTests,
  registerWorktreeHandlers
} from './worktrees'

type HandlerMap = Record<string, (_event: unknown, args: unknown) => unknown>

const MAIN_WORKTREE: GitWorktreeInfo = {
  path: 'C:/repo',
  head: 'abc123',
  branch: 'refs/heads/main',
  isBare: false,
  isMainWorktree: true
}

const FEATURE_WORKTREE: GitWorktreeInfo = {
  path: 'C:/workspaces/feature',
  head: 'def456',
  branch: 'refs/heads/feature',
  isBare: false,
  isMainWorktree: false
}

describe('listDetected local/WSL discovery failures', () => {
  const handlers: HandlerMap = {}
  const originalPlatform = process.platform
  let warnSpy: ReturnType<typeof vi.spyOn>
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
    getAllWorktreeMeta: vi.fn(),
    setWorktreeMeta: vi.fn(),
    removeWorktreeMeta: vi.fn(),
    getAllWorktreeLineage: vi.fn(),
    removeWorktreeLineage: vi.fn(),
    getAllWorkspaceLineage: vi.fn(),
    removeWorkspaceLineage: vi.fn()
  }

  function setPlatform(platform: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: platform
    })
  }

  function localRepo(path = 'C:\\repo') {
    return {
      id: 'repo-1',
      path,
      displayName: 'repo',
      badgeColor: '#000',
      addedAt: 0,
      worktreeBaseRef: null
    }
  }

  function mockWslProjectRuntime(): void {
    store.getProjects.mockReturnValue([
      {
        id: 'project-1',
        displayName: 'repo',
        badgeColor: '#000',
        sourceRepoIds: ['repo-1'],
        localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' },
        createdAt: 0,
        updatedAt: 0
      }
    ])
  }

  async function listDetected(): Promise<DetectedWorktreeListResult> {
    return (await handlers['worktrees:listDetected'](null, {
      repoId: 'repo-1'
    })) as DetectedWorktreeListResult
  }

  beforeEach(() => {
    setPlatform('win32')
    __resetDetectedWorktreeScanCacheForTests()
    for (const mock of [
      handleMock,
      removeHandlerMock,
      listWorktreesMock,
      listWorktreesStrictMock,
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
      deleteWorktreeHistoryDirMock,
      mainWindow.webContents.send,
      store.getRepos,
      store.getRepo,
      store.getProjects,
      store.getProjectHostSetups,
      store.getSettings,
      store.getWorktreeMeta,
      store.getAllWorktreeMeta,
      store.setWorktreeMeta,
      store.removeWorktreeMeta,
      store.getAllWorktreeLineage,
      store.removeWorktreeLineage,
      store.getAllWorkspaceLineage,
      store.removeWorkspaceLineage
    ]) {
      mock.mockReset()
    }

    for (const key of Object.keys(handlers)) {
      delete handlers[key]
    }
    handleMock.mockImplementation((channel, handler) => {
      handlers[channel] = handler
    })

    const repo = localRepo()
    store.getRepos.mockReturnValue([repo])
    store.getRepo.mockReturnValue(repo)
    store.getProjects.mockReturnValue([])
    store.getProjectHostSetups.mockReturnValue([])
    store.getSettings.mockReturnValue({
      branchPrefix: 'none',
      nestWorkspaces: false,
      refreshLocalBaseRefOnWorktreeCreate: false,
      workspaceDir: 'C:\\workspaces'
    })
    store.getWorktreeMeta.mockReturnValue(undefined)
    store.getAllWorktreeMeta.mockReturnValue({})
    store.setWorktreeMeta.mockReturnValue({})
    store.getAllWorktreeLineage.mockReturnValue({
      'repo-1::C:/workspaces/feature': {
        worktreeId: 'repo-1::C:/workspaces/feature',
        worktreeInstanceId: 'child-instance',
        parentWorktreeId: 'repo-1::C:/repo',
        parentWorktreeInstanceId: 'parent-instance',
        origin: 'agent',
        capture: 'env-workspace',
        createdAt: 1
      }
    })
    store.getAllWorkspaceLineage.mockReturnValue({})
    resolveSetupRunnerShellMock.mockReturnValue(undefined)
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
    listWorktreesMock.mockResolvedValue([])
    killAllProcessesForWorktreeMock.mockResolvedValue({
      runtimeStopped: 0,
      providerStopped: 0,
      registryStopped: 0
    })
    getLocalPtyProviderMock.mockReturnValue({})

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
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  afterEach(() => {
    warnSpy.mockRestore()
    setPlatform(originalPlatform)
  })

  it.each([
    ['wsl.exe timed out', new Error('wsl.exe timed out')],
    [
      'missing repo path',
      Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' })
    ],
    [
      'not a git repository',
      new Error('fatal: not a git repository (or any of the parent directories): .git')
    ]
  ])('keeps a %s local scan non-authoritative and uncached', async (_label, error) => {
    listWorktreesStrictMock.mockRejectedValue(error)

    const result = await listDetected()

    expect(result).toMatchObject({
      repoId: 'repo-1',
      authoritative: false,
      source: 'metadata-fallback',
      worktrees: []
    })
    expect(listWorktreesStrictMock).toHaveBeenCalledWith('C:\\repo')
    expect(listWorktreesMock).not.toHaveBeenCalled()
    expect(__getDetectedWorktreeScanCacheStatsForTests()).toEqual({
      cacheSize: 0,
      inFlightSize: 0
    })
    expect(store.removeWorktreeLineage).not.toHaveBeenCalled()
  })

  it('keeps a WSL timeout non-authoritative and scoped to the selected distro', async () => {
    mockWslProjectRuntime()
    listWorktreesStrictMock.mockRejectedValue(new Error('wsl.exe timed out'))

    const result = await listDetected()

    expect(result).toMatchObject({
      repoId: 'repo-1',
      authoritative: false,
      source: 'metadata-fallback',
      worktrees: []
    })
    expect(listWorktreesStrictMock).toHaveBeenCalledWith('C:\\repo', { wslDistro: 'Ubuntu' })
    expect(listWorktreesMock).not.toHaveBeenCalled()
    expect(__getDetectedWorktreeScanCacheStatsForTests()).toEqual({
      cacheSize: 0,
      inFlightSize: 0
    })
  })

  it('republishes recovered worktrees after a failed local scan', async () => {
    listWorktreesStrictMock
      .mockRejectedValueOnce(new Error('wsl.exe timed out'))
      .mockResolvedValueOnce([MAIN_WORKTREE, FEATURE_WORKTREE])

    const failed = await listDetected()
    const recovered = await listDetected()

    expect(failed.authoritative).toBe(false)
    expect(recovered).toMatchObject({
      repoId: 'repo-1',
      authoritative: true,
      source: 'git',
      worktrees: [
        expect.objectContaining({ path: MAIN_WORKTREE.path }),
        expect.objectContaining({ path: FEATURE_WORKTREE.path })
      ]
    })
    expect(__getDetectedWorktreeScanCacheStatsForTests()).toEqual({
      cacheSize: 1,
      inFlightSize: 0
    })
  })

  it('does not let a later success reuse a failed scan as a cached empty catalog', async () => {
    listWorktreesStrictMock.mockRejectedValue(new Error('spawn git EAGAIN'))
    await listDetected()
    expect(__getDetectedWorktreeScanCacheStatsForTests().cacheSize).toBe(0)

    listWorktreesStrictMock.mockResolvedValue([MAIN_WORKTREE])
    const recovered = await listDetected()

    expect(recovered.authoritative).toBe(true)
    expect(recovered.worktrees).toEqual([
      expect.objectContaining({ path: MAIN_WORKTREE.path, isMainWorktree: true })
    ])
    expect(listWorktreesStrictMock).toHaveBeenCalledTimes(2)
  })
})
