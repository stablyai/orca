import { __resetSshWorktreeCreateFetchCacheForTests } from './worktree-remote'
import { invalidateAuthorizedRootsCache } from './registered-worktree-roots-cache'
import { __resetDetectedWorktreeScanCacheForTests, registerWorktreeHandlers } from './worktrees'
import { clearConfiguredWorktreeSharedDirectoriesCacheForTests } from '../git/worktree-shared-directories'
import { resetRetirementCollisionKeyCacheForTests } from '../worktree-name-retirement'
import { resetSshProviderAuthorities } from '../ssh/ssh-provider-authority'
import { createWorktreeRuntimeStub, type WorktreeRuntimeStub } from './worktrees-test-runtime-stub'
import { handlers, mainWindow, store } from './worktrees-test-ipc-surface'
import {
  ORIGINAL_PLATFORM,
  setPlatform,
  removeWorktreeLinkedPathsMock,
  findExistingWorktreeSymlinkPathsMock,
  handleMock,
  removeHandlerMock,
  listWorktreesMock,
  assertWorktreeCleanForRemovalMock,
  addWorktreeMock,
  addSparseWorktreeMock,
  removeWorktreeMock,
  forceDeleteLocalBranchMock,
  resolveLocalGitUsernameMock,
  getBaseRefDefaultMock,
  resolveDefaultBaseRefWithLocalGitMock,
  resolveDefaultBaseRefViaExecMock,
  getDefaultRemoteMock,
  getBranchConflictKindMock,
  getPRForBranchMock,
  getHostedReviewForBranchMock,
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
  resolveSetupRunnerShellMock,
  runHookMock,
  hasHooksFileMock,
  loadHooksMock,
  computeWorktreePathMock,
  ensurePathWithinWorkspaceMock,
  gitExecFileAsyncMock,
  getSshGitProviderMock,
  getSshFilesystemProviderMock,
  getActiveMultiplexerMock,
  deleteWorktreeHistoryDirMock,
  advertisedUrlWatcherForgetWorktreeMock,
  pruneCleanupScanSnapshotMock,
  pruneCleanupScanSnapshotsMock,
  pruneSpaceAnalysisSnapshotMock,
  pruneSpaceAnalysisSnapshotsMock,
  recordRemovalSnapshotPruneMock,
  killAllProcessesForWorktreeMock,
  clearProviderPtyStateMock,
  getLocalPtyProviderMock,
  getSshPtyProviderMock
} from './worktrees-test-module-mocks'

export {
  handlers,
  ipcEvent,
  mainWindow,
  store,
  type HandlerMap
} from './worktrees-test-ipc-surface'

