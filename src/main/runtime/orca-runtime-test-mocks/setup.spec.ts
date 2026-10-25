import { expect, vi } from 'vitest'
import type { Mock } from 'vitest'
import type * as GitUsernameModule from '../../git/git-username'
import type * as FilesystemPathContainmentModule from '../../ipc/filesystem-path-containment'
import { reviewHeadRemoteRefComponent } from '../../../shared/review-head-tracking-ref'

export const ORIGIN_REMOTE_URL = 'git@example.com:group/repo.git'
export const ORIGIN_HEAD_COMPONENT = reviewHeadRemoteRefComponent('origin', ORIGIN_REMOTE_URL)
import type { OrcaRuntimeService as OrcaRuntimeServiceConstructor } from '../orca-runtime'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import { setWorktreeWatcherRemoval } from '../../ipc/worktree-watcher-removal'

type TestMock = Mock

export const ORIGINAL_PLATFORM = process.platform
export const ORIGINAL_PLATFORM_DESCRIPTOR = Object.getOwnPropertyDescriptor(process, 'platform')
const removeWorktreeLinkedPathsMock: ReturnType<typeof vi.fn> = vi.hoisted(() => vi.fn())
const findExistingWorktreeSymlinkPathsMock: TestMock = vi.hoisted(() => vi.fn())
const resolveLocalGitUsernameMock: TestMock = vi.hoisted(() => vi.fn(async () => ''))

vi.mock('../../ipc/worktree-symlinks', () => ({
  createWorktreeCopiedPaths: vi.fn(),
  createWorktreeLinkedPaths: vi.fn(),
  createWorktreeSharedPaths: vi.fn(),
  findExistingWorktreeSymlinkPaths: findExistingWorktreeSymlinkPathsMock,
  removeWorktreeLinkedPaths: removeWorktreeLinkedPathsMock
}))

export async function waitForMobileSessionTabsEvents(
  events: RuntimeMobileSessionTabsResult[],
  count: number
): Promise<void> {
  await vi.waitFor(() => expect(events).toHaveLength(count))
}

export function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: platform
  })
}

export function resetPlatform(): void {
  if (ORIGINAL_PLATFORM_DESCRIPTOR) {
    Object.defineProperty(process, 'platform', ORIGINAL_PLATFORM_DESCRIPTOR)
  }
}

export function acknowledgeAgentPromptSubmit(
  runtime: InstanceType<typeof OrcaRuntimeServiceConstructor>,
  ptyId: string,
  data: string
): void {
  if (data === '\r') {
    runtime.onPtyData(ptyId, '\x1b]0;Codex working\x07', Date.now())
  }
}

const electronMocks = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void
  const listeners = new Map<string, Set<Listener>>()
  const ipcMain = {
    on: vi.fn((channel: string, listener: Listener) => {
      const existing = listeners.get(channel) ?? new Set<Listener>()
      existing.add(listener)
      listeners.set(channel, existing)
      return ipcMain
    }),
    removeListener: vi.fn((channel: string, listener: Listener) => {
      listeners.get(channel)?.delete(listener)
      return ipcMain
    }),
    emit: vi.fn((channel: string, ...args: unknown[]) => {
      for (const listener of listeners.get(channel) ?? []) {
        listener(...args)
      }
      return true
    })
  }
  return {
    BrowserWindow: { fromId: vi.fn((_id: number): unknown => null) },
    webContents: { fromId: vi.fn((_id: number): unknown => null) },
    ipcMain,
    app: { getPath: vi.fn(() => '/tmp'), isPackaged: false }
  }
})

const closeLocalWatcherForWorktreePathMock: TestMock = vi.hoisted(() => vi.fn())
const restoreLocalWatcherAfterFailedRemovalMock: TestMock = vi.hoisted(() => vi.fn())
const forgetLocalWatcherRemovalSnapshotMock: TestMock = vi.hoisted(() => vi.fn())
const scanLocalRepoWorktreesForResolutionMock: TestMock = vi.hoisted(() => vi.fn())

vi.mock('electron', () => electronMocks)
// Runtime calls the WorktreeWatcherRemoval port; filesystem-watcher module mocks would be inert.
setWorktreeWatcherRemoval({
  closeLocal: closeLocalWatcherForWorktreePathMock,
  restoreLocal: restoreLocalWatcherAfterFailedRemovalMock,
  forgetLocal: forgetLocalWatcherRemovalSnapshotMock
})

