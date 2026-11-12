import './runtime-test-module-registration.spec'
import {
  MOCK_GIT_WORKTREES,
  addGitHubIssueCommentMock,
  addGitHubPRReviewCommentMock,
  addGitHubPRReviewCommentReplyMock,
  addGitLabIssueCommentMock,
  addGitLabMRCommentMock,
  addGitLabMRInlineCommentMock,
  applyAgentStatusHooksEnabledMock,
  closeGitLabMRMock,
  closeLocalWatcherForWorktreePathMock,
  computeWorktreePathMock,
  countGitHubWorkItemsMock,
  createGitHubIssueMock,
  createGitLabIssueMock,
  createHostedReviewMock,
  createStackedHostedReviewMock,
  detectInstalledAgentsWithShellPathHydrationMock,
  electronMocks,
  ensurePathWithinWorkspaceMock,
  findExistingWorktreeSymlinkPathsMock,
  forceDeleteLocalBranchMock,
  forgetLocalWatcherRemovalSnapshotMock,
  getGitHubPRCheckDetailsMock,
  getGitHubPRChecksMock,
  getGitHubPRCommentsMock,
  getGitHubPRFileContentsMock,
  getGitHubWorkItemByOwnerRepoMock,
  getGitHubWorkItemDetailsMock,
  getGitHubWorkItemMock,
  getGitLabJobTraceMock,
  getGitLabProjectRefForRemoteMock,
  getGitLabWorkItemByProjectRefMock,
  getGitLabWorkItemDetailsMock,
  getGlabKnownHostsMock,
  getHostedReviewCreationEligibilityMock,
  getHostedReviewForBranchMock,
  getIssueMock,
  getPRForBranchMock,
  getPRForBranchOutcomeMock,
  getPullRequestPushTargetMock,
  getRepoSlugMock,
  getRepoUpstreamMock,
  invalidateAuthorizedRootsCacheMock,
  listGitHubAssignableUsersMock,
  listGitHubIssuesMock,
  listGitHubLabelsMock,
  listGitHubWorkItemsMock,
  listGitLabIssuesMock,
  listGitLabLabelsMock,
  listGitLabMergeRequestsMock,
  listGitLabTodosMock,
  listGitLabWorkItemsMock,
  markCodexProjectTrustedMock,
  markCopilotFolderTrustedMock,
  markCursorWorkspaceTrustedMock,
  mergeGitHubPRMock,
  mergeGitLabMRMock,
  prepareLocalWorktreeRootForRepoMock,
  removeGitHubPRReviewersMock,
  removeWorktreeLinkedPathsMock,
  reopenGitLabMRMock,
  requestGitHubPRReviewersMock,
  rerunGitHubPRChecksMock,
  resetPlatform,
  resolveGitHubReviewThreadMock,
  resolveGitLabMRDiscussionMock,
  resolveLocalGitUsernameMock,
  restoreLocalWatcherAfterFailedRemovalMock,
  retryGitLabJobMock,
  scanLocalRepoWorktreesForResolutionMock,
  setGitHubPRAutoMergeMock,
  setGitHubPRFileViewedMock,
  updateGitHubIssueMock,
  updateGitHubPRDetailsMock,
  updateGitHubPRStateMock,
  updateGitHubPRTitleMock,
  updateGitLabIssueMock,
  updateGitLabMRMock,
  updateGitLabMRReviewersMock
} from '../orca-runtime-test-mocks/setup.spec'
import { RuntimeBrowserCommands } from '../browser/commands/browser-commands'
import { _resetTerminalViewAttributesForTest } from '../terminal/view/terminal-view-attribute-store'
import { addSparseWorktree } from '../../git/worktrees/creation/worktree-sparse-add'
import { addWorktree } from '../../git/worktrees/creation/worktree-add'
import { advertisedUrlWatcher } from '../../ports/advertised-url-watcher'
import { afterAll, afterEach, beforeEach, vi, type MockInstance } from 'vitest'
import { initOrcaProfilePaths } from '../../orca-profiles/profile-storage-paths'
import { stopStructuredAgentSessionRuntime } from '../agent-session/structured-agent-session-runtime'
import { assertWorktreeCleanForRemoval } from '../../git/worktrees/removal/worktree-removal-preflight'
import { __cancelLegacyWorkerTerminalRecoveryRetriesForTests as cancelLegacyWorkerTerminalRecoveryRetriesForTests } from '../orchestration/terminal-authority/runtime-legacy-worker-terminal-recovery-controller'
import { clearConfiguredWorktreeSharedDirectoriesCacheForTests } from '../../git/worktrees/content-paths/worktree-shared-directories'
import {
  createSetupRunnerScript,
  resolveSetupRunnerShell
} from '../../workspace-hooks/worktree-runner-script'
import {
  describeCreatedWorktree,
  listWorktreesStrict
} from '../../git/worktrees/catalog/worktree-listing'
import {
  getDefaultTabsLaunch,
  getEffectiveHooksFromConfig,
  shouldRunSetupForCreate
} from '../../workspace-hooks/effective-hook-config'
import { getEffectiveHooks, hasHooksFile, loadHooks, runHook } from '../../workspace-hooks/hooks'
import { installFakeAppEnvironment } from '../../../../config/scripts/test-runtime/environment/vitest-host-ports-setup'
import {
  listWorktrees,
  listWorktreesSharedStrict
} from '../../git/worktrees/catalog/worktree-scan-cache'
import { parseOrcaYaml } from '../../../shared/orca-yaml'
import { removeWorktree } from '../../git/worktrees/removal/worktree-removal'
import {
  setRuntimeBrowserCommandsFactory,
  setRuntimeBrowserUnavailableCause
} from '../browser/installation/runtime-browser-commands-factory'
import { setRuntimeDesktopSurface } from '../construction/runtime-desktop-surface'
import { setRuntimeTerminalUnavailableCause } from '../terminal/launch/native-terminal-availability'
import { OrcaRuntimeService as runtimeMockOrcaRuntimeService } from '../orca-runtime'

