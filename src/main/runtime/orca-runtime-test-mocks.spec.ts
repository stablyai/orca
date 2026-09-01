// Compatibility facade for the split runtime test harness.
// Keep this path stable while setup.spec.ts owns Vitest mock registration.
import * as setup from './orca-runtime-test-mocks/setup.spec'
import * as importedValues from './orca-runtime-test-mocks/imported-values.spec'

import type * as GitUsernameModule from '../git/git-username'

export const AGENT_PROMPT_BRACKETED_PASTE_END =
  importedValues.exportedAGENT_PROMPT_BRACKETED_PASTE_END
export const AGENT_PROMPT_BRACKETED_PASTE_START =
  importedValues.exportedAGENT_PROMPT_BRACKETED_PASTE_START
export const AGENT_STATUS_STALE_AFTER_MS = importedValues.exportedAGENT_STATUS_STALE_AFTER_MS
export const AUTHORITATIVE_TERMINAL_SNAPSHOT_TIMEOUT_MS =
  importedValues.exportedAUTHORITATIVE_TERMINAL_SNAPSHOT_TIMEOUT_MS
export const CLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS =
  importedValues.exportedCLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS
export const DEFAULT_REPO_BADGE_COLOR = importedValues.exportedDEFAULT_REPO_BADGE_COLOR
export const EventEmitter = importedValues.exportedEventEmitter
export const FLOATING_TERMINAL_WORKTREE_ID = importedValues.exportedFLOATING_TERMINAL_WORKTREE_ID
export const FOLDER_WORKSPACE_INSTANCE_SEPARATOR =
  importedValues.exportedFOLDER_WORKSPACE_INSTANCE_SEPARATOR
export const HEADLESS_RUNTIME_WINDOW_ID = importedValues.exportedHEADLESS_RUNTIME_WINDOW_ID
export const HeadlessEmulator = importedValues.exportedHeadlessEmulator
export const MAX_OSC_TITLE_CHARS = importedValues.exportedMAX_OSC_TITLE_CHARS
export const MAX_QUICK_COMMANDS = importedValues.exportedMAX_QUICK_COMMANDS
export const OrcaRuntimeService = importedValues.exportedOrcaRuntimeService
export const OrchestrationDb = importedValues.exportedOrchestrationDb
export const REVIEW_HEAD_FETCH_TIMEOUT_MS = importedValues.exportedREVIEW_HEAD_FETCH_TIMEOUT_MS
export const RUNTIME_GRAPH_RELOAD_TIMEOUT_MS =
  importedValues.exportedRUNTIME_GRAPH_RELOAD_TIMEOUT_MS
export const RecentPtyOutputBuffer = importedValues.exportedRecentPtyOutputBuffer
export const RpcDispatcher = importedValues.exportedRpcDispatcher
export const RuntimeBrowserCommands = importedValues.exportedRuntimeBrowserCommands
export const SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV =
  importedValues.exportedSETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV
export const SETUP_AGENT_SEQUENCE_STARTUP_SCRIPT_ENV =
  importedValues.exportedSETUP_AGENT_SEQUENCE_STARTUP_SCRIPT_ENV
export const TERMINAL_INPUT_CHUNK_MAX_BYTES = importedValues.exportedTERMINAL_INPUT_CHUNK_MAX_BYTES
export const TERMINAL_INPUT_MAX_BYTES = importedValues.exportedTERMINAL_INPUT_MAX_BYTES
export const TERMINAL_INPUT_TOO_LARGE_ERROR = importedValues.exportedTERMINAL_INPUT_TOO_LARGE_ERROR
export const TERMINAL_METHODS = importedValues.exportedTERMINAL_METHODS
export const TUI_AGENT_CONFIG = importedValues.exportedTUI_AGENT_CONFIG
export const WATCHER_REMOVAL_DRAIN_BUDGET_MS =
  importedValues.exportedWATCHER_REMOVAL_DRAIN_BUDGET_MS
export const WORKTREE_PROCESS_SWEEP_TIMEOUT_MS =
  importedValues.exportedWORKTREE_PROCESS_SWEEP_TIMEOUT_MS
export const WORKTREE_TEARDOWN_RPC_MARGIN_MS =
  importedValues.exportedWORKTREE_TEARDOWN_RPC_MARGIN_MS
export const _resetTerminalViewAttributesForTest =
  importedValues.exportedPrivateresetTerminalViewAttributesForTest
export const addSparseWorktree = importedValues.exportedAddSparseWorktree
export const addWorktree = importedValues.exportedAddWorktree
export const advertisedUrlWatcher = importedValues.exportedAdvertisedUrlWatcher
export const afterEach = importedValues.exportedAfterEach
export const appendBrowserTabOrder = importedValues.exportedAppendBrowserTabOrder
export const appendNormalizedToTailBuffer = importedValues.exportedAppendNormalizedToTailBuffer
export const appendRecentPtyPathCandidates = importedValues.exportedAppendRecentPtyPathCandidates
export const assertWorktreeCleanForRemoval = importedValues.exportedAssertWorktreeCleanForRemoval
export const basename = importedValues.exportedBasename
export const beforeEach = importedValues.exportedBeforeEach
export const beginWatcherInstall = importedValues.exportedBeginWatcherInstall
export const buildAgentPromptPasteBytes = importedValues.exportedBuildAgentPromptPasteBytes
export const buildPreview = importedValues.exportedBuildPreview
export const clearConfiguredWorktreeSharedDirectoriesCacheForTests =
  importedValues.exportedClearConfiguredWorktreeSharedDirectoriesCacheForTests