const {
  MOCK_GIT_WORKTREES,
  addSparseWorktreeMock,
  addWorktreeMock,
  removeWorktreeMock,
  forceDeleteLocalBranchMock,
  computeWorktreePathMock,
  ensurePathWithinWorkspaceMock,
  invalidateAuthorizedRootsCacheMock,
  prepareLocalWorktreeRootForRepoMock,
  createHostedReviewMock,
  createStackedHostedReviewMock,
  getHostedReviewCreationEligibilityMock,
  getHostedReviewForBranchMock,
  getPRForBranchMock,
  getPRForBranchOutcomeMock,
  getRepoSlugMock,
  getRepoUpstreamMock,
  getGitHubWorkItemMock,
  getPullRequestPushTargetMock,
  getGitHubWorkItemByOwnerRepoMock,
  getGitHubWorkItemDetailsMock,
  getGitHubPRFileContentsMock,
  getGitHubPRChecksMock,
  rerunGitHubPRChecksMock,
  getGitHubPRCheckDetailsMock,
  getGitHubPRCommentsMock,
  resolveGitHubReviewThreadMock,
  setGitHubPRFileViewedMock,
  updateGitHubPRTitleMock,
  updateGitHubPRDetailsMock,
  mergeGitHubPRMock,
  setGitHubPRAutoMergeMock,
  updateGitHubPRStateMock,
  requestGitHubPRReviewersMock,
  removeGitHubPRReviewersMock,
  addGitHubPRReviewCommentMock,
  addGitHubPRReviewCommentReplyMock,
  listGitHubIssuesMock,
  listGitHubWorkItemsMock,
  countGitHubWorkItemsMock,
  createGitHubIssueMock,
  updateGitHubIssueMock,
  addGitHubIssueCommentMock,
  listGitHubLabelsMock,
  listGitHubAssignableUsersMock,
  applyAgentStatusHooksEnabledMock,
  detectInstalledAgentsWithShellPathHydrationMock,
  markCodexProjectTrustedMock,
  markCopilotFolderTrustedMock,
  markCursorWorkspaceTrustedMock,
  listGitLabMergeRequestsMock,
  listGitLabWorkItemsMock,
  listGitLabIssuesMock,
  listGitLabLabelsMock,
  listGitLabAssignableUsersMock,
  listGitLabTodosMock,
  getGitLabProjectRefForRemoteMock,
  getGitLabWorkItemByProjectRefMock,
  createGitLabIssueMock,
  updateGitLabIssueMock,
  addGitLabIssueCommentMock,
  addGitLabMRCommentMock,
  addGitLabMRInlineCommentMock,
  resolveGitLabMRDiscussionMock,
  getGitLabJobTraceMock,
  retryGitLabJobMock,
  mergeGitLabMRMock,
  closeGitLabMRMock,
  reopenGitLabMRMock,
  updateGitLabMRMock,
  getGlabKnownHostsMock,
  getGitLabWorkItemDetailsMock,
  updateGitLabMRReviewersMock,
  getIssueMock,
  deleteWorktreeHistoryDirMock
} = vi.hoisted(() => {
  return {
    MOCK_GIT_WORKTREES: [
      {
        path: '/tmp/worktree-a',
        head: 'abc',
        branch: 'feature/foo',
        isBare: false,
        isMainWorktree: false
      }
    ],
    addSparseWorktreeMock: vi.fn() as TestMock,
    addWorktreeMock: vi.fn() as TestMock,
    removeWorktreeMock: vi.fn() as TestMock,
    forceDeleteLocalBranchMock: vi.fn() as TestMock,
    computeWorktreePathMock: vi.fn() as TestMock,
    ensurePathWithinWorkspaceMock: vi.fn() as TestMock,
    invalidateAuthorizedRootsCacheMock: vi.fn() as TestMock,
    prepareLocalWorktreeRootForRepoMock: vi.fn() as TestMock,
    createHostedReviewMock: vi.fn() as TestMock,
    createStackedHostedReviewMock: vi.fn() as TestMock,
    getHostedReviewCreationEligibilityMock: vi.fn() as TestMock,
    getHostedReviewForBranchMock: vi.fn() as TestMock,
    getPRForBranchMock: vi.fn().mockResolvedValue(null) as TestMock,
    getPRForBranchOutcomeMock: vi
      .fn()
      .mockResolvedValue({ kind: 'no-pr', fetchedAt: 0 }) as TestMock,
    getRepoSlugMock: vi.fn().mockResolvedValue(null) as TestMock,
    getRepoUpstreamMock: vi.fn().mockResolvedValue(null) as TestMock,
    getGitHubWorkItemMock: vi.fn() as TestMock,
    getPullRequestPushTargetMock: vi.fn() as TestMock,
    getGitHubWorkItemByOwnerRepoMock: vi.fn() as TestMock,
    getGitHubWorkItemDetailsMock: vi.fn() as TestMock,
    getGitHubPRFileContentsMock: vi.fn() as TestMock,
    getGitHubPRChecksMock: vi.fn() as TestMock,
    rerunGitHubPRChecksMock: vi.fn() as TestMock,
    getGitHubPRCheckDetailsMock: vi.fn() as TestMock,
    getGitHubPRCommentsMock: vi.fn() as TestMock,
    resolveGitHubReviewThreadMock: vi.fn() as TestMock,
    setGitHubPRFileViewedMock: vi.fn() as TestMock,
    updateGitHubPRTitleMock: vi.fn() as TestMock,
    updateGitHubPRDetailsMock: vi.fn() as TestMock,
    mergeGitHubPRMock: vi.fn() as TestMock,
    setGitHubPRAutoMergeMock: vi.fn() as TestMock,
    updateGitHubPRStateMock: vi.fn() as TestMock,
    requestGitHubPRReviewersMock: vi.fn() as TestMock,
    removeGitHubPRReviewersMock: vi.fn() as TestMock,
    addGitHubPRReviewCommentMock: vi.fn() as TestMock,
    addGitHubPRReviewCommentReplyMock: vi.fn() as TestMock,
    listGitHubIssuesMock: vi.fn() as TestMock,
    listGitHubWorkItemsMock: vi.fn() as TestMock,
    countGitHubWorkItemsMock: vi.fn() as TestMock,
    createGitHubIssueMock: vi.fn() as TestMock,
    updateGitHubIssueMock: vi.fn() as TestMock,
    addGitHubIssueCommentMock: vi.fn() as TestMock,
    listGitHubLabelsMock: vi.fn() as TestMock,
    listGitHubAssignableUsersMock: vi.fn() as TestMock,
    applyAgentStatusHooksEnabledMock: vi.fn() as TestMock,
    detectInstalledAgentsWithShellPathHydrationMock: vi.fn() as TestMock,
    markCodexProjectTrustedMock: vi.fn() as TestMock,
    markCopilotFolderTrustedMock: vi.fn() as TestMock,
    markCursorWorkspaceTrustedMock: vi.fn() as TestMock,
    listGitLabMergeRequestsMock: vi.fn() as TestMock,
    listGitLabWorkItemsMock: vi.fn() as TestMock,
    listGitLabIssuesMock: vi.fn() as TestMock,
    listGitLabLabelsMock: vi.fn() as TestMock,
    listGitLabAssignableUsersMock: vi.fn<TestMock>(),
    listGitLabTodosMock: vi.fn() as TestMock,
    getGitLabProjectRefForRemoteMock: vi.fn() as TestMock,
    getGitLabWorkItemByProjectRefMock: vi.fn() as TestMock,
    createGitLabIssueMock: vi.fn() as TestMock,
    updateGitLabIssueMock: vi.fn() as TestMock,
    addGitLabIssueCommentMock: vi.fn() as TestMock,
    addGitLabMRCommentMock: vi.fn() as TestMock,
    addGitLabMRInlineCommentMock: vi.fn() as TestMock,
    resolveGitLabMRDiscussionMock: vi.fn() as TestMock,
    getGitLabJobTraceMock: vi.fn() as TestMock,
    retryGitLabJobMock: vi.fn() as TestMock,
    mergeGitLabMRMock: vi.fn() as TestMock,
    closeGitLabMRMock: vi.fn() as TestMock,
    reopenGitLabMRMock: vi.fn() as TestMock,
    updateGitLabMRMock: vi.fn() as TestMock,
    getGlabKnownHostsMock: vi.fn() as TestMock,
    getGitLabWorkItemDetailsMock: vi.fn() as TestMock,
    updateGitLabMRReviewersMock: vi.fn() as TestMock,
    getIssueMock: vi.fn() as TestMock,
    deleteWorktreeHistoryDirMock: vi.fn() as TestMock
  }
})