import * as worktreeChangeInvalidators from '../../ipc/worktrees/listing/worktree-change-invalidators'
import { awaitBackgroundRemovalsInRuntimeTests } from '../workspaces/removal/orca-runtime-background-removal-test-support'
import { commitFakeSpawnsInRuntimeTests } from './bind-first-pane.test-fixture'
import {
  _resetPendingWorktreeRemovalsForTests,
  _settlePendingWorktreeRemovalsForTests
} from '../../workspaces/removal/worktree-background-removal'
import { _resetCanonicalRepoKeyCacheForTests } from '../../git/repositories/canonical-repo-key'

awaitBackgroundRemovalsInRuntimeTests(runtimeMockOrcaRuntimeService.prototype)
commitFakeSpawnsInRuntimeTests(runtimeMockOrcaRuntimeService.prototype)

function resetRuntimeTestMocks(): void {
  _resetCanonicalRepoKeyCacheForTests()
  _resetPendingWorktreeRemovalsForTests()
  // Chromium commands install only at Electron entry; Node hosts must refuse browser RPCs without them.
  setRuntimeBrowserCommandsFactory((host) => new RuntimeBrowserCommands(host), {
    clientHosting: true
  })
  setRuntimeBrowserUnavailableCause(null)
  setRuntimeTerminalUnavailableCause(null)
  // Runtime uses the injected desktop surface; Electron mocks alone cannot drive these assertions.
  setRuntimeDesktopSurface({
    showNotification: () => true,
    findWindowById: (id) => electronMocks.BrowserWindow.fromId(id) as never,
    onIpc: (channel, listener) => electronMocks.ipcMain.on(channel, listener as never),
    removeIpcListener: (channel, listener) =>
      electronMocks.ipcMain.removeListener(channel, listener as never)
  })
  resetPlatform()
  electronMocks.app.isPackaged = false
  // AppEnvironment owns runtime paths/package flag; delegate to Electron mocks to retain per-test toggles.
  installFakeAppEnvironment({
    getPath: () => electronMocks.app.getPath(),
    isPackaged: () => electronMocks.app.isPackaged
  })
  initOrcaProfilePaths()
  // Deferred worker recovery re-arms forever; cancel it before shared git stubs leak across cases.
  cancelLegacyWorkerTerminalRecoveryRetriesForTests()
  clearConfiguredWorktreeSharedDirectoriesCacheForTests()
  _resetTerminalViewAttributesForTest()
  advertisedUrlWatcher.clear()
  electronMocks.BrowserWindow.fromId.mockReset()
  electronMocks.BrowserWindow.fromId.mockReturnValue(null)
  electronMocks.webContents.fromId.mockReset()
  electronMocks.webContents.fromId.mockReturnValue(null)
  electronMocks.ipcMain.on.mockClear()
  electronMocks.ipcMain.removeListener.mockClear()
  electronMocks.ipcMain.emit.mockClear()
  closeLocalWatcherForWorktreePathMock.mockReset().mockResolvedValue(undefined)
  restoreLocalWatcherAfterFailedRemovalMock.mockReset().mockResolvedValue(undefined)
  forgetLocalWatcherRemovalSnapshotMock.mockReset()
  vi.mocked(listWorktrees).mockResolvedValue(MOCK_GIT_WORKTREES)
  vi.mocked(listWorktreesStrict).mockResolvedValue(MOCK_GIT_WORKTREES)
  vi.mocked(describeCreatedWorktree).mockResolvedValue(undefined)
  // Strict-create and listing reads share production repo state; delegate mocks so both see identical rows.
  vi.mocked(listWorktreesSharedStrict).mockImplementation((repoPath, options) =>
    options ? listWorktrees(repoPath, options) : listWorktrees(repoPath)
  )
  scanLocalRepoWorktreesForResolutionMock
    .mockReset()
    .mockImplementation(async (repoPath: string, options: { wslDistro?: string }) => {
      try {
        const worktrees = options.wslDistro
          ? await listWorktrees(repoPath, options)
          : await listWorktrees(repoPath)
        return { ok: true, worktrees }
      } catch {
        return { ok: false, worktrees: [] }
      }
    })
  vi.mocked(addWorktree).mockReset()
  vi.mocked(addSparseWorktree).mockReset()
  vi.mocked(assertWorktreeCleanForRemoval).mockReset()
  vi.mocked(assertWorktreeCleanForRemoval).mockResolvedValue(undefined)
  vi.mocked(removeWorktree).mockReset()
  findExistingWorktreeSymlinkPathsMock.mockReset().mockResolvedValue([])
  removeWorktreeLinkedPathsMock.mockReset()
  resolveLocalGitUsernameMock.mockReset().mockResolvedValue('')
  vi.mocked(forceDeleteLocalBranchMock).mockReset()
  vi.mocked(forceDeleteLocalBranchMock).mockResolvedValue(undefined)
  applyAgentStatusHooksEnabledMock.mockReset().mockResolvedValue([])
  vi.mocked(createSetupRunnerScript).mockReset()
  vi.mocked(getEffectiveHooks).mockReset()
  vi.mocked(getEffectiveHooksFromConfig).mockReset()
  vi.mocked(getDefaultTabsLaunch).mockReset()
  vi.mocked(loadHooks).mockReset()
  vi.mocked(resolveSetupRunnerShell).mockReset()
  vi.mocked(hasHooksFile).mockReset()
  vi.mocked(parseOrcaYaml).mockReset()
  vi.mocked(runHook).mockReset()
  vi.mocked(shouldRunSetupForCreate).mockReset()
  vi.mocked(shouldRunSetupForCreate).mockImplementation((_repo, decision) => decision === 'run')
  vi.mocked(getEffectiveHooks).mockReturnValue(null)
  // Setup derives effective hooks from the parsed orca.yaml; tests steer it through getEffectiveHooks.
  vi.mocked(getEffectiveHooksFromConfig).mockImplementation((repo) => getEffectiveHooks(repo))
  vi.mocked(getDefaultTabsLaunch).mockReturnValue(undefined)
  vi.mocked(loadHooks).mockReturnValue(null)
  vi.mocked(resolveSetupRunnerShell).mockReturnValue(undefined)
  vi.mocked(hasHooksFile).mockReturnValue(false)
  vi.mocked(parseOrcaYaml).mockReturnValue(null)
  computeWorktreePathMock.mockReset()
  ensurePathWithinWorkspaceMock.mockReset()
  invalidateAuthorizedRootsCacheMock.mockReset()
  prepareLocalWorktreeRootForRepoMock.mockReset().mockResolvedValue(undefined)
  createHostedReviewMock.mockReset()
  createHostedReviewMock.mockResolvedValue({
    ok: true,
    provider: 'github',
    number: 1,
    url: 'https://example.com/pull/1'
  })
  createStackedHostedReviewMock.mockReset()
  createStackedHostedReviewMock.mockResolvedValue({
    ok: true,
    number: 2,
    url: 'https://example.com/pull/2',
    stackNumber: 10,
    parentReview: { number: 1, url: 'https://example.com/pull/1' }
  })
  getHostedReviewCreationEligibilityMock.mockReset()
  getHostedReviewCreationEligibilityMock.mockResolvedValue({
    provider: 'github',
    review: null,
    canCreate: true,
    blockedReason: null,
    nextAction: null,
    defaultBaseRef: 'main',
    head: 'feature/foo',
    title: null,
    body: null
  })
  getHostedReviewForBranchMock.mockReset()
  getHostedReviewForBranchMock.mockResolvedValue(null)
  getPRForBranchMock.mockReset()
  getPRForBranchMock.mockResolvedValue(null)
  getPRForBranchOutcomeMock.mockReset()
  getPRForBranchOutcomeMock.mockResolvedValue({ kind: 'no-pr', fetchedAt: 0 })
  getRepoSlugMock.mockReset()
  getRepoSlugMock.mockResolvedValue(null)
  getRepoUpstreamMock.mockReset()
  getRepoUpstreamMock.mockResolvedValue(null)
  getGitHubWorkItemMock.mockReset()
  getGitHubWorkItemMock.mockResolvedValue(null)
  getPullRequestPushTargetMock.mockReset()
  getPullRequestPushTargetMock.mockResolvedValue(null)
  getGitHubWorkItemByOwnerRepoMock.mockReset()
  getGitHubWorkItemByOwnerRepoMock.mockResolvedValue(null)
  getGitHubWorkItemDetailsMock.mockReset()
  getGitHubWorkItemDetailsMock.mockResolvedValue(null)
  getGitHubPRFileContentsMock.mockReset()
  getGitHubPRFileContentsMock.mockResolvedValue({ original: '', modified: '' })
  getGitHubPRChecksMock.mockReset()
  getGitHubPRChecksMock.mockResolvedValue([])
  rerunGitHubPRChecksMock.mockReset()
  rerunGitHubPRChecksMock.mockResolvedValue({ ok: true, count: 0 })
  getGitHubPRCheckDetailsMock.mockReset()
  getGitHubPRCheckDetailsMock.mockResolvedValue(null)
  getGitHubPRCommentsMock.mockReset()
  getGitHubPRCommentsMock.mockResolvedValue([])
  resolveGitHubReviewThreadMock.mockReset()
  resolveGitHubReviewThreadMock.mockResolvedValue(true)
  setGitHubPRFileViewedMock.mockReset()
  setGitHubPRFileViewedMock.mockResolvedValue(true)
  updateGitHubPRTitleMock.mockReset()
  updateGitHubPRTitleMock.mockResolvedValue(true)
  updateGitHubPRDetailsMock.mockReset()
  updateGitHubPRDetailsMock.mockResolvedValue({ ok: true })
  mergeGitHubPRMock.mockReset()
  mergeGitHubPRMock.mockResolvedValue({ ok: true })
  setGitHubPRAutoMergeMock.mockReset()
  setGitHubPRAutoMergeMock.mockResolvedValue({ ok: true })
  updateGitHubPRStateMock.mockReset()
  updateGitHubPRStateMock.mockResolvedValue({ ok: true })
  requestGitHubPRReviewersMock.mockReset()
  requestGitHubPRReviewersMock.mockResolvedValue({ ok: true })
  removeGitHubPRReviewersMock.mockReset()
  removeGitHubPRReviewersMock.mockResolvedValue({ ok: true })
  addGitHubPRReviewCommentMock.mockReset()
  addGitHubPRReviewCommentMock.mockResolvedValue({ ok: true })
  addGitHubPRReviewCommentReplyMock.mockReset()
  addGitHubPRReviewCommentReplyMock.mockResolvedValue({ ok: true })
  listGitHubIssuesMock.mockReset()
  listGitHubIssuesMock.mockResolvedValue({ items: [] })
  listGitHubWorkItemsMock.mockReset()
  listGitHubWorkItemsMock.mockResolvedValue({ items: [] })
  countGitHubWorkItemsMock.mockReset()
  countGitHubWorkItemsMock.mockResolvedValue(0)
  createGitHubIssueMock.mockReset()
  createGitHubIssueMock.mockResolvedValue({ ok: true, number: 1, url: 'https://example.com/1' })
  updateGitHubIssueMock.mockReset()
  updateGitHubIssueMock.mockResolvedValue({ ok: true })
  addGitHubIssueCommentMock.mockReset()
  addGitHubIssueCommentMock.mockResolvedValue({ ok: true })
  listGitHubLabelsMock.mockReset()
  listGitHubLabelsMock.mockResolvedValue([])
  listGitHubAssignableUsersMock.mockReset()
  listGitHubAssignableUsersMock.mockResolvedValue([])
  detectInstalledAgentsWithShellPathHydrationMock.mockReset()
  detectInstalledAgentsWithShellPathHydrationMock.mockResolvedValue([])
  markCodexProjectTrustedMock.mockReset()
  markCopilotFolderTrustedMock.mockReset()
  markCursorWorkspaceTrustedMock.mockReset()
  listGitLabMergeRequestsMock.mockReset()
  listGitLabMergeRequestsMock.mockResolvedValue({ items: [] })
  listGitLabWorkItemsMock.mockReset()
  listGitLabWorkItemsMock.mockResolvedValue({ items: [] })
  listGitLabIssuesMock.mockReset()
  listGitLabIssuesMock.mockResolvedValue({ items: [] })
  listGitLabLabelsMock.mockReset()
  listGitLabLabelsMock.mockResolvedValue(['bug'])
  listGitLabTodosMock.mockReset()
  listGitLabTodosMock.mockResolvedValue([])
  getGitLabProjectRefForRemoteMock.mockReset()
  getGitLabProjectRefForRemoteMock.mockResolvedValue({ host: 'gitlab.example', path: 'group/repo' })
  getGlabKnownHostsMock.mockReset()
  getGlabKnownHostsMock.mockResolvedValue(['gitlab.com'])
  getGitLabWorkItemByProjectRefMock.mockReset()
  getGitLabWorkItemByProjectRefMock.mockResolvedValue(null)
  createGitLabIssueMock.mockReset()
  createGitLabIssueMock.mockResolvedValue({
    ok: true,
    number: 1,
    url: 'https://gitlab.example/i/1'
  })
  updateGitLabIssueMock.mockReset()
  updateGitLabIssueMock.mockResolvedValue({ ok: true })
  addGitLabIssueCommentMock.mockReset()
  addGitLabIssueCommentMock.mockResolvedValue({ ok: true })
  addGitLabMRCommentMock.mockReset()
  addGitLabMRCommentMock.mockResolvedValue({ ok: true })
  addGitLabMRInlineCommentMock.mockReset()
  addGitLabMRInlineCommentMock.mockResolvedValue({ ok: true })
  resolveGitLabMRDiscussionMock.mockReset()
  resolveGitLabMRDiscussionMock.mockResolvedValue({ ok: true })
  getGitLabJobTraceMock.mockReset()
  getGitLabJobTraceMock.mockResolvedValue({ ok: true, trace: 'log' })
  retryGitLabJobMock.mockReset()
  retryGitLabJobMock.mockResolvedValue({ ok: true })
  mergeGitLabMRMock.mockReset()
  mergeGitLabMRMock.mockResolvedValue({ ok: true })
  closeGitLabMRMock.mockReset()
  closeGitLabMRMock.mockResolvedValue({ ok: true })
  reopenGitLabMRMock.mockReset()
  reopenGitLabMRMock.mockResolvedValue({ ok: true })
  updateGitLabMRMock.mockReset()
  updateGitLabMRMock.mockResolvedValue({ ok: true })
  getGitLabWorkItemDetailsMock.mockReset()
  getGitLabWorkItemDetailsMock.mockResolvedValue({ body: 'Details' })
  updateGitLabMRReviewersMock.mockReset()
  updateGitLabMRReviewersMock.mockResolvedValue({ ok: true, reviewers: [] })
  getIssueMock.mockReset()
  getIssueMock.mockResolvedValue(null)
}

let registrationSpy:
  | MockInstance<typeof worktreeChangeInvalidators.registerWorktreeChangeInvalidator>
  | undefined

beforeEach(() => {
  resetRuntimeTestMocks()
  registrationSpy = vi.spyOn(worktreeChangeInvalidators, 'registerWorktreeChangeInvalidator')
})
afterEach(async () => {
  try {
    await _settlePendingWorktreeRemovalsForTests()
  } finally {
    try {
      for (const result of registrationSpy?.mock.results ?? []) {
        if (result.type === 'return') {
          result.value()
        }
      }
    } finally {
      registrationSpy?.mockRestore()
      registrationSpy = undefined
      resetRuntimeTestMocks()
    }
  }
})

export { resetRuntimeTestMocks }

afterAll(async () => {
  await stopStructuredAgentSessionRuntime()
})