export const clearSubmodulePathsCacheForTests =
  importedValues.exportedClearSubmodulePathsCacheForTests
export const collectBrowserGroupAssignment = importedValues.exportedCollectBrowserGroupAssignment
export const createHash = importedValues.exportedCreateHash
export const createRootDispatch = importedValues.exportedCreateRootDispatch
export const createSetupRunnerScript = importedValues.exportedCreateSetupRunnerScript
export const describe = importedValues.exportedDescribe
export const describeCreatedWorktree = importedValues.exportedDescribeCreatedWorktree
export const detectAgentStatusFromTitle = importedValues.exportedDetectAgentStatusFromTitle
export const execFileSync = importedValues.exportedExecFileSync
export const expect = importedValues.exportedExpect
export const getAgentPromptSubmitDelayMs = importedValues.exportedGetAgentPromptSubmitDelayMs
export const getBaseRefDefault = importedValues.exportedGetBaseRefDefault
export const getBranchConflictKind = importedValues.exportedGetBranchConflictKind
export const getBrowserHostLeaseRegistry = importedValues.exportedGetBrowserHostLeaseRegistry
export const getDefaultTabsLaunch = importedValues.exportedGetDefaultTabsLaunch
export const getDefaultWorkspaceSession = importedValues.exportedGetDefaultWorkspaceSession
export const getEffectiveHooks = importedValues.exportedGetEffectiveHooks
export const getEffectiveHooksFromConfig = importedValues.exportedGetEffectiveHooksFromConfig
export const getRuntimeBrowserPageRegistry = importedValues.exportedGetRuntimeBrowserPageRegistry
export const getTerminalPasteIngestMs = importedValues.exportedGetTerminalPasteIngestMs
export const gitRunner = importedValues.exportedGitRunner
export const hasHooksFile = importedValues.exportedHasHooksFile
export const headlessBrowserTabsUnchanged = importedValues.exportedHeadlessBrowserTabsUnchanged
export const homedir = importedValues.exportedHomedir
export const inspectPtyProviderProcess = importedValues.exportedInspectPtyProviderProcess
export const installFakeAppEnvironment = importedValues.exportedInstallFakeAppEnvironment
export const ipcMain = importedValues.exportedIpcMain
export const it = importedValues.exportedIt
export const join = importedValues.exportedJoin
export const listSubmodulePaths = importedValues.exportedListSubmodulePaths
export const listWorktrees = importedValues.exportedListWorktrees
export const listWorktreesSharedStrict = importedValues.exportedListWorktreesSharedStrict
export const listWorktreesStrict = importedValues.exportedListWorktreesStrict
export const loadHooks = importedValues.exportedLoadHooks
export const localWorktreeFilesystem = importedValues.exportedLocalWorktreeFilesystem
export const lstat = importedValues.exportedLstat
export const makePaneKey = importedValues.exportedMakePaneKey
export const mkdir = importedValues.exportedMkdir
export const mkdirSync = importedValues.exportedMkdirSync
export const mkdtemp = importedValues.exportedMkdtemp
export const onTestFinished = importedValues.exportedOnTestFinished
export const parseOrcaYaml = importedValues.exportedParseOrcaYaml
export const performance = importedValues.exportedPerformance
export const projectHostSetupProjectionFromRepos =
  importedValues.exportedProjectHostSetupProjectionFromRepos
export const randomUUID = importedValues.exportedRandomUUID
export const recentTerminalOutputIncludesPath =
  importedValues.exportedRecentTerminalOutputIncludesPath
export const recentTerminalPathCandidatesIncludePath =
  importedValues.exportedRecentTerminalPathCandidatesIncludePath
export const registerLocalPtyMemoryRow = importedValues.exportedRegisterLocalPtyMemoryRow
export const registerSshFilesystemProvider = importedValues.exportedRegisterSshFilesystemProvider
export const registerSshGitProvider = importedValues.exportedRegisterSshGitProvider
export const removeWorktree = importedValues.exportedRemoveWorktree
export const resolveSetupRunnerShell = importedValues.exportedResolveSetupRunnerShell
export const resolveWorktreeScanCacheTtlMs = importedValues.exportedResolveWorktreeScanCacheTtlMs
export const reviewHeadRemoteRefComponent = importedValues.exportedReviewHeadRemoteRefComponent
export const rm = importedValues.exportedRm
export const runHook = importedValues.exportedRunHook
export const setRuntimeBrowserCommandsFactory =
  importedValues.exportedSetRuntimeBrowserCommandsFactory
export const setRuntimeBrowserUnavailableCause =
  importedValues.exportedSetRuntimeBrowserUnavailableCause