vi.mock('../../git/worktree', () => ({
  listWorktrees: vi.fn().mockResolvedValue(MOCK_GIT_WORKTREES),
  listWorktreesSharedStrict: vi.fn().mockResolvedValue(MOCK_GIT_WORKTREES),
  listWorktreesStrict: vi.fn().mockResolvedValue(MOCK_GIT_WORKTREES),
  describeCreatedWorktree: vi.fn().mockResolvedValue(undefined),
  assertWorktreeCleanForRemoval: vi.fn().mockResolvedValue(undefined),
  addSparseWorktree: addSparseWorktreeMock,
  addWorktree: addWorktreeMock,
  removeWorktree: removeWorktreeMock,
  forceDeleteLocalBranch: forceDeleteLocalBranchMock
}))

vi.mock('../repo-worktree-resolution-scan', () => ({
  scanLocalRepoWorktreesForResolution: scanLocalRepoWorktreesForResolutionMock
}))

vi.mock('../../terminal-history-deletion', () => ({
  deleteWorktreeHistoryDir: deleteWorktreeHistoryDirMock
}))

vi.mock('../../ssh/targets/ssh-target-registry', () => ({
  getRegisteredSshState: () => ({ remotePlatform: 'linux' })
}))

vi.mock('../../preflight/agent-detection', () => ({
  detectAgentCommandsOnHost: vi.fn(async () => new Set(['qodercli'])),
  detectInstalledAgentsWithShellPathHydration: detectInstalledAgentsWithShellPathHydrationMock
}))