/** Registers worktree IPC handlers against freshly reset shared mocks and returns the runtime stub. */
export function setupWorktreeHandlers(): WorktreeRuntimeStub {
  setPlatform(ORIGINAL_PLATFORM)
  clearConfiguredWorktreeSharedDirectoriesCacheForTests()
  __resetSshWorktreeCreateFetchCacheForTests()
  __resetDetectedWorktreeScanCacheForTests()
  resetSshProviderAuthorities()
  invalidateAuthorizedRootsCache()
  for (const m of [
    handleMock,
    removeHandlerMock,
    listWorktreesMock,
    assertWorktreeCleanForRemovalMock,
    addWorktreeMock,
    addSparseWorktreeMock,
    removeWorktreeMock,
    forceDeleteLocalBranchMock,
    resolveLocalGitUsernameMock,
    getBaseRefDefaultMock,
    resolveDefaultBaseRefWithLocalGitMock,
    resolveDefaultBaseRefViaExecMock,
    getDefaultRemoteMock,
    getBranchConflictKindMock,
    getPRForBranchMock,
    getHostedReviewForBranchMock,
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
    resolveSetupRunnerShellMock,
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
    store.getProjects,
    store.getSparsePresets,
    store.getSettings,
    store.getWorktreeMeta,
    store.getAllWorktreeMeta,
    store.setWorktreeMeta,
    store.getProjectHostSetups,
    store.removeWorktreeMeta,
    store.removeWorkspaceSessionStateForWorktree,
    store.getAllWorktreeLineage,
    store.removeWorktreeLineage,
    store.getAllWorkspaceLineage,
    store.getFolderWorkspaces,
    store.getProjectGroups,
    store.addRetiredWorktreeName,
    store.getRetiredWorktreeNameRegistry,
    store.mergeRetiredWorktreeNames,
    killAllProcessesForWorktreeMock,
    clearProviderPtyStateMock,
    getLocalPtyProviderMock,
    getSshPtyProviderMock,
    deleteWorktreeHistoryDirMock,
    advertisedUrlWatcherForgetWorktreeMock,
    pruneCleanupScanSnapshotMock,
    pruneCleanupScanSnapshotsMock,
    pruneSpaceAnalysisSnapshotMock,
    pruneSpaceAnalysisSnapshotsMock,
    recordRemovalSnapshotPruneMock,
    findExistingWorktreeSymlinkPathsMock,
    removeWorktreeLinkedPathsMock
  ]) {
    m.mockReset()
  }
  killAllProcessesForWorktreeMock.mockResolvedValue({
    runtimeStopped: 0,
    providerStopped: 0,
    registryStopped: 0
  })
  assertWorktreeCleanForRemovalMock.mockResolvedValue(undefined)
  findExistingWorktreeSymlinkPathsMock.mockResolvedValue([])
  getLocalPtyProviderMock.mockReturnValue({} as never)
  getSshPtyProviderMock.mockReturnValue({} as never)

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
  store.getProjects.mockReturnValue([])
  store.getSparsePresets.mockReturnValue([])
  store.getSettings.mockReturnValue({
    branchPrefix: 'none',
    nestWorkspaces: false,
    refreshLocalBaseRefOnWorktreeCreate: false,
    workspaceDir: '/workspace'
  })
  store.getWorktreeMeta.mockReturnValue(undefined)
  store.getAllWorktreeMeta.mockReturnValue({})
  store.getRetiredWorktreeNameRegistry.mockReturnValue({ exhaustedTiers: 0, names: [] })
  resetRetirementCollisionKeyCacheForTests()
  store.setWorktreeMeta.mockReturnValue({})
  store.getProjectHostSetups.mockReturnValue([
    {
      id: 'repo-1',
      projectId: 'repo:repo-1',
      hostId: 'local',
      repoId: 'repo-1',
      path: '/workspace/repo',
      displayName: 'repo',
      setupState: 'ready',
      setupMethod: 'legacy-repo',
      createdAt: 0,
      updatedAt: 0
    }
  ])
  store.getAllWorktreeLineage.mockReturnValue({})
  store.getAllWorkspaceLineage.mockReturnValue({})
  store.getFolderWorkspaces.mockReturnValue([])
  store.getProjectGroups.mockReturnValue([])
  resolveLocalGitUsernameMock.mockResolvedValue('')
  getBaseRefDefaultMock.mockResolvedValue('origin/main')
  resolveDefaultBaseRefWithLocalGitMock.mockResolvedValue('origin/main')
  resolveDefaultBaseRefViaExecMock.mockResolvedValue('origin/main')
  getDefaultRemoteMock.mockResolvedValue('origin')
  getBranchConflictKindMock.mockResolvedValue(null)
  getPRForBranchMock.mockResolvedValue(null)
  getHostedReviewForBranchMock.mockResolvedValue(null)
  getWorkItemMock.mockResolvedValue(null)
  getPullRequestPushTargetMock.mockResolvedValue(null)
  // Why: createLocalWorktree can still hit the legacy git fetch fallback here; resolve so catch/then chains don't trip on undefined.
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
  resolveSetupRunnerShellMock.mockReturnValue(undefined)
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
  const runtimeStub = createWorktreeRuntimeStub()
  registerWorktreeHandlers(mainWindow as never, store as never, runtimeStub as never)
  return runtimeStub
}
