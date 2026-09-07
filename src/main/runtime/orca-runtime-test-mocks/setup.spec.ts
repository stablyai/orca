import { expect, vi } from 'vitest'
import type { Mock } from 'vitest'
import type * as GitUsernameModule from '../../git/git-username'
import { reviewHeadRemoteRefComponent } from '../../../shared/review-head-tracking-ref'

// Why: durable review-head refs are scoped by remote identity (name + URL hash).
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
const closeRemoteWatcherForWorktreePathMock: TestMock = vi.hoisted(() => vi.fn())
const restoreLocalWatcherAfterFailedRemovalMock: TestMock = vi.hoisted(() => vi.fn())
const restoreRemoteWatcherAfterFailedRemovalMock: TestMock = vi.hoisted(() => vi.fn())
const forgetLocalWatcherRemovalSnapshotMock: TestMock = vi.hoisted(() => vi.fn())
const forgetRemoteWatcherRemovalSnapshotMock: TestMock = vi.hoisted(() => vi.fn())
const scanLocalRepoWorktreesForResolutionMock: TestMock = vi.hoisted(() => vi.fn())

vi.mock('electron', () => electronMocks)
// Why install the port instead of mocking ../ipc/filesystem-watcher: the runtime calls
// WorktreeWatcherRemoval now, so a module mock would be inert and every assertion below
// would silently pass against the inert default. Same mocks, same expectations.
setWorktreeWatcherRemoval({
  closeLocal: closeLocalWatcherForWorktreePathMock,
  closeRemote: closeRemoteWatcherForWorktreePathMock,
  restoreLocal: restoreLocalWatcherAfterFailedRemovalMock,
  restoreRemote: restoreRemoteWatcherAfterFailedRemovalMock,
  forgetLocal: forgetLocalWatcherRemovalSnapshotMock,
  forgetRemote: forgetRemoteWatcherRemovalSnapshotMock
})

const {
  MOCK_GIT_WORKTREES,
  addSparseWorktreeMock,
  addWorktreeMock,
  removeWorktreeMock,
  forceDeleteLocalBranchMock,
  computeWorktreePathMock,
  ensurePathWithinWorkspaceMock,
  sshGitProviders,
  sshProviderGenerations,
  getSshGitProviderMock,
  getSshGitProviderGenerationMock,
  registerSshGitProviderMock,
  unregisterSshGitProviderMock,
  getActiveMultiplexerMock,
  muxRequestMock,
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
  detectRemoteAgentsMock,
  markCodexProjectTrustedMock,
  markCopilotFolderTrustedMock,
  markCursorWorkspaceTrustedMock,
  listGitLabMergeRequestsMock,
  listGitLabWorkItemsMock,
  listGitLabIssuesMock,
  listGitLabLabelsMock,
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
  // Why: SSH runtime tests register providers via the public dispatcher API, so the mock needs the same registry semantics as the real module.
  const sshGitProviders = new Map<string, unknown>()
  const sshProviderGenerations = new Map<string, number>()

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
    sshGitProviders,
    sshProviderGenerations,
    getSshGitProviderMock: vi.fn((connectionId: string) => sshGitProviders.get(connectionId)),
    getSshGitProviderGenerationMock: vi.fn(
      (connectionId: string) => sshProviderGenerations.get(connectionId) ?? 0
    ),
    registerSshGitProviderMock: vi.fn((connectionId: string, provider: unknown) => {
      sshGitProviders.set(connectionId, provider)
      sshProviderGenerations.set(connectionId, (sshProviderGenerations.get(connectionId) ?? 0) + 1)
    }),
    unregisterSshGitProviderMock: vi.fn((connectionId: string) => {
      if (sshGitProviders.delete(connectionId)) {
        sshProviderGenerations.set(
          connectionId,
          (sshProviderGenerations.get(connectionId) ?? 0) + 1
        )
      }
    }),
    getActiveMultiplexerMock: vi.fn() as TestMock,
    muxRequestMock: vi.fn() as TestMock,
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
    detectRemoteAgentsMock: vi.fn() as TestMock,
    markCodexProjectTrustedMock: vi.fn() as TestMock,
    markCopilotFolderTrustedMock: vi.fn() as TestMock,
    markCursorWorkspaceTrustedMock: vi.fn() as TestMock,
    listGitLabMergeRequestsMock: vi.fn() as TestMock,
    listGitLabWorkItemsMock: vi.fn() as TestMock,
    listGitLabIssuesMock: vi.fn() as TestMock,
    listGitLabLabelsMock: vi.fn() as TestMock,
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

vi.mock('../../providers/ssh-git-dispatch', () => ({
  getSshGitProvider: getSshGitProviderMock,
  getSshGitProviderGeneration: getSshGitProviderGenerationMock,
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
  },
  registerSshGitProvider: registerSshGitProviderMock,
  unregisterSshGitProvider: unregisterSshGitProviderMock
}))