vi.mock('../../agent-hooks/managed-agent-hook-controls', () => ({
  applyAgentStatusHooksEnabled: applyAgentStatusHooksEnabledMock
}))

vi.mock('../../agent-trust-presets', () => ({
  markCodexProjectTrusted: markCodexProjectTrustedMock,
  markCopilotFolderTrusted: markCopilotFolderTrustedMock,
  markCursorWorkspaceTrusted: markCursorWorkspaceTrustedMock
}))

vi.mock('../../hooks', () => ({
  getEffectiveHooks: vi.fn().mockReturnValue(null),
  loadHooks: vi.fn().mockReturnValue(null),
  runHook: vi.fn().mockResolvedValue({ success: true, output: '' }),
  hasHooksFile: vi.fn().mockReturnValue(false),
  parseOrcaYaml: vi.fn().mockReturnValue(null)
}))

vi.mock('../../setup-runner-script-text', () => ({
  buildPosixRunnerScript: (script: string) => `#!/usr/bin/env bash\nset -e\n${script}\n`,
  buildWindowsRunnerScript: (script: string) => `@echo off\r\n${script}\r\n`
}))

vi.mock('../../worktree-runner-script', () => ({
  createSetupRunnerScript: vi.fn(),
  resolveSetupRunnerShell: vi.fn().mockReturnValue(undefined)
}))

vi.mock('../../setup-hook-env-vars', () => ({
  getSetupRunnerEnvVars: (_repo: never, worktreePath: string) => ({
    ORCA_ROOT_PATH: '/remote/repo',
    ORCA_WORKTREE_PATH: worktreePath
  })
}))

vi.mock('../../effective-hook-config', () => ({
  getEffectiveHooksFromConfig: vi.fn().mockReturnValue(null),
  getDefaultTabCommandTrustContent: vi.fn(
    (hooks: { scripts?: { setup?: string } } | null) => hooks?.scripts?.setup?.trim() ?? ''
  ),
  getDefaultTabsLaunch: vi.fn().mockReturnValue(undefined),
  shouldRunSetupForCreate: vi
    .fn()
    .mockImplementation((_repo: never, decision: string) => decision === 'run'),
  getEffectiveSetupRunPolicy: vi.fn().mockReturnValue('auto')
}))

vi.mock('../../ipc/worktree-logic', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    computeWorktreePath: computeWorktreePathMock,
    ensurePathWithinWorkspace: ensurePathWithinWorkspaceMock
  }
})

vi.mock('../../ipc/filesystem-auth', () => ({
  resolveAuthorizedPath: vi.fn(async (pathValue: string) => pathValue)
}))

vi.mock('../../ipc/registered-worktree-roots-cache', () => ({
  invalidateAuthorizedRootsCache: invalidateAuthorizedRootsCacheMock
}))

vi.mock('../../ipc/registered-worktree-roots-scoped-invalidation', () => ({
  invalidateAuthorizedRootsCacheForRepo: invalidateAuthorizedRootsCacheMock
}))

// Relay-rebuilt ENOENT errors may retain only the message.
vi.mock('../../ipc/filesystem-path-containment', async () => {
  const actual = await vi.importActual<typeof FilesystemPathContainmentModule>(
    '../../ipc/filesystem-path-containment'
  )
  return { isENOENT: actual.isENOENT }
})

