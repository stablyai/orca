import * as mocks from './orca-runtime-test-mocks.spec'

const { MOCK_GIT_WORKTREES, RuntimeBrowserCommands, _resetTerminalViewAttributesForTest } = mocks
const { addGitHubIssueCommentMock, addGitHubPRReviewCommentMock } = mocks
const { addGitHubPRReviewCommentReplyMock, addGitLabIssueCommentMock, addGitLabMRCommentMock } =
  mocks
const { addGitLabMRInlineCommentMock, addSparseWorktree, addWorktree, advertisedUrlWatcher } = mocks
const { afterEach, applyAgentStatusHooksEnabledMock, assertWorktreeCleanForRemoval, beforeEach } =
  mocks
const { clearConfiguredWorktreeSharedDirectoriesCacheForTests, closeGitLabMRMock } = mocks
const { closeLocalWatcherForWorktreePathMock, closeRemoteWatcherForWorktreePathMock } = mocks
const { computeWorktreePathMock, countGitHubWorkItemsMock, createGitHubIssueMock } = mocks
const { createGitLabIssueMock, createHostedReviewMock, createSetupRunnerScript } = mocks
const { createStackedHostedReviewMock, detectInstalledAgentsWithShellPathHydrationMock } = mocks
const { detectRemoteAgentsMock, electronMocks, ensurePathWithinWorkspaceMock } = mocks
const { findExistingWorktreeSymlinkPathsMock, forceDeleteLocalBranchMock } = mocks
const { forgetLocalWatcherRemovalSnapshotMock, forgetRemoteWatcherRemovalSnapshotMock } = mocks
const { describeCreatedWorktree } = mocks
const { getActiveMultiplexerMock, getDefaultTabsLaunch, getEffectiveHooks } = mocks
const { getEffectiveHooksFromConfig, getGitHubPRCheckDetailsMock, getGitHubPRChecksMock } = mocks
const { getGitHubPRCommentsMock, getGitHubPRFileContentsMock, getGitHubWorkItemByOwnerRepoMock } =
  mocks
const { getGitHubWorkItemDetailsMock, getGitHubWorkItemMock, getGitLabJobTraceMock } = mocks
const { getGitLabProjectRefForRemoteMock, getGitLabWorkItemByProjectRefMock } = mocks
const { getGitLabWorkItemDetailsMock, getGlabKnownHostsMock } = mocks
const { getHostedReviewCreationEligibilityMock, getHostedReviewForBranchMock, getIssueMock } = mocks
const { getPRForBranchMock, getPRForBranchOutcomeMock, getPullRequestPushTargetMock } = mocks
const { getRepoSlugMock, getRepoUpstreamMock, getSshGitProviderMock, hasHooksFile } = mocks
const { installFakeAppEnvironment, invalidateAuthorizedRootsCacheMock } = mocks
const { listGitHubAssignableUsersMock, listGitHubIssuesMock, listGitHubLabelsMock } = mocks
const { listGitHubWorkItemsMock, listGitLabIssuesMock, listGitLabLabelsMock } = mocks
const {
  listGitLabMergeRequestsMock,
  listGitLabTodosMock,
  listGitLabWorkItemsMock,
  listWorktrees,
  listWorktreesSharedStrict
} = mocks
const { listWorktreesStrict, loadHooks, markCodexProjectTrustedMock } = mocks
const { markCopilotFolderTrustedMock, markCursorWorkspaceTrustedMock, mergeGitHubPRMock } = mocks
const { mergeGitLabMRMock, muxRequestMock, parseOrcaYaml, prepareLocalWorktreeRootForRepoMock } =
  mocks
const { registerSshGitProviderMock, removeGitHubPRReviewersMock, removeWorktree } = mocks
const { removeWorktreeLinkedPathsMock, reopenGitLabMRMock, requestGitHubPRReviewersMock } = mocks
const { rerunGitHubPRChecksMock, resetPlatform, resolveGitHubReviewThreadMock } = mocks
const { resolveGitLabMRDiscussionMock, resolveLocalGitUsernameMock, resolveSetupRunnerShell } =
  mocks
const { restoreLocalWatcherAfterFailedRemovalMock, restoreRemoteWatcherAfterFailedRemovalMock } =
  mocks
const { retryGitLabJobMock, runHook, scanLocalRepoWorktreesForResolutionMock } = mocks
const { setGitHubPRAutoMergeMock, setGitHubPRFileViewedMock, setRuntimeBrowserCommandsFactory } =
  mocks