vi.mock('../../ssh/ssh-target-registry', () => ({
  getActiveMultiplexer: getActiveMultiplexerMock,
  getRegisteredSshState: () => ({ remotePlatform: 'linux' }),
  setSshActiveMultiplexerResolver: vi.fn()
}))

vi.mock('../../preflight/agent-detection', () => ({
  detectInstalledAgentsWithShellPathHydration: detectInstalledAgentsWithShellPathHydrationMock,
  detectRemoteAgents: detectRemoteAgentsMock
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
  resolveAuthorizedPath: vi.fn(async (pathValue: string) => pathValue),
  invalidateAuthorizedRootsCache: invalidateAuthorizedRootsCacheMock,
  isENOENT: (error: unknown) =>
    Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}))

vi.mock('../../ipc/registered-worktree-roots-cache', () => ({
  invalidateAuthorizedRootsCache: invalidateAuthorizedRootsCacheMock
}))

vi.mock('../../ipc/filesystem-path-containment', () => ({
  isENOENT: (error: unknown) =>
    Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}))

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

// Why: CLI worktree creation resolves a default against fabricated repo paths, so keep the async resolver deterministic.
vi.mock('../../git/repo', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  const actualGetBaseRefDefault = actual.getBaseRefDefault as (
    path: string,
    options?: { wslDistro?: string }
  ) => Promise<string | null>
  return {
    ...actual,
    // Why: fabricated local test repos need a deterministic default, while WSL coverage must still exercise the real async Git-options path.
    getBaseRefDefault: vi
      .fn()
      .mockImplementation((path: string, options?: { wslDistro?: string }) =>
        options?.wslDistro ? actualGetBaseRefDefault(path, options) : Promise.resolve('origin/main')
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
  closeRemoteWatcherForWorktreePathMock,
  restoreLocalWatcherAfterFailedRemovalMock,
  restoreRemoteWatcherAfterFailedRemovalMock,
  forgetLocalWatcherRemovalSnapshotMock,
  forgetRemoteWatcherRemovalSnapshotMock,
  scanLocalRepoWorktreesForResolutionMock,
  MOCK_GIT_WORKTREES,
  addSparseWorktreeMock,
  addWorktreeMock,
  removeWorktreeMock,
  forceDeleteLocalBranchMock,
  computeWorktreePathMock,
  ensurePathWithinWorkspaceMock,
  sshGitProviders,
  sshProviderGenerations,
  getSshGitProviderMock,
  getSshGitProviderGenerationMock,
  registerSshGitProviderMock,
  unregisterSshGitProviderMock,
  getActiveMultiplexerMock,
  muxRequestMock,
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
  detectRemoteAgentsMock,
  markCodexProjectTrustedMock,
  markCopilotFolderTrustedMock,
  markCursorWorkspaceTrustedMock,
  listGitLabMergeRequestsMock,
  listGitLabWorkItemsMock,
  listGitLabIssuesMock,
  listGitLabLabelsMock,
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