vi.mock('../../worktree-root-preparation', () => ({
  prepareLocalWorktreeRootForRepo: prepareLocalWorktreeRootForRepoMock
}))

vi.mock('../../source-control/hosted-review-creation', () => ({
  createHostedReview: createHostedReviewMock,
  getHostedReviewCreationEligibility: getHostedReviewCreationEligibilityMock
}))

vi.mock('../../source-control/stacked-hosted-review-creation', () => ({
  createStackedHostedReview: createStackedHostedReviewMock
}))

vi.mock('../../source-control/hosted-review', () => ({
  getHostedReviewForBranch: getHostedReviewForBranchMock
}))

vi.mock('../../github/client', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    getPRForBranch: getPRForBranchMock,
    getPRForBranchOutcome: getPRForBranchOutcomeMock,
    getRepoSlug: getRepoSlugMock,
    getRepoUpstream: getRepoUpstreamMock,
    getWorkItem: getGitHubWorkItemMock,
    getPullRequestPushTarget: getPullRequestPushTargetMock,
    getWorkItemByOwnerRepo: getGitHubWorkItemByOwnerRepoMock,
    getPRChecks: getGitHubPRChecksMock,
    rerunPRChecks: rerunGitHubPRChecksMock,
    getPRCheckDetails: getGitHubPRCheckDetailsMock,
    getPRComments: getGitHubPRCommentsMock,
    resolveReviewThread: resolveGitHubReviewThreadMock,
    setPRFileViewed: setGitHubPRFileViewedMock,
    updatePRTitle: updateGitHubPRTitleMock,
    updatePRDetails: updateGitHubPRDetailsMock,
    mergePR: mergeGitHubPRMock,
    setPRAutoMerge: setGitHubPRAutoMergeMock,
    updatePRState: updateGitHubPRStateMock,
    requestPRReviewers: requestGitHubPRReviewersMock,
    removePRReviewers: removeGitHubPRReviewersMock,
    addPRReviewComment: addGitHubPRReviewCommentMock,
    addPRReviewCommentReply: addGitHubPRReviewCommentReplyMock,
    listIssues: listGitHubIssuesMock,
    listWorkItems: listGitHubWorkItemsMock,
    countWorkItems: countGitHubWorkItemsMock,
    getIssue: getIssueMock,
    createIssue: createGitHubIssueMock,
    updateIssue: updateGitHubIssueMock,
    addIssueComment: addGitHubIssueCommentMock,
    listLabels: listGitHubLabelsMock,
    listAssignableUsers: listGitHubAssignableUsersMock
  }
})

vi.mock('../../gitlab/client', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    listMergeRequests: listGitLabMergeRequestsMock,
    listWorkItems: listGitLabWorkItemsMock,
    listIssues: listGitLabIssuesMock,
    listLabels: listGitLabLabelsMock,
    listAssignableUsers: listGitLabAssignableUsersMock,
    listTodos: listGitLabTodosMock,
    getProjectRefForRemote: getGitLabProjectRefForRemoteMock,
    getWorkItemByProjectRef: getGitLabWorkItemByProjectRefMock,
    createIssue: createGitLabIssueMock,
    updateIssue: updateGitLabIssueMock,
    addIssueComment: addGitLabIssueCommentMock,
    addMRComment: addGitLabMRCommentMock,
    addMRInlineComment: addGitLabMRInlineCommentMock,
    resolveMRDiscussion: resolveGitLabMRDiscussionMock,
    getJobTrace: getGitLabJobTraceMock,
    retryJob: retryGitLabJobMock,
    mergeMR: mergeGitLabMRMock,
    closeMR: closeGitLabMRMock,
    reopenMR: reopenGitLabMRMock,
    updateMR: updateGitLabMRMock,
    updateMRReviewers: updateGitLabMRReviewersMock
  }
})

vi.mock('../../gitlab/gl-utils', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    getGlabKnownHosts: getGlabKnownHostsMock
  }
})

vi.mock('../../gitlab/work-item-details', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    getWorkItemDetails: getGitLabWorkItemDetailsMock
  }
})

vi.mock('../../github/work-item-details', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    getWorkItemDetails: getGitHubWorkItemDetailsMock,
    getPRFileContents: getGitHubPRFileContentsMock
  }
})

vi.mock('../../github/issues', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    getIssue: getIssueMock
  }
})