export const setRuntimeDesktopSurface = importedValues.exportedSetRuntimeDesktopSurface
export const setRuntimeTerminalUnavailableCause =
  importedValues.exportedSetRuntimeTerminalUnavailableCause
export const setTerminalViewAttributes = importedValues.exportedSetTerminalViewAttributes
export const setWorktreeWatcherRemoval = importedValues.exportedSetWorktreeWatcherRemoval
export const shouldRunSetupForCreate = importedValues.exportedShouldRunSetupForCreate
export const tmpdir = importedValues.exportedTmpdir
export const unregisterLocalPtyMemoryRow = importedValues.exportedUnregisterLocalPtyMemoryRow
export const unregisterSshFilesystemProvider =
  importedValues.exportedUnregisterSshFilesystemProvider
export const unregisterSshGitProvider = importedValues.exportedUnregisterSshGitProvider
export const vi = importedValues.exportedVi
export const win32 = importedValues.exportedWin32
export const worktreePathComparison = importedValues.exportedWorktreePathComparison
export const writeFile = importedValues.exportedWriteFile
export const ORIGIN_REMOTE_URL = setup.ORIGIN_REMOTE_URL
export const ORIGIN_HEAD_COMPONENT = setup.ORIGIN_HEAD_COMPONENT
export const ORIGINAL_PLATFORM = setup.ORIGINAL_PLATFORM
export const ORIGINAL_PLATFORM_DESCRIPTOR = setup.ORIGINAL_PLATFORM_DESCRIPTOR
// Re-export mock bindings directly so TypeScript does not have to name Vitest's
// private inferred spy implementation types in this compatibility facade.
export {
  removeWorktreeLinkedPathsMock,
  findExistingWorktreeSymlinkPathsMock,
  resolveLocalGitUsernameMock
} from './orca-runtime-test-mocks/setup.spec'
export const waitForMobileSessionTabsEvents = setup.waitForMobileSessionTabsEvents
export const setPlatform = setup.setPlatform
export const resetPlatform = setup.resetPlatform
export const acknowledgeAgentPromptSubmit = setup.acknowledgeAgentPromptSubmit
export { electronMocks } from './orca-runtime-test-mocks/setup.spec'
export {
  closeLocalWatcherForWorktreePathMock,
  closeRemoteWatcherForWorktreePathMock,
  restoreLocalWatcherAfterFailedRemovalMock,
  restoreRemoteWatcherAfterFailedRemovalMock,
  forgetLocalWatcherRemovalSnapshotMock,
  forgetRemoteWatcherRemovalSnapshotMock,
  scanLocalRepoWorktreesForResolutionMock
} from './orca-runtime-test-mocks/setup.spec'
export const MOCK_GIT_WORKTREES = setup.MOCK_GIT_WORKTREES
export {
  addSparseWorktreeMock,
  addWorktreeMock,
  removeWorktreeMock,
  forceDeleteLocalBranchMock,
  computeWorktreePathMock,
  ensurePathWithinWorkspaceMock
} from './orca-runtime-test-mocks/setup.spec'
export const sshGitProviders = setup.sshGitProviders
export const sshProviderGenerations = setup.sshProviderGenerations
export {
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
} from './orca-runtime-test-mocks/setup.spec'

// Preserve the instance-side types for fragments that use these constructors in annotations.
export type OrcaRuntimeService = InstanceType<typeof importedValues.exportedOrcaRuntimeService>
export type EventEmitter = InstanceType<typeof importedValues.exportedEventEmitter>
export type OrchestrationDb = InstanceType<typeof importedValues.exportedOrchestrationDb>

export type {
  AgentSessionExecutionClaim,
  AgentSessionSurfaceBinding
} from '../../shared/agent-session-host-authority'
export type { BrowserClientHostCommandEvent } from '../../shared/browser-client-host-protocol'
export type { FolderWorkspace } from '../../shared/folder-workspace-types'
export type { GitUsernameModule }
export type { IPtyProvider } from '../providers/types'
export type { MessagePriority, MessageRow, MessageType } from './orchestration/types'
export type { ProjectGroup } from '../../shared/project-group-types'
export type { RpcRequest } from './rpc/core'
export type { RuntimeBrowserClientPlacement } from '../../shared/runtime-browser-placement'
export type { RuntimeClientEvent } from '../../shared/runtime-client-events'
export type {
  RuntimeMobileSessionTabsResult,
  RuntimeSyncWindowGraph,
  RuntimeTerminalCreate
} from '../../shared/runtime-types'
export type { RuntimeTerminalAgentStatusEvent } from './orca-runtime'
export type { SleepingAgentSessionRecord } from '../../shared/agent-session-resume'
export type { Tab } from '../../shared/tab-types'
export type { TerminalLayoutSnapshot } from '../../shared/terminal-tab-types'
export type { TerminalSideEffectBatch } from '../../shared/terminal-side-effect-facts'
export type { TuiAgent } from '../../shared/tui-agent'
export type { WorkspaceLineage, WorktreeLineage } from '../../shared/worktree/lineage-types'
export type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
export type { Worktree } from '../../shared/worktree/types'
export type { WorktreeMeta } from '../../shared/worktree/meta-types'