const { setRuntimeBrowserUnavailableCause, setRuntimeDesktopSurface } = mocks
const { setRuntimeTerminalUnavailableCause, shouldRunSetupForCreate, sshGitProviders } = mocks
const { sshProviderGenerations, unregisterSshGitProviderMock, updateGitHubIssueMock } = mocks
const { updateGitHubPRDetailsMock, updateGitHubPRStateMock, updateGitHubPRTitleMock } = mocks
const { updateGitLabIssueMock, updateGitLabMRMock, updateGitLabMRReviewersMock, vi } = mocks

function resetRuntimeTestMocks(): void {
  // Why: constructing the browser commands is what pulls the Chromium cluster in, so
  // production installs this at the Electron entry. A Node host installs none and the
  // browser RPCs reject rather than silently succeeding.
  setRuntimeBrowserCommandsFactory((host) => new RuntimeBrowserCommands(host))
  setRuntimeBrowserUnavailableCause(null)
  setRuntimeTerminalUnavailableCause(null)
  // Why: the runtime's notification, window lookup and tab-create-reply channel are
  // injected now, so the electron mock alone is inert. Back the surface with the same
  // mocks so every existing expectation still holds.
  setRuntimeDesktopSurface({
    showNotification: () => true,
    findWindowById: (id) => electronMocks.BrowserWindow.fromId(id) as never,
    onIpc: (channel, listener) => electronMocks.ipcMain.on(channel, listener as never),
    removeIpcListener: (channel, listener) =>
      electronMocks.ipcMain.removeListener(channel, listener as never)
  })
  resetPlatform()
  electronMocks.app.isPackaged = false
  // Why here and not the electron mock: the runtime reads paths and the packaged flag
  // through the AppEnvironment port now, so the electron mock alone is inert. Reading
  // electronMocks.app keeps the existing per-test toggles below working unchanged.
  installFakeAppEnvironment({
    getPath: () => electronMocks.app.getPath(),
    isPackaged: () => electronMocks.app.isPackaged
  })
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
  closeRemoteWatcherForWorktreePathMock.mockReset().mockResolvedValue(undefined)
  restoreLocalWatcherAfterFailedRemovalMock.mockReset().mockResolvedValue(undefined)
  restoreRemoteWatcherAfterFailedRemovalMock.mockReset().mockResolvedValue(undefined)
  forgetLocalWatcherRemovalSnapshotMock.mockReset()
  forgetRemoteWatcherRemovalSnapshotMock.mockReset()
  vi.mocked(listWorktrees).mockResolvedValue(MOCK_GIT_WORKTREES)
  vi.mocked(listWorktreesStrict).mockResolvedValue(MOCK_GIT_WORKTREES)
  vi.mocked(describeCreatedWorktree).mockResolvedValue(undefined)
  // Why delegate: production reads both from one repo state, so a test that stubs the listing must
  // see the same rows through the create path's strict read.
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
  sshGitProviders.clear()
  sshProviderGenerations.clear()
  getSshGitProviderMock.mockReset()
  getSshGitProviderMock.mockImplementation((connectionId: string) =>
    sshGitProviders.get(connectionId)
  )
  registerSshGitProviderMock.mockReset()
  registerSshGitProviderMock.mockImplementation((connectionId: string, provider: unknown) => {
    sshGitProviders.set(connectionId, provider)
    sshProviderGenerations.set(connectionId, (sshProviderGenerations.get(connectionId) ?? 0) + 1)
  })
  unregisterSshGitProviderMock.mockReset()
  unregisterSshGitProviderMock.mockImplementation((connectionId: string) => {
    if (sshGitProviders.delete(connectionId)) {
      sshProviderGenerations.set(connectionId, (sshProviderGenerations.get(connectionId) ?? 0) + 1)
    }
  })
  muxRequestMock.mockReset()
  muxRequestMock.mockResolvedValue(undefined)
  applyAgentStatusHooksEnabledMock.mockReset().mockResolvedValue([])
  getActiveMultiplexerMock.mockReset()
  getActiveMultiplexerMock.mockReturnValue({ request: muxRequestMock, notify: vi.fn() })
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
  vi.mocked(getEffectiveHooksFromConfig).mockReturnValue(null)
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
  detectRemoteAgentsMock.mockReset()
  detectRemoteAgentsMock.mockResolvedValue([])
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

beforeEach(resetRuntimeTestMocks)
afterEach(resetRuntimeTestMocks)

export { resetRuntimeTestMocks }