// Fabricated repo paths need deterministic async default-ref resolution.
vi.mock('../../git/repo', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  const actualGetBaseRefDefault = actual.getBaseRefDefault as (
    path: string,
    options?: { wslDistro?: string }
  ) => Promise<string | null>
  return {
    ...actual,
    // Keep fake local defaults deterministic while WSL exercises real async Git options.
    getBaseRefDefault: vi
      .fn()
      .mockImplementation((path: string, options?: { wslDistro?: string }) =>
        options?.wslDistro ? actualGetBaseRefDefault(path, options) : Promise.resolve('origin/main')
      ),
    resolveDefaultBaseRefWithLocalGit: vi
      .fn()
      .mockImplementation((options: { cwd: string; wslDistro?: string }) =>
        options.wslDistro
          ? actualGetBaseRefDefault(options.cwd, options)
          : Promise.resolve('origin/main')
      ),
    getBranchConflictKind: vi.fn().mockResolvedValue(null)
  }
})

vi.mock('../../git/git-username', async () => {
  const actual = await vi.importActual<typeof GitUsernameModule>('../../git/git-username')
  return { ...actual, resolveLocalGitUsername: resolveLocalGitUsernameMock }
})

export {
  electronMocks,
  removeWorktreeLinkedPathsMock,
  findExistingWorktreeSymlinkPathsMock,
  resolveLocalGitUsernameMock,
  closeLocalWatcherForWorktreePathMock,
  restoreLocalWatcherAfterFailedRemovalMock,
  forgetLocalWatcherRemovalSnapshotMock,
  scanLocalRepoWorktreesForResolutionMock,
  MOCK_GIT_WORKTREES,
  addSparseWorktreeMock,
  addWorktreeMock,
  removeWorktreeMock,
  forceDeleteLocalBranchMock,
  computeWorktreePathMock,
  ensurePathWithinWorkspaceMock,
  invalidateAuthorizedRootsCacheMock,
  prepareLocalWorktreeRootForRepoMock,
  createHostedReviewMock,
  createStackedHostedReviewMock,
  getHostedReviewCreationEligibilityMock,
  getHostedReviewForBranchMock,
  getPRForBranchMock,
  getPRForBranchOutcomeMock,
  getRepoSlugMock,
  getRepoUpstreamMock,
  getGitHubWorkItemMock,
  getPullRequestPushTargetMock,
  getGitHubWorkItemByOwnerRepoMock,
  getGitHubWorkItemDetailsMock,
  getGitHubPRFileContentsMock,
  getGitHubPRChecksMock,
  rerunGitHubPRChecksMock,
  getGitHubPRCheckDetailsMock,
  getGitHubPRCommentsMock,
  resolveGitHubReviewThreadMock,
  setGitHubPRFileViewedMock,
  updateGitHubPRTitleMock,
  updateGitHubPRDetailsMock,
  mergeGitHubPRMock,
  setGitHubPRAutoMergeMock,
  updateGitHubPRStateMock,
  requestGitHubPRReviewersMock,
  removeGitHubPRReviewersMock,
  addGitHubPRReviewCommentMock,
  addGitHubPRReviewCommentReplyMock,
  listGitHubIssuesMock,
  listGitHubWorkItemsMock,
  countGitHubWorkItemsMock,
  createGitHubIssueMock,
  updateGitHubIssueMock,
  addGitHubIssueCommentMock,
  listGitHubLabelsMock,
  listGitHubAssignableUsersMock,
  applyAgentStatusHooksEnabledMock,
  detectInstalledAgentsWithShellPathHydrationMock,
  markCodexProjectTrustedMock,
  markCopilotFolderTrustedMock,
  markCursorWorkspaceTrustedMock,
  listGitLabMergeRequestsMock,
  listGitLabWorkItemsMock,
  listGitLabIssuesMock,
  listGitLabLabelsMock,
  listGitLabAssignableUsersMock,
  listGitLabTodosMock,
  getGitLabProjectRefForRemoteMock,
  getGitLabWorkItemByProjectRefMock,
  createGitLabIssueMock,
  updateGitLabIssueMock,
  addGitLabIssueCommentMock,
  addGitLabMRCommentMock,
  addGitLabMRInlineCommentMock,
  resolveGitLabMRDiscussionMock,
  getGitLabJobTraceMock,
  retryGitLabJobMock,
  mergeGitLabMRMock,
  closeGitLabMRMock,
  reopenGitLabMRMock,
  updateGitLabMRMock,
  getGlabKnownHostsMock,
  getGitLabWorkItemDetailsMock,
  updateGitLabMRReviewersMock,
  getIssueMock,
  deleteWorktreeHistoryDirMock
}
