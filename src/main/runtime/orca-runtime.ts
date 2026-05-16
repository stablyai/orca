/* eslint-disable max-lines -- Why: OrcaRuntimeService still owns the mutable live graph, PTY handles, waiters, mobile floor/layout state, and managed-worktree reconciliation. Stateless browser and file command adapters live beside it; the remaining split points need state-owner extraction before enforcing max-lines. */
/* eslint-disable unicorn/no-useless-spread -- Why: waiter sets and handle keys are cloned intentionally before mutation so resolution and rejection can safely remove entries while iterating. */
/* eslint-disable no-control-regex -- Why: terminal normalization must strip ANSI and OSC control sequences from PTY output before returning bounded text to agents. */
import {
  extractLastOscTitle,
  detectAgentStatusFromTitle,
  isShellProcess
} from '../../shared/agent-detection'
import type { AgentStatus } from '../../shared/agent-detection'
import { gitExecFileAsync, wslAwareSpawn } from '../git/runner'
import { isWslPath, parseWslPath, getWslHome } from '../wsl'
import { randomUUID } from 'crypto'
import { basename, isAbsolute, join } from 'path'
import { mkdir, readdir, rm, stat } from 'fs/promises'
import { OrchestrationDb } from './orchestration/db'
import { formatMessagesForInjection } from './orchestration/formatter'
import type {
  CreateWorktreeResult,
  GitPushTarget,
  GitWorktreeInfo,
  GlobalSettings,
  Repo,
  StatsSummary,
  Worktree,
  WorktreeLineage,
  WorktreeLineageWarning,
  WorktreeMeta,
  WorktreeBaseStatusEvent,
  WorktreeRemoteBranchConflictEvent,
  WorktreeStartupLaunch,
  LinearIssueUpdate,
  LinearWorkspaceSelection,
  TuiAgent
} from '../../shared/types'
import { splitWorktreeId } from '../../shared/worktree-id'
import { isFolderRepo } from '../../shared/repo-kind'
import { buildSetupRunnerCommand } from '../../shared/setup-runner-command'
import { FIRST_PANE_ID } from '../../shared/pane-key'
import { isTerminalLeafId, makePaneKey, parsePaneKey } from '../../shared/stable-pane-id'
import {
  isPathInsideOrEqual,
  normalizeRuntimePathForComparison
} from '../../shared/cross-platform-path'
import {
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  RUNTIME_CAPABILITIES,
  RUNTIME_PROTOCOL_VERSION
} from '../../shared/protocol-version'
import type {
  RuntimeGraphStatus,
  RuntimeRepoSearchRefs,
  RuntimeTerminalRead,
  RuntimeTerminalRename,
  RuntimeTerminalSend,
  RuntimeTerminalCreate,
  RuntimeTerminalSplit,
  RuntimeTerminalFocus,
  RuntimeTerminalClose,
  RuntimeTerminalListResult,
  RuntimeTerminalState,
  RuntimeStatus,
  RuntimeTerminalWait,
  RuntimeTerminalWaitCondition,
  RuntimeWorktreePsSummary,
  RuntimeWorktreeStatus,
  RuntimeTerminalShow,
  RuntimeTerminalSummary,
  RuntimeSyncedLeaf,
  RuntimeSyncedTab,
  RuntimeMarkdownReadTabResult,
  RuntimeMarkdownSaveTabResult,
  RuntimeMobileSessionCreateTerminalResult,
  RuntimeMobileSessionClientTab,
  RuntimeMobileSessionMarkdownTab,
  RuntimeMobileSessionTerminalTab,
  RuntimeMobileSessionTabsRemovedResult,
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTabsSnapshot,
  RuntimeTerminalDriverState,
  RuntimeSyncWindowGraph,
  RuntimeWorktreeListResult
} from '../../shared/runtime-types'
import { RuntimeBrowserCommands } from './orca-runtime-browser'
import { RuntimeFileCommands } from './orca-runtime-files'
import { RuntimeGitCommands } from './orca-runtime-git'
import { joinWorktreeRelativePath } from './runtime-relative-paths'
import { BrowserWindow, ipcMain } from 'electron'
import type { AgentBrowserBridge } from '../browser/agent-browser-bridge'
import {
  getPRForBranch,
  getPullRequestPushTarget,
  getRepoSlug,
  getWorkItem,
  listWorkItems,
  countWorkItems,
  getPRChecks,
  getPRComments,
  getIssue,
  resolveReviewThread,
  getWorkItemByOwnerRepo,
  updatePRTitle,
  mergePR,
  createIssue,
  updateIssue,
  addIssueComment,
  addPRReviewComment,
  addPRReviewCommentReply,
  listLabels,
  listAssignableUsers
} from '../github/client'
import { getWorkItemDetails, getPRFileContents } from '../github/work-item-details'
import { getRateLimit } from '../github/rate-limit'
import type {
  GitHubIssueUpdate,
  GitHubPRFile,
  GitHubPRReviewCommentInput
} from '../../shared/types'
import type {
  CreateHostedReviewInput,
  CreateHostedReviewResult,
  HostedReviewCreationEligibility,
  HostedReviewCreationEligibilityArgs,
  HostedReviewInfo
} from '../../shared/hosted-review'
import { getHostedReviewForBranch as getHostedReviewForBranchFromRepo } from '../source-control/hosted-review'
import {
  createHostedReview as createHostedReviewFromRepo,
  getHostedReviewCreationEligibility as getHostedReviewCreationEligibilityFromRepo
} from '../source-control/hosted-review-creation'
import {
  connect as connectLinear,
  disconnect as disconnectLinear,
  getStatus as getLinearStatus,
  selectWorkspace as selectLinearWorkspace,
  testConnection as testLinearConnection
} from '../linear/client'
import {
  addIssueComment as addLinearIssueComment,
  createIssue as createLinearIssue,
  getIssue as getLinearIssue,
  getIssueComments as getLinearIssueComments,
  listIssues as listLinearIssues,
  searchIssues as searchLinearIssues,
  updateIssue as updateLinearIssue,
  type LinearListFilter
} from '../linear/issues'
import {
  getTeamLabels as getLinearTeamLabels,
  getTeamMembers as getLinearTeamMembers,
  getTeamStates as getLinearTeamStates,
  listTeams as listLinearTeams
} from '../linear/teams'
import {
  clearProjectItemFieldValue,
  getProjectViewTable,
  getWorkItemDetailsBySlug,
  listAccessibleProjects,
  listProjectViews,
  resolveProjectRef,
  addIssueCommentBySlug,
  deleteIssueCommentBySlug,
  listAssignableUsersBySlug,
  listIssueTypesBySlug,
  listLabelsBySlug,
  updateIssueCommentBySlug,
  updateIssueBySlug,
  updateIssueTypeBySlug,
  updateProjectItemFieldValue,
  updatePullRequestBySlug
} from '../github/project-view'
import type {
  ClearProjectItemFieldArgs,
  GetProjectViewTableArgs,
  ListAssignableUsersBySlugArgs,
  ListIssueTypesBySlugArgs,
  ListLabelsBySlugArgs,
  ListProjectViewsArgs,
  ProjectWorkItemDetailsBySlugArgs,
  ResolveProjectRefArgs,
  AddIssueCommentBySlugArgs,
  DeleteIssueCommentBySlugArgs,
  UpdateIssueBySlugArgs,
  UpdateIssueCommentBySlugArgs,
  UpdateIssueTypeBySlugArgs,
  UpdateProjectItemFieldArgs,
  UpdatePullRequestBySlugArgs
} from '../../shared/github-project-types'
import {
  getGitUsername,
  getBaseRefDefault,
  getDefaultBaseRef,
  getDefaultRemote,
  getBranchConflictKind,
  isGitRepo,
  getRepoName,
  searchBaseRefs,
  getRemoteCount,
  normalizeRefSearchQuery,
  parseAndFilterSearchRefs,
  parseRemoteCount,
  resolveDefaultBaseRefViaExec,
  buildSearchBaseRefsArgv,
  getRemoteDrift,
  getRecentDriftSubjects
} from '../git/repo'
import { listWorktrees, addWorktree, addSparseWorktree, removeWorktree } from '../git/worktree'
import { isENOENT } from '../ipc/filesystem-auth'
import {
  createSetupRunnerScript,
  getEffectiveHooks,
  getEffectiveSetupRunPolicy,
  hasUnrecognizedOrcaYamlKeys,
  hasHooksFile,
  loadHooks,
  parseOrcaYaml,
  readIssueCommand,
  runHook,
  shouldRunSetupForCreate,
  writeIssueCommand
} from '../hooks'
import { REPO_COLORS, getDefaultVoiceSettings } from '../../shared/constants'
import { listRepoWorktrees } from '../repo-worktrees'
import { createWorktreeSymlinks } from '../ipc/worktree-symlinks'
import {
  configureCreatedWorktreePushTarget,
  prepareWorktreePushTarget
} from '../ipc/worktree-remote'
import { normalizeSparseDirectories } from '../ipc/sparse-checkout-directories'
import type { Store } from '../persistence'
import type { StatsCollector } from '../stats/collector'
import { AgentDetector } from '../stats/agent-detector'
import {
  computeBranchName,
  computeWorktreePath,
  ensurePathWithinWorkspace,
  formatWorktreeRemovalError,
  isOrphanedWorktreeError,
  mergeWorktree,
  sanitizeWorktreeName,
  shouldSetDisplayName,
  areWorktreePathsEqual
} from '../ipc/worktree-logic'
import { canSafelyRemoveOrphanedWorktreeDirectory } from '../worktree-removal-safety'
import { invalidateAuthorizedRootsCache } from '../ipc/filesystem-auth'
import { HeadlessEmulator } from '../daemon/headless-emulator'
import { killAllProcessesForWorktree } from './worktree-teardown'
import { MOBILE_SUBSCRIBE_SCROLLBACK_ROWS } from './scrollback-limits'
import type { IFilesystemProvider, IPtyProvider } from '../providers/types'
import { getSshFilesystemProvider } from '../providers/ssh-filesystem-dispatch'
import { getSshGitProvider } from '../providers/ssh-git-dispatch'
import type { ClaudeAccountService } from '../claude-accounts/service'
import type { CodexAccountService } from '../codex-accounts/service'
import type { RateLimitService } from '../rate-limits/service'
import type { ClaudeRateLimitAccountsState, CodexRateLimitAccountsState } from '../../shared/types'
import type { RateLimitState } from '../../shared/rate-limit-types'
import type { VoiceSettings } from '../../shared/speech-types'
import { getSpeechModelManager, getSpeechSttService } from '../speech/speech-runtime-service'

type RuntimeAccountServices = {
  claudeAccounts: ClaudeAccountService
  codexAccounts: CodexAccountService
  rateLimits: RateLimitService
}

export type RemoteFetchResult = { ok: true } | { ok: false; errorKind: 'git_error' }

export type RemoteTrackingBase = {
  remote: string
  branch: string
  ref: string
  base: string
}

export type AccountsSnapshot = {
  claude: ClaudeRateLimitAccountsState
  codex: CodexRateLimitAccountsState
  rateLimits: RateLimitState
}

type RuntimeStore = {
  getRepos: Store['getRepos']
  getRepo: Store['getRepo']
  addRepo: Store['addRepo']
  updateRepo: Store['updateRepo']
  removeRepo?: Store['removeRepo']
  reorderRepos?: Store['reorderRepos']
  getAllWorktreeMeta: Store['getAllWorktreeMeta']
  getWorktreeMeta: Store['getWorktreeMeta']
  setWorktreeMeta: Store['setWorktreeMeta']
  removeWorktreeMeta: Store['removeWorktreeMeta']
  getWorktreeLineage?: Store['getWorktreeLineage']
  getAllWorktreeLineage?: Store['getAllWorktreeLineage']
  setWorktreeLineage?: Store['setWorktreeLineage']
  removeWorktreeLineage?: Store['removeWorktreeLineage']
  getGitHubCache: Store['getGitHubCache']
  getWorkspaceSession?: Store['getWorkspaceSession']
  getSettings(): {
    workspaceDir: string
    nestWorkspaces: boolean
    refreshLocalBaseRefOnWorktreeCreate: boolean
    branchPrefix: string
    branchPrefixCustom: string
    experimentalWorktreeSymlinks?: boolean
    mobileAutoRestoreFitMs?: number | null
    voice?: VoiceSettings
  }
  // Why: narrow to `unknown` return so test mocks can return void without
  // a cast. The runtime never reads the return value — the persisted value
  // is read back via getSettings() on the next access.
  updateSettings?: (updates: Partial<GlobalSettings>) => unknown
}

type RuntimeLeafRecord = RuntimeSyncedLeaf & {
  ptyGeneration: number
  connected: boolean
  writable: boolean
  lastOutputAt: number | null
  lastExitCode: number | null
  tailBuffer: string[]
  tailPartialLine: string
  tailTruncated: boolean
  tailLinesTotal: number
  preview: string
  lastAgentStatus: AgentStatus | null
  // Why: the most recent OSC title observed on this leaf's PTY data. Used by
  // worktree.ps so daemon-hosted terminals (no renderer pushing pane titles)
  // still recompute working/idle from the live title each call instead of
  // serving a stale `lastAgentStatus` after the agent process exits and the
  // shell takes over the title — the bug behind issue #1437.
  lastOscTitle: string | null
}

type RuntimePtyWorktreeRecord = {
  ptyId: string
  worktreeId: string
  // Why: background CLI PTYs can outlive a failed renderer reveal. Preserve the
  // spawn-time tab/pane identity so later reveals can adopt under the env key.
  tabId: string | null
  paneKey: string | null
  connected: boolean
  lastExitCode: number | null
  lastAgentStatus: AgentStatus | null
  lastOscTitle: string | null
  title: string | null
  lastOutputAt: number | null
  tailBuffer: string[]
  tailPartialLine: string
  tailTruncated: boolean
  tailLinesTotal: number
  preview: string
}

type RuntimeHeadlessTerminal = {
  emulator: HeadlessEmulator
  writeChain: Promise<void>
}

type RuntimePtyController = {
  spawn?(opts: {
    cols: number
    rows: number
    cwd?: string
    command?: string
    env?: Record<string, string>
    connectionId?: string | null
    worktreeId?: string
    preAllocatedHandle?: string
  }): Promise<{ id: string }>
  write(ptyId: string, data: string): boolean
  kill(ptyId: string): boolean
  getForegroundProcess(ptyId: string): Promise<string | null>
  hasChildProcesses?(ptyId: string): Promise<boolean>
  clearBuffer?(ptyId: string): Promise<void>
  resize?(ptyId: string, cols: number, rows: number): boolean
  listProcesses?(): Promise<{ id: string; cwd: string; title: string }[]>
  serializeBuffer?(
    ptyId: string,
    opts?: { scrollbackRows?: number; altScreenForcesZeroRows?: boolean }
  ): Promise<{ data: string; cols: number; rows: number; lastTitle?: string } | null>
  // Why: synchronous probe used by maybeHydrateHeadlessFromRenderer to skip
  // hydration when no renderer is authoritative for this PTY. See
  // docs/mobile-prefer-renderer-scrollback.md.
  hasRendererSerializer?(ptyId: string): boolean
  getSize?(ptyId: string): { cols: number; rows: number } | null
}

type RuntimeNotifier = {
  worktreesChanged(repoId: string): void
  worktreeBaseStatus?(event: WorktreeBaseStatusEvent): void
  worktreeRemoteBranchConflict?(event: WorktreeRemoteBranchConflictEvent): void
  reposChanged(): void
  activateWorktree(
    repoId: string,
    worktreeId: string,
    setup?: CreateWorktreeResult['setup'],
    startup?: WorktreeStartupLaunch
  ): void
  createTerminal(worktreeId: string, opts: { command?: string; title?: string }): void
  revealTerminalSession?(
    worktreeId: string,
    opts: {
      ptyId: string
      title?: string | null
      activate?: boolean
      tabId?: string
      leafId?: string
    }
  ):
    | Promise<{ tabId: string; title?: string | null }>
    | { tabId: string; title?: string | null }
    | void
  splitTerminal(
    tabId: string,
    paneRuntimeId: number,
    opts: { direction: 'horizontal' | 'vertical'; command?: string }
  ): void
  renameTerminal(tabId: string, title: string | null): void
  focusTerminal(tabId: string, worktreeId: string, leafId?: string | null): void
  focusEditorTab?(tabId: string, worktreeId: string): void
  closeSessionTab?(tabId: string, worktreeId: string): void
  openFile?(worktreeId: string, filePath: string, relativePath: string): void
  readMobileMarkdownTab?(worktreeId: string, tabId: string): Promise<RuntimeMarkdownReadTabResult>
  saveMobileMarkdownTab?(
    worktreeId: string,
    tabId: string,
    baseVersion: string,
    content: string
  ): Promise<RuntimeMarkdownSaveTabResult>
  closeTerminal(tabId: string, paneRuntimeId?: number): void
  sleepWorktree(worktreeId: string): void
  terminalFitOverrideChanged(
    ptyId: string,
    mode: 'mobile-fit' | 'desktop-fit',
    cols: number,
    rows: number
  ): void
  // Why: presence-based lock signal — desktop renderer mounts the lock
  // banner when `driver.kind === 'mobile'` and unmounts otherwise. The
  // structured payload (vs a `locked: boolean`) carries the active mobile
  // actor's clientId so the renderer can disambiguate multi-phone scenarios
  // and so a future write coordinator can use the same signal as scheduling
  // input. See docs/mobile-presence-lock.md.
  terminalDriverChanged(ptyId: string, driver: DriverState): void
}

type TerminalHandleRecord = {
  handle: string
  runtimeId: string
  rendererGraphEpoch: number
  worktreeId: string
  tabId: string
  leafId: string
  ptyId: string | null
  ptyGeneration: number
}

type TerminalWaiter = {
  handle: string
  condition: RuntimeTerminalWaitCondition
  resolve: (result: RuntimeTerminalWait) => void
  reject: (error: Error) => void
  timeout: NodeJS.Timeout | null
  pollInterval: NodeJS.Timeout | null
}

type MessageWaiter = {
  handle: string
  typeFilter: string[] | undefined
  resolve: (result: void) => void
  timeout: NodeJS.Timeout | null
}

function omitUndefinedProperties<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined)
  ) as Partial<T>
}

type ResolvedWorktree = Worktree & {
  parentWorktreeId: string | null
  childWorktreeIds: string[]
  lineage: WorktreeLineage | null
  git: GitWorktreeInfo
}

type WorktreeLineageInput = {
  parentWorktree?: string
  cwdParentWorktree?: string
  noParent?: boolean
  callerTerminalHandle?: string
  comment?: string
  orchestrationContext?: {
    parentWorktreeId?: string
    orchestrationRunId?: string
    taskId?: string
    coordinatorHandle?: string
  }
}

type WorktreeLineageResolution =
  | {
      kind: 'lineage'
      parent: ResolvedWorktree
      origin: WorktreeLineage['origin']
      capture: WorktreeLineage['capture']
      orchestrationRunId?: string
      taskId?: string
      coordinatorHandle?: string
      createdByTerminalHandle?: string
    }
  | {
      kind: 'none'
      warnings: WorktreeLineageWarning[]
    }

type RuntimeWorktreeScanResult =
  | { ok: true; worktrees: GitWorktreeInfo[] }
  | { ok: false; worktrees: [] }

type WorktreeLineageCandidate = {
  source: 'cwd-context' | 'terminal-context' | 'orchestration-context'
  parent: ResolvedWorktree
  orchestrationRunId?: string
  taskId?: string
  coordinatorHandle?: string
}

function extractOrchestrationTaskId(text?: string): string | undefined {
  return text?.match(/\btask_[A-Za-z0-9]+\b/)?.[0]
}

class RuntimeLineageError extends Error {
  code: string
  data?: unknown

  constructor(code: string, message: string, data?: unknown) {
    super(message)
    this.code = code
    this.data = data
  }
}

type ResolvedWorktreeCache = {
  expiresAt: number
  worktrees: ResolvedWorktree[]
}

type ResolvedWorktreeInFlight = {
  generation: number
  promise: Promise<ResolvedWorktree[]>
}

export type MobileNotificationEvent = {
  source: 'agent-task-complete' | 'terminal-bell' | 'test'
  title: string
  body: string
  worktreeId?: string
}

// Why: presence-based driver state for the mobile-presence lock. Exactly one
// driver per PTY at any moment. See docs/mobile-presence-lock.md.
//   - `idle`: no mobile subscribers; desktop input flows freely
//   - `desktop`: at least one mobile client subscribed but desktop reclaimed
//      (or all mobile clients are passive `desktop`-mode watchers); desktop
//      input flows freely
//   - `mobile{clientId}`: a mobile client is the active driver; desktop
//      input/resize are dropped server-side and the lock banner is mounted.
//      `clientId` is the most recent mobile actor for this PTY.
export type DriverState = RuntimeTerminalDriverState

// Why: per-PTY layout target — what the PTY *should* be at right now.
// `desktop` ⇒ runs at the desktop renderer's pane geometry; mobile passive
// watchers (mode='desktop') still receive scrollback. `phone` ⇒ runs at
// `ownerClientId`'s viewport; the desktop renderer's auto-fit is suppressed.
// See docs/mobile-terminal-layout-state-machine.md.
export type PtyLayoutTarget =
  | { kind: 'desktop'; cols: number; rows: number }
  | { kind: 'phone'; cols: number; rows: number; ownerClientId: string }

// Why: authoritative layout state with monotonic seq. Bumped on every
// applyLayout success; emitted on mobile subscribe-stream events so clients
// drop stale events that arrive after a newer transition.
export type PtyLayoutState = PtyLayoutTarget & {
  seq: number
  appliedAt: number
}

// Why: applyLayout result discriminator. Callers (especially RPC handlers)
// need to distinguish "shipped a new state at seq N" from "no-op — caller
// should not claim a seq it didn't produce." `pty-exited` is terminal;
// `resize-failed` is transient and the caller may retry.
export type ApplyLayoutResult =
  | { ok: true; state: PtyLayoutState }
  | { ok: false; reason: 'pty-exited' | 'resize-failed' }

type LayoutQueueEntry = {
  running: Promise<ApplyLayoutResult> | null
  pending: {
    target: PtyLayoutTarget
    waiters: ((r: ApplyLayoutResult) => void)[]
  }[]
}

export class OrcaRuntimeService {
  private readonly runtimeId = randomUUID()
  private readonly startedAt = Date.now()
  private readonly store: RuntimeStore | null
  private rendererGraphEpoch = 0
  private graphStatus: RuntimeGraphStatus = 'unavailable'
  private authoritativeWindowId: number | null = null
  private tabs = new Map<string, RuntimeSyncedTab>()
  private mobileSessionTabsByWorktree = new Map<string, RuntimeMobileSessionTabsSnapshot>()
  private mobileSessionTabListeners = new Set<(snapshot: RuntimeMobileSessionTabsResult) => void>()
  private leaves = new Map<string, RuntimeLeafRecord>()
  private handles = new Map<string, TerminalHandleRecord>()
  private handleByLeafKey = new Map<string, string>()
  private handleByPtyId = new Map<string, string>()
  private detachedPreAllocatedLeaves = new Map<string, RuntimeLeafRecord>()
  private graphSyncCallbacks: (() => void)[] = []
  private waitersByHandle = new Map<string, Set<TerminalWaiter>>()
  private ptyController: RuntimePtyController | null = null
  private notifier: RuntimeNotifier | null = null
  private agentBrowserBridge: AgentBrowserBridge | null = null
  private resolvedWorktreeCache: ResolvedWorktreeCache | null = null
  private resolvedWorktreeInFlight: ResolvedWorktreeInFlight | null = null
  private resolvedWorktreeGeneration = 0
  private agentDetector: AgentDetector | null = null
  private _orchestrationDb: OrchestrationDb | null = null
  private messageWaitersByHandle = new Map<string, Set<MessageWaiter>>()
  // Why: mobile clients subscribe to terminal output via terminal.subscribe.
  // These listeners fire on every onPtyData call, enabling real-time streaming
  // without polling. Keyed by ptyId for O(1) lookup per data event.
  private dataListeners = new Map<string, Set<(data: string) => void>>()
  // Why: mobile clients need to know when the desktop restores a terminal
  // from mobile-fit so they can update their UI. These listeners are
  // invoked from resizeForClient and onClientDisconnected/onPtyExit.
  private fitOverrideListeners = new Map<
    string,
    Set<(event: { mode: 'mobile-fit' | 'desktop-fit'; cols: number; rows: number }) => void>
  >()
  private driverListeners = new Map<string, Set<(driver: DriverState) => void>>()
  private subscriptionCleanups = new Map<string, () => void>()
  // Why: index of subscriptionIds by per-WebSocket connectionId so the
  // server can sweep all subscriptions for a closing socket without
  // touching subscriptions on other live sockets that share the same
  // deviceToken (multi-screen mobile).
  private subscriptionsByConnection = new Map<string, Set<string>>()
  private subscriptionConnectionByEntry = new Map<string, string>()
  // Why: mobile clients subscribe to desktop notifications via
  // notifications.subscribe. This set enables fan-out — each connected
  // mobile client gets its own listener, and dispatchMobileNotification
  // iterates them all. Listeners are cleaned up via subscriptionCleanups.
  private notificationListeners = new Set<(event: MobileNotificationEvent) => void>()
  private ptysById = new Map<string, RuntimePtyWorktreeRecord>()
  private headlessTerminals = new Map<string, RuntimeHeadlessTerminal>()
  // Why: per-PTY hydration state guards against double-hydration. Keys:
  //   'pending'  → maybeHydrateHeadlessFromRenderer is in flight
  //   'done'     → hydration completed (success or skip); never run again
  // Absent  → hydration has not been considered yet for this PTY.
  // See docs/mobile-prefer-renderer-scrollback.md.
  private headlessHydrationState = new Map<string, 'pending' | 'done'>()
  // Why: mobile-fit overrides are keyed by ptyId (not terminal handle) because
  // handles can be reissued while the PTY identity is stable. In-memory only —
  // a stale phone override should not survive an app restart.
  private terminalFitOverrides = new Map<
    string,
    {
      mode: 'mobile-fit'
      cols: number
      rows: number
      previousCols: number | null
      previousRows: number | null
      updatedAt: number
      clientId: string
    }
  >()

  // Why: server-authoritative display mode per terminal. 'auto' (default)
  // means phone-fit when mobile subscribes, desktop otherwise. 'desktop'
  // locks to no-resize regardless of subscriber state. The third historical
  // value ('phone' = sticky phone-fit after unsubscribe) was removed since
  // the toggle UI never produced it and nothing in product depended on it.
  // In-memory only — modes reset on restart.
  private mobileDisplayModes = new Map<string, 'desktop'>()

  // Why: tracks active mobile subscribers per PTY so the runtime can restore
  // desktop dimensions on unsubscribe and prevent orphaned overrides during
  // rapid tab switches. Keyed by ptyId → inner map of clientId → subscriber.
  // The two-level map preserves multi-mobile soundness: phone B subscribing
  // does not silently overwrite phone A's record. See
  // docs/mobile-presence-lock.md "Multi-mobile subscriber model".
  // subscribedAt drives "earliest-by-subscribe-time" restore-target selection
  // (only among subscribers with non-null previousCols/Rows; desktop-mode
  // joins carry null and are skipped). lastActedAt drives "most-recent
  // actor's viewport wins" for active phone-fit dims.
  private mobileSubscribers = new Map<
    string,
    Map<
      string,
      {
        clientId: string
        viewport: { cols: number; rows: number } | null
        wasResizedToPhone: boolean
        previousCols: number | null
        previousRows: number | null
        subscribedAt: number
        lastActedAt: number
      }
    >
  >()

  // Why: per-PTY driver state. The "driver" is whoever currently owns the
  // input/resize floor. While `kind === 'mobile'` the desktop renderer drops
  // xterm.onData/onResize and shows the lock banner; `terminal.send` /
  // `pty:write` and `pty:resize` IPC handlers also drop desktop-side calls
  // server-side as defense-in-depth. The `clientId` carried on the mobile
  // variant is the most recent mobile actor — used by
  // `applyMobileDisplayMode` to pick the active phone-fit viewport. See
  // docs/mobile-presence-lock.md.
  private currentDriver = new Map<string, DriverState>()

  // Why: resubscribe-grace window. When the last mobile subscriber for a
  // PTY unsubscribes, we hold the driver=mobile{clientId} state and the
  // inner-map record open for ~250ms. If the same (ptyId, clientId)
  // re-subscribes inside the window — typically because the mobile app
  // tore down the stream to reconfigure (rare with the new
  // updateMobileViewport path, but still possible on reconnects, network
  // hiccups, or older client builds) — we cancel the deferred idle and
  // restore-timer so the desktop banner doesn't flash and the new
  // subscriber doesn't capture an already-phone-fitted PTY size as its
  // restore baseline. Keyed by ptyId; carries the timer plus the snapshot
  // of the leaving subscriber so we can re-insert it on cancel. See
  // docs/mobile-presence-lock.md.
  private pendingSoftLeavers = new Map<
    string,
    {
      clientId: string
      timer: ReturnType<typeof setTimeout>
      record: {
        clientId: string
        viewport: { cols: number; rows: number } | null
        wasResizedToPhone: boolean
        previousCols: number | null
        previousRows: number | null
        subscribedAt: number
        lastActedAt: number
      }
    }
  >()

  // Why: tracks the last PTY size set by the desktop renderer (via pty:resize
  // IPC). Unlike ptySizes (which is overwritten by server-side phone-fit
  // resizes), this map preserves the actual pane geometry. Used as the
  // preferred source for previousCols so desktop restore uses the correct
  // split-pane width instead of a stale full-width value.
  private lastRendererSizes = new Map<string, { cols: number; rows: number }>()

  // Why: when a desktop-fit override change fires, the desktop renderer's
  // re-render cascade (triggered by setOverrideTick) runs safeFit on ALL
  // panes — not just the affected one. Background tab panes get measured at
  // full-width (214) instead of their correct split width (105). The stale
  // pty:resize IPCs overwrite both the actual PTY size and lastRendererSizes.
  // This global window suppresses ALL pty:resize for 200ms after any
  // desktop-fit notification. The server has already set the correct PTY
  // size via ptyController.resize(), so desktop renderer resizes during
  // this window are redundant (for the restored pane) or wrong (collateral).
  private resizeSuppressedUntil = 0

  // Why: delays PTY restore by 300ms after mobile unsubscribe so rapid tab
  // switches don't cause unnecessary resize thrashing. Keyed by clientId
  // Why: keyed by ptyId so each PTY gets its own independent restore timer.
  // The old clientId-keyed design lost timers when two PTYs were unsubscribed
  // back-to-back (only the last timer survived).
  private pendingRestoreTimers = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; clientId: string }
  >()

  // Why: inline resize events replace the unsubscribe→resubscribe pattern.
  // Listeners are notified when mode changes or desktop restores, allowing
  // the subscribe stream to emit a 'resized' event with fresh scrollback.
  // `seq` is the layout state-machine sequence number bumped on every
  // applyLayout success; mobile clients use it to drop stale events that
  // arrive after a newer transition. See docs/mobile-terminal-layout-state-machine.md.
  private resizeListeners = new Map<
    string,
    Set<
      (event: {
        cols: number
        rows: number
        displayMode: string
        reason: string
        seq?: number
      }) => void
    >
  >()

  // Why: per-PTY layout state machine. `applyLayout` is the sole writer of
  // `layouts`, `terminalFitOverrides`, and `ptyController.resize`; every
  // trigger method routes through `enqueueLayout`. The monotonic `seq` is
  // emitted on the mobile subscribe stream so clients can drop stale events.
  // See docs/mobile-terminal-layout-state-machine.md.
  private layouts = new Map<string, PtyLayoutState>()

  // Why: per-PTY async serialization queue for applyLayout. Without
  // serialization, two concurrent triggers can interleave around the
  // ptyController.resize await and bump seq in the wrong order, defeating
  // seq-as-truth. Coalesces same-kind same-owner viewport ticks so the
  // keyboard-show/hide animation doesn't queue 10+ resizes; mode flips,
  // take-floor, and different-owner targets always append (preserves
  // multi-mobile fairness). See docs/mobile-terminal-layout-state-machine.md
  // "enqueueLayout coalescing".
  private layoutQueues = new Map<string, LayoutQueueEntry>()

  // Why: gate so enqueueLayout's "no layouts entry" short-circuit doesn't
  // fire on the very first transition for a PTY (where the entry doesn't
  // exist yet *because* we're about to create it). `handleMobileSubscribe`
  // adds the ptyId before calling enqueueLayout and removes it after the
  // call resolves.
  private freshSubscribeGuard = new Set<string>()

  private stats: StatsCollector | null = null
  // Why (§3.3 + §7.1): the renderer-create path and coordinator
  // `probeWorktreeDrift` share this cache so a create that already fetched
  // `origin` within the last 30s does not re-fetch during dispatch, and
  // vice-versa. Keyed by `<repoPath>::<remote>` so multi-remote repos (even
  // though v1 only uses `origin`) don't cross-contaminate. The in-flight Map
  // also provides serialization — two concurrent callers share a single
  // underlying `git fetch`. Lifecycle rules are enforced in
  // `fetchRemoteWithCache` and MUST NOT be duplicated elsewhere:
  //   - entry inserted BEFORE await,
  //   - `.finally()` removes the entry on BOTH success and rejection,
  //   - timestamp written ONLY on success (rejection must not make the
  //     30s freshness cache lie).
  // A literal "insert before await / read-back after await" without these
  // three rules wedges all future creates on the same repo after a single
  // DNS hiccup until process restart (see §3.3 Lifecycle).
  private fetchInflight = new Map<string, Promise<RemoteFetchResult>>()
  private fetchLastCompletedAt = new Map<string, number>()
  // Why: `getCanonicalFetchKey` is awaited from every freshness probe and
  // every getOrStartRemoteFetch call. Without memoization the warm-cache hot
  // path spawns a `git rev-parse --git-common-dir` subprocess per touch
  // (twice in createLocalWorktree). Cache by `<repoPath>::<remote>` so the
  // canonical key is resolved at most once per repo+remote in the process.
  private canonicalFetchKeyCache = new Map<string, string>()
  private optimisticReconcileTokens = new Map<string, string>()
  private readonly getLocalProviderFn: (() => IPtyProvider) | null
  private accountServices: RuntimeAccountServices | null = null
  private mobileDictation: {
    id: string
    owner: string
    clientId?: string
    connectionId?: string
    state: 'starting' | 'active' | 'closing'
    partialText: string
    finalTexts: string[]
    errors: string[]
  } | null = null

  constructor(
    store: RuntimeStore | null = null,
    stats?: StatsCollector,
    deps?: { getLocalProvider?: () => IPtyProvider }
  ) {
    this.store = store
    if (stats) {
      this.stats = stats
      this.agentDetector = new AgentDetector(stats)
    }
    // Why: the daemon adapter is installed via `setLocalPtyProvider()` during
    // attachMainWindowServices, AFTER this service is constructed. Capturing
    // `getLocalPtyProvider()` at construction time would freeze a reference to
    // the pre-daemon `LocalPtyProvider` and miss the routed adapter. Resolve
    // lazily via thunk so teardown always sees the currently-installed
    // provider (design §4.3 wire-up).
    this.getLocalProviderFn = deps?.getLocalProvider ?? null
  }

  getLocalProvider(): IPtyProvider | null {
    return this.getLocalProviderFn ? this.getLocalProviderFn() : null
  }

  getStatsSummary(): StatsSummary | null {
    return this.stats?.getSummary() ?? null
  }

  // Why: lazy initialization — the DB path depends on Electron's userData
  // which may not be finalized until after app.ready. Also allows unit tests
  // to inject an in-memory DB without touching the filesystem.
  getOrchestrationDb(): OrchestrationDb {
    if (!this._orchestrationDb) {
      const { app } = require('electron')
      const dbPath = join(app.getPath('userData'), 'orchestration.db')
      this._orchestrationDb = new OrchestrationDb(dbPath)
    }
    return this._orchestrationDb
  }

  setOrchestrationDb(db: OrchestrationDb): void {
    this._orchestrationDb = db
  }

  getRuntimeId(): string {
    return this.runtimeId
  }

  getStartedAt(): number {
    return this.startedAt
  }

  getStatus(): RuntimeStatus {
    return {
      runtimeId: this.runtimeId,
      rendererGraphEpoch: this.rendererGraphEpoch,
      graphStatus: this.graphStatus,
      authoritativeWindowId: this.authoritativeWindowId,
      liveTabCount: this.tabs.size,
      liveLeafCount: this.leaves.size,
      runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
      minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
      capabilities: [...RUNTIME_CAPABILITIES],
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      minCompatibleMobileVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION
    }
  }

  setPtyController(controller: RuntimePtyController | null): void {
    // Why: CLI terminal writes must go through the main-owned PTY registry
    // instead of tunneling back through renderer IPC, or live handles could
    // drift from the process they are supposed to control during reloads.
    this.ptyController = controller
  }

  setNotifier(notifier: RuntimeNotifier | null): void {
    this.notifier = notifier
  }

  setAgentBrowserBridge(bridge: AgentBrowserBridge | null): void {
    this.agentBrowserBridge = bridge
  }

  getAgentBrowserBridge(): AgentBrowserBridge | null {
    return this.agentBrowserBridge
  }

  attachWindow(windowId: number): void {
    if (this.authoritativeWindowId === null) {
      this.authoritativeWindowId = windowId
    }
  }

  syncWindowGraph(windowId: number, graph: RuntimeSyncWindowGraph): RuntimeStatus {
    if (this.authoritativeWindowId === null) {
      this.authoritativeWindowId = windowId
    }
    if (windowId !== this.authoritativeWindowId) {
      throw new Error('Runtime graph publisher does not match the authoritative window')
    }

    this.tabs = new Map(graph.tabs.map((tab) => [tab.tabId, tab]))
    this.syncMobileSessionTabs(graph.mobileSessionTabs)
    const nextLeaves = new Map<string, RuntimeLeafRecord>()

    // Why: renderer reloads can briefly republish the same leaf with no ptyId;
    // keep live CLI handles usable while the UI graph rebuilds.
    const preserveLivePtysDuringReload = this.graphStatus === 'reloading'
    for (const leaf of graph.leaves) {
      const leafKey = this.getLeafKey(leaf.tabId, leaf.leafId)
      const existing = this.leaves.get(leafKey)
      const ptyId =
        preserveLivePtysDuringReload && leaf.ptyId === null && existing?.ptyId
          ? existing.ptyId
          : leaf.ptyId
      const ptyGeneration =
        existing && existing.ptyId !== ptyId
          ? existing.ptyGeneration + 1
          : (existing?.ptyGeneration ?? 0)

      nextLeaves.set(leafKey, {
        ...leaf,
        ptyId,
        ptyGeneration,
        connected: ptyId !== null,
        writable: this.graphStatus === 'ready' && ptyId !== null,
        lastOutputAt: existing?.ptyId === ptyId ? existing.lastOutputAt : null,
        lastExitCode: existing?.ptyId === ptyId ? existing.lastExitCode : null,
        tailBuffer: existing?.ptyId === ptyId ? existing.tailBuffer : [],
        tailPartialLine: existing?.ptyId === ptyId ? existing.tailPartialLine : '',
        tailTruncated: existing?.ptyId === ptyId ? existing.tailTruncated : false,
        tailLinesTotal: existing?.ptyId === ptyId ? existing.tailLinesTotal : 0,
        preview: existing?.ptyId === ptyId ? existing.preview : '',
        lastAgentStatus: existing?.ptyId === ptyId ? existing.lastAgentStatus : null,
        lastOscTitle: existing?.ptyId === ptyId ? existing.lastOscTitle : null
      })

      if (leaf.ptyId) {
        this.recordPtyWorktree(leaf.ptyId, leaf.worktreeId, {
          connected: true,
          lastOutputAt: existing?.ptyId === leaf.ptyId ? existing.lastOutputAt : null,
          preview: existing?.ptyId === leaf.ptyId ? existing.preview : '',
          tabId: leaf.tabId,
          paneKey: this.makeRuntimePaneKey(leaf)
        })
      }

      if (existing && (existing.ptyId !== ptyId || existing.ptyGeneration !== ptyGeneration)) {
        this.invalidateLeafHandle(leafKey)
      }
    }

    for (const oldLeafKey of this.leaves.keys()) {
      if (!nextLeaves.has(oldLeafKey)) {
        const oldLeaf = this.leaves.get(oldLeafKey)
        if (
          preserveLivePtysDuringReload &&
          oldLeaf?.ptyId &&
          this.handleByPtyId.has(oldLeaf.ptyId)
        ) {
          // Why: a CLI-created agent keeps using its exported handle even if
          // the reloaded renderer has not rebound the pane yet.
          nextLeaves.set(oldLeafKey, oldLeaf)
        } else {
          this.invalidateLeafHandle(oldLeafKey)
        }
      }
    }

    const nextPtyIds = new Set(
      [...nextLeaves.values()].map((leaf) => leaf.ptyId).filter((ptyId): ptyId is string => !!ptyId)
    )
    for (const [ptyId, leaf] of this.detachedPreAllocatedLeaves) {
      if (nextPtyIds.has(ptyId) || !this.handleByPtyId.has(ptyId)) {
        this.detachedPreAllocatedLeaves.delete(ptyId)
        continue
      }
      nextLeaves.set(this.getLeafKey(leaf.tabId, leaf.leafId), leaf)
      nextPtyIds.add(ptyId)
    }

    this.leaves = nextLeaves
    this.notifyMobileSessionTabSnapshots()
    this.graphStatus = 'ready'
    this.refreshWritableFlags()
    for (const leaf of this.leaves.values()) {
      this.adoptPreAllocatedHandle(leaf)
    }

    // Why: createTerminal waits for the renderer's graph sync to populate the
    // new leaf so it can return a handle. Drain callbacks after leaves update.
    for (const cb of [...this.graphSyncCallbacks]) {
      cb()
    }

    return this.getStatus()
  }

  async listMobileSessionTabs(worktreeSelector: string): Promise<RuntimeMobileSessionTabsResult> {
    const explicitWorktreeId = getExplicitWorktreeIdSelector(worktreeSelector)
    if (explicitWorktreeId) {
      return this.getMobileSessionTabsForWorktree(explicitWorktreeId)
    }
    const worktree = await this.resolveWorktreeSelector(worktreeSelector)
    return this.getMobileSessionTabsForWorktree(worktree.id)
  }

  async activateMobileSessionTab(
    worktreeSelector: string,
    tabId: string
  ): Promise<RuntimeMobileSessionTabsResult> {
    const explicitWorktreeId = getExplicitWorktreeIdSelector(worktreeSelector)
    const worktreeId =
      explicitWorktreeId ?? (await this.resolveWorktreeSelector(worktreeSelector)).id
    const snapshot = this.mobileSessionTabsByWorktree.get(worktreeId)
    const tab = snapshot?.tabs.find((candidate) => candidate.id === tabId)
    if (!tab) {
      throw new Error('tab_not_found')
    }

    if (tab.type === 'terminal') {
      this.notifier?.focusTerminal(tab.parentTabId, worktreeId, tab.leafId)
    } else {
      this.notifier?.focusEditorTab?.(tab.id, worktreeId)
    }
    return this.getMobileSessionTabsForWorktree(worktreeId)
  }

  async closeMobileSessionTab(worktreeSelector: string, tabId: string): Promise<{ closed: true }> {
    const explicitWorktreeId = getExplicitWorktreeIdSelector(worktreeSelector)
    const worktreeId =
      explicitWorktreeId ?? (await this.resolveWorktreeSelector(worktreeSelector)).id
    const snapshot = this.mobileSessionTabsByWorktree.get(worktreeId)
    const tab = snapshot?.tabs.find((candidate) => candidate.id === tabId)
    if (!tab) {
      throw new Error('tab_not_found')
    }
    if (tab.type === 'terminal') {
      const pty = this.findPtyForMobileTerminalTab(tab)
      if (pty) {
        this.ptyController?.kill(pty.ptyId)
      } else {
        this.notifier?.closeTerminal(tab.parentTabId)
      }
    } else {
      this.notifier?.closeSessionTab?.(tab.id, worktreeId)
    }
    return { closed: true }
  }

  async readMobileMarkdownTab(
    worktreeSelector: string,
    tabId: string
  ): Promise<RuntimeMarkdownReadTabResult> {
    const worktreeId = await this.resolveMobileMarkdownWorktreeId(worktreeSelector, tabId)
    if (!this.notifier?.readMobileMarkdownTab) {
      throw new Error('renderer_unavailable')
    }
    return await this.notifier.readMobileMarkdownTab(worktreeId, tabId)
  }

  async saveMobileMarkdownTab(
    worktreeSelector: string,
    tabId: string,
    baseVersion: string,
    content: string
  ): Promise<RuntimeMarkdownSaveTabResult> {
    const worktreeId = await this.resolveMobileMarkdownWorktreeId(worktreeSelector, tabId)
    if (!this.notifier?.saveMobileMarkdownTab) {
      throw new Error('renderer_unavailable')
    }
    return await this.notifier.saveMobileMarkdownTab(worktreeId, tabId, baseVersion, content)
  }

  private readonly fileCommands = new RuntimeFileCommands({
    getRuntimeId: () => this.runtimeId,
    requireStore: () => this.requireStore(),
    resolveWorktreeSelector: (selector) => this.resolveWorktreeSelector(selector),
    resolveRuntimeGitTarget: (selector) => this.resolveRuntimeGitTarget(selector),
    openFile: (worktreeId, filePath, relativePath) => {
      if (!this.notifier?.openFile) {
        throw new Error('renderer_unavailable')
      }
      this.notifier.openFile(worktreeId, filePath, relativePath)
    }
  })

  listMobileFiles: RuntimeFileCommands['listMobileFiles'] = this.fileCommands.listMobileFiles.bind(
    this.fileCommands
  )
  openMobileFile: RuntimeFileCommands['openMobileFile'] = this.fileCommands.openMobileFile.bind(
    this.fileCommands
  )
  readMobileFile: RuntimeFileCommands['readMobileFile'] = this.fileCommands.readMobileFile.bind(
    this.fileCommands
  )
  readFileExplorerDir: RuntimeFileCommands['readFileExplorerDir'] =
    this.fileCommands.readFileExplorerDir.bind(this.fileCommands)
  watchFileExplorer: RuntimeFileCommands['watchFileExplorer'] =
    this.fileCommands.watchFileExplorer.bind(this.fileCommands)
  readFileExplorerPreview: RuntimeFileCommands['readFileExplorerPreview'] =
    this.fileCommands.readFileExplorerPreview.bind(this.fileCommands)
  writeFileExplorerFile: RuntimeFileCommands['writeFileExplorerFile'] =
    this.fileCommands.writeFileExplorerFile.bind(this.fileCommands)
  writeFileExplorerFileBase64: RuntimeFileCommands['writeFileExplorerFileBase64'] =
    this.fileCommands.writeFileExplorerFileBase64.bind(this.fileCommands)
  writeFileExplorerFileBase64Chunk: RuntimeFileCommands['writeFileExplorerFileBase64Chunk'] =
    this.fileCommands.writeFileExplorerFileBase64Chunk.bind(this.fileCommands)
  createFileExplorerFile: RuntimeFileCommands['createFileExplorerFile'] =
    this.fileCommands.createFileExplorerFile.bind(this.fileCommands)
  createFileExplorerDir: RuntimeFileCommands['createFileExplorerDir'] =
    this.fileCommands.createFileExplorerDir.bind(this.fileCommands)
  createFileExplorerDirNoClobber: RuntimeFileCommands['createFileExplorerDirNoClobber'] =
    this.fileCommands.createFileExplorerDirNoClobber.bind(this.fileCommands)
  commitFileExplorerUpload: RuntimeFileCommands['commitFileExplorerUpload'] =
    this.fileCommands.commitFileExplorerUpload.bind(this.fileCommands)
  renameFileExplorerPath: RuntimeFileCommands['renameFileExplorerPath'] =
    this.fileCommands.renameFileExplorerPath.bind(this.fileCommands)
  copyFileExplorerPath: RuntimeFileCommands['copyFileExplorerPath'] =
    this.fileCommands.copyFileExplorerPath.bind(this.fileCommands)
  deleteFileExplorerPath: RuntimeFileCommands['deleteFileExplorerPath'] =
    this.fileCommands.deleteFileExplorerPath.bind(this.fileCommands)
  searchRuntimeFiles: RuntimeFileCommands['searchRuntimeFiles'] =
    this.fileCommands.searchRuntimeFiles.bind(this.fileCommands)
  listRuntimeFiles: RuntimeFileCommands['listRuntimeFiles'] =
    this.fileCommands.listRuntimeFiles.bind(this.fileCommands)
  listRuntimeMarkdownDocuments: RuntimeFileCommands['listRuntimeMarkdownDocuments'] =
    this.fileCommands.listRuntimeMarkdownDocuments.bind(this.fileCommands)
  statRuntimeFile: RuntimeFileCommands['statRuntimeFile'] = this.fileCommands.statRuntimeFile.bind(
    this.fileCommands
  )

  private readonly gitCommands = new RuntimeGitCommands({
    resolveRuntimeGitTarget: (selector) => this.resolveRuntimeGitTarget(selector)
  })

  getRuntimeGitStatus: RuntimeGitCommands['getRuntimeGitStatus'] =
    this.gitCommands.getRuntimeGitStatus.bind(this.gitCommands)
  getRuntimeGitConflictOperation: RuntimeGitCommands['getRuntimeGitConflictOperation'] =
    this.gitCommands.getRuntimeGitConflictOperation.bind(this.gitCommands)
  getRuntimeGitDiff: RuntimeGitCommands['getRuntimeGitDiff'] =
    this.gitCommands.getRuntimeGitDiff.bind(this.gitCommands)
  getRuntimeGitBranchCompare: RuntimeGitCommands['getRuntimeGitBranchCompare'] =
    this.gitCommands.getRuntimeGitBranchCompare.bind(this.gitCommands)
  getRuntimeGitUpstreamStatus: RuntimeGitCommands['getRuntimeGitUpstreamStatus'] =
    this.gitCommands.getRuntimeGitUpstreamStatus.bind(this.gitCommands)
  fetchRuntimeGit: RuntimeGitCommands['fetchRuntimeGit'] = this.gitCommands.fetchRuntimeGit.bind(
    this.gitCommands
  )
  pullRuntimeGit: RuntimeGitCommands['pullRuntimeGit'] = this.gitCommands.pullRuntimeGit.bind(
    this.gitCommands
  )
  pushRuntimeGit: RuntimeGitCommands['pushRuntimeGit'] = this.gitCommands.pushRuntimeGit.bind(
    this.gitCommands
  )
  getRuntimeGitBranchDiff: RuntimeGitCommands['getRuntimeGitBranchDiff'] =
    this.gitCommands.getRuntimeGitBranchDiff.bind(this.gitCommands)
  commitRuntimeGit: RuntimeGitCommands['commitRuntimeGit'] = this.gitCommands.commitRuntimeGit.bind(
    this.gitCommands
  )
  stageRuntimeGitPath: RuntimeGitCommands['stageRuntimeGitPath'] =
    this.gitCommands.stageRuntimeGitPath.bind(this.gitCommands)
  unstageRuntimeGitPath: RuntimeGitCommands['unstageRuntimeGitPath'] =
    this.gitCommands.unstageRuntimeGitPath.bind(this.gitCommands)
  bulkStageRuntimeGitPaths: RuntimeGitCommands['bulkStageRuntimeGitPaths'] =
    this.gitCommands.bulkStageRuntimeGitPaths.bind(this.gitCommands)
  bulkUnstageRuntimeGitPaths: RuntimeGitCommands['bulkUnstageRuntimeGitPaths'] =
    this.gitCommands.bulkUnstageRuntimeGitPaths.bind(this.gitCommands)
  discardRuntimeGitPath: RuntimeGitCommands['discardRuntimeGitPath'] =
    this.gitCommands.discardRuntimeGitPath.bind(this.gitCommands)
  getRuntimeGitRemoteFileUrl: RuntimeGitCommands['getRuntimeGitRemoteFileUrl'] =
    this.gitCommands.getRuntimeGitRemoteFileUrl.bind(this.gitCommands)

  private async resolveRuntimeGitTarget(
    worktreeSelector: string
  ): Promise<{ worktree: ResolvedWorktree; connectionId?: string }> {
    const store = this.requireStore()
    const worktree = await this.resolveWorktreeSelector(worktreeSelector)
    const repo = store.getRepo(worktree.repoId)
    return { worktree, connectionId: repo?.connectionId ?? undefined }
  }

  onMobileSessionTabsChanged(
    listener: (snapshot: RuntimeMobileSessionTabsResult) => void
  ): () => void {
    this.mobileSessionTabListeners.add(listener)
    return () => {
      this.mobileSessionTabListeners.delete(listener)
    }
  }

  // Why: terminal handles are normally created lazily when first referenced via
  // RPC, but agents need their own handle at spawn time (via ORCA_TERMINAL_HANDLE
  // env var) so they can self-identify in orchestration messages without an
  // extra RPC round-trip. Pre-allocating by ptyId lets issueHandle reuse it.
  preAllocateHandleForPty(ptyId: string): string {
    const existing = this.handleByPtyId.get(ptyId)
    if (existing) {
      return existing
    }
    const handle = this.createPreAllocatedTerminalHandle()
    this.handleByPtyId.set(ptyId, handle)
    return handle
  }

  createPreAllocatedTerminalHandle(): string {
    return `term_${randomUUID()}`
  }

  registerPreAllocatedHandleForPty(ptyId: string, handle: string): void {
    this.handleByPtyId.set(ptyId, handle)
    for (const leaf of this.leaves.values()) {
      if (leaf.ptyId === ptyId) {
        this.adoptPreAllocatedHandle(leaf)
      }
    }
  }

  onPtySpawned(ptyId: string): void {
    const pty = this.getOrCreatePtyWorktreeRecord(ptyId)
    if (pty) {
      pty.connected = true
    }
    for (const leaf of this.leaves.values()) {
      if (leaf.ptyId === ptyId) {
        leaf.connected = true
        leaf.writable = this.graphStatus === 'ready'
        this.adoptPreAllocatedHandle(leaf)
      }
    }
  }

  registerPty(ptyId: string, worktreeId: string): void {
    this.recordPtyWorktree(ptyId, worktreeId, { connected: true })
  }

  onPtyData(ptyId: string, data: string, at: number): void {
    // Agent detection runs on raw data before leaf processing, since the
    // tail buffer logic normalizes away the OSC sequences we need.
    this.agentDetector?.onData(ptyId, data, at)
    // Ordering invariant (DO NOT REORDER): maybeHydrateHeadlessFromRenderer
    // MUST run before trackHeadlessTerminalData so the eager-state pattern
    // (set headlessTerminals + writeChain head = seedPromise) is in place
    // before the live byte's chain link is queued. Without this ordering,
    // trackHeadlessTerminalData would lazy-create a fresh state at PTY dims
    // that the later seed-resolve would overwrite, dropping the live byte.
    // See docs/mobile-prefer-renderer-scrollback.md.
    this.maybeHydrateHeadlessFromRenderer(ptyId)
    this.trackHeadlessTerminalData(ptyId, data)

    // Why: extract OSC title from raw PTY data before tail-buffer processing
    // strips the escape sequences. Agent CLIs (Claude Code, Gemini, etc.)
    // announce status via OSC 0/1/2 title sequences — this is the same
    // detection path the renderer uses for notifications and sidebar badges.
    const oscTitle = extractLastOscTitle(data)
    const agentStatus = oscTitle ? detectAgentStatusFromTitle(oscTitle) : null

    const pty = this.getOrCreatePtyWorktreeRecord(ptyId)
    if (pty) {
      pty.connected = true
      pty.lastOutputAt = at
      const nextTail = appendToTailBuffer(pty.tailBuffer, pty.tailPartialLine, data)
      pty.tailBuffer = nextTail.lines
      pty.tailPartialLine = nextTail.partialLine
      pty.tailTruncated = pty.tailTruncated || nextTail.truncated
      pty.tailLinesTotal += nextTail.newCompleteLines
      pty.preview = buildPreview(pty.tailBuffer, pty.tailPartialLine)
      if (oscTitle !== null) {
        const prevStatus = pty.lastAgentStatus
        pty.lastOscTitle = oscTitle
        pty.lastAgentStatus = agentStatus
        if (agentStatus === 'idle' && prevStatus !== 'idle') {
          this.resolvePtyTuiIdleWaiters(pty, ptyId)
        }
      }
    }

    for (const leaf of this.leaves.values()) {
      if (leaf.ptyId !== ptyId) {
        continue
      }
      this.recordPtyWorktree(ptyId, leaf.worktreeId, {
        connected: true,
        lastOutputAt: pty?.lastOutputAt ?? at,
        preview: pty?.preview ?? leaf.preview,
        tabId: leaf.tabId,
        paneKey: this.makeRuntimePaneKey(leaf)
      })
      leaf.connected = true
      leaf.writable = this.graphStatus === 'ready'
      leaf.lastOutputAt = at
      const nextTail = appendToTailBuffer(leaf.tailBuffer, leaf.tailPartialLine, data)
      leaf.tailBuffer = nextTail.lines
      leaf.tailPartialLine = nextTail.partialLine
      leaf.tailTruncated = leaf.tailTruncated || nextTail.truncated
      leaf.tailLinesTotal += nextTail.newCompleteLines
      leaf.preview = buildPreview(leaf.tailBuffer, leaf.tailPartialLine)

      if (oscTitle !== null) {
        // Why: keep the latest OSC title on the leaf so worktree.ps can
        // recompute status from the live title each call. Without this,
        // daemon-hosted terminals (no renderer pushing pane titles) had no
        // way to clear a stale 'working' status after the agent exited and
        // the shell took over the title — the stuck-spinner bug in #1437.
        leaf.lastOscTitle = oscTitle
        const prevStatus = leaf.lastAgentStatus
        // Why: when a new OSC title doesn't classify as an agent state (e.g.
        // bare shell title after the agent exits), clear lastAgentStatus so
        // it is no longer sticky. Tui-idle waiters that needed the previous
        // 'idle' transition were already resolved at the moment of the
        // transition below; only fresh waiters registered after the agent
        // exits would observe the cleared value, and they correctly fall
        // back to title-based detection / polling.
        leaf.lastAgentStatus = agentStatus
        // Why: resolve tui-idle on any transition TO idle (not just working→idle).
        // Claude Code may skip "working" entirely on fast tasks, going null→idle,
        // and the coordinator's tui-idle waiter would hang forever waiting for a
        // working→idle transition that never comes. Permission→idle is excluded:
        // it means the agent was blocked on user approval and the user said no,
        // which isn't a task-completion signal.
        if (agentStatus === 'idle' && prevStatus !== 'idle') {
          this.resolveTuiIdleWaiters(leaf)
          this.deliverPendingMessages(leaf)
        }
      }
    }

    const listeners = this.dataListeners.get(ptyId)
    if (listeners) {
      for (const listener of listeners) {
        listener(data)
      }
    }
  }

  subscribeToTerminalData(ptyId: string, listener: (data: string) => void): () => void {
    let listeners = this.dataListeners.get(ptyId)
    if (!listeners) {
      listeners = new Set()
      this.dataListeners.set(ptyId, listeners)
    }
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) {
        this.dataListeners.delete(ptyId)
      }
    }
  }

  subscribeToFitOverrideChanges(
    ptyId: string,
    listener: (event: { mode: 'mobile-fit' | 'desktop-fit'; cols: number; rows: number }) => void
  ): () => void {
    let listeners = this.fitOverrideListeners.get(ptyId)
    if (!listeners) {
      listeners = new Set()
      this.fitOverrideListeners.set(ptyId, listeners)
    }
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) {
        this.fitOverrideListeners.delete(ptyId)
      }
    }
  }

  subscribeToDriverChanges(ptyId: string, listener: (driver: DriverState) => void): () => void {
    let listeners = this.driverListeners.get(ptyId)
    if (!listeners) {
      listeners = new Set()
      this.driverListeners.set(ptyId, listeners)
    }
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) {
        this.driverListeners.delete(ptyId)
      }
    }
  }

  private notifyFitOverrideListeners(
    ptyId: string,
    mode: 'mobile-fit' | 'desktop-fit',
    cols: number,
    rows: number
  ): void {
    const listeners = this.fitOverrideListeners.get(ptyId)
    if (!listeners) {
      return
    }
    for (const listener of listeners) {
      listener({ mode, cols, rows })
    }
  }

  serializeTerminalBuffer(
    ptyId: string,
    opts: { scrollbackRows?: number } = {}
  ): Promise<{ data: string; cols: number; rows: number } | null> {
    return this.serializeTerminalBufferFromAvailableState(ptyId, opts)
  }

  async clearTerminalBuffer(handle: string): Promise<{ handle: string; cleared: boolean }> {
    const leaf = this.resolveLeafForHandle(handle)
    if (!leaf?.ptyId) {
      throw new Error('terminal_not_found')
    }
    // Why: clear is a terminal UI action (Cmd+K on desktop), not shell input.
    // Route through the controller so renderer-owned xterm buffers, daemon
    // sessions, and SSH relay sessions all drop scrollback before the next
    // mobile snapshot.
    await this.ptyController?.clearBuffer?.(leaf.ptyId)
    await this.clearHeadlessTerminalBuffer(leaf.ptyId)
    return { handle, cleared: true }
  }

  getTerminalSize(ptyId: string): { cols: number; rows: number } | null {
    return this.ptyController?.getSize?.(ptyId) ?? null
  }

  // Why: daemon-backed PTYs that the runtime adopted after an Orca relaunch
  // start with a fresh headless emulator that has zero scrollback, even though
  // the daemon's on-disk checkpoint and the desktop xterm both contain the
  // full prior history. Without this hydration, mobile subscribers see only
  // the bare current prompt because serializeHeadlessTerminalBuffer always
  // wins over the renderer-path fallback. Seeding the emulator with the
  // adapter's snapshot/cold-restore data makes mobile and desktop agree on
  // what scrollback is available.
  seedHeadlessTerminal(ptyId: string, data: string, size?: { cols: number; rows: number }): void {
    if (!data) {
      return
    }
    const existing = this.headlessTerminals.get(ptyId)
    if (existing) {
      // Why: emulator already has live data — re-seeding would duplicate
      // every byte. The seed is only valid when the emulator is fresh.
      return
    }
    const dims = size ?? this.getTerminalSize(ptyId) ?? { cols: 80, rows: 24 }
    const state: RuntimeHeadlessTerminal = {
      emulator: new HeadlessEmulator({ cols: dims.cols, rows: dims.rows }),
      writeChain: Promise.resolve()
    }
    this.headlessTerminals.set(ptyId, state)
    state.writeChain = state.writeChain
      .then(() => state.emulator.write(data))
      .catch(() => {
        // Seeding is best-effort; live data will continue to populate the
        // emulator even if the snapshot replay fails.
      })
  }

  // Why: hydrate the runtime headless emulator from the desktop renderer's
  // xterm buffer on the first onPtyData byte after a PTY is taken over by a
  // pane. Eager-state pattern matches seedHeadlessTerminal: headlessTerminals
  // is populated synchronously so concurrent live writes from
  // trackHeadlessTerminalData chain after the seed via the same writeChain.
  // See docs/mobile-prefer-renderer-scrollback.md.
  private maybeHydrateHeadlessFromRenderer(ptyId: string): void {
    if (this.headlessHydrationState.has(ptyId)) {
      return
    }
    if (this.headlessTerminals.has(ptyId)) {
      // Daemon-snapshot seed already populated the emulator — skip hydration.
      this.headlessHydrationState.set(ptyId, 'done')
      return
    }
    const controller = this.ptyController
    if (!controller?.serializeBuffer || !controller.hasRendererSerializer) {
      return
    }
    if (!controller.hasRendererSerializer(ptyId)) {
      // Renderer hasn't registered yet (or never will). Live writes lazy-
      // create the state via trackHeadlessTerminalData on this same tick.
      return
    }

    this.headlessHydrationState.set(ptyId, 'pending')
    const dims = this.getTerminalSize(ptyId) ?? { cols: 80, rows: 24 }
    const state: RuntimeHeadlessTerminal = {
      emulator: new HeadlessEmulator({ cols: dims.cols, rows: dims.rows }),
      writeChain: Promise.resolve()
    }
    this.headlessTerminals.set(ptyId, state)

    // Why: append the seed work to writeChain so live writes queued by
    // trackHeadlessTerminalData (after this method returns synchronously)
    // execute AFTER the seed-write resolves. If we awaited inline before
    // setting headlessTerminals, the live byte would lazy-create a separate
    // state and the seed-resolve would overwrite it, dropping live bytes.
    state.writeChain = state.writeChain.then(async () => {
      try {
        const rendered = await controller.serializeBuffer!(ptyId, {
          scrollbackRows: MOBILE_SUBSCRIBE_SCROLLBACK_ROWS,
          altScreenForcesZeroRows: true
        })
        if (!rendered || rendered.data.length === 0) {
          return
        }
        // Resize to renderer's dims so the seed reflows correctly into the
        // emulator's grid, then resize back to PTY dims (if known) so live
        // writes use the correct cell layout.
        if (rendered.cols !== dims.cols || rendered.rows !== dims.rows) {
          state.emulator.resize(rendered.cols, rendered.rows)
        }
        await state.emulator.write(rendered.data)
        const ptyDims = this.getTerminalSize(ptyId)
        if (ptyDims && (ptyDims.cols !== rendered.cols || ptyDims.rows !== rendered.rows)) {
          state.emulator.resize(ptyDims.cols, ptyDims.rows)
        }
        if (rendered.lastTitle) {
          this.applySeededAgentStatus(ptyId, rendered.lastTitle)
        }
      } catch {
        // Hydration is best-effort. Live writes continue via the same
        // writeChain that this catch-arm leaves intact.
      } finally {
        this.headlessHydrationState.set(ptyId, 'done')
      }
    })
  }

  // Why: seed-derived agent status reflects historical state. Orchestration
  // waiters (resolveTuiIdleWaiters, deliverPendingMessages) must only react
  // to LIVE transitions, so this helper writes leaf.lastAgentStatus only and
  // never resolves waiters. detectAgentStatusFromTitle wrap mirrors the live
  // path so seeded and live values are the same union member, keeping
  // downstream `=== 'idle'` checks correct.
  private applySeededAgentStatus(ptyId: string, title: string): void {
    if (!title) {
      return
    }
    const status = detectAgentStatusFromTitle(title)
    for (const leaf of this.leaves.values()) {
      if (leaf.ptyId === ptyId) {
        // Why: seed lastOscTitle even when the seeded title doesn't classify
        // as an agent state, so worktree.ps recomputes status from the live
        // title rather than treating the leaf as agentless.
        leaf.lastOscTitle = title
        if (status !== null) {
          leaf.lastAgentStatus = status
        }
      }
    }
  }

  private trackHeadlessTerminalData(ptyId: string, data: string): void {
    const state = this.getOrCreateHeadlessTerminal(ptyId)
    state.writeChain = state.writeChain
      .then(() => state.emulator.write(data))
      .catch(() => {
        // Best-effort state tracking; live streaming must continue even if
        // xterm rejects a malformed or raced write during shutdown.
      })
  }

  private getOrCreateHeadlessTerminal(ptyId: string): RuntimeHeadlessTerminal {
    const existing = this.headlessTerminals.get(ptyId)
    if (existing) {
      return existing
    }
    const size = this.getTerminalSize(ptyId) ?? { cols: 80, rows: 24 }
    const state: RuntimeHeadlessTerminal = {
      emulator: new HeadlessEmulator({ cols: size.cols, rows: size.rows }),
      writeChain: Promise.resolve()
    }
    this.headlessTerminals.set(ptyId, state)
    return state
  }

  private resizeHeadlessTerminal(ptyId: string, cols: number, rows: number): void {
    this.headlessTerminals.get(ptyId)?.emulator.resize(cols, rows)
  }

  private async clearHeadlessTerminalBuffer(ptyId: string): Promise<void> {
    const state = this.headlessTerminals.get(ptyId)
    if (!state) {
      return
    }
    // Why: headless writes are queued to preserve xterm parser order. Clear
    // must join that same chain or an earlier PTY chunk can finish after the
    // clear request and repopulate mobile scrollback.
    state.writeChain = state.writeChain.then(() => state.emulator.clearScrollback())
    await state.writeChain
  }

  private async serializeTerminalBufferFromAvailableState(
    ptyId: string,
    opts: { scrollbackRows?: number } = {}
  ): Promise<{ data: string; cols: number; rows: number } | null> {
    const headlessSnapshot = await this.serializeHeadlessTerminalBuffer(ptyId, opts)
    if (headlessSnapshot) {
      return headlessSnapshot
    }

    let rendererSnapshot: {
      data: string
      cols: number
      rows: number
      lastTitle?: string
    } | null = null
    try {
      // Why: read-fallback wants visible alt-screen content (e.g. an active
      // TUI like vim) so altScreenForcesZeroRows is FALSE here. Hydration is
      // the only path that suppresses alt-screen scrollback. See
      // docs/mobile-prefer-renderer-scrollback.md.
      rendererSnapshot = await (this.ptyController?.serializeBuffer?.(ptyId, {
        scrollbackRows: opts.scrollbackRows,
        altScreenForcesZeroRows: false
      }) ?? Promise.resolve(null))
    } catch {
      // Why: mobile scrollback should not depend on a mounted renderer pane.
      // If renderer serialization races reload/unmount, the runtime snapshot
      // below can still preserve colored terminal state.
    }
    if (rendererSnapshot && rendererSnapshot.data.length > 0) {
      return rendererSnapshot
    }
    return rendererSnapshot
  }

  private async serializeHeadlessTerminalBuffer(
    ptyId: string,
    opts: { scrollbackRows?: number } = {}
  ): Promise<{ data: string; cols: number; rows: number } | null> {
    const state = this.headlessTerminals.get(ptyId)
    if (!state) {
      return null
    }
    await state.writeChain
    // Why: when an alternate-screen TUI (Claude Code, vim, etc.) is currently
    // active, the visible content is the alt-screen snapshot — replaying any
    // normal-buffer scrollback before it can duplicate shell prompts and
    // flatten SGR attributes when the mobile xterm replays the data. Force
    // scrollbackRows=0 in that case. When the buffer is in normal mode the
    // caller can request scrollback so the user can scroll up to see prior
    // agent output.
    const requested = opts.scrollbackRows ?? 0
    const scrollbackRows = state.emulator.isAlternateScreen ? 0 : requested
    const snapshot = state.emulator.getSnapshot({ scrollbackRows })
    const data = snapshot.rehydrateSequences + snapshot.snapshotAnsi
    return data.length > 0 ? { data, cols: snapshot.cols, rows: snapshot.rows } : null
  }

  private disposeHeadlessTerminal(ptyId: string): void {
    this.headlessHydrationState.delete(ptyId)
    const state = this.headlessTerminals.get(ptyId)
    if (!state) {
      return
    }
    this.headlessTerminals.delete(ptyId)
    state.writeChain.finally(() => state.emulator.dispose()).catch(() => state.emulator.dispose())
  }

  resolveLeafForHandle(handle: string): { ptyId: string | null } | null {
    const record = this.handles.get(handle)
    if (!record) {
      return null
    }
    if (record.tabId.startsWith('pty:')) {
      return { ptyId: record.ptyId }
    }
    const leaf = this.leaves.get(this.getLeafKey(record.tabId, record.leafId))
    if (!leaf) {
      return null
    }
    return { ptyId: leaf.ptyId }
  }

  registerSubscriptionCleanup(
    subscriptionId: string,
    cleanup: () => void,
    connectionId?: string
  ): void {
    // Why: mobile clients reconnect frequently (phone lock, network switch).
    // The RPC client re-sends terminal.subscribe on reconnect, creating a new
    // handler before the old one is cleaned up. Without this, the old data
    // listener leaks in dataListeners and duplicates every PTY data event.
    const existing = this.subscriptionCleanups.get(subscriptionId)
    if (existing) {
      this.cleanupSubscription(subscriptionId)
    }
    this.subscriptionCleanups.set(subscriptionId, cleanup)
    if (connectionId) {
      let set = this.subscriptionsByConnection.get(connectionId)
      if (!set) {
        set = new Set()
        this.subscriptionsByConnection.set(connectionId, set)
      }
      set.add(subscriptionId)
      this.subscriptionConnectionByEntry.set(subscriptionId, connectionId)
    }
  }

  cleanupSubscription(subscriptionId: string): void {
    const cleanup = this.subscriptionCleanups.get(subscriptionId)
    if (cleanup) {
      this.subscriptionCleanups.delete(subscriptionId)
      const connectionId = this.subscriptionConnectionByEntry.get(subscriptionId)
      if (connectionId) {
        this.subscriptionConnectionByEntry.delete(subscriptionId)
        const set = this.subscriptionsByConnection.get(connectionId)
        if (set) {
          set.delete(subscriptionId)
          if (set.size === 0) {
            this.subscriptionsByConnection.delete(connectionId)
          }
        }
      }
      cleanup()
    }
  }

  // Why: invoked from the WebSocket transport's on-close hook so streaming
  // listeners registered for this exact socket get torn down even when other
  // sockets sharing the same deviceToken are still alive (multi-screen
  // mobile). Without this sweep, listeners leak across every reconnect.
  cleanupSubscriptionsForConnection(connectionId: string): void {
    const set = this.subscriptionsByConnection.get(connectionId)
    if (!set) {
      return
    }
    // Why: snapshot the ids before iterating because cleanupSubscription
    // mutates both the set and the index map.
    const ids = Array.from(set)
    for (const id of ids) {
      this.cleanupSubscription(id)
    }
  }

  // Why: mobile clients subscribe via notifications.subscribe streaming RPC.
  // Each subscriber gets its own listener. Returns an unsubscribe function
  // that the subscription cleanup mechanism calls on disconnect.
  onNotificationDispatched(listener: (event: MobileNotificationEvent) => void): () => void {
    this.notificationListeners.add(listener)
    return () => {
      this.notificationListeners.delete(listener)
    }
  }

  getMobileNotificationListenerCount(): number {
    return this.notificationListeners.size
  }

  dispatchMobileNotification(event: MobileNotificationEvent): void {
    for (const listener of this.notificationListeners) {
      listener(event)
    }
  }

  // ─── Account Services (mobile RPC bridge) ─────────────────────

  setAccountServices(services: RuntimeAccountServices): void {
    this.accountServices = services
  }

  async startMobileDictation(params: {
    dictationId: string
    modelId?: string
    clientId?: string
    connectionId?: string
  }): Promise<{
    dictationId: string
    modelId: string
  }> {
    if (!this.store) {
      throw new Error('voice_dictation_unavailable')
    }

    const voice = this.store.getSettings().voice ?? getDefaultVoiceSettings()
    if (!voice.enabled) {
      throw new Error('voice_dictation_disabled')
    }

    const modelId = params.modelId || voice.sttModel
    if (!modelId) {
      throw new Error('voice_model_not_selected')
    }

    const modelState = await getSpeechModelManager(this.store).getModelState(modelId)
    if (modelState.status !== 'ready') {
      throw new Error(`voice_model_not_ready:${modelState.status}`)
    }

    if (!params.clientId) {
      throw new Error('dictation_requires_mobile_client')
    }

    if (this.mobileDictation) {
      throw new Error('dictation_already_active')
    }

    const owner = `mobile:${params.dictationId}`
    this.mobileDictation = {
      id: params.dictationId,
      owner,
      clientId: params.clientId,
      connectionId: params.connectionId,
      state: 'starting',
      partialText: '',
      finalTexts: [],
      errors: []
    }

    try {
      await getSpeechSttService(this.store).startDictation(
        modelId,
        (event) => {
          const session = this.mobileDictation
          if (!session || session.id !== params.dictationId) {
            return
          }
          if (event.type === 'partial') {
            session.partialText = event.text ?? ''
          } else if (event.type === 'final') {
            const text = event.text?.trim()
            if (text) {
              session.finalTexts.push(text)
              session.partialText = ''
            }
          } else if (event.type === 'error') {
            session.errors.push(event.error ?? 'Speech worker error')
          }
        },
        undefined,
        owner
      )
      if (this.mobileDictation?.id !== params.dictationId) {
        throw new Error('dictation_canceled')
      }
      this.mobileDictation.state = 'active'
    } catch (error) {
      if (this.mobileDictation?.id === params.dictationId) {
        this.mobileDictation = null
      }
      throw error
    }

    return { dictationId: params.dictationId, modelId }
  }

  feedMobileDictation(params: {
    dictationId: string
    audioBase64: string
    sampleRate: number
    clientId?: string
    connectionId?: string
  }): {
    dictationId: string
  } {
    const session = this.mobileDictation
    if (!session || session.id !== params.dictationId) {
      throw new Error('dictation_stream_not_started')
    }
    if (!params.clientId || session.clientId !== params.clientId) {
      throw new Error('dictation_owner_mismatch')
    }
    if (session.connectionId && session.connectionId !== params.connectionId) {
      throw new Error('dictation_owner_mismatch')
    }
    if (session.state !== 'active') {
      throw new Error('dictation_stream_closing')
    }
    if (session.errors.length > 0) {
      throw new Error(session.errors[0])
    }

    const pcm = Buffer.from(params.audioBase64, 'base64')
    const samples = new Float32Array(Math.floor(pcm.length / 2))
    for (let i = 0; i < samples.length; i += 1) {
      samples[i] = pcm.readInt16LE(i * 2) / 32768
    }
    getSpeechSttService(this.store!).feedAudio(samples, params.sampleRate, session.owner)
    return { dictationId: params.dictationId }
  }

  async finishMobileDictation(params: {
    dictationId: string
    clientId?: string
    connectionId?: string
  }): Promise<{
    dictationId: string
    text: string
  }> {
    const session = this.mobileDictation
    if (!session || session.id !== params.dictationId) {
      throw new Error('dictation_stream_not_started')
    }
    if (!params.clientId || session.clientId !== params.clientId) {
      throw new Error('dictation_owner_mismatch')
    }
    if (session.connectionId && session.connectionId !== params.connectionId) {
      throw new Error('dictation_owner_mismatch')
    }
    session.state = 'closing'
    try {
      await getSpeechSttService(this.store!).stopDictation(session.owner)
      if (session.errors.length > 0) {
        throw new Error(session.errors[0])
      }
      const text = [...session.finalTexts, session.partialText].join(' ').trim()
      return { dictationId: params.dictationId, text }
    } finally {
      if (this.mobileDictation?.id === session.id) {
        this.mobileDictation = null
      }
    }
  }

  async cancelMobileDictation(params: {
    dictationId: string
    clientId?: string
    connectionId?: string
  }): Promise<{ dictationId: string }> {
    const session = this.mobileDictation
    if (
      session?.id === params.dictationId &&
      params.clientId &&
      session.clientId === params.clientId &&
      (!session.connectionId || session.connectionId === params.connectionId)
    ) {
      session.state = 'closing'
      try {
        await getSpeechSttService(this.store!).stopDictation(session.owner)
      } finally {
        if (this.mobileDictation?.id === session.id) {
          this.mobileDictation = null
        }
      }
    }
    return { dictationId: params.dictationId }
  }

  private cancelMobileDictationSession(session: NonNullable<typeof this.mobileDictation>): void {
    if (session.state === 'closing') {
      return
    }
    session.state = 'closing'
    void getSpeechSttService(this.store!)
      .stopDictation(session.owner)
      .finally(() => {
        if (this.mobileDictation?.id === session.id) {
          this.mobileDictation = null
        }
      })
  }

  cancelMobileDictationForConnection(connectionId: string): void {
    const session = this.mobileDictation
    if (!session || session.connectionId !== connectionId) {
      return
    }
    this.cancelMobileDictationSession(session)
  }

  private cancelMobileDictationForClient(clientId: string): void {
    const session = this.mobileDictation
    if (!session || session.clientId !== clientId) {
      return
    }
    this.cancelMobileDictationSession(session)
  }

  private requireAccountServices(): RuntimeAccountServices {
    if (!this.accountServices) {
      throw new Error('Account services are not configured on this runtime')
    }
    return this.accountServices
  }

  getAccountsSnapshot(): AccountsSnapshot {
    const { claudeAccounts, codexAccounts, rateLimits } = this.requireAccountServices()
    return {
      claude: claudeAccounts.listAccounts(),
      codex: codexAccounts.listAccounts(),
      rateLimits: rateLimits.getState()
    }
  }

  // Why: RateLimitService polls only when the Electron window is visible AND
  // focused, and the inactive-account caches fill lazily when the user opens
  // the desktop AccountsPane. Mobile has neither trigger, so without this the
  // phone shows 0% / "—" against a backgrounded desktop. Errors swallowed
  // because partial usage is still useful for the rest of the snapshot.
  async refreshAccountsForMobile(): Promise<void> {
    const { rateLimits } = this.requireAccountServices()
    await Promise.allSettled([
      rateLimits.refresh(),
      rateLimits.fetchInactiveClaudeAccountsOnOpen(),
      rateLimits.fetchInactiveCodexAccountsOnOpen()
    ])
  }

  selectClaudeAccount(accountId: string | null): Promise<ClaudeRateLimitAccountsState> {
    return this.requireAccountServices().claudeAccounts.selectAccount(accountId)
  }

  selectCodexAccount(accountId: string | null): Promise<CodexRateLimitAccountsState> {
    return this.requireAccountServices().codexAccounts.selectAccount(accountId)
  }

  removeClaudeAccount(accountId: string): Promise<ClaudeRateLimitAccountsState> {
    return this.requireAccountServices().claudeAccounts.removeAccount(accountId)
  }

  removeCodexAccount(accountId: string): Promise<CodexRateLimitAccountsState> {
    return this.requireAccountServices().codexAccounts.removeAccount(accountId)
  }

  // Why: rate-limit polling fires every 5 minutes and on account switch.
  // Mobile clients subscribe to receive a fresh AccountsSnapshot whenever
  // RateLimitService pushes new usage data, mirroring the existing
  // `rateLimits:update` IPC channel desktop already uses.
  onAccountsChanged(listener: (snapshot: AccountsSnapshot) => void): () => void {
    const services = this.requireAccountServices()
    return services.rateLimits.onStateChange(() => {
      listener({
        claude: services.claudeAccounts.listAccounts(),
        codex: services.codexAccounts.listAccounts(),
        rateLimits: services.rateLimits.getState()
      })
    })
  }

  // ─── Mobile Fit Override Management ─────────────────────────

  // Why: legacy mobile RPC entrypoint. After the state-machine rewrite this
  // is a thin shim that computes a `PtyLayoutTarget` and routes through
  // `enqueueLayout`. Keeps the same observable return shape so older mobile
  // builds continue to work. See docs/mobile-terminal-layout-state-machine.md.
  async resizeForClient(
    ptyId: string,
    mode: 'mobile-fit' | 'restore',
    clientId: string,
    cols?: number,
    rows?: number
  ): Promise<{
    cols: number
    rows: number
    previousCols: number | null
    previousRows: number | null
    mode: 'mobile-fit' | 'desktop-fit'
  }> {
    if (mode === 'mobile-fit') {
      if (cols == null || rows == null || !Number.isFinite(cols) || !Number.isFinite(rows)) {
        throw new Error('invalid_dimensions')
      }
      const clampedCols = Math.max(20, Math.min(240, Math.round(cols)))
      const clampedRows = Math.max(8, Math.min(120, Math.round(rows)))

      const currentSize = this.getTerminalSize(ptyId)
      const existing = this.terminalFitOverrides.get(ptyId)
      // Capture baseline cols/rows for the return value (existing override's
      // baseline wins over current size to preserve original desktop dims
      // across multiple re-fits).
      const previousCols = existing?.previousCols ?? currentSize?.cols ?? null
      const previousRows = existing?.previousRows ?? currentSize?.rows ?? null

      // Why: legacy resizeForClient callers bypass handleMobileSubscribe, so
      // mobileSubscribers stays empty and resolveDesktopRestoreTarget's step-1
      // (per-subscriber baseline) never matches. Stash the pre-fit PTY size
      // into lastRendererSizes so restore lands on step 2 (renderer geometry)
      // instead of step 3 (current phone-fit dims = no-op restore).
      if (currentSize && !existing) {
        this.lastRendererSizes.set(ptyId, {
          cols: currentSize.cols,
          rows: currentSize.rows
        })
      }

      this.freshSubscribeGuard.add(ptyId)
      let result: ApplyLayoutResult
      try {
        result = await this.enqueueLayout(ptyId, {
          kind: 'phone',
          cols: clampedCols,
          rows: clampedRows,
          ownerClientId: clientId
        })
      } finally {
        this.freshSubscribeGuard.delete(ptyId)
      }
      if (!result.ok) {
        throw new Error('resize_failed')
      }

      // Why: mobile-fit via resizeForClient is a deliberate mobile action;
      // the actor takes the floor (updates lastActedAt; mode-flip case is
      // already handled by enqueueLayout above).
      await this.mobileTookFloor(ptyId, clientId)

      return {
        cols: clampedCols,
        rows: clampedRows,
        previousCols,
        previousRows,
        mode: 'mobile-fit'
      }
    }

    // restore mode
    const override = this.terminalFitOverrides.get(ptyId)
    if (!override) {
      throw new Error('no_active_override')
    }
    // Only the owning client can restore — prevents one phone from undoing
    // another phone's active fit.
    if (override.clientId !== clientId) {
      throw new Error('not_override_owner')
    }

    const restore = this.resolveDesktopRestoreTarget(ptyId)
    const result = await this.enqueueLayout(ptyId, {
      kind: 'desktop',
      cols: restore.cols,
      rows: restore.rows
    })
    if (!result.ok) {
      throw new Error('resize_failed')
    }

    // Why: legacy mobile clients on the resizeForClient path also need a
    // fit-override-listener notification (the renderer-side terminalFitOverrideChanged
    // is already emitted by applyLayout's mode-flip path).
    this.notifyFitOverrideListeners(ptyId, 'desktop-fit', restore.cols, restore.rows)

    return {
      cols: restore.cols,
      rows: restore.rows,
      previousCols: null,
      previousRows: null,
      mode: 'desktop-fit'
    }
  }

  getTerminalFitOverride(ptyId: string) {
    return this.terminalFitOverrides.get(ptyId) ?? null
  }

  getAllTerminalFitOverrides(): Map<string, { mode: 'mobile-fit'; cols: number; rows: number }> {
    const result = new Map<string, { mode: 'mobile-fit'; cols: number; rows: number }>()
    for (const [ptyId, override] of this.terminalFitOverrides) {
      result.set(ptyId, { mode: override.mode, cols: override.cols, rows: override.rows })
    }
    return result
  }

  getAllTerminalDrivers(): Map<string, DriverState> {
    return new Map(this.currentDriver)
  }

  onClientDisconnected(clientId: string): void {
    this.cancelMobileDictationForClient(clientId)

    // (1) Cancel pending restore-debounce timers owned by this client.
    for (const [ptyId, entry] of this.pendingRestoreTimers) {
      if (entry.clientId === clientId) {
        clearTimeout(entry.timer)
        this.pendingRestoreTimers.delete(ptyId)
      }
    }

    // (2) Promote any soft-leave grace owned by this client into immediate
    // finalization. Grace existed to absorb a quick re-subscribe; a real
    // disconnect kills any chance of re-subscribe.
    //
    // Note: this is mode-decoupled (matches docs/mobile-terminal-layout-state-machine.md
    // sub-case 2). Today's pre-rewrite code only restored when
    // `mode === 'auto' && wasResizedToPhone`; the new design restores
    // whenever the layout is currently `phone`. This is an intentional
    // behavior fix — `mode === 'phone'` with no subscribers is a degenerate
    // state nothing in product depends on.
    for (const [ptyId, soft] of this.pendingSoftLeavers) {
      if (soft.clientId !== clientId) {
        continue
      }
      clearTimeout(soft.timer)
      this.pendingSoftLeavers.delete(ptyId)

      // Cancel any in-flight 300ms restore timer too — we'll handle it inline.
      const pending = this.pendingRestoreTimers.get(ptyId)
      if (pending) {
        clearTimeout(pending.timer)
        this.pendingRestoreTimers.delete(ptyId)
      }

      const cur = this.layouts.get(ptyId)
      // Why: Indefinite hold (mobileAutoRestoreFitMs == null) keeps the PTY
      // at phone dims after the phone disconnects; the desktop banner's
      // Restore button is the explicit return path. See
      // docs/mobile-fit-hold.md.
      if (cur?.kind === 'phone' && this.getAutoRestoreFitMs() != null) {
        // Use the soft-leaver's snapshot baseline as a hint, falling
        // through to resolveDesktopRestoreTarget for missing values.
        const fallback = this.resolveDesktopRestoreTarget(ptyId)
        const cols = soft.record.previousCols ?? fallback.cols
        const rows = soft.record.previousRows ?? fallback.rows
        void this.enqueueLayout(ptyId, { kind: 'desktop', cols, rows })
      }
      this.setDriver(ptyId, { kind: 'idle' })
    }

    // (3) Immediate restore for PTYs where this client was the last
    // mobile subscriber. With multi-mobile, peer subscribers keep the
    // floor; only when the inner map empties do we transition to desktop.
    const ptysWithSurvivingPeers: string[] = []
    const ptysToRestore: { ptyId: string; baseline: { cols: number; rows: number } | null }[] = []
    for (const [ptyId, inner] of this.mobileSubscribers) {
      const subscriber = inner.get(clientId)
      if (!subscriber) {
        continue
      }
      // Snapshot baseline before deleting — needed once mobileSubscribers
      // entry is gone for the resolveDesktopRestoreTarget chain.
      const baseline =
        subscriber.previousCols != null && subscriber.previousRows != null
          ? { cols: subscriber.previousCols, rows: subscriber.previousRows }
          : null
      inner.delete(clientId)
      if (inner.size > 0) {
        ptysWithSurvivingPeers.push(ptyId)
      } else {
        this.mobileSubscribers.delete(ptyId)
        ptysToRestore.push({ ptyId, baseline })
      }
    }
    for (const { ptyId, baseline } of ptysToRestore) {
      const cur = this.layouts.get(ptyId)
      // Why: Indefinite hold gate — see soft-leaver branch above.
      if (cur?.kind === 'phone' && this.getAutoRestoreFitMs() != null) {
        const fallback = this.resolveDesktopRestoreTarget(ptyId)
        const cols = baseline?.cols ?? fallback.cols
        const rows = baseline?.rows ?? fallback.rows
        void this.enqueueLayout(ptyId, { kind: 'desktop', cols, rows })
      }
      this.setDriver(ptyId, { kind: 'idle' })
    }

    // (4) Driver re-election where peers survived. If the disconnecting
    // client was the active driver, the most-recent surviving actor takes
    // the floor.
    for (const ptyId of ptysWithSurvivingPeers) {
      const driver = this.getDriver(ptyId)
      if (driver.kind !== 'mobile' || driver.clientId !== clientId) {
        continue
      }
      const inner = this.mobileSubscribers.get(ptyId)
      const next = inner ? this.pickMostRecentActor(inner) : null
      if (!next) {
        continue
      }
      this.setDriver(ptyId, { kind: 'mobile', clientId: next.clientId })

      const mode = this.mobileDisplayModes.get(ptyId) ?? 'auto'
      if (mode === 'desktop') {
        continue
      }
      const nextSub = inner!.get(next.clientId)
      const nextViewport = nextSub?.viewport
      if (!nextViewport) {
        continue
      }
      void this.enqueueLayout(ptyId, {
        kind: 'phone',
        cols: nextViewport.cols,
        rows: nextViewport.rows,
        ownerClientId: next.clientId
      })
    }

    // (5) Legacy-callers fallback. Older mobile builds use resizeForClient
    // directly and never populate mobileSubscribers. For those PTYs the
    // override carries the owning clientId; restore the layout when the
    // owner disconnects. resolveDesktopRestoreTarget reads lastRendererSizes
    // (which the legacy mobile-fit branch stashes the pre-fit size into).
    for (const [ptyId, override] of this.terminalFitOverrides) {
      if (override.clientId !== clientId) {
        continue
      }
      if (this.mobileSubscribers.has(ptyId)) {
        continue
      }
      const cur = this.layouts.get(ptyId)
      if (cur?.kind !== 'phone') {
        continue
      }
      // Why: Indefinite hold gate — see soft-leaver branch above. Legacy
      // mobile clients (resizeForClient path) honor the same setting.
      if (this.getAutoRestoreFitMs() == null) {
        continue
      }
      const fallback = this.resolveDesktopRestoreTarget(ptyId)
      const cols = override.previousCols ?? fallback.cols
      const rows = override.previousRows ?? fallback.rows
      void this.enqueueLayout(ptyId, { kind: 'desktop', cols, rows })
    }
  }

  onPtyExit(ptyId: string, exitCode: number): void {
    // Clean up new mobile state for this PTY
    this.mobileSubscribers.delete(ptyId)
    this.mobileDisplayModes.delete(ptyId)
    this.resizeListeners.delete(ptyId)
    this.lastRendererSizes.delete(ptyId)
    // Layout state machine: clear `layouts` and `layoutQueues`. Any
    // already-queued applyLayout work for this ptyId will run, but every
    // applyLayout re-checks `layouts.has(ptyId)` (or fresh-subscribe) and
    // short-circuits with `pty-exited`.
    this.layouts.delete(ptyId)
    this.layoutQueues.delete(ptyId)
    this.freshSubscribeGuard.delete(ptyId)
    const pendingRestore = this.pendingRestoreTimers.get(ptyId)
    if (pendingRestore) {
      clearTimeout(pendingRestore.timer)
      this.pendingRestoreTimers.delete(ptyId)
    }
    const pendingSoft = this.pendingSoftLeavers.get(ptyId)
    if (pendingSoft) {
      clearTimeout(pendingSoft.timer)
      this.pendingSoftLeavers.delete(ptyId)
    }

    if (this.terminalFitOverrides.has(ptyId)) {
      this.terminalFitOverrides.delete(ptyId)
      this.notifier?.terminalFitOverrideChanged(ptyId, 'desktop-fit', 0, 0)
      this.notifyFitOverrideListeners(ptyId, 'desktop-fit', 0, 0)
    }
    // Why: clear driver state and notify the renderer so any lock banner on
    // this dead pane unmounts. Without this, the pane shows a stuck banner
    // until tab teardown, and `getDriver(deadPtyId)` would keep returning a
    // stale `mobile{X}` to any caller that hasn't yet seen the exit IPC.
    if (this.currentDriver.has(ptyId)) {
      this.currentDriver.delete(ptyId)
      this.notifier?.terminalDriverChanged(ptyId, { kind: 'idle' })
    }
    this.disposeHeadlessTerminal(ptyId)
    this.agentDetector?.onExit(ptyId)
    const pty = this.ptysById.get(ptyId)
    if (pty) {
      pty.connected = false
      pty.lastExitCode = exitCode
      this.resolvePtyExitWaiters(pty, ptyId)
    }

    for (const leaf of this.leaves.values()) {
      if (leaf.ptyId !== ptyId) {
        continue
      }
      this.detachedPreAllocatedLeaves.delete(ptyId)
      leaf.connected = false
      leaf.writable = false
      leaf.lastExitCode = exitCode
      this.resolveExitWaiters(leaf)
      this.failActiveDispatchOnExit(leaf, exitCode)
    }
  }

  // ─── Driver state (mobile-presence lock) ──────────────────────────
  //
  // See docs/mobile-presence-lock.md.

  getDriver(ptyId: string): DriverState {
    return this.currentDriver.get(ptyId) ?? { kind: 'idle' }
  }

  private setDriver(ptyId: string, next: DriverState): void {
    const prev = this.getDriver(ptyId)
    if (prev.kind === next.kind) {
      if (prev.kind === 'mobile' && next.kind === 'mobile' && prev.clientId === next.clientId) {
        return
      }
      if (prev.kind !== 'mobile' && next.kind !== 'mobile') {
        return
      }
    }
    if (next.kind === 'idle') {
      this.currentDriver.delete(ptyId)
    } else {
      this.currentDriver.set(ptyId, next)
    }
    this.notifier?.terminalDriverChanged(ptyId, next)
    const listeners = this.driverListeners.get(ptyId)
    if (listeners) {
      for (const listener of listeners) {
        listener(next)
      }
    }
  }

  // Why: invoked from mobile RPC method handlers (terminal.send / setDisplayMode /
  // resizeForClient / fresh subscribe with auto). Records the actor as the
  // most recent mobile driver and re-applies phone-fit if we were previously
  // in `desktop` mode (mobile reclaims a take-back). Mobile-to-mobile hand-offs
  // are no-ops for resize.
  async mobileTookFloor(ptyId: string, clientId: string): Promise<void> {
    const inner = this.mobileSubscribers.get(ptyId)
    const sub = inner?.get(clientId)
    if (sub) {
      sub.lastActedAt = Date.now()
    }
    const prev = this.getDriver(ptyId)
    const currentMode = this.mobileDisplayModes.get(ptyId)
    // Why: a deliberate mobile action implies mobile is resuming control.
    // If the display mode is currently 'desktop' (set by an earlier
    // take-back), flip it back to 'auto' (= map absence) and re-apply so
    // phone-fit takes hold again. See docs/mobile-presence-lock.md.
    if (prev.kind === 'desktop' || currentMode === 'desktop') {
      if (currentMode === 'desktop') {
        this.mobileDisplayModes.delete(ptyId)
      }
      await this.applyMobileDisplayMode(ptyId)
    }
    this.setDriver(ptyId, { kind: 'mobile', clientId })
  }

  // Why: in-place viewport update on the existing mobile subscription —
  // used when the mobile keyboard opens/closes and shrinks/grows the
  // visible terminal area. We refresh the subscriber's viewport, re-fit
  // the PTY to the new dims, and emit a 'resized' event so the mobile
  // xterm reinits inline at the new dims without re-subscribing. This
  // avoids the unsubscribe → resubscribe cycle which would (a) flash the
  // desktop lock banner during the brief idle gap and (b) cause the new
  // subscribe to capture the already-phone-fitted PTY size as its
  // restore baseline (stuck-dim bug on later disconnect).
  // No-op when the client isn't actually subscribed to this PTY.
  async updateMobileViewport(
    ptyId: string,
    clientId: string,
    viewport: { cols: number; rows: number }
  ): Promise<boolean> {
    const inner = this.mobileSubscribers.get(ptyId)
    const sub = inner?.get(clientId)
    if (!sub) {
      return false
    }
    sub.viewport = viewport
    sub.lastActedAt = Date.now()

    const mode = this.mobileDisplayModes.get(ptyId) ?? 'auto'
    if (mode === 'desktop') {
      // Watching at desktop dims — viewport is informational only.
      return true
    }
    // Drive PTY dims by the most-recent-actor (just updated to this client).
    const winner = this.pickMostRecentActor(inner!)
    if (!winner) {
      return false
    }
    const winnerSub = inner!.get(winner.clientId)
    const driveViewport = winnerSub?.viewport ?? viewport
    const clampedCols = Math.max(20, Math.min(240, Math.round(driveViewport.cols)))
    const clampedRows = Math.max(8, Math.min(120, Math.round(driveViewport.rows)))

    sub.wasResizedToPhone = true
    // The driver is already mobile{this client} when we got here; refresh
    // to update lastActedAt-based ordering on later actor selection.
    this.setDriver(ptyId, { kind: 'mobile', clientId })

    await this.enqueueLayout(ptyId, {
      kind: 'phone',
      cols: clampedCols,
      rows: clampedRows,
      ownerClientId: winner.clientId
    })
    return true
  }

  // Why: remote desktop clients do not have the local `pty:resize` IPC path.
  // Their measured xterm size still has to resize the source PTY so TUIs
  // reflow to the visible client dimensions.
  async updateDesktopViewport(
    ptyId: string,
    viewport: { cols: number; rows: number }
  ): Promise<boolean> {
    if (
      this.isResizeSuppressed() ||
      this.getDriver(ptyId).kind === 'mobile' ||
      this.terminalFitOverrides.has(ptyId)
    ) {
      return false
    }
    const cols = Math.max(20, Math.min(240, Math.round(viewport.cols)))
    const rows = Math.max(8, Math.min(120, Math.round(viewport.rows)))
    let resized = false
    try {
      resized = this.ptyController?.resize?.(ptyId, cols, rows) ?? false
    } catch {
      return false
    }
    if (!resized) {
      return false
    }
    this.resizeHeadlessTerminal(ptyId, cols, rows)
    this.onExternalPtyResize(ptyId, cols, rows)
    return true
  }

  // Why: invoked from `runtime:restoreTerminalFit` IPC (the desktop "Take
  // back" / "Restore" button). Forces the PTY back to desktop dims and
  // flips the driver to `desktop`, suppressing further mobile-driven dim
  // changes until a mobile actor takes the floor again. Two cases:
  //   1. Active mobile subscriber: route through applyMobileDisplayMode so
  //      the existing 'resized' event reaches the phone.
  //   2. Held with no mobile subscriber (post-indefinite-hold): no inner
  //      subscriber to notify; resolve restore target and enqueueLayout
  //      directly. applyLayout is the SOLE writer of terminalFitOverrides;
  //      the held branch must not duplicate that mutation. See
  //      docs/mobile-fit-hold.md.
  async reclaimTerminalForDesktop(ptyId: string): Promise<boolean> {
    if (this.isMobileSubscriberActive(ptyId)) {
      this.setMobileDisplayMode(ptyId, 'desktop')
      await this.applyMobileDisplayMode(ptyId)
      this.setDriver(ptyId, { kind: 'desktop' })
      // Why: a desktop-initiated reclaim is "I'm taking over right now",
      // not a sticky preference. The next mobile subscribe (e.g. user
      // switches back to the terminal tab on the phone) must default to
      // phone-fit again, not stay in passive desktop-watch mode.
      this.setMobileDisplayMode(ptyId, 'auto')
      return true
    }
    const heldOverride = this.terminalFitOverrides.get(ptyId)
    if (heldOverride) {
      const pending = this.pendingRestoreTimers.get(ptyId)
      if (pending) {
        clearTimeout(pending.timer)
        this.pendingRestoreTimers.delete(ptyId)
      }
      // Why: with no subscribers, resolveDesktopRestoreTarget falls through
      // to current PTY size — which is at phone dims (wrong). Prefer the
      // baseline captured on the override at first phone-fit; this is the
      // last desktop geometry the layout machine knew about. Then chain
      // to the standard resolver for the residual fallbacks.
      const fallback = this.resolveDesktopRestoreTarget(ptyId)
      const cols = heldOverride.previousCols ?? fallback.cols
      const rows = heldOverride.previousRows ?? fallback.rows
      await this.enqueueLayout(ptyId, { kind: 'desktop', cols, rows })
      this.setDriver(ptyId, { kind: 'desktop' })
      // Why: a desktop-initiated reclaim is "I'm taking over right now",
      // not a sticky preference. Reset to auto so the next mobile subscribe
      // re-enters phone-fit. (Held-PTY branch may not have an entry, but
      // calling setMobileDisplayMode('auto') is a no-op deletion in that
      // case — safe and idempotent.)
      this.setMobileDisplayMode(ptyId, 'auto')
      return true
    }
    return false
  }

  // Why: read-side clamp for mobileAutoRestoreFitMs. `null` means
  // indefinite hold (no auto-restore timer). A finite value is clamped
  // to [MIN, MAX] to defend against bad config — the smallest useful
  // value is a few seconds, the largest is one hour. See
  // docs/mobile-fit-hold.md.
  private getAutoRestoreFitMs(): number | null {
    const raw = this.store?.getSettings().mobileAutoRestoreFitMs ?? null
    if (raw == null) {
      return null
    }
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      return null
    }
    return Math.min(Math.max(raw, MOBILE_AUTO_RESTORE_FIT_MIN_MS), MOBILE_AUTO_RESTORE_FIT_MAX_MS)
  }

  // Why: invoked when the user changes mobileAutoRestoreFitMs to `null`
  // (Indefinite). Clears every pending restore timer so the just-expressed
  // preference "do not auto-restore" is honored for ALL currently-pending
  // PTYs, not just one. See docs/mobile-fit-hold.md.
  cancelAllPendingFitRestoreTimers(): void {
    for (const [, entry] of this.pendingRestoreTimers) {
      clearTimeout(entry.timer)
    }
    this.pendingRestoreTimers.clear()
  }

  // Why: read the persisted user preference (clamped) for surfacing to UI
  // callers (mobile RPC, desktop preferences). Returns null when the
  // setting is unset or `null` ("Indefinite").
  getMobileAutoRestoreFitMs(): number | null {
    return this.getAutoRestoreFitMs()
  }

  // Why: persisted-preference setter routed through the same `Store` the
  // desktop preferences UI writes to. Transitions to `null` (Indefinite)
  // clear every pending restore timer to honor the preference change for
  // already-held PTYs. Transitions to a finite value do NOT retroactively
  // schedule timers for PTYs that are currently held — those PTYs were
  // already-not-restored under the old preference, and silently scheduling
  // a restore on a settings change would be surprising. The new value
  // takes effect on the next unsubscribe. See docs/mobile-fit-hold.md.
  setMobileAutoRestoreFitMs(ms: number | null): number | null {
    if (!this.store?.updateSettings) {
      return this.getAutoRestoreFitMs()
    }
    let normalized: number | null
    if (ms == null) {
      normalized = null
    } else if (typeof ms !== 'number' || !Number.isFinite(ms)) {
      normalized = null
    } else {
      normalized = Math.min(
        Math.max(ms, MOBILE_AUTO_RESTORE_FIT_MIN_MS),
        MOBILE_AUTO_RESTORE_FIT_MAX_MS
      )
    }
    this.store.updateSettings({ mobileAutoRestoreFitMs: normalized })
    if (normalized == null) {
      this.cancelAllPendingFitRestoreTimers()
    }
    return normalized
  }

  // Why: with multiple subscribers, the active phone-fit dims follow the
  // most recent mobile actor (argmax(lastActedAt)). See
  // docs/mobile-presence-lock.md "Active phone-fit dim selection".
  private pickMostRecentActor(
    inner: Map<string, { clientId: string; lastActedAt: number }>
  ): { clientId: string; lastActedAt: number } | null {
    let best: { clientId: string; lastActedAt: number } | null = null
    for (const sub of inner.values()) {
      if (best === null || sub.lastActedAt > best.lastActedAt) {
        best = sub
      }
    }
    return best
  }

  // Why: restore-target selection on last-subscriber-leaves picks the
  // earliest-by-subscribe-time subscriber AMONG those with non-null
  // previousCols/Rows. Desktop-mode joins carry null and are skipped — they
  // never captured pre-fit dims by design.
  private pickEarliestRestoreTarget(
    inner: Map<
      string,
      { subscribedAt: number; previousCols: number | null; previousRows: number | null }
    >
  ): { previousCols: number; previousRows: number } | null {
    let best: { subscribedAt: number; previousCols: number; previousRows: number } | null = null
    for (const sub of inner.values()) {
      if (sub.previousCols == null || sub.previousRows == null) {
        continue
      }
      if (best === null || sub.subscribedAt < best.subscribedAt) {
        best = {
          subscribedAt: sub.subscribedAt,
          previousCols: sub.previousCols,
          previousRows: sub.previousRows
        }
      }
    }
    return best ? { previousCols: best.previousCols, previousRows: best.previousRows } : null
  }

  // ─── Layout state machine ─────────────────────────────────────────
  //
  // See docs/mobile-terminal-layout-state-machine.md.
  //
  // applyLayout is the SOLE writer of:
  //   - this.layouts
  //   - this.terminalFitOverrides
  //   - this.ptyController.resize (i.e. the actual PTY dims)
  //
  // Every trigger that wants to change PTY dims or flip mode goes through
  // enqueueLayout, which serializes calls behind a per-PTY async queue
  // (the await on ptyController.resize would otherwise let seq bumps reach
  // the wire out of order).

  getLayout(ptyId: string): PtyLayoutState | null {
    return this.layouts.get(ptyId) ?? null
  }

  // Why: `enqueueLayout`'s "no layouts entry" short-circuit must not fire
  // on the very first transition for a PTY (where the entry doesn't exist
  // yet *because* we're about to create it). handleMobileSubscribe adds
  // the ptyId to `freshSubscribeGuard` before calling enqueueLayout and
  // removes it in a finally block.
  private isFreshSubscribe(ptyId: string): boolean {
    return this.freshSubscribeGuard.has(ptyId)
  }

  // Why: four-step fallback chain for desktop-restore targets. Always
  // returns a value; the terminal {80,24} branch is reached only under
  // bug. Wrapping the chain as a single helper prevents callsite drift.
  private resolveDesktopRestoreTarget(ptyId: string): { cols: number; rows: number } {
    // 1. Earliest-by-subscribedAt subscriber with non-null baseline.
    const inner = this.mobileSubscribers.get(ptyId)
    if (inner) {
      const earliest = this.pickEarliestRestoreTarget(inner)
      if (earliest) {
        return { cols: earliest.previousCols, rows: earliest.previousRows }
      }
    }
    // 2. Most-recent desktop renderer geometry report.
    const renderer = this.lastRendererSizes.get(ptyId)
    if (renderer) {
      return { cols: renderer.cols, rows: renderer.rows }
    }
    // 3. Current PTY size.
    const size = this.getTerminalSize(ptyId)
    if (size) {
      return { cols: size.cols, rows: size.rows }
    }
    // 4. Hard default.
    return { cols: 80, rows: 24 }
  }

  // Why: a new viewport-only update from the same owner supersedes a
  // queued same-shape tail. Mode flips, owner changes, and take-back
  // append (losing a take-floor to a viewport tick would be a fairness
  // hole — see "enqueueLayout coalescing" in the design doc).
  private coalescesWith(prev: PtyLayoutTarget, next: PtyLayoutTarget): boolean {
    if (prev.kind !== next.kind) {
      return false
    }
    if (prev.kind === 'phone' && next.kind === 'phone') {
      return prev.ownerClientId === next.ownerClientId
    }
    return true
  }

  private enqueueLayout(ptyId: string, target: PtyLayoutTarget): Promise<ApplyLayoutResult> {
    // Why: PTY-exit short-circuit. Fresh-subscribe gate lets the very first
    // transition through even though `layouts` has no entry yet.
    if (!this.layouts.has(ptyId) && !this.isFreshSubscribe(ptyId)) {
      return Promise.resolve({ ok: false, reason: 'pty-exited' })
    }

    let entry = this.layoutQueues.get(ptyId)
    if (!entry) {
      entry = { running: null, pending: [] }
      this.layoutQueues.set(ptyId, entry)
    }
    const queue = entry

    return new Promise<ApplyLayoutResult>((resolve) => {
      if (!queue.running) {
        queue.running = this.runLayoutSlot(ptyId, target, [resolve])
        return
      }
      const tail = queue.pending.at(-1)
      if (tail && this.coalescesWith(tail.target, target)) {
        tail.target = target
        tail.waiters.push(resolve)
        return
      }
      queue.pending.push({ target, waiters: [resolve] })
    })
  }

  private async runLayoutSlot(
    ptyId: string,
    target: PtyLayoutTarget,
    waiters: ((r: ApplyLayoutResult) => void)[]
  ): Promise<ApplyLayoutResult> {
    let result: ApplyLayoutResult
    try {
      result = await this.applyLayout(ptyId, target)
    } catch (err) {
      // Why: defensive — applyLayout itself catches resize errors, but a
      // throw from one of the synchronous map writes (e.g. notifier hook)
      // must not jam the queue forever.
      console.error('[layout] applyLayout threw', { ptyId, err })
      result = { ok: false, reason: 'resize-failed' }
    }
    for (const w of waiters) {
      w(result)
    }

    const queue = this.layoutQueues.get(ptyId)
    if (!queue) {
      return result
    }
    const next = queue.pending.shift()
    if (next) {
      queue.running = this.runLayoutSlot(ptyId, next.target, next.waiters)
    } else {
      queue.running = null
      // Why: drop the entry once empty so the map doesn't grow without bound
      // across short-lived PTYs.
      this.layoutQueues.delete(ptyId)
    }
    return result
  }

  private async applyLayout(ptyId: string, target: PtyLayoutTarget): Promise<ApplyLayoutResult> {
    // Why: re-check pty-exit at the head of the slot — the queue may have
    // accepted this target before onPtyExit ran.
    if (!this.layouts.has(ptyId) && !this.isFreshSubscribe(ptyId)) {
      return { ok: false, reason: 'pty-exited' }
    }

    const prev = this.layouts.get(ptyId) ?? null
    const seq = (prev?.seq ?? 0) + 1
    const next: PtyLayoutState = { ...target, seq, appliedAt: Date.now() }

    const currentSize = this.getTerminalSize(ptyId)
    const dimsChanged = currentSize?.cols !== target.cols || currentSize?.rows !== target.rows
    const modeChanged = (prev?.kind ?? 'desktop') !== target.kind

    // Snapshot for rollback.
    const prevFitOverride = this.terminalFitOverrides.get(ptyId) ?? null

    // Tentative writes — the resize is the point of no return.
    this.layouts.set(ptyId, next)
    if (target.kind === 'phone') {
      // Why: pull baseline cols+rows atomically from the same subscriber so
      // they can't desync.
      const baseline = (() => {
        const inner = this.mobileSubscribers.get(ptyId)
        if (!inner) {
          return null
        }
        return this.pickEarliestRestoreTarget(inner)
      })()
      this.terminalFitOverrides.set(ptyId, {
        mode: 'mobile-fit',
        cols: target.cols,
        rows: target.rows,
        previousCols: baseline?.previousCols ?? null,
        previousRows: baseline?.previousRows ?? null,
        updatedAt: next.appliedAt,
        clientId: target.ownerClientId
      })
    } else {
      this.terminalFitOverrides.delete(ptyId)
    }

    if (dimsChanged) {
      let ok = false
      try {
        const r = this.ptyController?.resize?.(ptyId, target.cols, target.rows)
        ok = r ?? true
      } catch (err) {
        console.error('[layout] ptyController.resize threw', { ptyId, err })
        ok = false
      }
      if (!ok) {
        // Roll back to pre-call snapshot. seq is NOT bumped on the wire
        // because we never emit below.
        if (prev) {
          this.layouts.set(ptyId, prev)
        } else {
          this.layouts.delete(ptyId)
        }
        if (prevFitOverride) {
          this.terminalFitOverrides.set(ptyId, prevFitOverride)
        } else {
          this.terminalFitOverrides.delete(ptyId)
        }
        return { ok: false, reason: 'resize-failed' }
      }
      this.resizeHeadlessTerminal(ptyId, target.cols, target.rows)
    }

    // Why: emit fit-override-changed only when the *mode* flips. Layouts
    // can change dims without flipping mode (keyboard show/hide while
    // phone), and waking the renderer on every viewport tick is wasteful
    // churn.
    if (modeChanged) {
      // Why: phone→desktop arms the renderer-cascade suppress window
      // before the collateral safeFit IPCs arrive. See "Renderer cascade
      // suppression".
      if (target.kind === 'desktop') {
        this.lastRendererSizes.delete(ptyId)
        this.suppressResizesForMs(500)
      }
      this.notifier?.terminalFitOverrideChanged(
        ptyId,
        target.kind === 'phone' ? 'mobile-fit' : 'desktop-fit',
        target.cols,
        target.rows
      )
      this.notifyFitOverrideListeners(
        ptyId,
        target.kind === 'phone' ? 'mobile-fit' : 'desktop-fit',
        target.cols,
        target.rows
      )
    }

    // Mobile-facing event always fires (phone clients need to re-fit on
    // every dim change, not just mode flips).
    this.notifyTerminalResize(ptyId, {
      cols: target.cols,
      rows: target.rows,
      displayMode: target.kind === 'phone' ? 'phone' : 'desktop',
      reason: 'apply-layout',
      seq
    })

    return { ok: true, state: next }
  }

  // ─── Server-Authoritative Mobile Display Mode ─────────────────────

  setMobileDisplayMode(ptyId: string, mode: 'auto' | 'desktop'): void {
    if (mode === 'auto') {
      this.mobileDisplayModes.delete(ptyId)
    } else {
      this.mobileDisplayModes.set(ptyId, mode)
    }
  }

  getMobileDisplayMode(ptyId: string): 'auto' | 'desktop' {
    return this.mobileDisplayModes.get(ptyId) ?? 'auto'
  }

  isMobileSubscriberActive(ptyId: string): boolean {
    const inner = this.mobileSubscribers.get(ptyId)
    return inner !== undefined && inner.size > 0
  }

  // Why: late-bind viewport on an existing subscriber record. Subscribers
  // that registered before the mobile side measured (e.g. terminal first
  // mounted while the WebView was still loading) have null viewport, and
  // applyMobileDisplayMode's auto branch needs a viewport to phone-fit.
  // The setDisplayMode RPC carries the latest viewport so we can patch it
  // here just before applyMobileDisplayMode runs.
  updateMobileSubscriberViewport(
    ptyId: string,
    clientId: string,
    viewport: { cols: number; rows: number }
  ): void {
    const inner = this.mobileSubscribers.get(ptyId)
    const record = inner?.get(clientId)
    if (!record) {
      return
    }
    record.viewport = viewport
  }

  // Why: server-side auto-fit on mobile subscribe. The runtime is the single
  // source of truth — the mobile client just passes its viewport and the runtime
  // decides whether to resize. This eliminates the measure→RPC→resubscribe
  // pipeline that caused race conditions.
  //
  // Multi-mobile keying: each subscriber lives in `mobileSubscribers[ptyId]`'s
  // inner map under its own clientId. Phone B subscribing does not overwrite
  // phone A's record — both stay until each unsubscribes.
  //
  // Subscribe-in-desktop-mode rule: a subscribe with displayMode='desktop' is
  // a passive watch; it does NOT take the floor. The driver remains
  // `idle`/`desktop`. The lock banner is reserved for actual mobile
  // interaction (input/resize/setDisplayMode/auto-or-phone subscribe).
  async handleMobileSubscribe(
    ptyId: string,
    clientId: string,
    viewport?: { cols: number; rows: number }
  ): Promise<boolean> {
    const mode = this.mobileDisplayModes.get(ptyId) ?? 'auto'
    if (!viewport) {
      return false
    }

    // Cancel pending restore timer for this ptyId — any new subscriber
    // supersedes any old client's pending restore.
    const pendingRestore = this.pendingRestoreTimers.get(ptyId)
    if (pendingRestore) {
      clearTimeout(pendingRestore.timer)
      this.pendingRestoreTimers.delete(ptyId)
    }

    const clampedCols = Math.max(20, Math.min(240, Math.round(viewport.cols)))
    const clampedRows = Math.max(8, Math.min(120, Math.round(viewport.rows)))

    // Resubscribe-grace honor: same client returning within soft-leave
    // window restores prior record (preserving baseline so we don't capture
    // phone-fitted dims as the new baseline).
    const softLeaver = this.pendingSoftLeavers.get(ptyId)
    if (softLeaver && softLeaver.clientId === clientId) {
      clearTimeout(softLeaver.timer)
      this.pendingSoftLeavers.delete(ptyId)
      let inner = this.mobileSubscribers.get(ptyId)
      if (!inner) {
        inner = new Map()
        this.mobileSubscribers.set(ptyId, inner)
      }
      inner.set(clientId, {
        ...softLeaver.record,
        viewport,
        lastActedAt: Date.now()
      })
      this.setDriver(ptyId, { kind: 'mobile', clientId })
      if (mode !== 'desktop') {
        this.freshSubscribeGuard.add(ptyId)
        try {
          await this.enqueueLayout(ptyId, {
            kind: 'phone',
            cols: clampedCols,
            rows: clampedRows,
            ownerClientId: clientId
          })
        } finally {
          this.freshSubscribeGuard.delete(ptyId)
        }
      }
      return true
    }

    let inner = this.mobileSubscribers.get(ptyId)
    if (!inner) {
      inner = new Map()
      this.mobileSubscribers.set(ptyId, inner)
    }

    // Capture restore baseline BEFORE applyLayout writes the override.
    // Multi-mobile: peer joiner against an already-fitted PTY captures null
    // — the existing baseline-holder's snapshot remains canonical. See
    // docs/mobile-presence-lock.md.
    //
    // Resubscribe-after-indefinite-hold: the held override carries the only
    // authoritative pre-fit dims across the no-subscriber gap. Inherit it
    // first; otherwise rendererSize/currentSize would be the held phone dims
    // and applyLayout would clobber the override's previousCols with phone
    // dims, making any subsequent Restore a no-op.
    const heldOverride = this.terminalFitOverrides.get(ptyId)
    const existing = inner.get(clientId)
    const someoneAlreadyFitted = [...inner.values()].some((s) => s.wasResizedToPhone)
    const currentSize = this.getTerminalSize(ptyId)
    const rendererSize = this.lastRendererSizes.get(ptyId)
    const previousCols =
      existing?.previousCols ??
      heldOverride?.previousCols ??
      (someoneAlreadyFitted ? null : (rendererSize?.cols ?? currentSize?.cols ?? null))
    const previousRows =
      existing?.previousRows ??
      heldOverride?.previousRows ??
      (someoneAlreadyFitted ? null : (rendererSize?.rows ?? currentSize?.rows ?? null))
    const now = Date.now()
    const subscribedAt = existing?.subscribedAt ?? now

    if (mode === 'desktop') {
      // Passive watch — null baseline (we'll capture later if user toggles
      // to auto/phone, since safeFit will have converged by then). Do not
      // flip driver.
      inner.set(clientId, {
        clientId,
        viewport,
        wasResizedToPhone: false,
        previousCols: null,
        previousRows: null,
        subscribedAt,
        lastActedAt: now
      })
      return false
    }

    inner.set(clientId, {
      clientId,
      viewport,
      wasResizedToPhone: true,
      previousCols,
      previousRows,
      subscribedAt,
      lastActedAt: now
    })

    // Subscribe-fresh with auto/phone counts as "take the floor".
    this.setDriver(ptyId, { kind: 'mobile', clientId })

    // Route the actual resize through the state machine. The fresh-subscribe
    // gate lets enqueueLayout's "no layouts entry" short-circuit pass on
    // the very first transition for this PTY.
    this.freshSubscribeGuard.add(ptyId)
    try {
      await this.enqueueLayout(ptyId, {
        kind: 'phone',
        cols: clampedCols,
        rows: clampedRows,
        ownerClientId: clientId
      })
    } finally {
      this.freshSubscribeGuard.delete(ptyId)
    }

    return true
  }

  // Why: delayed restore prevents resize thrashing during rapid tab switches.
  // The 300ms debounce means only the final tab triggers a PTY restore;
  // intermediate terminals keep their current dims harmlessly.
  //
  // Multi-mobile: only the last subscriber leaving for this ptyId triggers
  // restore + driver=idle. Peer mobile clients still on the inner map keep
  // the lock banner mounted; if the disconnecting client was the active
  // driver, we re-elect the most-recent surviving subscriber.
  handleMobileUnsubscribe(ptyId: string, clientId: string): void {
    const inner = this.mobileSubscribers.get(ptyId)
    if (!inner) {
      return
    }
    const subscriber = inner.get(clientId)
    if (!subscriber) {
      return
    }
    const wasResizedToPhone = subscriber.wasResizedToPhone

    inner.delete(clientId)

    if (inner.size > 0) {
      // Why: if the leaving client was the only one with a non-null restore
      // baseline (typical when peer joiners subscribed against an
      // already-phone-fitted PTY and got null prevCols), donate the baseline
      // to the earliest surviving subscriber so a future last-leaver can
      // still restore correctly. See docs/mobile-presence-lock.md.
      if (
        subscriber.previousCols != null &&
        subscriber.previousRows != null &&
        !this.pickEarliestRestoreTarget(inner)
      ) {
        let earliestSurvivor: { clientId: string; subscribedAt: number } | null = null
        for (const sub of inner.values()) {
          if (earliestSurvivor === null || sub.subscribedAt < earliestSurvivor.subscribedAt) {
            earliestSurvivor = { clientId: sub.clientId, subscribedAt: sub.subscribedAt }
          }
        }
        if (earliestSurvivor) {
          const heir = inner.get(earliestSurvivor.clientId)
          if (heir) {
            heir.previousCols = subscriber.previousCols
            heir.previousRows = subscriber.previousRows
          }
        }
      }
      // Peers still on the line. If the disconnecting client was the active
      // mobile driver, re-elect the most-recent surviving subscriber so the
      // banner remains correct and active phone-fit dims follow them.
      const driver = this.getDriver(ptyId)
      if (driver.kind === 'mobile' && driver.clientId === clientId) {
        const next = this.pickMostRecentActor(inner)
        if (next) {
          this.setDriver(ptyId, { kind: 'mobile', clientId: next.clientId })
          // Fire-and-forget — handleMobileUnsubscribe stays sync; applyLayout
          // failures self-recover on the next gesture.
          void this.applyMobileDisplayMode(ptyId)
        }
      }
      return
    }

    // Last subscriber leaving — clean up.
    this.mobileSubscribers.delete(ptyId)
    const mode = this.mobileDisplayModes.get(ptyId) ?? 'auto'

    // Resubscribe-grace: hold driver=mobile{clientId} for ~250ms so a quick
    // re-subscribe (older clients without updateViewport) doesn't flash the
    // desktop banner. See docs/mobile-presence-lock.md.
    const SOFT_LEAVE_GRACE_MS = 250
    const existingSoft = this.pendingSoftLeavers.get(ptyId)
    if (existingSoft) {
      clearTimeout(existingSoft.timer)
      this.pendingSoftLeavers.delete(ptyId)
    }
    const softTimer = setTimeout(() => {
      this.pendingSoftLeavers.delete(ptyId)
      if (!this.mobileSubscribers.has(ptyId)) {
        this.setDriver(ptyId, { kind: 'idle' })
      }
    }, SOFT_LEAVE_GRACE_MS)
    this.pendingSoftLeavers.set(ptyId, {
      clientId,
      timer: softTimer,
      record: {
        clientId: subscriber.clientId,
        viewport: subscriber.viewport,
        wasResizedToPhone: subscriber.wasResizedToPhone,
        previousCols: subscriber.previousCols,
        previousRows: subscriber.previousRows,
        subscribedAt: subscriber.subscribedAt,
        lastActedAt: subscriber.lastActedAt
      }
    })

    if (mode === 'auto' && wasResizedToPhone) {
      const existingTimer = this.pendingRestoreTimers.get(ptyId)
      if (existingTimer) {
        clearTimeout(existingTimer.timer)
        this.pendingRestoreTimers.delete(ptyId)
      }
      // Why: scheduling is conditional on the user's mobileAutoRestoreFitMs
      // preference. `null` (default, "Indefinite") leaves the PTY at phone
      // dims until the user clicks Restore on the desktop banner — the
      // central UX promise of docs/mobile-fit-hold.md. A finite value runs
      // the restore that long after the last unsubscribe.
      const autoRestoreMs = this.getAutoRestoreFitMs()
      if (autoRestoreMs == null) {
        // Indefinite hold: the fit override persists, the SOFT_LEAVE_GRACE
        // driver-state grace above still releases the input lock, and the
        // banner's Restore button is the explicit return path.
      } else {
        // Snapshot the disconnecting subscriber's baseline NOW, before the
        // timer fires. By the time the timer runs, the subscriber map has
        // been deleted; resolveDesktopRestoreTarget would fall through to
        // lastRendererSizes → current PTY size (which is at phone dims,
        // wrong). The disconnecting subscriber's baseline is the correct
        // restore target.
        const fallback = this.lastRendererSizes.get(ptyId)
        const restoreCols =
          subscriber.previousCols ?? fallback?.cols ?? this.getTerminalSize(ptyId)?.cols ?? 80
        const restoreRows =
          subscriber.previousRows ?? fallback?.rows ?? this.getTerminalSize(ptyId)?.rows ?? 24
        const timer = setTimeout(() => {
          this.pendingRestoreTimers.delete(ptyId)
          if (this.isMobileSubscriberActive(ptyId)) {
            return
          }
          void this.enqueueLayout(ptyId, {
            kind: 'desktop',
            cols: restoreCols,
            rows: restoreRows
          })
        }, autoRestoreMs)

        this.pendingRestoreTimers.set(ptyId, { timer, clientId })
      }
    }
    // 'desktop' mode: was never resized, nothing to restore.
  }

  // Why: called when mode changes via terminal.setDisplayMode. Applies the
  // mode change immediately if there's an active subscriber, and emits a
  // 'resized' event so the mobile client can reinitialize xterm inline.
  //
  // Multi-mobile: the most recent mobile actor's viewport drives the active
  // phone-fit dims. The earliest-by-subscribe-time subscriber's
  // previousCols/Rows drive the desktop-restore target.
  async applyMobileDisplayMode(ptyId: string): Promise<void> {
    const mode = this.mobileDisplayModes.get(ptyId) ?? 'auto'
    const inner = this.mobileSubscribers.get(ptyId)
    const subscriber = inner ? this.pickMostRecentActor(inner) : null
    const subscriberRecord = subscriber && inner ? inner.get(subscriber.clientId) : null

    if (mode === 'desktop') {
      // Reset wasResizedToPhone on every fitted subscriber so a future
      // toggle back to auto re-issues the resize. applyLayout owns the
      // actual PTY resize + override delete + renderer notify.
      let anyWasResized = false
      if (inner) {
        for (const sub of inner.values()) {
          if (sub.wasResizedToPhone) {
            anyWasResized = true
            sub.wasResizedToPhone = false
          }
        }
      }
      if (anyWasResized) {
        const restore = this.resolveDesktopRestoreTarget(ptyId)
        await this.enqueueLayout(ptyId, {
          kind: 'desktop',
          cols: restore.cols,
          rows: restore.rows
        })
      } else {
        // No subscriber was fitted — emit a mode-change resize event so
        // the mobile client still learns the toggle landed.
        const size = this.getTerminalSize(ptyId)
        this.notifyTerminalResize(ptyId, {
          cols: size?.cols ?? 0,
          rows: size?.rows ?? 0,
          displayMode: 'desktop',
          reason: 'mode-change',
          seq: this.layouts.get(ptyId)?.seq
        })
      }
    } else {
      // mode === 'auto' — the only non-desktop mode after the 'phone'
      // (sticky-fit) collapse. Phone-fit if the active subscriber has a
      // viewport and we haven't already applied it.
      if (subscriberRecord && !subscriberRecord.wasResizedToPhone) {
        const viewport = subscriberRecord.viewport
        if (viewport) {
          await this.handleMobileSubscribe(ptyId, subscriberRecord.clientId, viewport)
          return
        }
      }
      // Why: always emit the mode change even when no resize occurred — the
      // mobile client needs to learn the toggle landed even if dims didn't
      // actually change. Carry the current seq (or undefined if no layout
      // entry yet) so the mobile-side stale-event filter behaves correctly.
      const size = this.getTerminalSize(ptyId)
      this.notifyTerminalResize(ptyId, {
        cols: size?.cols ?? 0,
        rows: size?.rows ?? 0,
        displayMode: 'auto',
        reason: 'mode-change',
        seq: this.layouts.get(ptyId)?.seq
      })
    }
  }

  // Why: called from the pty:resize IPC handler whenever the desktop renderer
  // resizes a PTY (e.g. via safeFit after window resize, split, or desktop-mode
  // restore). Stores the renderer-reported size so handleMobileSubscribe can use
  // the actual pane geometry instead of a stale PTY size for previousCols.
  // This is a passive geometry report — it does NOT call applyLayout; the
  // PTY is already at the reported size.
  onExternalPtyResize(ptyId: string, cols: number, rows: number): void {
    // The pty:resize IPC handler is supposed to gate via `isResizeSuppressed`
    // before calling here, but defend against callers that don't.
    if (this.isResizeSuppressed()) {
      return
    }
    // Why: while a mobile-fit override is in place, the desktop renderer's
    // safeFit echoes pty:resize(override.cols, override.rows). Treating that
    // echo as legitimate geometry would overwrite each subscriber's
    // previousCols/Rows baseline with phone dims, so the next take-back
    // enqueues a no-op {kind:'desktop', cols:49, rows:40} and leaves xterm
    // stuck. Only filter reports that EXACTLY match the override — a fresh
    // measurement from a now-visible pane (e.g. user activated a previously
    // hidden tab on desktop, container went 0×0 → 1782×1195) reports
    // different dims and is the right baseline to remember.
    const activeOverride = this.terminalFitOverrides.get(ptyId)
    if (activeOverride && activeOverride.cols === cols && activeOverride.rows === rows) {
      return
    }
    this.refreshRendererGeometry(ptyId, cols, rows)
  }

  // Why: pty:reportGeometry IPC sibling. The renderer calls this when a
  // desktop pane container goes from 0×0 to a real size while a mobile-fit
  // override is active (e.g. user activates a previously-hidden tab on
  // desktop after the phone has already taken the floor). We need the
  // restore-target baseline to track real desktop dims even during the
  // fit period — otherwise resolveDesktopRestoreTarget falls back to the
  // PTY's spawn default (typically 80×24) and Take Back leaves the
  // terminal partially restored. This is a measurement-only channel: it
  // refreshes lastRendererSizes and non-null subscriber baselines, never
  // resizes the PTY, and bypasses both isResizeSuppressed and the
  // override-echo gate by design — the renderer only fires it when it
  // has just measured fresh real geometry. See docs/mobile-fit-hold.md.
  recordRendererGeometry(ptyId: string, cols: number, rows: number): void {
    if (cols <= 0 || rows <= 0) {
      return
    }
    this.refreshRendererGeometry(ptyId, cols, rows)
  }

  // Why: test seam — exposes lastRendererSizes for assertions about
  // pty:reportGeometry / onExternalPtyResize side effects without making
  // the underlying Map writable from the outside.
  getLastRendererSize(ptyId: string): { cols: number; rows: number } | null {
    return this.lastRendererSizes.get(ptyId) ?? null
  }

  private refreshRendererGeometry(ptyId: string, cols: number, rows: number): void {
    this.lastRendererSizes.set(ptyId, { cols, rows })
    const inner = this.mobileSubscribers.get(ptyId)
    if (!inner) {
      return
    }
    // Refresh the renderer-current size as the next-restore target on every
    // subscriber that already has a non-null baseline. Subscribers with null
    // baselines (joined while a peer had already phone-fitted) stay null.
    for (const sub of inner.values()) {
      if (sub.previousCols != null && sub.previousRows != null) {
        sub.previousCols = cols
        sub.previousRows = rows
      }
    }
  }

  // Why: the pty:resize IPC handler calls this to check if the global
  // suppress window is active. During this window, all desktop renderer
  // pty:resize events are ignored to prevent collateral safeFit corruption.
  isResizeSuppressed(): boolean {
    return Date.now() < this.resizeSuppressedUntil
  }

  private suppressResizesForMs(ms: number): void {
    this.resizeSuppressedUntil = Date.now() + ms
  }

  subscribeToTerminalResize(
    ptyId: string,
    listener: (event: {
      cols: number
      rows: number
      displayMode: string
      reason: string
      seq?: number
    }) => void
  ): () => void {
    let listeners = this.resizeListeners.get(ptyId)
    if (!listeners) {
      listeners = new Set()
      this.resizeListeners.set(ptyId, listeners)
    }
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) {
        this.resizeListeners.delete(ptyId)
      }
    }
  }

  private notifyTerminalResize(
    ptyId: string,
    event: { cols: number; rows: number; displayMode: string; reason: string; seq?: number }
  ): void {
    const listeners = this.resizeListeners.get(ptyId)
    if (!listeners) {
      return
    }
    for (const listener of listeners) {
      listener(event)
    }
  }

  // Why: Section 7.2 — the runtime detects agent exit directly and updates
  // dispatch contexts immediately, rather than waiting for the coordinator's
  // next poll cycle. This catches agent crashes and unexpected exits within
  // milliseconds. The task is set back to 'pending' so it can be re-dispatched.
  private failActiveDispatchOnExit(leaf: RuntimeLeafRecord, exitCode: number): void {
    if (!this._orchestrationDb) {
      return
    }

    const handle = this.handleByLeafKey.get(this.getLeafKey(leaf.tabId, leaf.leafId))
    if (!handle) {
      return
    }

    const dispatch = this._orchestrationDb.getActiveDispatchForTerminal(handle)
    if (!dispatch) {
      return
    }

    const errorContext = `Agent exited with code ${exitCode}`
    this._orchestrationDb.failDispatch(dispatch.id, errorContext)

    // Why: create an escalation message so the coordinator is notified about
    // the unexpected exit on its next check cycle, even if the circuit breaker
    // hasn't tripped yet.
    const run = this._orchestrationDb.getActiveCoordinatorRun()
    if (run) {
      this._orchestrationDb.insertMessage({
        from: handle,
        to: run.coordinator_handle,
        subject: `Agent exited unexpectedly (code ${exitCode})`,
        type: 'escalation',
        priority: 'high',
        payload: JSON.stringify({
          taskId: dispatch.task_id,
          exitCode,
          handle
        })
      })
    }
  }

  async listTerminals(
    worktreeSelector?: string,
    limit = DEFAULT_TERMINAL_LIST_LIMIT
  ): Promise<RuntimeTerminalListResult> {
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error('invalid_limit')
    }
    const graphEpoch = this.captureReadyGraphEpoch()
    const targetWorktreeId = worktreeSelector
      ? (getExplicitWorktreeIdSelector(worktreeSelector) ??
        (await this.resolveWorktreeSelector(worktreeSelector)).id)
      : null
    const worktreesById = await this.getResolvedWorktreeMap()
    this.assertStableReadyGraph(graphEpoch)

    const resolvedWorktrees = [...worktreesById.values()]
    await this.refreshPtyWorktreeRecordsFromController(resolvedWorktrees)

    const livePtyWorktreeIds = new Set<string>()
    for (const pty of this.ptysById.values()) {
      if (pty.connected) {
        livePtyWorktreeIds.add(pty.worktreeId)
      }
    }

    const terminals: RuntimeTerminalSummary[] = []
    const ptyIdsFromLeaves = new Set<string>()
    for (const leaf of this.leaves.values()) {
      if (targetWorktreeId && leaf.worktreeId !== targetWorktreeId) {
        continue
      }
      if (!leaf.ptyId && livePtyWorktreeIds.has(leaf.worktreeId)) {
        continue
      }
      if (leaf.ptyId) {
        ptyIdsFromLeaves.add(leaf.ptyId)
      }
      terminals.push(this.buildTerminalSummary(leaf, worktreesById))
    }

    // Why: worktree.ps can classify active worktrees from PTY records even when
    // the renderer graph is missing a leaf. terminal.list needs the same fallback
    // so mobile does not show a false "No terminals" create flow.
    for (const pty of this.ptysById.values()) {
      if (!pty.connected || ptyIdsFromLeaves.has(pty.ptyId)) {
        continue
      }
      if (targetWorktreeId && pty.worktreeId !== targetWorktreeId) {
        continue
      }
      terminals.push(this.buildPtyTerminalSummary(pty, worktreesById))
    }

    return {
      terminals: terminals.slice(0, limit),
      totalCount: terminals.length,
      truncated: terminals.length > limit
    }
  }

  // Why: when --terminal is omitted, the CLI auto-resolves to the active
  // terminal in the current worktree — matching browser's implicit active tab.
  async resolveActiveTerminal(worktreeSelector?: string): Promise<string> {
    this.assertGraphReady()

    const targetWorktreeId = worktreeSelector
      ? (await this.resolveWorktreeSelector(worktreeSelector)).id
      : null

    // Prefer the tab's activeLeafId — this is the pane the user last focused
    for (const tab of this.tabs.values()) {
      if (targetWorktreeId && tab.worktreeId !== targetWorktreeId) {
        continue
      }
      if (!tab.activeLeafId) {
        continue
      }
      const leafKey = this.getLeafKey(tab.tabId, tab.activeLeafId)
      const leaf = this.leaves.get(leafKey)
      if (leaf) {
        return this.issueHandle(leaf)
      }
    }

    // Fallback: any leaf in the target worktree
    for (const leaf of this.leaves.values()) {
      if (targetWorktreeId && leaf.worktreeId !== targetWorktreeId) {
        continue
      }
      return this.issueHandle(leaf)
    }

    throw new Error('no_active_terminal')
  }

  async showTerminal(handle: string): Promise<RuntimeTerminalShow> {
    const graphEpoch = this.captureReadyGraphEpoch()
    const worktreesById = await this.getResolvedWorktreeMap()
    this.assertStableReadyGraph(graphEpoch)
    const pty = this.getLivePtyForHandle(handle)
    if (pty) {
      return {
        ...this.buildPtyTerminalSummary(pty.pty, worktreesById),
        paneRuntimeId: -1,
        ptyId: pty.pty.ptyId,
        rendererGraphEpoch: this.rendererGraphEpoch
      }
    }
    const { leaf } = this.getLiveLeafForHandle(handle)
    const summary = this.buildTerminalSummary(leaf, worktreesById)
    return {
      ...summary,
      paneRuntimeId: leaf.paneRuntimeId,
      ptyId: leaf.ptyId,
      rendererGraphEpoch: this.rendererGraphEpoch
    }
  }

  async readTerminal(handle: string, opts: { cursor?: number } = {}): Promise<RuntimeTerminalRead> {
    const pty = this.getLivePtyForHandle(handle)
    if (pty) {
      return this.readPtyTerminal(handle, pty.pty, opts)
    }

    const { leaf } = this.getLiveLeafForHandle(handle)
    const allLines = buildTailLines(leaf.tailBuffer, leaf.tailPartialLine)

    let tail: string[]
    let truncated: boolean

    if (typeof opts.cursor === 'number' && opts.cursor >= 0) {
      // Why: the buffer only retains the last MAX_TAIL_LINES lines. If the
      // caller's cursor points to lines that were already evicted, we can only
      // return what's still in memory and mark truncated=true to signal the gap.
      const bufferStart = leaf.tailLinesTotal - leaf.tailBuffer.length
      const sliceFrom = Math.max(0, opts.cursor - bufferStart)
      // Why: cursor-based reads return only completed lines, excluding the
      // trailing partial line. Including the partial would cause duplication:
      // the consumer sees "hel" now, then "hello\n" on the next read after
      // the line completes — same content delivered twice.
      tail = leaf.tailBuffer.slice(sliceFrom)
      truncated = opts.cursor < bufferStart
    } else {
      tail = allLines
      // Why: Orca does not have a truthful main-owned screen model yet,
      // especially for hidden panes. Focused v1 therefore returns the bounded
      // tail lines directly instead of duplicating the same text in a fake
      // screen field that would waste agent tokens.
      truncated = leaf.tailTruncated
    }

    return {
      handle,
      status: getTerminalState(leaf),
      tail,
      truncated,
      // Why: cursors advance by completed lines only. If we count the current
      // partial line here, later reads can skip continued output on that same
      // line because no new complete line was emitted yet.
      nextCursor: String(leaf.tailLinesTotal)
    }
  }

  async sendTerminal(
    handle: string,
    action: {
      text?: string
      enter?: boolean
      interrupt?: boolean
    }
  ): Promise<RuntimeTerminalSend> {
    const pty = this.getLivePtyForHandle(handle)
    if (pty) {
      if (!pty.pty.connected) {
        throw new Error('terminal_not_writable')
      }
      const payload = buildSendPayload(action)
      if (payload === null) {
        throw new Error('invalid_terminal_send')
      }
      await this.writeTerminalAction(pty.pty.ptyId, action, payload)
      return {
        handle,
        accepted: true,
        bytesWritten: Buffer.byteLength(payload, 'utf8')
      }
    }

    const { leaf } = this.getLiveLeafForHandle(handle)
    if (!leaf.writable || !leaf.ptyId) {
      throw new Error('terminal_not_writable')
    }
    const payload = buildSendPayload(action)
    if (payload === null) {
      throw new Error('invalid_terminal_send')
    }

    await this.writeTerminalAction(leaf.ptyId, action, payload)

    return {
      handle,
      accepted: true,
      bytesWritten: Buffer.byteLength(payload, 'utf8')
    }
  }

  private async writeTerminalAction(
    ptyId: string,
    action: { text?: string; enter?: boolean; interrupt?: boolean },
    payload: string
  ): Promise<void> {
    // Why: TUI apps (Claude Code, etc.) treat a single large write as a paste
    // event. Keep Enter/interrupt as a second write for both visible and
    // background PTYs so CLI automation behaves the same either way.
    const hasText = typeof action.text === 'string' && action.text.length > 0
    const hasSuffix = action.enter || action.interrupt
    if (hasText && hasSuffix) {
      const textWrote = this.ptyController?.write(ptyId, action.text!) ?? false
      if (!textWrote) {
        throw new Error('terminal_not_writable')
      }
      const suffix = (action.enter ? '\r' : '') + (action.interrupt ? '\x03' : '')
      await new Promise((resolve) => setTimeout(resolve, 500))
      const suffixWrote = this.ptyController?.write(ptyId, suffix) ?? false
      if (!suffixWrote) {
        throw new Error('terminal_not_writable')
      }
      return
    }

    const wrote = this.ptyController?.write(ptyId, payload) ?? false
    if (!wrote) {
      throw new Error('terminal_not_writable')
    }
  }

  async waitForTerminal(
    handle: string,
    options?: {
      condition?: RuntimeTerminalWaitCondition
      timeoutMs?: number
    }
  ): Promise<RuntimeTerminalWait> {
    const condition = options?.condition ?? 'exit'
    const pty = this.getLivePtyForHandle(handle)
    if (pty) {
      if (condition === 'exit' && !pty.pty.connected) {
        return buildPtyTerminalWaitResult(handle, condition, pty.pty)
      }
      if (condition === 'tui-idle' && pty.pty.lastAgentStatus === 'idle') {
        return buildPtyTerminalWaitResult(handle, condition, pty.pty)
      }
      return await new Promise<RuntimeTerminalWait>((resolve, reject) => {
        const effectiveTimeoutMs =
          typeof options?.timeoutMs === 'number' && options.timeoutMs > 0
            ? options.timeoutMs
            : condition === 'tui-idle'
              ? TUI_IDLE_DEFAULT_TIMEOUT_MS
              : 0
        const waiter: TerminalWaiter = {
          handle,
          condition,
          resolve,
          reject,
          timeout: null,
          pollInterval: null
        }
        if (effectiveTimeoutMs > 0) {
          waiter.timeout = setTimeout(() => {
            this.removeWaiter(waiter)
            reject(new Error('timeout'))
          }, effectiveTimeoutMs)
        }
        let waiters = this.waitersByHandle.get(handle)
        if (!waiters) {
          waiters = new Set()
          this.waitersByHandle.set(handle, waiters)
        }
        waiters.add(waiter)
        const live = this.getLivePtyForHandle(handle)
        if (!live) {
          this.removeWaiter(waiter)
          reject(new Error('terminal_handle_stale'))
        } else if (condition === 'exit' && !live.pty.connected) {
          this.resolveWaiter(waiter, buildPtyTerminalWaitResult(handle, condition, live.pty))
        } else if (condition === 'tui-idle' && live.pty.lastAgentStatus === 'idle') {
          this.resolveWaiter(waiter, buildPtyTerminalWaitResult(handle, condition, live.pty))
        }
      })
    }
    const { leaf } = this.getLiveLeafForHandle(handle)

    if (condition === 'exit' && getTerminalState(leaf) === 'exited') {
      return buildTerminalWaitResult(handle, condition, leaf)
    }

    // Why: if the agent already transitioned to idle (or permission) before the
    // waiter was registered, resolve immediately. This uses the same OSC title
    // detection that powers the renderer's "Task complete" notifications.
    // Why: only 'idle' satisfies tui-idle, not 'permission'. Permission means the
    // agent is blocked on user approval, not finished with its task.
    if (condition === 'tui-idle' && leaf.lastAgentStatus === 'idle') {
      return buildTerminalWaitResult(handle, condition, leaf)
    }

    return await new Promise<RuntimeTerminalWait>((resolve, reject) => {
      // Why: tui-idle depends on OSC title transitions from a recognized agent.
      // If no agent is detected, the waiter would hang forever. Enforce a default
      // timeout so unsupported CLIs fail predictably instead of silently blocking.
      const effectiveTimeoutMs =
        typeof options?.timeoutMs === 'number' && options.timeoutMs > 0
          ? options.timeoutMs
          : condition === 'tui-idle'
            ? TUI_IDLE_DEFAULT_TIMEOUT_MS
            : 0

      const waiter: TerminalWaiter = {
        handle,
        condition,
        resolve,
        reject,
        timeout: null,
        pollInterval: null
      }

      if (effectiveTimeoutMs > 0) {
        waiter.timeout = setTimeout(() => {
          this.removeWaiter(waiter)
          reject(new Error('timeout'))
        }, effectiveTimeoutMs)
      }

      let waiters = this.waitersByHandle.get(handle)
      if (!waiters) {
        waiters = new Set()
        this.waitersByHandle.set(handle, waiters)
      }
      waiters.add(waiter)

      // Why: the handle may go stale or exit in the small gap between the first
      // validation and waiter registration. Re-checking here keeps wait --for
      // exit honest instead of hanging on a terminal that already changed.
      try {
        const live = this.getLiveLeafForHandle(handle)
        if (getTerminalState(live.leaf) === 'exited') {
          this.resolveWaiter(waiter, buildTerminalWaitResult(handle, condition, live.leaf))
        } else if (condition === 'tui-idle' && live.leaf.lastAgentStatus === 'idle') {
          // Why: don't clear lastAgentStatus here. It's a factual record of the
          // last detected OSC state, not a one-shot signal. Clearing it causes
          // subsequent tui-idle waiters to hang even though the agent is idle —
          // the first waiter consumes the status and all later ones see null.
          this.resolveWaiter(waiter, buildTerminalWaitResult(handle, condition, live.leaf))
        } else if (condition === 'tui-idle' && live.leaf.lastAgentStatus === null) {
          // Why: for daemon-hosted terminals, lastAgentStatus stays null because
          // PTY data doesn't flow through onPtyData. Check the renderer-synced
          // title as a fast path before falling back to polling.
          const fastPathTitle = live.leaf.paneTitle ?? this.tabs.get(live.leaf.tabId)?.title
          if (fastPathTitle && detectAgentStatusFromTitle(fastPathTitle) === 'idle') {
            this.resolveWaiter(waiter, buildTerminalWaitResult(handle, condition, live.leaf))
          } else {
            this.startTuiIdleFallbackPoll(waiter, live.leaf)
          }
        }
      } catch (error) {
        this.removeWaiter(waiter)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  async getWorktreePs(limit = DEFAULT_WORKTREE_PS_LIMIT): Promise<{
    worktrees: RuntimeWorktreePsSummary[]
    totalCount: number
    truncated: boolean
  }> {
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error('invalid_limit')
    }
    const resolvedWorktrees = await this.listResolvedWorktrees()
    await this.refreshPtyWorktreeRecordsFromController(resolvedWorktrees)
    const repoById = new Map((this.store?.getRepos() ?? []).map((repo) => [repo.id, repo]))
    const summaries = new Map<string, RuntimeWorktreePsSummary>()

    // Why: the GitHub cache is keyed by `repoPath::branch` (no refs/heads/ prefix),
    // matching how the renderer's fetchPRForBranch stores entries. We look up cached
    // PR info so mobile clients can group worktrees by PR state without making
    // expensive `gh` CLI calls. Falls back to meta.linkedPR if no cache entry exists.
    const ghCache = this.store?.getGitHubCache?.()
    for (const worktree of resolvedWorktrees) {
      const meta =
        this.store?.getWorktreeMeta?.(worktree.id) ?? this.store?.getAllWorktreeMeta()[worktree.id]
      const repo = repoById.get(worktree.repoId)
      let linkedPR: { number: number; state: string } | null = null
      const branch = worktree.branch.replace(/^refs\/heads\//, '')
      if (repo?.path && branch && ghCache) {
        const prCacheKey = `${repo.path}::${branch}`
        const cached = ghCache.pr[prCacheKey]
        if (cached?.data) {
          linkedPR = { number: cached.data.number, state: cached.data.state }
        }
      }
      if (!linkedPR && meta?.linkedPR != null) {
        linkedPR = { number: meta.linkedPR, state: 'unknown' }
      }
      summaries.set(worktree.id, {
        worktreeId: worktree.id,
        repoId: worktree.repoId,
        repo: repo?.displayName ?? worktree.repoId,
        path: worktree.path,
        branch: worktree.branch,
        parentWorktreeId: worktree.parentWorktreeId,
        childWorktreeIds: worktree.childWorktreeIds,
        displayName: worktree.displayName,
        linkedIssue: worktree.linkedIssue,
        linkedPR,
        isPinned: meta?.isPinned ?? false,
        unread: meta?.isUnread ?? false,
        liveTerminalCount: 0,
        hasAttachedPty: false,
        lastOutputAt: null,
        preview: '',
        status: 'inactive'
      })
    }

    const countedPtyIds = new Set<string>()
    for (const leaf of this.leaves.values()) {
      const summary = this.getSummaryForRuntimeWorktreeId(
        summaries,
        resolvedWorktrees,
        leaf.worktreeId
      )
      if (!summary) {
        continue
      }
      if (leaf.ptyId) {
        countedPtyIds.add(leaf.ptyId)
      }
      const previousLastOutputAt = summary.lastOutputAt
      summary.liveTerminalCount += 1
      summary.hasAttachedPty = summary.hasAttachedPty || leaf.connected
      summary.lastOutputAt = maxTimestamp(summary.lastOutputAt, leaf.lastOutputAt)
      summary.status = mergeWorktreeStatus(
        summary.status,
        getLeafWorktreeStatus(leaf, this.tabs.get(leaf.tabId)?.title ?? null)
      )
      if (
        leaf.preview &&
        (summary.preview.length === 0 || (leaf.lastOutputAt ?? -1) >= (previousLastOutputAt ?? -1))
      ) {
        summary.preview = leaf.preview
      }
    }

    for (const pty of this.ptysById.values()) {
      if (!pty.connected || countedPtyIds.has(pty.ptyId)) {
        continue
      }
      const summary = this.getSummaryForRuntimeWorktreeId(
        summaries,
        resolvedWorktrees,
        pty.worktreeId
      )
      if (!summary) {
        continue
      }
      const previousLastOutputAt = summary.lastOutputAt
      summary.liveTerminalCount += 1
      summary.hasAttachedPty = true
      summary.lastOutputAt = maxTimestamp(summary.lastOutputAt, pty.lastOutputAt)
      summary.status = mergeWorktreeStatus(summary.status, 'active')
      if (
        pty.preview &&
        (summary.preview.length === 0 || (pty.lastOutputAt ?? -1) >= (previousLastOutputAt ?? -1))
      ) {
        summary.preview = pty.preview
      }
    }

    const session = this.store?.getWorkspaceSession?.()
    for (const [worktreeId, tabs] of Object.entries(session?.tabsByWorktree ?? {})) {
      if (tabs.length === 0) {
        continue
      }
      const summary = this.getSummaryForRuntimeWorktreeId(summaries, resolvedWorktrees, worktreeId)
      if (!summary) {
        continue
      }
      // Why: desktop can show terminal tabs that are not mounted as renderer
      // leaves and are not currently visible in the PTY provider list. Mobile
      // still needs those worktrees to show as terminal-bearing entries.
      summary.liveTerminalCount = Math.max(summary.liveTerminalCount, tabs.length)
      summary.hasAttachedPty = summary.hasAttachedPty || tabs.some((tab) => tab.ptyId !== null)
      for (const tab of tabs) {
        summary.status = mergeWorktreeStatus(
          summary.status,
          getSavedTabWorktreeStatus(tab.title, tab.ptyId !== null)
        )
      }
    }

    const sorted = [...summaries.values()].sort(compareWorktreePs)
    return {
      worktrees: sorted.slice(0, limit),
      totalCount: sorted.length,
      truncated: sorted.length > limit
    }
  }

  listRepos(): Repo[] {
    return this.store?.getRepos() ?? []
  }

  async addRepo(path: string, kind: 'git' | 'folder' = 'git'): Promise<Repo> {
    if (!this.store) {
      throw new Error('runtime_unavailable')
    }
    if (!isAbsolute(path)) {
      // Why: remote clients may run in a different cwd than the server. Require
      // server-side repo paths to be explicit so `orca serve` cwd is irrelevant.
      throw new Error('Repo path must be an absolute path')
    }
    if (kind === 'git' && !isGitRepo(path)) {
      throw new Error(`Not a valid git repository: ${path}`)
    }

    const existing = this.store.getRepos().find((repo) => runtimePathsEqual(repo.path, path))
    if (existing) {
      return existing
    }

    const repo: Repo = {
      id: randomUUID(),
      path,
      displayName: getRepoName(path),
      badgeColor: REPO_COLORS[this.store.getRepos().length % REPO_COLORS.length],
      addedAt: Date.now(),
      kind
    }
    this.store.addRepo(repo)
    this.invalidateResolvedWorktreeCache()
    this.notifier?.reposChanged()
    return this.store.getRepo(repo.id) ?? repo
  }

  async createRepo(
    parentPath: string,
    name: string,
    kind: 'git' | 'folder' = 'git'
  ): Promise<{ repo: Repo } | { error: string }> {
    if (!this.store) {
      throw new Error('runtime_unavailable')
    }
    const trimmedName = name.trim()
    const trimmedParentPath = parentPath.trim()
    const repoKind: 'git' | 'folder' = kind === 'folder' ? 'folder' : 'git'
    if (!trimmedName) {
      return { error: 'Name cannot be empty' }
    }
    if (/[\\/]/.test(trimmedName) || trimmedName === '.' || trimmedName === '..') {
      return { error: 'Name cannot contain slashes or be "." / ".."' }
    }
    if (!trimmedParentPath) {
      return { error: 'Parent directory is required' }
    }
    if (!isAbsolute(trimmedParentPath)) {
      return { error: 'Parent directory must be an absolute path' }
    }

    const targetPath = join(trimmedParentPath, trimmedName)
    const existing = this.store.getRepos().find((repo) => runtimePathsEqual(repo.path, targetPath))
    if (existing) {
      return { repo: existing }
    }

    let createdDir = false
    try {
      const existingStat = await stat(targetPath).catch((error: unknown) => {
        if (isENOENT(error)) {
          return null
        }
        throw error
      })
      if (existingStat) {
        if (!existingStat.isDirectory()) {
          return { error: `"${trimmedName}" already exists at this location and is not a folder.` }
        }
        const entries = await readdir(targetPath)
        if (entries.length > 0) {
          return { error: `"${trimmedName}" already exists at this location and is not empty.` }
        }
      } else {
        await mkdir(targetPath, { recursive: false })
        createdDir = true
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { error: `Failed to prepare directory: ${message}` }
    }

    if (repoKind === 'git') {
      let step: 'init' | 'commit' = 'init'
      try {
        await gitExecFileAsync(['init'], { cwd: targetPath })
        step = 'commit'
        await gitExecFileAsync(['commit', '--allow-empty', '-m', 'Initial commit'], {
          cwd: targetPath
        })
      } catch (error) {
        if (createdDir) {
          await rm(targetPath, { recursive: true, force: true }).catch(() => {})
        } else if (step === 'commit') {
          await rm(join(targetPath, '.git'), { recursive: true, force: true }).catch(() => {})
        }
        const message = error instanceof Error ? error.message : String(error)
        if (
          step === 'commit' &&
          /Please tell me who you are|user\.name|user\.email/i.test(message)
        ) {
          return {
            error:
              'Git author identity is not configured. Run `git config --global user.name "Your Name"` and `git config --global user.email "you@example.com"`, then try again.'
          }
        }
        const stepLabel =
          step === 'init'
            ? 'Failed to initialize git repository'
            : 'Failed to create initial commit'
        return { error: `${stepLabel}: ${message}` }
      }
    }

    const raceWinner = this.store
      .getRepos()
      .find((repo) => runtimePathsEqual(repo.path, targetPath))
    if (raceWinner) {
      return { repo: raceWinner }
    }

    const repo: Repo = {
      id: randomUUID(),
      path: targetPath,
      displayName: trimmedName,
      badgeColor: REPO_COLORS[this.store.getRepos().length % REPO_COLORS.length],
      addedAt: Date.now(),
      kind: repoKind
    }
    this.store.addRepo(repo)
    invalidateAuthorizedRootsCache()
    this.invalidateResolvedWorktreeCache()
    this.notifier?.reposChanged()
    return { repo: this.store.getRepo(repo.id) ?? repo }
  }

  async cloneRepo(url: string, destination: string): Promise<Repo> {
    if (!this.store) {
      throw new Error('runtime_unavailable')
    }
    const trimmedUrl = url.trim()
    const trimmedDestination = destination.trim()
    const repoName = basename(trimmedUrl.replace(/\.git\/?$/, ''))
    if (!repoName) {
      throw new Error('Could not determine repository name from URL')
    }
    if (!trimmedDestination) {
      throw new Error('Clone destination is required')
    }
    if (!isAbsolute(trimmedDestination)) {
      throw new Error('Clone destination must be an absolute path')
    }
    await mkdir(trimmedDestination, { recursive: true })
    const clonePath = join(trimmedDestination, repoName)
    await new Promise<void>((resolve, reject) => {
      const proc = wslAwareSpawn('git', ['clone', '--progress', '--', trimmedUrl, clonePath], {
        cwd: trimmedDestination,
        stdio: ['ignore', 'ignore', 'pipe']
      })
      let stderrTail = ''
      proc.stderr?.on('data', (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString()).slice(-4096)
      })
      proc.on('error', (error) => reject(new Error(`Clone failed: ${error.message}`)))
      proc.on('close', (code, signal) => {
        if (signal === 'SIGTERM') {
          reject(new Error('Clone aborted'))
        } else if (code === 0) {
          resolve()
        } else {
          const lastLine = stderrTail.trim().split('\n').pop() ?? 'unknown error'
          reject(new Error(`Clone failed: ${lastLine}`))
        }
      })
    })

    const existing = this.store.getRepos().find((repo) => runtimePathsEqual(repo.path, clonePath))
    if (existing) {
      if (isFolderRepo(existing)) {
        const updated = this.store.updateRepo(existing.id, { kind: 'git' })
        if (updated) {
          this.notifier?.reposChanged()
          return updated
        }
      }
      return existing
    }

    const repo: Repo = {
      id: randomUUID(),
      path: clonePath,
      displayName: getRepoName(clonePath),
      badgeColor: REPO_COLORS[this.store.getRepos().length % REPO_COLORS.length],
      addedAt: Date.now(),
      kind: 'git'
    }
    this.store.addRepo(repo)
    invalidateAuthorizedRootsCache()
    this.invalidateResolvedWorktreeCache()
    this.notifier?.reposChanged()
    return this.store.getRepo(repo.id) ?? repo
  }

  async showRepo(repoSelector: string): Promise<Repo> {
    return await this.resolveRepoSelector(repoSelector)
  }

  async setRepoBaseRef(repoSelector: string, baseRef: string): Promise<Repo> {
    if (!this.store) {
      throw new Error('runtime_unavailable')
    }
    const repo = await this.resolveRepoSelector(repoSelector)
    if (isFolderRepo(repo)) {
      throw new Error('Folder mode does not support base refs.')
    }
    const updated = this.store.updateRepo(repo.id, { worktreeBaseRef: baseRef })
    if (!updated) {
      throw new Error('repo_not_found')
    }
    this.invalidateResolvedWorktreeCache()
    this.notifier?.reposChanged()
    return updated
  }

  async updateRepo(
    repoSelector: string,
    updates: Partial<
      Pick<
        Repo,
        | 'displayName'
        | 'badgeColor'
        | 'hookSettings'
        | 'worktreeBaseRef'
        | 'kind'
        | 'symlinkPaths'
        | 'issueSourcePreference'
      >
    >
  ): Promise<Repo> {
    if (!this.store) {
      throw new Error('runtime_unavailable')
    }
    const repo = await this.resolveRepoSelector(repoSelector)
    const updated = this.store.updateRepo(repo.id, omitUndefinedProperties(updates))
    if (!updated) {
      throw new Error('repo_not_found')
    }
    this.invalidateResolvedWorktreeCache()
    this.notifier?.reposChanged()
    return updated
  }

  async removeRepo(repoSelector: string): Promise<{ removed: true }> {
    if (!this.store?.removeRepo) {
      throw new Error('runtime_unavailable')
    }
    const repo = await this.resolveRepoSelector(repoSelector)
    this.store.removeRepo(repo.id)
    this.invalidateResolvedWorktreeCache()
    invalidateAuthorizedRootsCache()
    this.notifier?.reposChanged()
    return { removed: true }
  }

  async inspectTerminalProcess(
    terminalSelector: string
  ): Promise<{ foregroundProcess: string | null; hasChildProcesses: boolean }> {
    const leaf = this.resolveLeafForHandle(terminalSelector)
    if (!leaf?.ptyId || !this.ptyController) {
      return { foregroundProcess: null, hasChildProcesses: false }
    }
    const foregroundProcess = await this.ptyController.getForegroundProcess(leaf.ptyId)
    const hasChildProcesses =
      (await this.ptyController.hasChildProcesses?.(leaf.ptyId).catch(() => false)) ?? false
    return { foregroundProcess, hasChildProcesses }
  }

  reorderRepos(orderedIds: string[]): { status: 'applied' | 'rejected' } {
    if (!this.store?.reorderRepos) {
      throw new Error('runtime_unavailable')
    }
    // Why: remote clients can race repo add/remove on the server just like
    // local drag-reorder can race another window. Let the store validate the
    // full permutation and signal a resync-worthy rejection.
    const applied = this.store.reorderRepos(orderedIds)
    if (!applied) {
      return { status: 'rejected' }
    }
    this.invalidateResolvedWorktreeCache()
    this.notifier?.reposChanged()
    return { status: 'applied' }
  }

  async searchRepoRefs(
    repoSelector: string,
    query: string,
    limit = DEFAULT_REPO_SEARCH_REFS_LIMIT
  ): Promise<RuntimeRepoSearchRefs> {
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error('invalid_limit')
    }
    const repo = await this.resolveRepoSelector(repoSelector)
    if (isFolderRepo(repo)) {
      return {
        refs: [],
        truncated: false
      }
    }
    const refs = repo.connectionId
      ? await this.searchRemoteRepoRefs(repo, query, limit + 1)
      : await searchBaseRefs(repo.path, query, limit + 1)
    return {
      refs: refs.slice(0, limit),
      truncated: refs.length > limit
    }
  }

  async getRepoBaseRefDefault(
    repoSelector: string
  ): Promise<{ defaultBaseRef: string | null; remoteCount: number }> {
    const repo = await this.resolveRepoSelector(repoSelector)
    if (isFolderRepo(repo)) {
      return { defaultBaseRef: null, remoteCount: 0 }
    }
    if (repo.connectionId) {
      return this.getRemoteRepoBaseRefDefault(repo)
    }
    const [defaultBaseRef, remoteCount] = await Promise.all([
      getBaseRefDefault(repo.path),
      getRemoteCount(repo.path)
    ])
    return { defaultBaseRef, remoteCount }
  }

  private async getRemoteRepoBaseRefDefault(
    repo: Repo
  ): Promise<{ defaultBaseRef: string | null; remoteCount: number }> {
    const provider = repo.connectionId ? getSshGitProvider(repo.connectionId) : null
    if (!provider) {
      return { defaultBaseRef: null, remoteCount: 0 }
    }
    const [defaultBaseRef, remoteCount] = await Promise.all([
      resolveDefaultBaseRefViaExec(async (argv) => {
        try {
          return await provider.exec(argv, repo.path)
        } catch (err) {
          if (argv[0] === 'symbolic-ref') {
            console.warn('[runtime:repo.baseRefDefault] SSH symbolic-ref failed', {
              path: repo.path,
              err
            })
          }
          throw err
        }
      }),
      provider
        .exec(['remote'], repo.path)
        .then((result) => parseRemoteCount(result.stdout))
        .catch((err) => {
          console.warn('[runtime:repo.baseRefDefault] SSH git remote count failed', {
            path: repo.path,
            err
          })
          return 0
        })
    ])
    return { defaultBaseRef, remoteCount }
  }

  private async searchRemoteRepoRefs(repo: Repo, query: string, limit: number): Promise<string[]> {
    const provider = repo.connectionId ? getSshGitProvider(repo.connectionId) : null
    if (!provider) {
      return []
    }
    const normalizedQuery = normalizeRefSearchQuery(query)
    if (!normalizedQuery) {
      return []
    }
    try {
      const result = await provider.exec(buildSearchBaseRefsArgv(normalizedQuery), repo.path)
      return parseAndFilterSearchRefs(result.stdout, limit)
    } catch (err) {
      console.warn('[runtime:repo.searchRefs] SSH for-each-ref failed', {
        path: repo.path,
        err
      })
      return []
    }
  }

  private assertHostIntegrationRepoIsLocal(repo: Repo, operation: string): void {
    if (repo.connectionId) {
      throw new Error(`${operation}_unsupported_for_ssh_repo`)
    }
  }

  async getRepoSlug(repoSelector: string): Promise<{ owner: string; repo: string } | null> {
    const repo = await this.resolveRepoSelector(repoSelector)
    this.assertHostIntegrationRepoIsLocal(repo, 'repo_slug')
    return getRepoSlug(repo.path)
  }

  async listRepoWorkItems(
    repoSelector: string,
    limit?: number,
    query?: string,
    before?: string
  ): Promise<Awaited<ReturnType<typeof listWorkItems>>> {
    const repo = await this.resolveRepoSelector(repoSelector)
    this.assertHostIntegrationRepoIsLocal(repo, 'repo_work_items')
    return listWorkItems(repo.path, limit, query, before, repo.issueSourcePreference)
  }

  async getRepoWorkItem(
    repoSelector: string,
    number: number,
    type?: 'issue' | 'pr'
  ): Promise<Awaited<ReturnType<typeof getWorkItem>>> {
    const repo = await this.resolveRepoSelector(repoSelector)
    this.assertHostIntegrationRepoIsLocal(repo, 'repo_work_item')
    return getWorkItem(repo.path, number, type)
  }

  async getRepoWorkItemByOwnerRepo(
    repoSelector: string,
    ownerRepo: { owner: string; repo: string },
    number: number,
    type: 'issue' | 'pr'
  ): Promise<Awaited<ReturnType<typeof getWorkItemByOwnerRepo>>> {
    const repo = await this.resolveRepoSelector(repoSelector)
    this.assertHostIntegrationRepoIsLocal(repo, 'repo_work_item')
    return getWorkItemByOwnerRepo(repo.path, ownerRepo, number, type)
  }

  async getRepoWorkItemDetails(
    repoSelector: string,
    number: number,
    type?: 'issue' | 'pr'
  ): Promise<Awaited<ReturnType<typeof getWorkItemDetails>>> {
    const repo = await this.resolveRepoSelector(repoSelector)
    this.assertHostIntegrationRepoIsLocal(repo, 'repo_work_item_details')
    return getWorkItemDetails(repo.path, number, type)
  }

  async countRepoWorkItems(repoSelector: string, query?: string): Promise<number> {
    const repo = await this.resolveRepoSelector(repoSelector)
    this.assertHostIntegrationRepoIsLocal(repo, 'repo_work_items')
    return countWorkItems(repo.path, query, repo.issueSourcePreference)
  }

  async listRepoLabels(repoSelector: string): Promise<Awaited<ReturnType<typeof listLabels>>> {
    const repo = await this.resolveRepoSelector(repoSelector)
    this.assertHostIntegrationRepoIsLocal(repo, 'repo_labels')
    return listLabels(repo.path, repo.issueSourcePreference)
  }

  async listRepoAssignableUsers(
    repoSelector: string
  ): Promise<Awaited<ReturnType<typeof listAssignableUsers>>> {
    const repo = await this.resolveRepoSelector(repoSelector)
    this.assertHostIntegrationRepoIsLocal(repo, 'repo_assignable_users')
    return listAssignableUsers(repo.path, repo.issueSourcePreference)
  }

  getGitHubRateLimit(options?: {
    force?: boolean
  }): Promise<Awaited<ReturnType<typeof getRateLimit>>> {
    return getRateLimit(options)
  }

  async getRepoPRForBranch(
    repoSelector: string,
    branch: string,
    linkedPRNumber?: number | null
  ): Promise<Awaited<ReturnType<typeof getPRForBranch>>> {
    const repo = await this.resolveRepoSelector(repoSelector)
    this.assertHostIntegrationRepoIsLocal(repo, 'repo_pr')
    return getPRForBranch(repo.path, branch, linkedPRNumber ?? null)
  }

  async getHostedReviewForBranch(args: {
    repoSelector: string
    branch: string
    linkedGitHubPR?: number | null
    linkedGitLabMR?: number | null
    linkedBitbucketPR?: number | null
    linkedGiteaPR?: number | null
  }): Promise<HostedReviewInfo | null> {
    const repo = await this.resolveRepoSelector(args.repoSelector)
    this.assertHostIntegrationRepoIsLocal(repo, 'hosted_review')
    const review = await getHostedReviewForBranchFromRepo({
      repoPath: repo.path,
      branch: args.branch,
      linkedGitHubPR: args.linkedGitHubPR ?? null,
      linkedGitLabMR: args.linkedGitLabMR ?? null,
      linkedBitbucketPR: args.linkedBitbucketPR ?? null,
      linkedGiteaPR: args.linkedGiteaPR ?? null
    })
    if (review?.provider === 'github' && this.stats && !this.stats.hasCountedPR(review.url)) {
      this.stats.record({
        type: 'pr_created',
        at: Date.now(),
        repoId: repo.id,
        meta: { prNumber: review.number, prUrl: review.url }
      })
    }
    return review
  }

  async getHostedReviewCreationEligibility(
    args: Omit<HostedReviewCreationEligibilityArgs, 'repoPath'> & { repoSelector: string }
  ): Promise<HostedReviewCreationEligibility> {
    const repo = await this.resolveRepoSelector(args.repoSelector)
    this.assertHostIntegrationRepoIsLocal(repo, 'hosted_review')
    return getHostedReviewCreationEligibilityFromRepo({
      repoPath: repo.path,
      branch: args.branch,
      base: args.base ?? null,
      hasUncommittedChanges: args.hasUncommittedChanges,
      hasUpstream: args.hasUpstream,
      ahead: args.ahead,
      behind: args.behind,
      linkedGitHubPR: args.linkedGitHubPR ?? null,
      linkedGitLabMR: args.linkedGitLabMR ?? null,
      linkedBitbucketPR: args.linkedBitbucketPR ?? null,
      linkedGiteaPR: args.linkedGiteaPR ?? null
    })
  }

  async createHostedReview(
    args: CreateHostedReviewInput & { repoSelector: string }
  ): Promise<CreateHostedReviewResult> {
    const repo = await this.resolveRepoSelector(args.repoSelector)
    this.assertHostIntegrationRepoIsLocal(repo, 'hosted_review')
    const result = await createHostedReviewFromRepo(repo.path, {
      provider: args.provider,
      base: args.base,
      head: args.head,
      title: args.title,
      body: args.body,
      draft: args.draft
    })
    if (result.ok && this.stats && !this.stats.hasCountedPR(result.url)) {
      this.stats.record({
        type: 'pr_created',
        at: Date.now(),
        repoId: repo.id,
        meta: { prNumber: result.number, prUrl: result.url }
      })
    }
    return result
  }

  async getRepoIssue(
    repoSelector: string,
    number: number
  ): Promise<Awaited<ReturnType<typeof getIssue>>> {
    const repo = await this.resolveRepoSelector(repoSelector)
    this.assertHostIntegrationRepoIsLocal(repo, 'repo_issue')
    return getIssue(repo.path, number)
  }

  async getRepoPRChecks(
    repoSelector: string,
    prNumber: number,
    headSha?: string,
    options?: { noCache?: boolean }
  ): Promise<Awaited<ReturnType<typeof getPRChecks>>> {
    const repo = await this.resolveRepoSelector(repoSelector)
    this.assertHostIntegrationRepoIsLocal(repo, 'repo_pr_checks')
    return getPRChecks(repo.path, prNumber, headSha, options)
  }

  async getRepoPRComments(
    repoSelector: string,
    prNumber: number,
    options?: { noCache?: boolean }
  ): Promise<Awaited<ReturnType<typeof getPRComments>>> {
    const repo = await this.resolveRepoSelector(repoSelector)
    this.assertHostIntegrationRepoIsLocal(repo, 'repo_pr_comments')
    return getPRComments(repo.path, prNumber, options)
  }

  async getRepoPRFileContents(
    repoSelector: string,
    args: {
      prNumber: number
      path: string
      oldPath?: string
      status: GitHubPRFile['status']
      headSha: string
      baseSha: string
    }
  ): Promise<Awaited<ReturnType<typeof getPRFileContents>>> {
    const repo = await this.resolveRepoSelector(repoSelector)
    this.assertHostIntegrationRepoIsLocal(repo, 'repo_pr_file_contents')
    return getPRFileContents({ repoPath: repo.path, ...args })
  }

  async resolveRepoReviewThread(
    repoSelector: string,
    threadId: string,
    resolve: boolean
  ): Promise<Awaited<ReturnType<typeof resolveReviewThread>>> {
    const repo = await this.resolveRepoSelector(repoSelector)
    this.assertHostIntegrationRepoIsLocal(repo, 'repo_pr_review_thread')
    return resolveReviewThread(repo.path, threadId, resolve)
  }

  async updateRepoPRTitle(
    repoSelector: string,
    prNumber: number,
    title: string
  ): Promise<Awaited<ReturnType<typeof updatePRTitle>>> {
    const repo = await this.resolveRepoSelector(repoSelector)
    this.assertHostIntegrationRepoIsLocal(repo, 'repo_pr_title')
    return updatePRTitle(repo.path, prNumber, title)
  }

  async mergeRepoPR(
    repoSelector: string,
    prNumber: number,
    method?: 'merge' | 'squash' | 'rebase'
  ): Promise<Awaited<ReturnType<typeof mergePR>>> {
    const repo = await this.resolveRepoSelector(repoSelector)
    this.assertHostIntegrationRepoIsLocal(repo, 'repo_pr_merge')
    return mergePR(repo.path, prNumber, method)
  }

  async createRepoIssue(
    repoSelector: string,
    title: string,
    body: string
  ): Promise<Awaited<ReturnType<typeof createIssue>>> {
    const repo = await this.resolveRepoSelector(repoSelector)
    this.assertHostIntegrationRepoIsLocal(repo, 'repo_issue_create')
    return createIssue(repo.path, title, body, repo.issueSourcePreference)
  }

  async updateRepoIssue(
    repoSelector: string,
    number: number,
    updates: GitHubIssueUpdate
  ): Promise<Awaited<ReturnType<typeof updateIssue>>> {
    const repo = await this.resolveRepoSelector(repoSelector)
    this.assertHostIntegrationRepoIsLocal(repo, 'repo_issue_update')
    return updateIssue(repo.path, number, updates)
  }

  async addRepoIssueComment(
    repoSelector: string,
    number: number,
    body: string
  ): Promise<Awaited<ReturnType<typeof addIssueComment>>> {
    const repo = await this.resolveRepoSelector(repoSelector)
    this.assertHostIntegrationRepoIsLocal(repo, 'repo_issue_comment')
    return addIssueComment(repo.path, number, body)
  }

  async addRepoPRReviewComment(
    repoSelector: string,
    args: Omit<GitHubPRReviewCommentInput, 'repoPath'>
  ): Promise<Awaited<ReturnType<typeof addPRReviewComment>>> {
    const repo = await this.resolveRepoSelector(repoSelector)
    this.assertHostIntegrationRepoIsLocal(repo, 'repo_pr_review_comment')
    return addPRReviewComment({ repoPath: repo.path, ...args })
  }

  async addRepoPRReviewCommentReply(
    repoSelector: string,
    args: {
      prNumber: number
      commentId: number
      body: string
      threadId?: string
      path?: string
      line?: number
    }
  ): Promise<Awaited<ReturnType<typeof addPRReviewCommentReply>>> {
    const repo = await this.resolveRepoSelector(repoSelector)
    this.assertHostIntegrationRepoIsLocal(repo, 'repo_pr_review_comment_reply')
    return addPRReviewCommentReply(
      repo.path,
      args.prNumber,
      args.commentId,
      args.body,
      args.threadId,
      args.path,
      args.line
    )
  }

  async listGitHubProjects(): Promise<Awaited<ReturnType<typeof listAccessibleProjects>>> {
    return listAccessibleProjects()
  }

  async listGitHubLabelsBySlug(
    args: ListLabelsBySlugArgs
  ): Promise<Awaited<ReturnType<typeof listLabelsBySlug>>> {
    return listLabelsBySlug(args)
  }

  async listGitHubAssignableUsersBySlug(
    args: ListAssignableUsersBySlugArgs
  ): Promise<Awaited<ReturnType<typeof listAssignableUsersBySlug>>> {
    return listAssignableUsersBySlug(args)
  }

  async listGitHubIssueTypesBySlug(
    args: ListIssueTypesBySlugArgs
  ): Promise<Awaited<ReturnType<typeof listIssueTypesBySlug>>> {
    return listIssueTypesBySlug(args)
  }

  async resolveGitHubProjectRef(
    args: ResolveProjectRefArgs
  ): Promise<Awaited<ReturnType<typeof resolveProjectRef>>> {
    return resolveProjectRef(args)
  }

  async listGitHubProjectViews(
    args: ListProjectViewsArgs
  ): Promise<Awaited<ReturnType<typeof listProjectViews>>> {
    return listProjectViews(args)
  }

  async getGitHubProjectViewTable(
    args: GetProjectViewTableArgs
  ): Promise<Awaited<ReturnType<typeof getProjectViewTable>>> {
    return getProjectViewTable(args)
  }

  async getGitHubProjectWorkItemDetailsBySlug(
    args: ProjectWorkItemDetailsBySlugArgs
  ): Promise<Awaited<ReturnType<typeof getWorkItemDetailsBySlug>>> {
    return getWorkItemDetailsBySlug(args)
  }

  async updateGitHubProjectItemField(
    args: UpdateProjectItemFieldArgs
  ): Promise<Awaited<ReturnType<typeof updateProjectItemFieldValue>>> {
    return updateProjectItemFieldValue(args)
  }

  async clearGitHubProjectItemField(
    args: ClearProjectItemFieldArgs
  ): Promise<Awaited<ReturnType<typeof clearProjectItemFieldValue>>> {
    return clearProjectItemFieldValue(args)
  }

  async updateGitHubIssueBySlug(
    args: UpdateIssueBySlugArgs
  ): Promise<Awaited<ReturnType<typeof updateIssueBySlug>>> {
    return updateIssueBySlug(args)
  }

  async updateGitHubPullRequestBySlug(
    args: UpdatePullRequestBySlugArgs
  ): Promise<Awaited<ReturnType<typeof updatePullRequestBySlug>>> {
    return updatePullRequestBySlug(args)
  }

  async updateGitHubIssueTypeBySlug(
    args: UpdateIssueTypeBySlugArgs
  ): Promise<Awaited<ReturnType<typeof updateIssueTypeBySlug>>> {
    return updateIssueTypeBySlug(args)
  }

  async addGitHubIssueCommentBySlug(
    args: AddIssueCommentBySlugArgs
  ): Promise<Awaited<ReturnType<typeof addIssueCommentBySlug>>> {
    return addIssueCommentBySlug(args)
  }

  async updateGitHubIssueCommentBySlug(
    args: UpdateIssueCommentBySlugArgs
  ): Promise<Awaited<ReturnType<typeof updateIssueCommentBySlug>>> {
    return updateIssueCommentBySlug(args)
  }

  async deleteGitHubIssueCommentBySlug(
    args: DeleteIssueCommentBySlugArgs
  ): Promise<Awaited<ReturnType<typeof deleteIssueCommentBySlug>>> {
    return deleteIssueCommentBySlug(args)
  }

  async getRepoHooks(repoSelector: string) {
    const repo = await this.resolveRepoSelector(repoSelector)
    if (repo.connectionId) {
      const fsProvider = getSshFilesystemProvider(repo.connectionId)
      if (!fsProvider) {
        return {
          hasHooksFile: false,
          hooks: null,
          setupRunPolicy: getEffectiveSetupRunPolicy(repo),
          source: null
        }
      }
      try {
        const result = await fsProvider.readFile(joinWorktreeRelativePath(repo.path, '.orca.yaml'))
        const hooks = result.isBinary ? null : parseOrcaYaml(result.content)
        return {
          hasHooksFile: Boolean(hooks),
          hooks,
          setupRunPolicy: getEffectiveSetupRunPolicy(repo),
          source: hooks ? 'orca.yaml' : null
        }
      } catch {
        return {
          hasHooksFile: false,
          hooks: null,
          setupRunPolicy: getEffectiveSetupRunPolicy(repo),
          source: null
        }
      }
    }
    const hasFile = hasHooksFile(repo.path)
    const hooks = getEffectiveHooks(repo)
    const setupRunPolicy = getEffectiveSetupRunPolicy(repo)
    return {
      hasHooksFile: hasFile,
      hooks,
      setupRunPolicy,
      source: hasFile ? 'orca.yaml' : hooks ? 'legacy' : null
    }
  }

  async checkRepoHooks(repoSelector: string) {
    const repo = await this.resolveRepoSelector(repoSelector)
    if (isFolderRepo(repo)) {
      return { hasHooks: false, hooks: null, mayNeedUpdate: false }
    }

    if (repo.connectionId) {
      const fsProvider = getSshFilesystemProvider(repo.connectionId)
      if (!fsProvider) {
        return { hasHooks: false, hooks: null, mayNeedUpdate: false }
      }
      try {
        const result = await fsProvider.readFile(joinWorktreeRelativePath(repo.path, '.orca.yaml'))
        if (result.isBinary) {
          return { hasHooks: false, hooks: null, mayNeedUpdate: false }
        }
        const { parse } = await import('yaml')
        const parsed = parse(result.content)
        return { hasHooks: true, hooks: parsed, mayNeedUpdate: false }
      } catch {
        return { hasHooks: false, hooks: null, mayNeedUpdate: false }
      }
    }

    const has = hasHooksFile(repo.path)
    const hooks = has ? loadHooks(repo.path) : null
    return {
      hasHooks: has,
      hooks,
      mayNeedUpdate: has && !hooks && hasUnrecognizedOrcaYamlKeys(repo.path)
    }
  }

  async readRepoIssueCommand(repoSelector: string) {
    const repo = await this.resolveRepoSelector(repoSelector)
    if (isFolderRepo(repo)) {
      return {
        localContent: null,
        sharedContent: null,
        effectiveContent: null,
        localFilePath: '',
        source: 'none' as const
      }
    }

    if (repo.connectionId) {
      const issueCommandPath = joinWorktreeRelativePath(repo.path, '.orca/issue-command')
      const fsProvider = getSshFilesystemProvider(repo.connectionId)
      if (!fsProvider) {
        return {
          localContent: null,
          sharedContent: null,
          effectiveContent: null,
          localFilePath: issueCommandPath,
          source: 'none' as const
        }
      }
      const localContent = await this.readRemoteIssueCommandOverride(fsProvider, issueCommandPath)
      const sharedContent = await this.readRemoteSharedIssueCommand(fsProvider, repo.path)
      const effectiveContent = localContent ?? sharedContent
      return {
        localContent,
        sharedContent,
        effectiveContent,
        localFilePath: issueCommandPath,
        source: localContent
          ? ('local' as const)
          : sharedContent
            ? ('shared' as const)
            : ('none' as const)
      }
    }

    return readIssueCommand(repo.path)
  }

  private async readRemoteIssueCommandOverride(
    fsProvider: IFilesystemProvider,
    issueCommandPath: string
  ): Promise<string | null> {
    try {
      const result = await fsProvider.readFile(issueCommandPath)
      if (result.isBinary) {
        return null
      }
      return result.content.trim() || null
    } catch {
      return null
    }
  }

  private async readRemoteSharedIssueCommand(
    fsProvider: IFilesystemProvider,
    repoPath: string
  ): Promise<string | null> {
    try {
      const result = await fsProvider.readFile(joinWorktreeRelativePath(repoPath, 'orca.yaml'))
      if (result.isBinary) {
        return null
      }
      return parseOrcaYaml(result.content)?.issueCommand?.trim() || null
    } catch {
      return null
    }
  }

  async writeRepoIssueCommand(repoSelector: string, content: string): Promise<{ ok: true }> {
    const repo = await this.resolveRepoSelector(repoSelector)
    if (isFolderRepo(repo)) {
      return { ok: true }
    }

    if (repo.connectionId) {
      const issueCommandPath = joinWorktreeRelativePath(repo.path, '.orca/issue-command')
      const fsProvider = getSshFilesystemProvider(repo.connectionId)
      if (!fsProvider) {
        return { ok: true }
      }
      const trimmed = content.trim()
      if (!trimmed) {
        await fsProvider.deletePath(issueCommandPath, false).catch((error: unknown) => {
          if (!isENOENT(error)) {
            throw error
          }
        })
        return { ok: true }
      }
      await fsProvider.createDir(joinWorktreeRelativePath(repo.path, '.orca'))
      await this.ensureRemoteOrcaDirIgnored(fsProvider, repo.path)
      await fsProvider.writeFile(issueCommandPath, `${trimmed}\n`)
      return { ok: true }
    }

    writeIssueCommand(repo.path, content)
    return { ok: true }
  }

  private async ensureRemoteOrcaDirIgnored(
    fsProvider: IFilesystemProvider,
    repoPath: string
  ): Promise<void> {
    const gitignorePath = joinWorktreeRelativePath(repoPath, '.gitignore')
    try {
      const result = await fsProvider.readFile(gitignorePath)
      if (result.isBinary || /^\.orca\/?$/m.test(result.content)) {
        return
      }
      const separator = result.content.endsWith('\n') ? '' : '\n'
      await fsProvider.writeFile(gitignorePath, `${result.content}${separator}.orca\n`)
    } catch {
      try {
        await fsProvider.writeFile(gitignorePath, '.orca\n')
      } catch (error) {
        console.warn('[runtime] Could not update remote .gitignore to exclude .orca', error)
      }
    }
  }

  async listManagedWorktrees(
    repoSelector?: string,
    limit = DEFAULT_WORKTREE_LIST_LIMIT
  ): Promise<RuntimeWorktreeListResult> {
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error('invalid_limit')
    }
    const resolved = await this.listResolvedWorktrees()
    const repoId = repoSelector ? (await this.resolveRepoSelector(repoSelector)).id : null
    const worktrees = resolved.filter((worktree) => !repoId || worktree.repoId === repoId)
    return {
      worktrees: worktrees.slice(0, limit),
      totalCount: worktrees.length,
      truncated: worktrees.length > limit
    }
  }

  async showManagedWorktree(worktreeSelector: string) {
    return await this.resolveWorktreeSelector(worktreeSelector)
  }

  async sleepManagedWorktree(worktreeSelector: string): Promise<{ worktreeId: string }> {
    const worktree = await this.resolveWorktreeSelector(worktreeSelector)
    // Why: sleep is renderer-initiated on desktop (it tears down tab state
    // before killing PTYs). The notifier tells the renderer to run its own
    // sleep flow so all cleanup happens in the correct order.
    this.notifier?.sleepWorktree(worktree.id)
    return { worktreeId: worktree.id }
  }

  async activateManagedWorktree(worktreeSelector: string): Promise<{
    repoId: string
    worktreeId: string
    activated: boolean
  }> {
    this.assertGraphReady()
    const worktree = await this.resolveWorktreeSelector(worktreeSelector)
    const repo = this.store?.getRepo(worktree.repoId)
    if (!repo) {
      throw new Error('repo_not_found')
    }

    // Why: inactive worktree terminal panes are renderer-owned and may not have
    // live PTYs until the desktop activates the worktree and mounts them.
    this.notifier?.activateWorktree(repo.id, worktree.id)
    return { repoId: repo.id, worktreeId: worktree.id, activated: true }
  }

  async createManagedWorktree(args: {
    repoSelector: string
    name: string
    baseBranch?: string
    linkedIssue?: number | null
    linkedPR?: number | null
    linkedLinearIssue?: string
    comment?: string
    displayName?: string
    sparseCheckout?: { directories: string[]; presetId?: string }
    pushTarget?: GitPushTarget
    runHooks?: boolean
    activate?: boolean
    setupDecision?: 'run' | 'skip' | 'inherit'
    createdWithAgent?: TuiAgent
    startup?: WorktreeStartupLaunch
    lineage?: WorktreeLineageInput
  }): Promise<CreateWorktreeResult> {
    if (!this.store) {
      throw new Error('runtime_unavailable')
    }

    const repo = await this.resolveRepoSelector(args.repoSelector)
    if (isFolderRepo(repo)) {
      throw new Error('Folder mode does not support creating worktrees.')
    }
    if (repo.connectionId) {
      // Why: SSH-backed worktree creation still relies on the desktop SSH
      // flow, which can prime relay roots and enforce its remote constraints.
      // Runtime RPC must not fall through to local git against server paths.
      throw new Error('SSH-backed worktree creation is not supported through runtime RPC yet.')
    }
    const lineageInput =
      args.lineage || args.comment ? { ...args.lineage, comment: args.comment } : undefined
    const lineageResolution = await this.resolveLineageForWorktreeCreate(lineageInput)
    const settings = this.store.getSettings()
    const requestedName = args.name
    const requestedDisplayName = args.displayName?.trim() || undefined
    const sanitizedName = sanitizeWorktreeName(args.name)
    const username = getGitUsername(repo.path)
    const branchName = computeBranchName(sanitizedName, settings, username)

    const branchConflictKind = await getBranchConflictKind(repo.path, branchName)
    if (branchConflictKind) {
      throw new Error(
        `Branch "${branchName}" already exists ${branchConflictKind === 'local' ? 'locally' : 'on a remote'}.`
      )
    }

    let existingPR: Awaited<ReturnType<typeof getPRForBranch>> | null = null
    try {
      existingPR = await getPRForBranch(repo.path, branchName)
    } catch {
      // Why: worktree creation should not hard-fail on transient GitHub reachability
      // issues because git state is still the source of truth for whether the
      // worktree can be created locally.
    }
    if (existingPR) {
      throw new Error(`Branch "${branchName}" already has PR #${existingPR.number}.`)
    }

    let worktreePath = computeWorktreePath(sanitizedName, repo.path, settings)
    // Why: CLI-managed WSL worktrees live under ~/orca/workspaces inside the
    // distro filesystem. If home lookup fails, still validate against the
    // configured workspace dir so the traversal guard is never bypassed.
    const wslInfo = isWslPath(repo.path) ? parseWslPath(repo.path) : null
    const wslHome = wslInfo ? getWslHome(wslInfo.distro) : null
    const workspaceRoot = wslHome ? join(wslHome, 'orca', 'workspaces') : settings.workspaceDir
    worktreePath = ensurePathWithinWorkspace(worktreePath, workspaceRoot)
    const baseBranch = args.baseBranch || repo.worktreeBaseRef || getDefaultBaseRef(repo.path)
    if (!baseBranch) {
      // Why: getDefaultBaseRef returns null when no suitable ref exists.
      // Don't fabricate 'origin/main' — passing it to addWorktree would
      // produce an opaque git failure. Surface a clear error so the CLI
      // caller can pick an explicit --base ref.
      throw new Error(
        'Could not resolve a default base ref for this repo. Pass an explicit --base and try again.'
      )
    }

    const remote = baseBranch.includes('/') ? baseBranch.split('/')[0] : 'origin'
    // Why (§3.3 Lifecycle): route through the shared fetch cache so back-to-back
    // CLI creates on the same repo don't each pay the round-trip, and so a
    // subsequent dispatch probe within the 30s window reuses this result. The
    // helper swallows rejection (log-and-proceed) so a DNS hiccup never wedges
    // future creates and CLI creation stays usable offline — same intent as
    // the previous try/catch around gitExecFileSync.
    try {
      await this.fetchRemoteWithCache(repo.path, remote)
    } catch {
      // Why: belt-and-suspenders. fetchRemoteWithCache already logs and does
      // not throw; the outer try/catch guarantees create-path tolerance even
      // if future refactors change that contract.
    }

    const sparseDirectories = args.sparseCheckout
      ? normalizeSparseDirectories(args.sparseCheckout.directories)
      : []
    if (args.sparseCheckout && sparseDirectories.length === 0) {
      throw new Error('Sparse checkout requires at least one repo-relative directory.')
    }

    let preparedPushTarget: GitPushTarget | undefined
    if (args.pushTarget) {
      // Why: fork-PR worktrees created through a remote runtime need the same
      // upstream target setup as local desktop creates, or Push would publish
      // to the wrong remote after the client/server split.
      preparedPushTarget = await prepareWorktreePushTarget(repo.path, args.pushTarget)
    }

    await (sparseDirectories.length > 0
      ? addSparseWorktree(
          repo.path,
          worktreePath,
          branchName,
          sparseDirectories,
          baseBranch,
          settings.refreshLocalBaseRefOnWorktreeCreate
        )
      : addWorktree(
          repo.path,
          worktreePath,
          branchName,
          baseBranch,
          settings.refreshLocalBaseRefOnWorktreeCreate
        ))

    let configuredPushTarget: GitPushTarget | undefined
    if (preparedPushTarget) {
      configuredPushTarget = await configureCreatedWorktreePushTarget(
        worktreePath,
        branchName,
        preparedPushTarget
      )
    }

    const gitWorktrees = await listWorktrees(repo.path)
    const created = gitWorktrees.find((gw) => areWorktreePathsEqual(gw.path, worktreePath))
    if (!created) {
      throw new Error('Worktree created but not found in listing')
    }

    const worktreeId = `${repo.id}::${created.path}`
    const now = Date.now()
    const displayNameMeta = requestedDisplayName
      ? { displayName: requestedDisplayName }
      : shouldSetDisplayName(requestedName, branchName, sanitizedName)
        ? { displayName: requestedName }
        : {}
    const meta = this.store.setWorktreeMeta(worktreeId, {
      // Why: worktree IDs are path-derived. If a path is deleted outside Orca
      // and later recreated, creation must mint a fresh instance identity so
      // stale lineage records tied to the old occupant fail validation.
      instanceId: randomUUID(),
      lastActivityAt: now,
      // See createRemoteWorktree: createdAt grants the new worktree a grace
      // window in Recent sort so ambient PTY bumps in OTHER worktrees can't
      // push it down before the user has had a chance to notice it. Smart-sort
      // uses max(lastActivityAt, createdAt + CREATE_GRACE_MS).
      createdAt: now,
      ...displayNameMeta,
      baseRef: baseBranch,
      ...(configuredPushTarget ? { pushTarget: configuredPushTarget } : {}),
      ...(sparseDirectories.length > 0
        ? {
            sparseDirectories,
            sparseBaseRef: baseBranch,
            sparsePresetId: args.sparseCheckout?.presetId
          }
        : {}),
      ...(args.linkedIssue !== undefined ? { linkedIssue: args.linkedIssue } : {}),
      ...(args.linkedPR !== undefined ? { linkedPR: args.linkedPR } : {}),
      ...(args.linkedLinearIssue !== undefined
        ? { linkedLinearIssue: args.linkedLinearIssue }
        : {}),
      ...(args.createdWithAgent ? { createdWithAgent: args.createdWithAgent } : {}),
      ...(args.comment !== undefined ? { comment: args.comment } : {})
    })
    const worktree = mergeWorktree(repo.id, created, meta)
    let lineage: WorktreeLineage | null = null
    const lineageWarnings = lineageResolution.kind === 'none' ? [...lineageResolution.warnings] : []
    if (lineageResolution.kind === 'lineage') {
      const childInstanceId = meta.instanceId
      const parentInstanceId = lineageResolution.parent.instanceId
      if (childInstanceId && parentInstanceId && this.store.setWorktreeLineage) {
        lineage = this.store.setWorktreeLineage(worktreeId, {
          worktreeId,
          worktreeInstanceId: childInstanceId,
          parentWorktreeId: lineageResolution.parent.id,
          parentWorktreeInstanceId: parentInstanceId,
          origin: lineageResolution.origin,
          capture: lineageResolution.capture,
          ...(lineageResolution.orchestrationRunId
            ? { orchestrationRunId: lineageResolution.orchestrationRunId }
            : {}),
          ...(lineageResolution.taskId ? { taskId: lineageResolution.taskId } : {}),
          ...(lineageResolution.coordinatorHandle
            ? { coordinatorHandle: lineageResolution.coordinatorHandle }
            : {}),
          ...(lineageResolution.createdByTerminalHandle
            ? { createdByTerminalHandle: lineageResolution.createdByTerminalHandle }
            : {}),
          createdAt: now
        })
      } else {
        lineageWarnings.push({
          code: 'LINEAGE_PARENT_CONTEXT_MISSING',
          message:
            'Worktree created, but Orca could not record lineage because instance identity was unavailable.',
          details: {
            childHasInstanceId: Boolean(childInstanceId),
            parentHasInstanceId: Boolean(parentInstanceId),
            storeSupportsLineage: Boolean(this.store.setWorktreeLineage)
          }
        })
      }
    }

    if (
      settings.experimentalWorktreeSymlinks &&
      repo.symlinkPaths &&
      repo.symlinkPaths.length > 0
    ) {
      await createWorktreeSymlinks(repo.path, created.path, repo.symlinkPaths)
    }

    let setup: CreateWorktreeResult['setup']
    let warning: string | undefined
    // Why: CLI-created worktrees do not have a renderer preview to mismatch
    // against. Trust is granted by the direct CLI invocation (`--run-hooks`),
    // so loading the setup hook from the created worktree is intentional here.
    const hooks = getEffectiveHooks(repo, worktreePath)
    // Why: setupDecision lets mobile/CLI callers control whether the setup
    // script runs. 'skip' suppresses it, 'run' forces it, 'inherit' (default)
    // defers to the repo's orca.yaml setupRunPolicy. runHooks === true maps
    // to 'run' for backwards compatibility with the desktop create flow.
    const effectiveDecision = args.runHooks ? 'run' : (args.setupDecision ?? 'inherit')
    const shouldRunSetup = hooks?.scripts.setup && shouldRunSetupForCreate(repo, effectiveDecision)
    if (shouldRunSetup && hooks?.scripts.setup) {
      if (this.authoritativeWindowId !== null) {
        try {
          // Why: CLI-created worktrees must use the same runner-script path as the
          // renderer create flow so repo-committed `orca.yaml` setup hooks run in
          // the visible first terminal instead of a hidden background shell with
          // different failure and prompt behavior.
          setup = createSetupRunnerScript(repo, worktreePath, hooks.scripts.setup)
        } catch (error) {
          // Why: the git worktree is already real at this point. If runner
          // generation fails, keep creation successful and surface the problem in
          // logs rather than pretending the worktree was never created.
          console.error(`[hooks] Failed to prepare setup runner for ${worktreePath}:`, error)
        }
      } else {
        void runHook('setup', worktreePath, repo, worktreePath).then((result) => {
          if (!result.success) {
            console.error(`[hooks] setup hook failed for ${worktreePath}:`, result.output)
          }
        })
      }
    } else if (hooks?.scripts.setup) {
      // Runtime RPC calls have no renderer trust prompt, so hooks require explicit CLI opt-in.
      warning = `orca.yaml setup hook skipped for ${worktreePath}; pass --run-hooks to run it.`
      console.warn(`[hooks] ${warning}`)
    }

    this.invalidateResolvedWorktreeCache()
    // Why: the filesystem-auth layer maintains a separate cache of registered
    // worktree roots used by git IPC handlers (branchCompare, diff, status, etc.)
    // to authorize paths. Without invalidating it here, CLI-created worktrees
    // are not recognized and all git operations fail with "Access denied:
    // unknown repository or worktree path".
    invalidateAuthorizedRootsCache()

    this.notifier?.worktreesChanged(repo.id)
    const shouldActivate = args.activate === true || args.runHooks === true
    let didSpawnStartup = false
    let didSpawnSetup = false
    if (args.startup && this.ptyController?.spawn) {
      try {
        // Why: automation startup must not depend on a renderer TerminalPane
        // mounting. Runtime-spawned PTYs run immediately and the UI adopts the
        // session later, matching `orca terminal create` background semantics.
        await this.createTerminal(`path:${worktree.path}`, {
          command: args.startup.command,
          env: args.startup.env
        })
        didSpawnStartup = true
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        warning = warning
          ? `${warning} Also failed to create the startup terminal for ${worktreePath}: ${message}`
          : `Failed to create the startup terminal for ${worktreePath}: ${message}`
        console.warn(`[worktree-create] ${warning}`)
      }
    }
    if (didSpawnStartup && setup && this.ptyController?.spawn) {
      try {
        // Why: reveal-on-adopt can create the startup tab before renderer
        // activation handles setup. Spawn setup in runtime too so startup+setup
        // cannot be skipped by the renderer's "terminal already exists" guard.
        await this.createTerminal(`path:${worktree.path}`, {
          title: 'Setup',
          command: buildSetupRunnerCommand(
            setup.runnerScriptPath,
            process.platform === 'win32' ? 'windows' : 'posix'
          ),
          env: setup.envVars
        })
        didSpawnSetup = true
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        warning = warning
          ? `${warning} Also failed to create the setup terminal for ${worktreePath}: ${message}`
          : `Failed to create the setup terminal for ${worktreePath}: ${message}`
        console.warn(`[worktree-create] ${warning}`)
      }
    }
    if (shouldActivate) {
      // Why: plain CLI creates should not steal the user's current workspace.
      // Explicit activation and hook-running still use renderer activation so
      // the user can watch prompts/output in a visible pane.
      const activationSetup = didSpawnSetup ? undefined : setup
      if (args.startup && !didSpawnStartup) {
        this.notifier?.activateWorktree(repo.id, worktree.id, activationSetup, args.startup)
      } else {
        this.notifier?.activateWorktree(repo.id, worktree.id, activationSetup)
      }
    } else if (this.ptyController?.spawn) {
      try {
        if (!didSpawnStartup) {
          await this.createTerminal(`path:${worktree.path}`)
        }
        if (setup && !didSpawnSetup) {
          await this.createTerminal(`path:${worktree.path}`, {
            title: 'Setup',
            command: buildSetupRunnerCommand(
              setup.runnerScriptPath,
              process.platform === 'win32' ? 'windows' : 'posix'
            ),
            env: setup.envVars
          })
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        warning = warning
          ? `${warning} Also failed to create the initial terminal for ${worktreePath}: ${message}`
          : `Failed to create the initial terminal for ${worktreePath}: ${message}`
        console.warn(`[worktree-create] ${warning}`)
      }
    }
    return {
      worktree: {
        ...worktree,
        parentWorktreeId: lineage?.parentWorktreeId ?? null,
        childWorktreeIds: [],
        lineage,
        git: created
      },
      ...(lineageInput ? { lineage, warnings: lineageWarnings } : {}),
      ...(setup ? { setup } : {}),
      ...(warning ? { warning } : {})
    }
  }

  /**
   * Fetch `remote` in `repoPath`, sharing the 30s freshness window + in-flight
   * serialization with all other callers (renderer-create path, CLI create,
   * dispatch drift probe). Never rejects — callers log-and-proceed on offline
   * failures (§3.3 Lifecycle).
   *
   * Why a shared cache on the runtime instead of module-scoped: §7.1 relies on
   * one cache for BOTH the renderer create path and `probeWorktreeDrift`. A
   * dispatch tick that reuses a just-completed create-path fetch is the
   * primary telemetry target; splitting the cache by call-site would double
   * the fetch load on warm repos.
   */
  async getCanonicalFetchKey(repoPath: string, remote: string): Promise<string> {
    const cacheKey = `${repoPath}::${remote}`
    const cached = this.canonicalFetchKeyCache.get(cacheKey)
    if (cached !== undefined) {
      return cached
    }
    let resolved = cacheKey
    try {
      const { stdout } = await gitExecFileAsync(
        ['rev-parse', '--path-format=absolute', '--git-common-dir'],
        { cwd: repoPath }
      )
      const commonDir = stdout.trim()
      if (commonDir) {
        resolved = `${commonDir}::${remote}`
      }
    } catch {
      // Fall through to the caller-provided path. The fetch still runs from
      // repoPath; this key only controls cache sharing.
    }
    this.canonicalFetchKeyCache.set(cacheKey, resolved)
    return resolved
  }

  async isRemoteFetchFresh(repoPath: string, remote: string): Promise<boolean> {
    const key = await this.getCanonicalFetchKey(repoPath, remote)
    const lastAt = this.fetchLastCompletedAt.get(key)
    return lastAt !== undefined && Date.now() - lastAt < FETCH_FRESHNESS_MS
  }

  async getOrStartRemoteFetch(repoPath: string, remote: string): Promise<RemoteFetchResult> {
    const key = await this.getCanonicalFetchKey(repoPath, remote)
    const lastAt = this.fetchLastCompletedAt.get(key)
    if (lastAt !== undefined && Date.now() - lastAt < FETCH_FRESHNESS_MS) {
      // Why: freshness window hit — skip the fetch entirely. Do NOT reuse any
      // in-flight promise here; the timestamp is only written on success, so
      // hitting this branch means a previous fetch did succeed recently.
      return { ok: true }
    }

    const existing = this.fetchInflight.get(key)
    if (existing) {
      // Why: genuine serialization (not check-then-set). Two callers racing
      // on the same repo+remote share the single underlying `git fetch`.
      return existing
    }

    const promise = gitExecFileAsync(['fetch', remote], { cwd: repoPath })
      .then((): RemoteFetchResult => {
        // Why (§3.3 Lifecycle): timestamp on success ONLY. Writing on rejection
        // would make the freshness cache lie about the last known remote state.
        this.fetchLastCompletedAt.set(key, Date.now())
        return { ok: true }
      })
      .catch((err): RemoteFetchResult => {
        // Why: swallow here so awaiters don't throw at the await site. Outer
        // create/dispatch paths are already tolerant of offline fetch failure;
        // this is the behavioral contract of this helper.
        console.warn(`[fetchRemoteWithCache] ${remote} fetch failed for ${repoPath}:`, err)
        return { ok: false, errorKind: 'git_error' }
      })
      .finally(() => {
        // Why (§3.3 Lifecycle): evict on BOTH success and rejection. A
        // rejected entry that survived in the Map would wedge every future
        // create on this repo until Orca restarted (the F2 bug §3.3 pins).
        this.fetchInflight.delete(key)
      })

    this.fetchInflight.set(key, promise)
    return promise
  }

  async fetchRemoteWithCache(repoPath: string, remote: string): Promise<void> {
    await this.getOrStartRemoteFetch(repoPath, remote)
  }

  async resolveRemoteTrackingBase(
    repoPath: string,
    baseBranch: string
  ): Promise<RemoteTrackingBase | null> {
    let remotes: string[]
    try {
      const { stdout } = await gitExecFileAsync(['remote'], { cwd: repoPath })
      remotes = stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
    } catch {
      return null
    }

    const remote = remotes
      .filter((candidate) => baseBranch.startsWith(`${candidate}/`))
      .sort((a, b) => b.length - a.length)[0]
    if (!remote) {
      return null
    }
    const branch = baseBranch.slice(remote.length + 1)
    if (!branch) {
      return null
    }
    return {
      remote,
      branch,
      ref: `refs/remotes/${remote}/${branch}`,
      base: baseBranch
    }
  }

  async hasRemoteTrackingRef(repoPath: string, base: RemoteTrackingBase): Promise<boolean> {
    try {
      await gitExecFileAsync(['rev-parse', '--verify', `${base.ref}^{commit}`], { cwd: repoPath })
      return true
    } catch {
      return false
    }
  }

  recordOptimisticReconcileToken(worktreeId: string): string {
    const token = randomUUID()
    this.optimisticReconcileTokens.set(worktreeId, token)
    return token
  }

  clearOptimisticReconcileToken(worktreeId: string): void {
    this.optimisticReconcileTokens.delete(worktreeId)
  }

  emitWorktreeBaseStatus(event: WorktreeBaseStatusEvent): void {
    this.notifier?.worktreeBaseStatus?.(event)
  }

  async reconcileWorktreeBaseStatus(args: {
    repoId: string
    repoPath: string
    worktreeId: string
    base: RemoteTrackingBase
    branchName: string
    createdBaseSha: string
    token: string
    fetchPromise: Promise<RemoteFetchResult>
  }): Promise<void> {
    const stillCurrent = (): boolean =>
      this.optimisticReconcileTokens.get(args.worktreeId) === args.token
    const emit = (event: Omit<WorktreeBaseStatusEvent, 'repoId' | 'worktreeId' | 'base'>): void => {
      if (!stillCurrent()) {
        return
      }
      this.notifier?.worktreeBaseStatus?.({
        repoId: args.repoId,
        worktreeId: args.worktreeId,
        base: args.base.base,
        remote: args.base.remote,
        ...event
      })
    }
    const resolvePublishRemote = async (): Promise<string> => {
      // Why: repos whose canonical publish remote is named differently (e.g.
      // `upstream`, a forked `myfork`, or any non-`origin` configuration —
      // including multi-segment names like `foo/bar` that this PR's resolver
      // explicitly supports) would otherwise silently skip the conflict
      // signal. Resolve from git config in priority order:
      //   1) branch.<name>.pushRemote (explicit per-branch override)
      //   2) remote.pushDefault (workspace-wide override)
      //   3) branch.<name>.remote (tracked remote)
      //   4) the base ref's own remote (matches resolveRemoteTrackingBase)
      //   5) `origin` as a final fallback.
      const tryConfig = async (key: string): Promise<string | null> => {
        try {
          const { stdout } = await gitExecFileAsync(['config', '--get', key], {
            cwd: args.repoPath
          })
          const value = stdout.trim()
          return value || null
        } catch {
          return null
        }
      }
      return (
        (await tryConfig(`branch.${args.branchName}.pushRemote`)) ??
        (await tryConfig('remote.pushDefault')) ??
        (await tryConfig(`branch.${args.branchName}.remote`)) ??
        args.base.remote ??
        'origin'
      )
    }
    const checkPublishRemoteConflict = async (): Promise<void> => {
      const publishRemote = await resolvePublishRemote()
      try {
        if (publishRemote !== args.base.remote) {
          const result = await this.getOrStartRemoteFetch(args.repoPath, publishRemote)
          if (!result.ok) {
            return
          }
        }
        await gitExecFileAsync(
          ['rev-parse', '--verify', `refs/remotes/${publishRemote}/${args.branchName}^{commit}`],
          { cwd: args.repoPath }
        )
        if (stillCurrent()) {
          this.notifier?.worktreeRemoteBranchConflict?.({
            repoId: args.repoId,
            worktreeId: args.worktreeId,
            remote: publishRemote,
            branchName: args.branchName
          })
        }
      } catch {
        // No publish-remote conflict is the common case; stay quiet.
      }
    }

    try {
      const fetchResult = await args.fetchPromise
      if (!stillCurrent()) {
        return
      }
      if (!fetchResult.ok) {
        emit({ status: 'unknown' })
        return
      }

      const { stdout } = await gitExecFileAsync(
        ['rev-parse', '--verify', `${args.base.ref}^{commit}`],
        { cwd: args.repoPath }
      )
      const postFetchSha = stdout.trim()
      if (postFetchSha === args.createdBaseSha) {
        emit({ status: 'current' })
        await checkPublishRemoteConflict()
        return
      }

      try {
        await gitExecFileAsync(['merge-base', '--is-ancestor', args.createdBaseSha, postFetchSha], {
          cwd: args.repoPath
        })
      } catch {
        emit({ status: 'base_changed' })
        await checkPublishRemoteConflict()
        return
      }

      const { stdout: countStdout } = await gitExecFileAsync(
        ['rev-list', '--count', `${args.createdBaseSha}..${postFetchSha}`],
        { cwd: args.repoPath }
      )
      const behind = Number(countStdout.trim())
      if (!Number.isFinite(behind) || behind <= 0) {
        emit({ status: 'current' })
        await checkPublishRemoteConflict()
        return
      }
      const { stdout: logStdout } = await gitExecFileAsync(
        ['log', '--format=%s', '-n', '5', `${args.createdBaseSha}..${postFetchSha}`],
        { cwd: args.repoPath }
      )
      emit({
        status: 'drift',
        behind,
        recentSubjects: logStdout.split('\n').filter((line) => line.trim().length > 0)
      })
      await checkPublishRemoteConflict()
    } catch (err) {
      console.warn(`[worktree-base-status] reconcile failed for ${args.worktreeId}:`, err)
      emit({ status: 'unknown' })
    } finally {
      // Why: reconcile is one-shot; clear the token so long-lived sessions
      // that create many worktrees without removing them don't grow the
      // optimisticReconcileTokens map monotonically. Removal still no-ops
      // because the entry is already gone.
      if (this.optimisticReconcileTokens.get(args.worktreeId) === args.token) {
        this.optimisticReconcileTokens.delete(args.worktreeId)
      }
    }
  }

  /**
   * Probe how far the worktree's HEAD is behind its tracking remote. Returns
   * null when the probe cannot establish a signal (no default base ref, or
   * git failure). Dispatch treats null as "unknown — proceed" (§3.1); only
   * knowing-and-stale refuses.
   */
  async probeWorktreeDrift(worktreeSelector: string): Promise<{
    base: string
    behind: number
    recentSubjects: string[]
  } | null> {
    const wt = await this.resolveWorktreeSelector(worktreeSelector)
    if (!this.store) {
      return null
    }
    const repo = this.store.getRepos().find((r) => r.id === wt.repoId)
    if (!repo) {
      return null
    }
    if (repo.connectionId) {
      // Why: the drift probe uses local git helpers. Until the SSH provider
      // exposes equivalent remote refs/log plumbing, fail closed to "unknown"
      // instead of probing a server path on the desktop filesystem.
      return null
    }
    const meta = this.store.getWorktreeMeta(wt.id)
    const base =
      meta?.baseRef || meta?.sparseBaseRef || repo.worktreeBaseRef || getDefaultBaseRef(repo.path)
    if (!base) {
      // Why: brand-new repo with no remote primary — nothing to compare
      // against, so there's no meaningful drift to report. Dispatch should
      // not block on a probe that cannot form an opinion.
      return null
    }
    const remoteTrackingBase = await this.resolveRemoteTrackingBase(repo.path, base)
    if (!remoteTrackingBase) {
      return null
    }
    const remote = remoteTrackingBase.remote
    // Why: fetch failures are non-fatal; we proceed with whatever the
    // last-known remote ref points at. `fetchRemoteWithCache` never throws.
    await this.fetchRemoteWithCache(repo.path, remote)
    const drift = getRemoteDrift(wt.path, 'HEAD', base)
    if (!drift) {
      return null
    }
    const recentSubjects = getRecentDriftSubjects(wt.path, 'HEAD', base, DRIFT_PROBE_SUBJECT_LIMIT)
    return { base, behind: drift.behind, recentSubjects }
  }

  async updateManagedWorktreeMeta(
    worktreeSelector: string,
    updates: Partial<WorktreeMeta> & {
      lineage?: {
        parentWorktree?: string
        noParent?: boolean
      }
    }
  ) {
    if (!this.store) {
      throw new Error('runtime_unavailable')
    }
    const worktree = await this.resolveWorktreeSelector(worktreeSelector)
    const { lineage, ...metaUpdates } = updates
    if (lineage?.noParent === true) {
      this.store.removeWorktreeLineage?.(worktree.id)
    } else if (lineage?.parentWorktree) {
      const parent = await this.resolveWorktreeSelector(lineage.parentWorktree)
      this.validateLineageParent(worktree, parent)
      if (!worktree.instanceId || !parent.instanceId) {
        throw new RuntimeLineageError(
          'LINEAGE_PARENT_CONTEXT_MISSING',
          'Workspace instance identity was unavailable.'
        )
      }
      if (!this.store.setWorktreeLineage) {
        throw new RuntimeLineageError(
          'LINEAGE_PARENT_CONTEXT_MISSING',
          'Workspace lineage storage was unavailable.'
        )
      }
      this.store.setWorktreeLineage(worktree.id, {
        worktreeId: worktree.id,
        worktreeInstanceId: worktree.instanceId,
        parentWorktreeId: parent.id,
        parentWorktreeInstanceId: parent.instanceId,
        origin: 'manual',
        capture: { source: 'manual-action', confidence: 'explicit' },
        createdAt: Date.now()
      })
    }
    this.store.setWorktreeMeta(worktree.id, omitUndefinedProperties(metaUpdates))
    // Why: unlike renderer-initiated optimistic updates, CLI callers need an
    // explicit push so the editor refreshes metadata changed outside the UI.
    this.invalidateResolvedWorktreeCache()
    this.notifier?.worktreesChanged(worktree.repoId)
    return await this.showManagedWorktree(`id:${worktree.id}`)
  }

  persistManagedWorktreeSortOrder(orderedIds: string[]): { updated: number } {
    if (!this.store) {
      throw new Error('runtime_unavailable')
    }
    const now = Date.now()
    let updated = 0
    for (let i = 0; i < orderedIds.length; i++) {
      this.store.setWorktreeMeta(orderedIds[i], { sortOrder: now - i * 1000 })
      updated++
    }
    this.invalidateResolvedWorktreeCache()
    this.notifier?.reposChanged()
    return { updated }
  }

  async resolveManagedPrBase(args: {
    repoId: string
    prNumber: number
    headRefName?: string
    isCrossRepository?: boolean
  }): Promise<{ baseBranch: string; pushTarget?: GitPushTarget } | { error: string }> {
    if (!this.store) {
      throw new Error('runtime_unavailable')
    }
    const repo = this.store.getRepo(args.repoId)
    if (!repo) {
      return { error: 'Repo not found' }
    }
    if (repo.connectionId) {
      return { error: 'PR start points are not supported for remote repos yet.' }
    }
    if (isFolderRepo(repo)) {
      return { error: 'Folder mode does not support creating worktrees.' }
    }

    let headRefName = args.headRefName?.trim() ?? ''
    let isCrossRepository = args.isCrossRepository === true
    let pushTarget: GitPushTarget | undefined

    if (!headRefName) {
      const item = await getWorkItem(repo.path, args.prNumber, 'pr')
      if (!item || item.type !== 'pr') {
        return { error: `PR #${args.prNumber} not found.` }
      }
      headRefName = (item.branchName ?? '').trim()
      if (!headRefName) {
        return { error: `PR #${args.prNumber} has no head branch.` }
      }
      if (item.isCrossRepository === true) {
        isCrossRepository = true
      }
    }

    if (isCrossRepository) {
      try {
        pushTarget = (await getPullRequestPushTarget(repo.path, args.prNumber)) ?? undefined
      } catch (error) {
        return {
          error:
            error instanceof Error
              ? error.message
              : `Could not resolve PR #${args.prNumber} head push target.`
        }
      }
      if (!pushTarget) {
        return { error: `Could not resolve PR #${args.prNumber} head push target.` }
      }
    }

    let remote: string
    try {
      remote = await getDefaultRemote(repo.path)
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Could not resolve git remote.' }
    }

    if (isCrossRepository) {
      const pullRef = `refs/pull/${args.prNumber}/head`
      try {
        await gitExecFileAsync(['fetch', remote, pullRef], { cwd: repo.path })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { error: `Failed to fetch ${pullRef}: ${message.split('\n')[0]}` }
      }
      try {
        const { stdout } = await gitExecFileAsync(['rev-parse', '--verify', 'FETCH_HEAD'], {
          cwd: repo.path
        })
        const sha = stdout.trim()
        if (!sha) {
          return { error: `Empty SHA resolving fork PR #${args.prNumber} head.` }
        }
        return { baseBranch: sha, ...(pushTarget ? { pushTarget } : {}) }
      } catch {
        return { error: `Could not resolve fork PR #${args.prNumber} head after fetch.` }
      }
    }

    try {
      await gitExecFileAsync(
        ['fetch', remote, `+refs/heads/${headRefName}:refs/remotes/${remote}/${headRefName}`],
        { cwd: repo.path }
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { error: `Failed to fetch ${remote}/${headRefName}: ${message.split('\n')[0]}` }
    }

    const remoteRef = `${remote}/${headRefName}`
    try {
      await gitExecFileAsync(['rev-parse', '--verify', remoteRef], { cwd: repo.path })
    } catch {
      return { error: `Remote ref ${remoteRef} does not exist after fetch.` }
    }

    return {
      baseBranch: remoteRef,
      pushTarget: pushTarget ?? { remoteName: remote, branchName: headRefName }
    }
  }

  async removeManagedWorktree(
    worktreeSelector: string,
    force = false,
    runHooks = false
  ): Promise<{ warning?: string }> {
    if (!this.store) {
      throw new Error('runtime_unavailable')
    }
    const worktree = await this.resolveWorktreeSelector(worktreeSelector)
    const repo = this.store.getRepo(worktree.repoId)
    if (!repo) {
      throw new Error('repo_not_found')
    }
    if (isFolderRepo(repo)) {
      throw new Error('Folder mode does not support deleting worktrees.')
    }
    if (repo.connectionId) {
      const provider = getSshGitProvider(repo.connectionId)
      if (!provider) {
        throw new Error(`No git provider for connection "${repo.connectionId}"`)
      }
      await provider.removeWorktree(worktree.path, force)
      this.clearOptimisticReconcileToken(worktree.id)
      this.store.removeWorktreeMeta(worktree.id)
      this.invalidateResolvedWorktreeCache()
      invalidateAuthorizedRootsCache()
      this.notifier?.worktreesChanged(repo.id)
      return {}
    }

    // Why: kill every PTY belonging to this worktree BEFORE the git-level
    // removal. Some shells keep the worktree directory busy, and `git worktree
    // remove` throws a confusing error if PTYs still hold it open. This also
    // closes the headless-CLI leak (design §2a/§2b): without this call, the
    // CLI path runs git removal and never touches PTYs, leaving zombies
    // behind. Best-effort: any failure here must not prevent git removal —
    // the worst case without the call is the status quo.
    const localProvider = this.getLocalProvider()
    if (localProvider) {
      await killAllProcessesForWorktree(worktree.id, {
        runtime: this,
        localProvider
      })
        .then((r) => {
          const total = r.runtimeStopped + r.providerStopped + r.registryStopped
          if (total > 0) {
            // Why (design §4.4 observability): breadcrumb lets ops
            // distinguish a renderer-state-induced leak (diff-path purge
            // non-empty) from a backend-induced one (nothing to kill but
            // memory still pinned). Emit only when the sweep actually did
            // work so steady-state logs stay quiet.
            console.info(
              `[worktree-teardown] ${worktree.id} killed runtime=${r.runtimeStopped} provider=${r.providerStopped} registry=${r.registryStopped}`
            )
          }
        })
        .catch((err) => {
          console.warn(`[worktree-teardown] failed for ${worktree.id}:`, err)
        })
    }

    const hooks = getEffectiveHooks(repo)
    let warning: string | undefined
    if (hooks?.scripts.archive && runHooks) {
      const result = await runHook('archive', worktree.path, repo)
      if (!result.success) {
        console.error(`[hooks] archive hook failed for ${worktree.path}:`, result.output)
      }
    } else if (hooks?.scripts.archive) {
      // Runtime RPC calls have no renderer trust prompt, so hooks require explicit CLI opt-in.
      warning = `orca.yaml archive hook skipped for ${worktree.path}; pass --run-hooks to run it.`
      console.warn(`[hooks] ${warning}`)
    }

    try {
      await removeWorktree(repo.path, worktree.path, force)
    } catch (error) {
      if (isOrphanedWorktreeError(error)) {
        if (await canSafelyRemoveOrphanedWorktreeDirectory(worktree.path, repo.path)) {
          await rm(worktree.path, { recursive: true, force: true }).catch(() => {})
        } else {
          console.warn(
            `[worktrees] Refusing recursive cleanup for unproven worktree directory: ${worktree.path}`
          )
        }
        // Why: `git worktree remove` failed, so git's internal worktree tracking
        // (`.git/worktrees/<name>`) is still intact. Without pruning, `git worktree
        // list` continues to show the stale entry and the branch it had checked out
        // remains locked — other worktrees cannot check it out.
        await gitExecFileAsync(['worktree', 'prune'], { cwd: repo.path }).catch(() => {})
        this.clearOptimisticReconcileToken(worktree.id)
        this.store.removeWorktreeMeta(worktree.id)
        this.invalidateResolvedWorktreeCache()
        invalidateAuthorizedRootsCache()
        this.notifier?.worktreesChanged(repo.id)
        return {
          ...(warning ? { warning } : {})
        }
      }
      throw new Error(formatWorktreeRemovalError(error, worktree.path, force))
    }

    this.clearOptimisticReconcileToken(worktree.id)
    this.store.removeWorktreeMeta(worktree.id)
    this.invalidateResolvedWorktreeCache()
    invalidateAuthorizedRootsCache()
    this.notifier?.worktreesChanged(repo.id)
    return {
      ...(warning ? { warning } : {})
    }
  }

  async renameTerminal(handle: string, title: string | null): Promise<RuntimeTerminalRename> {
    this.assertGraphReady()
    const pty = this.getLivePtyForHandle(handle)
    if (pty) {
      pty.pty.title = title
      for (const leaf of this.leaves.values()) {
        if (leaf.ptyId === pty.pty.ptyId) {
          this.notifier?.renameTerminal(leaf.tabId, title)
          return { handle, tabId: leaf.tabId, title }
        }
      }
      return { handle, tabId: pty.record.tabId, title }
    }
    const { leaf } = this.getLiveLeafForHandle(handle)
    this.notifier?.renameTerminal(leaf.tabId, title)
    return { handle, tabId: leaf.tabId, title }
  }

  async createTerminal(
    worktreeSelector?: string,
    opts: {
      command?: string
      env?: Record<string, string>
      title?: string
      focus?: boolean
      tabId?: string
      leafId?: string
    } = {}
  ): Promise<RuntimeTerminalCreate> {
    if (opts.focus !== true) {
      if (!worktreeSelector) {
        throw new Error('MISSING_WORKTREE')
      }
      if (!this.ptyController?.spawn) {
        throw new Error('runtime_unavailable')
      }
      const worktree = await this.resolveWorktreeSelector(worktreeSelector)
      const repo = this.store?.getRepo(worktree.repoId)
      const preAllocatedHandle = this.createPreAllocatedTerminalHandle()
      // Why: mint tabId in main before spawn so paneKey is known at PTY env
      // build time. Hook-based agent status (Claude/Codex/Cursor/Gemini) keys
      // off `${tabId}:${leafId}` — without these vars set on the PTY, the
      // hook payload arrives with an empty paneKey and the renderer cannot
      // attribute the event. Use a stable UUID leaf because hooks reject the
      // legacy numeric pane keys after the pane-id migration.
      const hintedTabId = opts.tabId?.trim()
      const canAdoptPaneIdentity =
        hintedTabId !== undefined &&
        hintedTabId.length > 0 &&
        !hintedTabId.includes(':') &&
        opts.leafId !== undefined &&
        isTerminalLeafId(opts.leafId)
      const tabId = canAdoptPaneIdentity ? (hintedTabId as string) : randomUUID()
      const leafId = canAdoptPaneIdentity ? (opts.leafId as string) : randomUUID()
      const paneKey = makePaneKey(tabId, leafId)
      const env = {
        ...opts.env,
        ORCA_PANE_KEY: paneKey,
        ORCA_TAB_ID: tabId,
        ORCA_WORKTREE_ID: worktree.id
      }
      const result = await this.ptyController.spawn({
        cols: 120,
        rows: 40,
        cwd: worktree.path,
        command: opts.command,
        env,
        connectionId: repo?.connectionId ?? null,
        worktreeId: worktree.id,
        preAllocatedHandle
      })
      this.registerPreAllocatedHandleForPty(result.id, preAllocatedHandle)
      this.registerPty(result.id, worktree.id)
      const pty = this.getOrCreatePtyWorktreeRecord(result.id)
      if (pty) {
        pty.title = opts.title ?? null
        pty.tabId = tabId
        pty.paneKey = paneKey
      }
      const handle = pty ? this.issuePtyHandle(pty) : preAllocatedHandle
      let surface: RuntimeTerminalCreate['surface'] = 'background'
      if (this.notifier?.revealTerminalSession) {
        try {
          // Why: after the PTY is spawned, renderer tab adoption is best-effort;
          // failing here must not strand a live process without returning a handle.
          // Pass the pre-minted tabId so the renderer adopts under the same id
          // already baked into the PTY env — keeps paneKey hook attribution intact.
          await this.notifier.revealTerminalSession(worktree.id, {
            ptyId: result.id,
            title: opts.title ?? null,
            activate: false,
            tabId,
            leafId
          })
          surface = 'visible'
        } catch (err) {
          console.warn(`[terminal-create] failed to create inactive tab for ${result.id}:`, err)
        }
      }
      return { handle, worktreeId: worktree.id, title: opts.title ?? null, surface }
    }

    this.assertGraphReady()
    const win = this.getAuthoritativeWindow()
    // Why: mirrors browserTabCreate — when no worktree is specified, pass
    // undefined so the renderer uses its current active worktree.
    const worktreeId = worktreeSelector
      ? (await this.resolveWorktreeSelector(worktreeSelector)).id
      : undefined
    const requestId = randomUUID()

    // Why: terminal creation is a renderer-side Zustand store operation (like
    // browser tab creation). The main process sends a request, the renderer
    // creates the tab and replies with the tabId so we can resolve the handle.
    const reply = await new Promise<{ tabId: string; title: string }>((resolve, reject) => {
      const timer = setTimeout(() => {
        ipcMain.removeListener('terminal:tabCreateReply', handler)
        reject(new Error('Terminal creation timed out'))
      }, 10_000)

      const handler = (
        _event: Electron.IpcMainEvent,
        r: { requestId: string; tabId?: string; title?: string; error?: string }
      ): void => {
        if (r.requestId !== requestId) {
          return
        }
        clearTimeout(timer)
        ipcMain.removeListener('terminal:tabCreateReply', handler)
        if (r.error) {
          reject(new Error(r.error))
        } else {
          resolve({ tabId: r.tabId!, title: r.title ?? opts.title ?? '' })
        }
      }
      ipcMain.on('terminal:tabCreateReply', handler)
      win.webContents.send('terminal:requestTabCreate', {
        requestId,
        worktreeId,
        command: opts.command,
        title: opts.title
      })
    })

    // Why: the renderer created the tab immediately, but the graph sync that
    // populates this.leaves may not have arrived yet. Wait for the leaf to
    // appear so we can return a valid handle the caller can use right away.
    const handle = await this.waitForTerminalHandle(reply.tabId)
    return { handle, worktreeId: worktreeId ?? '', title: reply.title, surface: 'visible' }
  }

  async createMobileSessionTerminal(
    worktreeSelector: string,
    opts: { afterTabId?: string; activate?: boolean } = {}
  ): Promise<RuntimeMobileSessionCreateTerminalResult> {
    this.assertGraphReady()
    const worktreeId = (await this.resolveWorktreeSelector(worktreeSelector)).id
    let afterDesktopTabId: string | undefined
    if (opts.afterTabId) {
      const snapshot = this.mobileSessionTabsByWorktree.get(worktreeId)
      const anchor = snapshot?.tabs.find((tab) => tab.id === opts.afterTabId)
      if (!anchor) {
        throw new Error('after_tab_not_found')
      }
      afterDesktopTabId = anchor.type === 'terminal' ? anchor.parentTabId : anchor.id
    }

    const win = this.getAvailableAuthoritativeWindow()
    if (!win) {
      return await this.createHeadlessMobileSessionTerminal(
        worktreeId,
        opts.activate !== false,
        opts.afterTabId
      )
    }
    const requestId = randomUUID()
    const reply = await new Promise<{ tabId: string; title: string }>((resolve, reject) => {
      const timer = setTimeout(() => {
        ipcMain.removeListener('terminal:tabCreateReply', handler)
        reject(new Error('Terminal creation timed out'))
      }, 10_000)

      const handler = (
        _event: Electron.IpcMainEvent,
        r: { requestId: string; tabId?: string; title?: string; error?: string }
      ): void => {
        if (r.requestId !== requestId) {
          return
        }
        clearTimeout(timer)
        ipcMain.removeListener('terminal:tabCreateReply', handler)
        if (r.error) {
          reject(new Error(r.error))
        } else {
          resolve({ tabId: r.tabId!, title: r.title ?? '' })
        }
      }
      ipcMain.on('terminal:tabCreateReply', handler)
      win.webContents.send('terminal:requestTabCreate', {
        requestId,
        worktreeId,
        afterTabId: afterDesktopTabId
      })
    })

    if (opts.activate !== false) {
      this.notifier?.focusTerminal(reply.tabId, worktreeId, null)
    }
    return await this.waitForMobileTerminalSurface(worktreeId, reply.tabId)
  }

  private async createHeadlessMobileSessionTerminal(
    worktreeId: string,
    activate: boolean,
    afterTabId?: string
  ): Promise<RuntimeMobileSessionCreateTerminalResult> {
    const terminal = await this.createTerminal(`id:${worktreeId}`, { focus: false })
    const livePty = this.getLivePtyForHandle(terminal.handle)
    if (!livePty) {
      throw new Error('terminal_handle_stale')
    }
    const parentTabId = livePty.pty.tabId ?? `pty:${livePty.pty.ptyId}`
    const leafId = parsePaneKey(livePty.pty.paneKey ?? '')?.leafId ?? randomUUID()
    const tab: RuntimeMobileSessionTerminalTab = {
      type: 'terminal',
      id: `${parentTabId}::${leafId}`,
      parentTabId,
      leafId,
      title: terminal.title ?? livePty.pty.title ?? 'Terminal',
      isActive: activate
    }
    const existing = this.mobileSessionTabsByWorktree.get(worktreeId)
    const tabs = (existing?.tabs ?? [])
      .filter((candidate) => candidate.id !== tab.id)
      .map((candidate) => ({
        ...candidate,
        isActive: activate ? false : candidate.isActive
      }))
    const insertAfter = afterTabId ? tabs.findIndex((candidate) => candidate.id === afterTabId) : -1
    if (insertAfter >= 0) {
      tabs.splice(insertAfter + 1, 0, tab)
    } else {
      tabs.push(tab)
    }
    const next: RuntimeMobileSessionTabsSnapshot = {
      worktree: worktreeId,
      publicationEpoch: `headless:${Date.now().toString(36)}`,
      snapshotVersion: (existing?.snapshotVersion ?? 0) + 1,
      activeGroupId: existing?.activeGroupId ?? null,
      activeTabId: activate ? tab.id : (existing?.activeTabId ?? null),
      activeTabType: activate ? 'terminal' : (existing?.activeTabType ?? null),
      tabs
    }
    this.mobileSessionTabsByWorktree.set(worktreeId, next)
    const result = this.toMobileSessionTabsResult(next)
    for (const listener of this.mobileSessionTabListeners) {
      listener(result)
    }
    const created = result.tabs.find((candidate) => candidate.id === tab.id)
    if (!created || created.type !== 'terminal') {
      throw new Error('terminal_handle_stale')
    }
    return {
      tab: created,
      publicationEpoch: result.publicationEpoch,
      snapshotVersion: result.snapshotVersion
    }
  }

  private waitForMobileTerminalSurface(
    worktreeId: string,
    parentTabId: string,
    timeoutMs = 10_000
  ): Promise<RuntimeMobileSessionCreateTerminalResult> {
    const existing = this.findMobileTerminalSurface(worktreeId, parentTabId)
    if (existing) {
      return Promise.resolve(existing)
    }

    return new Promise<RuntimeMobileSessionCreateTerminalResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.graphSyncCallbacks.indexOf(check)
        if (idx !== -1) {
          this.graphSyncCallbacks.splice(idx, 1)
        }
        reject(new Error('Timed out waiting for terminal surface after creation'))
      }, timeoutMs)

      const check = (): void => {
        const next = this.findMobileTerminalSurface(worktreeId, parentTabId)
        if (!next) {
          return
        }
        clearTimeout(timer)
        const idx = this.graphSyncCallbacks.indexOf(check)
        if (idx !== -1) {
          this.graphSyncCallbacks.splice(idx, 1)
        }
        resolve(next)
      }
      this.graphSyncCallbacks.push(check)
      check()
    })
  }

  private findMobileTerminalSurface(
    worktreeId: string,
    parentTabId: string
  ): RuntimeMobileSessionCreateTerminalResult | null {
    const snapshot = this.mobileSessionTabsByWorktree.get(worktreeId)
    if (!snapshot) {
      return null
    }
    const result = this.toMobileSessionTabsResult(snapshot)
    const tab = result.tabs.find(
      (candidate) => candidate.type === 'terminal' && candidate.parentTabId === parentTabId
    )
    if (!tab || tab.type !== 'terminal') {
      return null
    }
    return {
      tab,
      publicationEpoch: result.publicationEpoch,
      snapshotVersion: result.snapshotVersion
    }
  }

  private waitForTerminalHandle(tabId: string, timeoutMs = 10_000): Promise<string> {
    const existing = this.resolveHandleForTab(tabId)
    if (existing) {
      return Promise.resolve(existing)
    }

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.graphSyncCallbacks.indexOf(check)
        if (idx !== -1) {
          this.graphSyncCallbacks.splice(idx, 1)
        }
        reject(new Error('Timed out waiting for terminal handle after creation'))
      }, timeoutMs)

      const check = (): void => {
        const handle = this.resolveHandleForTab(tabId)
        if (handle) {
          clearTimeout(timer)
          const idx = this.graphSyncCallbacks.indexOf(check)
          if (idx !== -1) {
            this.graphSyncCallbacks.splice(idx, 1)
          }
          resolve(handle)
        }
      }
      this.graphSyncCallbacks.push(check)
      // Why: the graph sync may have fired between the initial check and
      // callback registration. Re-check immediately to avoid a missed wake-up.
      check()
    })
  }

  // Why: mobile clients may subscribe before the PTY spawns (the left pane
  // of a new workspace). Instead of bailing with a bare scrollback+end,
  // wait for the PTY to appear so the subscribe can proceed with phone-fit.
  waitForLeafPtyId(handle: string, timeoutMs = 10_000): Promise<string> {
    const leaf = this.resolveLeafForHandle(handle)
    if (leaf?.ptyId) {
      return Promise.resolve(leaf.ptyId)
    }

    // Why: when the ptyId changes from null to a real value, the old handle
    // is invalidated (deleted from this.handles). Capture the tabId+leafId
    // now so we can look up the leaf directly even after handle invalidation.
    const record = this.handles.get(handle)
    const savedTabId = record?.tabId ?? null
    const savedLeafId = record?.leafId ?? null

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.graphSyncCallbacks.indexOf(check)
        if (idx !== -1) {
          this.graphSyncCallbacks.splice(idx, 1)
        }
        reject(new Error('Timed out waiting for PTY to spawn'))
      }, timeoutMs)

      const check = (): void => {
        // Try the handle first (works if handle wasn't invalidated yet)
        let ptyId = this.resolveLeafForHandle(handle)?.ptyId
        // Why: when ptyId transitions null→real, issueHandle invalidates the
        // old handle. Fall back to direct leaf lookup by the saved coordinates.
        if (!ptyId && savedTabId && savedLeafId) {
          const directLeaf = this.leaves.get(this.getLeafKey(savedTabId, savedLeafId))
          ptyId = directLeaf?.ptyId ?? null
        }
        if (ptyId) {
          clearTimeout(timer)
          const idx = this.graphSyncCallbacks.indexOf(check)
          if (idx !== -1) {
            this.graphSyncCallbacks.splice(idx, 1)
          }
          resolve(ptyId)
        }
      }
      this.graphSyncCallbacks.push(check)
      check()
    })
  }

  // Why: a leaf appears in the graph before its PTY spawns. If we issue a
  // handle while ptyId is null, the next graph sync after PTY spawn will
  // change ptyId and invalidate the handle. Wait for a connected PTY so
  // the handle is stable and immediately usable for send/read/wait.
  private countLeavesInTab(tabId: string): number {
    let count = 0
    for (const leaf of this.leaves.values()) {
      if (leaf.tabId === tabId) {
        count++
      }
    }
    return count
  }

  private resolveHandleForTab(tabId: string): string | null {
    for (const leaf of this.leaves.values()) {
      if (leaf.tabId === tabId && leaf.ptyId !== null) {
        return this.issueHandle(leaf)
      }
    }
    return null
  }

  async focusTerminal(handle: string): Promise<RuntimeTerminalFocus> {
    this.assertGraphReady()
    const pty = this.getLivePtyForHandle(handle)
    if (pty) {
      if (!pty.pty.connected) {
        throw new Error('terminal_exited')
      }
      const parsedPaneKey = parsePaneKey(pty.pty.paneKey ?? '')
      const revealed = await this.notifier?.revealTerminalSession?.(pty.pty.worktreeId, {
        ptyId: pty.pty.ptyId,
        title: pty.pty.title ?? pty.pty.lastOscTitle,
        ...(pty.pty.tabId !== null ? { tabId: pty.pty.tabId } : {}),
        ...(parsedPaneKey ? { leafId: parsedPaneKey.leafId } : {})
      })
      return {
        handle,
        tabId: revealed?.tabId ?? pty.pty.tabId ?? pty.record.tabId,
        worktreeId: pty.pty.worktreeId
      }
    }
    const { leaf } = this.getLiveLeafForHandle(handle)
    this.notifier?.focusTerminal(leaf.tabId, leaf.worktreeId, leaf.leafId)
    return { handle, tabId: leaf.tabId, worktreeId: leaf.worktreeId }
  }

  async closeTerminal(handle: string): Promise<RuntimeTerminalClose> {
    this.assertGraphReady()
    const pty = this.getLivePtyForHandle(handle)
    if (pty) {
      const ptyKilled = this.ptyController?.kill(pty.pty.ptyId) ?? false
      return { handle, tabId: pty.record.tabId, ptyKilled }
    }
    const { leaf } = this.getLiveLeafForHandle(handle)
    let ptyKilled = false
    if (leaf.ptyId) {
      ptyKilled = this.ptyController?.kill(leaf.ptyId) ?? false
    }
    // Why: killing the PTY in a multi-pane tab is sufficient — the renderer's
    // PTY exit handler already calls PaneManager.closePane() for split layouts.
    // Sending an additional IPC close would race with the exit handler and
    // incorrectly close the entire tab (the pane count drops to 1 before the
    // IPC arrives, triggering the single-pane fallback path).
    // We only send the notifier close when the PTY wasn't killed (e.g. PTY not
    // yet spawned) or when this is the only pane in the tab.
    const siblingCount = this.countLeavesInTab(leaf.tabId)
    if (!ptyKilled || siblingCount <= 1) {
      this.notifier?.closeTerminal(leaf.tabId, leaf.paneRuntimeId)
    }
    return { handle, tabId: leaf.tabId, ptyKilled }
  }

  async splitTerminal(
    handle: string,
    opts: { direction?: 'horizontal' | 'vertical'; command?: string } = {}
  ): Promise<RuntimeTerminalSplit> {
    this.assertGraphReady()
    const { leaf } = this.getLiveLeafForHandle(handle)
    const direction = opts.direction ?? 'horizontal'

    // Why: snapshot current leaf keys for this tab so we can detect the new
    // pane that appears after the split via graph sync delta.
    const leafKeysBefore = new Set<string>()
    for (const [key, l] of this.leaves) {
      if (l.tabId === leaf.tabId) {
        leafKeysBefore.add(key)
      }
    }

    this.notifier?.splitTerminal(leaf.tabId, leaf.paneRuntimeId, {
      direction,
      command: opts.command
    })

    const newHandle = await this.waitForNewLeafInTab(leaf.tabId, leafKeysBefore)
    return { handle: newHandle, tabId: leaf.tabId, paneRuntimeId: leaf.paneRuntimeId }
  }

  private waitForNewLeafInTab(
    tabId: string,
    existingLeafKeys: Set<string>,
    timeoutMs = 10_000
  ): Promise<string> {
    const tryResolve = (): string | null => {
      for (const [key, leaf] of this.leaves) {
        if (leaf.tabId === tabId && !existingLeafKeys.has(key) && leaf.ptyId !== null) {
          return this.issueHandle(leaf)
        }
      }
      return null
    }

    const existing = tryResolve()
    if (existing) {
      return Promise.resolve(existing)
    }

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.graphSyncCallbacks.indexOf(check)
        if (idx !== -1) {
          this.graphSyncCallbacks.splice(idx, 1)
        }
        reject(new Error('Timed out waiting for split pane handle'))
      }, timeoutMs)

      const check = (): void => {
        const handle = tryResolve()
        if (handle) {
          clearTimeout(timer)
          const idx = this.graphSyncCallbacks.indexOf(check)
          if (idx !== -1) {
            this.graphSyncCallbacks.splice(idx, 1)
          }
          resolve(handle)
        }
      }
      this.graphSyncCallbacks.push(check)
      check()
    })
  }

  async stopTerminalsForWorktree(worktreeSelector: string): Promise<{ stopped: number }> {
    // Why: this mutates live PTYs, so the runtime must reject it while the
    // renderer graph is reloading instead of acting on cached leaf ownership.
    const graphEpoch = this.captureReadyGraphEpoch()
    const worktree = await this.resolveWorktreeSelector(worktreeSelector)
    this.assertStableReadyGraph(graphEpoch)
    const ptyIds = new Set<string>()
    for (const leaf of this.leaves.values()) {
      if (leaf.worktreeId === worktree.id && leaf.ptyId) {
        ptyIds.add(leaf.ptyId)
      }
    }
    for (const pty of this.ptysById.values()) {
      if (pty.worktreeId === worktree.id && pty.connected) {
        ptyIds.add(pty.ptyId)
      }
    }

    let stopped = 0
    for (const ptyId of ptyIds) {
      if (this.ptyController?.kill(ptyId)) {
        stopped += 1
      }
    }
    return { stopped }
  }

  async hasTerminalsForWorktree(worktreeSelector: string): Promise<boolean> {
    const graphEpoch = this.captureReadyGraphEpoch()
    const worktree = await this.resolveWorktreeSelector(worktreeSelector)
    this.assertStableReadyGraph(graphEpoch)
    for (const leaf of this.leaves.values()) {
      if (leaf.worktreeId === worktree.id && leaf.ptyId) {
        return true
      }
    }
    for (const pty of this.ptysById.values()) {
      if (pty.worktreeId === worktree.id && pty.connected) {
        return true
      }
    }
    return false
  }

  markRendererReloading(windowId: number): void {
    if (windowId !== this.authoritativeWindowId) {
      return
    }
    if (this.graphStatus !== 'ready') {
      return
    }
    // Why: any renderer reload tears down the published live graph, so live
    // terminal handles must become stale immediately instead of being reused
    // against whatever the renderer rebuilds next.
    this.rendererGraphEpoch += 1
    this.graphStatus = 'reloading'
    this.rememberDetachedPreAllocatedLeaves()
    this.handles.clear()
    this.handleByLeafKey.clear()
    // Why: handleByPtyId maps ptyId → pre-allocated CLI handle (ORCA_TERMINAL_HANDLE).
    // These must survive renderer reloads so CLI agents can keep controlling the
    // same terminal across graph rebuilds — adoptPreAllocatedHandle re-links
    // them when the new graph arrives.
    this.rejectAllWaiters('terminal_handle_stale')
    this.refreshWritableFlags()
  }

  markGraphReady(windowId: number): void {
    if (windowId !== this.authoritativeWindowId) {
      return
    }
    this.graphStatus = 'ready'
    this.refreshWritableFlags()
  }

  markGraphUnavailable(windowId: number): void {
    if (windowId !== this.authoritativeWindowId) {
      return
    }
    // Why: once the authoritative renderer graph disappears, Orca must fail
    // closed for live-terminal operations instead of guessing from old state.
    if (this.graphStatus !== 'unavailable') {
      this.rendererGraphEpoch += 1
    }
    this.graphStatus = 'unavailable'
    this.authoritativeWindowId = null
    this.rememberDetachedPreAllocatedLeaves()
    this.tabs.clear()
    this.leaves.clear()
    this.handles.clear()
    this.handleByLeafKey.clear()
    // Why: same as markRendererReloading — pre-allocated CLI handles must
    // survive graph unavailability so they can be re-adopted on reconnect.
    this.rejectAllWaiters('terminal_handle_stale')
  }

  private assertGraphReady(): void {
    if (this.graphStatus !== 'ready') {
      throw new Error('runtime_unavailable')
    }
  }

  private captureReadyGraphEpoch(): number {
    this.assertGraphReady()
    return this.rendererGraphEpoch
  }

  private assertStableReadyGraph(expectedGraphEpoch: number): void {
    if (this.graphStatus !== 'ready' || this.rendererGraphEpoch !== expectedGraphEpoch) {
      throw new Error('runtime_unavailable')
    }
  }

  private async resolveWorktreeSelector(selector: string): Promise<ResolvedWorktree> {
    const worktrees = await this.listResolvedWorktrees()
    let candidates: ResolvedWorktree[]

    if (selector === 'active') {
      throw new Error('selector_not_found')
    }

    if (selector.startsWith('id:')) {
      candidates = worktrees.filter((worktree) => worktree.id === selector.slice(3))
    } else if (selector.startsWith('path:')) {
      candidates = worktrees.filter((worktree) =>
        runtimePathsEqual(worktree.path, selector.slice(5))
      )
    } else if (selector.startsWith('branch:')) {
      const branchSelector = selector.slice(7)
      candidates = worktrees.filter((worktree) =>
        branchSelectorMatches(worktree.branch, branchSelector)
      )
    } else if (selector.startsWith('issue:')) {
      candidates = worktrees.filter(
        (worktree) =>
          worktree.linkedIssue !== null && String(worktree.linkedIssue) === selector.slice(6)
      )
    } else {
      candidates = worktrees.filter(
        (worktree) =>
          worktree.id === selector ||
          runtimePathsEqual(worktree.path, selector) ||
          branchSelectorMatches(worktree.branch, selector)
      )
    }

    if (candidates.length === 1) {
      return candidates[0]
    }
    if (candidates.length > 1) {
      throw new Error('selector_ambiguous')
    }
    throw new Error('selector_not_found')
  }

  private validateLineageParent(child: ResolvedWorktree, parent: ResolvedWorktree): void {
    const childWorktreeId = child.id
    const parentWorktreeId = parent.id
    if (childWorktreeId === parentWorktreeId) {
      throw new RuntimeLineageError('LINEAGE_PARENT_CYCLE', 'A workspace cannot parent itself.')
    }
    const instanceByWorktreeId = new Map(
      this.resolvedWorktreeCache?.worktrees.map((worktree) => [
        worktree.id,
        worktree.instanceId
      ]) ?? [
        [child.id, child.instanceId],
        [parent.id, parent.instanceId]
      ]
    )
    let cursor: string | undefined = parentWorktreeId
    const visited = new Set<string>([childWorktreeId])
    while (cursor) {
      if (visited.has(cursor)) {
        throw new RuntimeLineageError(
          'LINEAGE_PARENT_CYCLE',
          'Parent workspace would create a lineage cycle.'
        )
      }
      visited.add(cursor)
      const lineage = this.store?.getWorktreeLineage?.(cursor)
      if (!lineage) {
        break
      }
      const cursorInstanceId = instanceByWorktreeId.get(cursor)
      const parentInstanceId = instanceByWorktreeId.get(lineage.parentWorktreeId)
      if (
        cursorInstanceId !== lineage.worktreeInstanceId ||
        parentInstanceId !== lineage.parentWorktreeInstanceId
      ) {
        break
      }
      cursor = lineage.parentWorktreeId
    }
  }

  private async resolveLineageForWorktreeCreate(
    input?: WorktreeLineageInput
  ): Promise<WorktreeLineageResolution> {
    if (!input) {
      return { kind: 'none', warnings: [] }
    }

    if (input.noParent === true && input.parentWorktree) {
      throw new RuntimeLineageError(
        'LINEAGE_PARENT_CONTEXT_CONFLICT',
        'Choose either --parent-worktree or --no-parent, not both.'
      )
    }

    if (input.noParent === true) {
      return { kind: 'none', warnings: [] }
    }

    if (input.parentWorktree) {
      try {
        const parent = await this.resolveWorktreeSelector(input.parentWorktree)
        return {
          kind: 'lineage',
          parent,
          origin: 'cli',
          capture: { source: 'explicit-cli-flag', confidence: 'explicit' }
        }
      } catch {
        throw new RuntimeLineageError(
          'LINEAGE_PARENT_NOT_FOUND',
          'Parent workspace was not found.',
          {
            nextSteps: [
              'Run `orca worktree list` and pass a valid --parent-worktree selector.',
              'Retry with --no-parent to create without lineage.'
            ]
          }
        )
      }
    }

    const warnings: WorktreeLineageWarning[] = []
    const candidates: WorktreeLineageCandidate[] = []
    let cwdCandidate: WorktreeLineageCandidate | null = null
    let terminalContextResolved = false

    if (input.orchestrationContext?.parentWorktreeId) {
      try {
        candidates.push({
          source: 'orchestration-context',
          parent: await this.resolveWorktreeSelector(
            `id:${input.orchestrationContext.parentWorktreeId}`
          )
        })
      } catch {
        // Keep creation recoverable; the warning below covers missing inferred context.
      }
    }

    const commentTaskId = extractOrchestrationTaskId(input.comment)
    if (commentTaskId) {
      const candidate = await this.resolveLineageCandidateForTaskId(commentTaskId)
      if (candidate) {
        candidates.push(candidate)
      }
    }

    if (input.callerTerminalHandle) {
      try {
        const terminal = await this.showTerminal(input.callerTerminalHandle)
        const terminalParent = await this.resolveWorktreeSelector(`id:${terminal.worktreeId}`)
        const activeDispatch = this._orchestrationDb?.getActiveDispatchForTerminal(
          input.callerTerminalHandle
        )
        const activeRun = this._orchestrationDb?.getActiveCoordinatorRun()
        if (activeDispatch) {
          candidates.push({
            source: 'orchestration-context',
            parent: terminalParent,
            taskId: activeDispatch.task_id,
            ...(activeRun
              ? {
                  orchestrationRunId: activeRun.id,
                  coordinatorHandle: activeRun.coordinator_handle
                }
              : {})
          })
        } else {
          candidates.push({
            source: 'terminal-context',
            parent: terminalParent
          })
        }
        terminalContextResolved = true
      } catch {
        // Why: terminal handles can go stale during reloads or SSH reconnects.
        // A valid orchestration parent is still authoritative, so keep resolving
        // other inferred candidates instead of dropping lineage completely.
        warnings.push({
          code: 'LINEAGE_PARENT_CONTEXT_MISSING',
          message:
            'Worktree created, but Orca could not validate the caller terminal as a parent workspace.',
          details: { callerTerminalHandle: input.callerTerminalHandle }
        })
      }
    }

    if (input.cwdParentWorktree) {
      try {
        cwdCandidate = {
          source: 'cwd-context',
          parent: await this.resolveWorktreeSelector(input.cwdParentWorktree)
        }
      } catch {
        warnings.push({
          code: 'LINEAGE_PARENT_CONTEXT_MISSING',
          message:
            'Worktree created, but Orca could not validate the current directory as a parent workspace.',
          details: { cwdParentWorktree: input.cwdParentWorktree }
        })
      }
    }

    if (candidates.length === 0 && cwdCandidate) {
      candidates.push(cwdCandidate)
    }

    if (candidates.length === 0) {
      return { kind: 'none', warnings }
    }

    const [first] = candidates
    const conflict = candidates.find((candidate) => candidate.parent.id !== first.parent.id)
    if (conflict) {
      return {
        kind: 'none',
        warnings: [
          {
            code: 'LINEAGE_PARENT_CONTEXT_CONFLICT',
            message: 'Worktree created, but Orca could not prove which parent workspace caused it.',
            details: {
              terminalParentWorktreeId: candidates.find((c) => c.source === 'terminal-context')
                ?.parent.id,
              orchestrationParentWorktreeId: candidates.find(
                (c) => c.source === 'orchestration-context'
              )?.parent.id
            }
          }
        ]
      }
    }

    const preferred =
      candidates.find((candidate) => candidate.source === 'orchestration-context') ?? first
    return {
      kind: 'lineage',
      parent: preferred.parent,
      origin: preferred.source === 'orchestration-context' ? 'orchestration' : 'cli',
      capture: { source: preferred.source, confidence: 'inferred' },
      ...((preferred.orchestrationRunId ?? input.orchestrationContext?.orchestrationRunId)
        ? {
            orchestrationRunId:
              preferred.orchestrationRunId ?? input.orchestrationContext?.orchestrationRunId
          }
        : {}),
      ...((preferred.taskId ?? input.orchestrationContext?.taskId)
        ? { taskId: preferred.taskId ?? input.orchestrationContext?.taskId }
        : {}),
      ...((preferred.coordinatorHandle ?? input.orchestrationContext?.coordinatorHandle)
        ? {
            coordinatorHandle:
              preferred.coordinatorHandle ?? input.orchestrationContext?.coordinatorHandle
          }
        : {}),
      ...(terminalContextResolved && input.callerTerminalHandle
        ? { createdByTerminalHandle: input.callerTerminalHandle }
        : {})
    }
  }

  private async resolveLineageCandidateForTaskId(
    taskId: string
  ): Promise<WorktreeLineageCandidate | null> {
    const db = this.getOrchestrationDbIfAvailable()
    const dispatch = db?.getDispatchContext(taskId)
    // Why: agent-created task records may never be dispatched, but the
    // creating terminal still identifies the parent workspace for descendants.
    const parentHandle =
      dispatch?.assignee_handle ?? db?.getTask(taskId)?.created_by_terminal_handle
    if (!parentHandle) {
      return null
    }
    try {
      const terminal = await this.showTerminal(parentHandle)
      return {
        source: 'orchestration-context',
        parent: await this.resolveWorktreeSelector(`id:${terminal.worktreeId}`),
        taskId
      }
    } catch {
      return null
    }
  }

  private getOrchestrationDbIfAvailable(): OrchestrationDb | null {
    try {
      return this._orchestrationDb ?? this.getOrchestrationDb()
    } catch {
      return this._orchestrationDb
    }
  }

  async hydrateInferredWorktreeLineage(): Promise<void> {
    const store = this.store
    if (
      !store ||
      typeof store.getWorktreeLineage !== 'function' ||
      typeof store.setWorktreeLineage !== 'function'
    ) {
      return
    }

    const worktrees = await this.listResolvedWorktrees()
    for (const worktree of worktrees) {
      if (store.getWorktreeLineage(worktree.id) || !worktree.instanceId) {
        continue
      }
      const taskId = extractOrchestrationTaskId(worktree.comment)
      if (!taskId) {
        continue
      }
      const candidate = await this.resolveLineageCandidateForTaskId(taskId)
      if (!candidate?.parent.instanceId || candidate.parent.id === worktree.id) {
        continue
      }
      try {
        this.validateLineageParent(worktree, candidate.parent)
      } catch {
        continue
      }
      store.setWorktreeLineage(worktree.id, {
        worktreeId: worktree.id,
        worktreeInstanceId: worktree.instanceId,
        parentWorktreeId: candidate.parent.id,
        parentWorktreeInstanceId: candidate.parent.instanceId,
        origin: 'orchestration',
        capture: { source: 'orchestration-context', confidence: 'inferred' },
        taskId,
        createdAt: Date.now()
      })
    }
  }

  async listWorktreeLineage(): Promise<Record<string, WorktreeLineage>> {
    await this.hydrateInferredWorktreeLineage()
    return this.store?.getAllWorktreeLineage?.() ?? {}
  }

  private async resolveRepoSelector(selector: string): Promise<Repo> {
    if (!this.store) {
      throw new Error('repo_not_found')
    }
    const repos = this.store.getRepos()
    let candidates: Repo[]

    if (selector.startsWith('id:')) {
      candidates = repos.filter((repo) => repo.id === selector.slice(3))
    } else if (selector.startsWith('path:')) {
      candidates = repos.filter((repo) => runtimePathsEqual(repo.path, selector.slice(5)))
    } else if (selector.startsWith('name:')) {
      candidates = repos.filter((repo) => repo.displayName === selector.slice(5))
    } else {
      candidates = repos.filter(
        (repo) =>
          repo.id === selector ||
          runtimePathsEqual(repo.path, selector) ||
          repo.displayName === selector
      )
    }

    if (candidates.length === 1) {
      return candidates[0]
    }
    if (candidates.length > 1) {
      throw new Error('selector_ambiguous')
    }
    throw new Error('repo_not_found')
  }

  private requireStore(): Store {
    if (!this.store) {
      throw new Error('runtime_unavailable')
    }
    return this.store as unknown as Store
  }

  private async listResolvedWorktrees(): Promise<ResolvedWorktree[]> {
    if (!this.store) {
      return []
    }
    const now = Date.now()
    if (this.resolvedWorktreeCache && this.resolvedWorktreeCache.expiresAt > now) {
      return this.resolvedWorktreeCache.worktrees
    }
    const generation = this.resolvedWorktreeGeneration
    if (this.resolvedWorktreeInFlight?.generation === generation) {
      return this.resolvedWorktreeInFlight.promise
    }

    const promise = this.computeResolvedWorktrees(generation)
    this.resolvedWorktreeInFlight = { generation, promise }
    try {
      return await promise
    } finally {
      if (this.resolvedWorktreeInFlight?.promise === promise) {
        this.resolvedWorktreeInFlight = null
      }
    }
  }

  private async computeResolvedWorktrees(generation: number): Promise<ResolvedWorktree[]> {
    if (!this.store) {
      return []
    }
    const now = Date.now()
    const perRepoWorktrees = await Promise.all(
      this.store.getRepos().map(async (repo) => {
        // Why: mobile startup RPCs share this path. A slow repo scan should
        // degrade one repo's metadata, not block all terminal/session loading.
        const scan = await withTimeout(
          this.listRepoWorktreesForResolution(repo),
          RESOLVED_WORKTREE_REPO_TIMEOUT_MS,
          { ok: false, worktrees: [] }
        )
        const gitWorktrees = scan.worktrees
        if (scan.ok) {
          this.pruneLineageForMissingRepoWorktrees(repo, gitWorktrees)
        }
        const metaById = this.store?.getAllWorktreeMeta() ?? {}
        return gitWorktrees.map((gitWorktree) => {
          const worktreeId = `${repo.id}::${gitWorktree.path}`
          // Why: lineage validation needs a durable instance ID even when the
          // runtime sees a workspace before the renderer's discovery-stamp path.
          const existingMeta = metaById[worktreeId]
          const meta =
            existingMeta && existingMeta.instanceId
              ? existingMeta
              : this.store?.setWorktreeMeta(worktreeId, {})
          const merged = mergeWorktree(repo.id, gitWorktree, meta, repo.displayName)
          return {
            ...merged,
            parentWorktreeId: null,
            childWorktreeIds: [],
            lineage: null,
            git: {
              path: gitWorktree.path,
              head: gitWorktree.head,
              branch: gitWorktree.branch,
              isBare: gitWorktree.isBare,
              isMainWorktree: gitWorktree.isMainWorktree
            },
            displayName: merged.displayName,
            comment: merged.comment
          }
        })
      })
    )
    const worktrees = this.attachLineageToResolvedWorktrees(perRepoWorktrees.flat())
    // Why: terminal polling can be frequent, but git worktree state is still
    // allowed to change outside Orca. A short TTL avoids shelling out on every
    // read without pretending the cache is authoritative for long.
    if (generation === this.resolvedWorktreeGeneration) {
      this.resolvedWorktreeCache = {
        worktrees,
        expiresAt: now + RESOLVED_WORKTREE_CACHE_TTL_MS
      }
    }
    return worktrees
  }

  private attachLineageToResolvedWorktrees(worktrees: ResolvedWorktree[]): ResolvedWorktree[] {
    const lineageById = this.store?.getAllWorktreeLineage?.() ?? {}
    const worktreeById = new Map(worktrees.map((worktree) => [worktree.id, worktree]))
    const validLineageByChildId = new Map<string, WorktreeLineage>()
    const childIdsByParentId = new Map<string, string[]>()

    for (const [childId, lineage] of Object.entries(lineageById)) {
      const child = worktreeById.get(childId)
      const parent = worktreeById.get(lineage.parentWorktreeId)
      if (
        !child ||
        !parent ||
        child.instanceId !== lineage.worktreeInstanceId ||
        parent.instanceId !== lineage.parentWorktreeInstanceId
      ) {
        // Why: worktree IDs are path-derived. Instance checks keep replacement
        // checkouts from appearing as children of stale same-path lineage.
        continue
      }
      validLineageByChildId.set(childId, lineage)
      const children = childIdsByParentId.get(lineage.parentWorktreeId) ?? []
      children.push(childId)
      childIdsByParentId.set(lineage.parentWorktreeId, children)
    }

    return worktrees.map((worktree) => {
      const lineage = validLineageByChildId.get(worktree.id) ?? null
      return {
        ...worktree,
        parentWorktreeId: lineage?.parentWorktreeId ?? null,
        childWorktreeIds: childIdsByParentId.get(worktree.id) ?? [],
        lineage
      }
    })
  }

  private pruneLineageForMissingRepoWorktrees(repo: Repo, gitWorktrees: GitWorktreeInfo[]): void {
    const store = this.store
    if (
      !store ||
      typeof store.getAllWorktreeLineage !== 'function' ||
      typeof store.removeWorktreeLineage !== 'function'
    ) {
      return
    }
    const liveIds = new Set(gitWorktrees.map((worktree) => `${repo.id}::${worktree.path}`))
    const repoPrefix = `${repo.id}::`
    for (const [childId, lineage] of Object.entries(store.getAllWorktreeLineage())) {
      if (childId.startsWith(repoPrefix) && !liveIds.has(childId)) {
        // Why: runtime selector scans can be the only scan before a path is
        // reused. Once a successful scan proves the child is gone, stale
        // lineage must not survive into the replacement checkout.
        store.removeWorktreeLineage(childId)
      }
      if (
        lineage.parentWorktreeId.startsWith(repoPrefix) &&
        !liveIds.has(lineage.parentWorktreeId)
      ) {
        const parentMeta = store.getWorktreeMeta(lineage.parentWorktreeId)
        if (!parentMeta || parentMeta.instanceId === lineage.parentWorktreeInstanceId) {
          // Why: preserving child lineage powers the repair UI, but a missing
          // parent path only needs one fresh identity to keep same-path
          // replacement checkouts from validating old lineage.
          store.setWorktreeMeta(lineage.parentWorktreeId, { instanceId: randomUUID() })
        }
      }
    }
  }

  private async listRepoWorktreesForResolution(repo: Repo): Promise<RuntimeWorktreeScanResult> {
    if (!repo.connectionId) {
      return { ok: true, worktrees: await listRepoWorktrees(repo) }
    }
    const provider = getSshGitProvider(repo.connectionId)
    if (!provider) {
      return { ok: false, worktrees: [] }
    }
    return { ok: true, worktrees: await provider.listWorktrees(repo.path) }
  }

  private async getResolvedWorktreeMap(): Promise<Map<string, ResolvedWorktree>> {
    return new Map((await this.listResolvedWorktrees()).map((worktree) => [worktree.id, worktree]))
  }

  private invalidateResolvedWorktreeCache(): void {
    this.resolvedWorktreeGeneration += 1
    this.resolvedWorktreeCache = null
  }

  private recordPtyWorktree(
    ptyId: string,
    worktreeId: string,
    state: Partial<
      Pick<RuntimePtyWorktreeRecord, 'connected' | 'lastOutputAt' | 'preview' | 'tabId' | 'paneKey'>
    > = {}
  ): RuntimePtyWorktreeRecord {
    let pty = this.ptysById.get(ptyId)
    if (!pty) {
      pty = {
        ptyId,
        worktreeId,
        tabId: state.tabId ?? null,
        paneKey: state.paneKey ?? null,
        connected: state.connected ?? true,
        lastExitCode: null,
        lastAgentStatus: null,
        lastOscTitle: null,
        title: null,
        lastOutputAt: state.lastOutputAt ?? null,
        tailBuffer: [],
        tailPartialLine: '',
        tailTruncated: false,
        tailLinesTotal: 0,
        preview: state.preview ?? ''
      }
      this.ptysById.set(ptyId, pty)
      return pty
    }

    pty.worktreeId = worktreeId
    if (state.tabId !== undefined) {
      pty.tabId = state.tabId
    }
    if (state.paneKey !== undefined) {
      pty.paneKey = state.paneKey
    }
    if (state.connected !== undefined) {
      pty.connected = state.connected
    }
    if (state.lastOutputAt !== undefined) {
      pty.lastOutputAt = maxTimestamp(pty.lastOutputAt, state.lastOutputAt)
    }
    if (state.preview !== undefined && state.preview.length > 0) {
      pty.preview = state.preview
    }
    return pty
  }

  private makeRuntimePaneKey(
    leaf: Pick<RuntimeSyncedLeaf, 'tabId' | 'leafId' | 'paneRuntimeId'>
  ): string {
    return isTerminalLeafId(leaf.leafId)
      ? makePaneKey(leaf.tabId, leaf.leafId)
      : `${leaf.tabId}:${leaf.paneRuntimeId}`
  }

  private getOrCreatePtyWorktreeRecord(ptyId: string): RuntimePtyWorktreeRecord | null {
    const existing = this.ptysById.get(ptyId)
    if (existing) {
      return existing
    }
    const inferredWorktreeId = inferWorktreeIdFromPtyId(ptyId)
    if (!inferredWorktreeId) {
      return null
    }
    // Why: daemon-backed PTY session IDs are prefixed with the worktree ID so
    // mobile summaries survive renderer graph gaps and Electron reloads.
    return this.recordPtyWorktree(ptyId, inferredWorktreeId)
  }

  private async refreshPtyWorktreeRecordsFromController(
    resolvedWorktrees: ResolvedWorktree[]
  ): Promise<void> {
    if (!this.ptyController?.listProcesses) {
      return
    }
    const sessions = await withTimeout(
      this.ptyController.listProcesses(),
      PTY_CONTROLLER_LIST_TIMEOUT_MS,
      []
    )
    const livePtyIds = new Set(sessions.map((session) => session.id))
    for (const session of sessions) {
      const worktreeId =
        inferWorktreeIdFromPtyId(session.id) ??
        findResolvedWorktreeIdForPath(resolvedWorktrees, session.cwd)
      if (worktreeId) {
        this.recordPtyWorktree(session.id, worktreeId, { connected: true })
      }
    }
    for (const pty of this.ptysById.values()) {
      if (!livePtyIds.has(pty.ptyId) && !this.leafExistsForPty(pty.ptyId)) {
        pty.connected = false
      }
    }
  }

  private leafExistsForPty(ptyId: string): boolean {
    for (const leaf of this.leaves.values()) {
      if (leaf.ptyId === ptyId) {
        return true
      }
    }
    return false
  }

  private getSummaryForRuntimeWorktreeId(
    summaries: Map<string, RuntimeWorktreePsSummary>,
    resolvedWorktrees: ResolvedWorktree[],
    runtimeWorktreeId: string
  ): RuntimeWorktreePsSummary | null {
    const exact = summaries.get(runtimeWorktreeId)
    if (exact) {
      return exact
    }
    const parsed = parseRuntimeWorktreeId(runtimeWorktreeId)
    if (!parsed) {
      return null
    }
    const resolved = resolvedWorktrees.find(
      (worktree) =>
        worktree.repoId === parsed.repoId &&
        areWorktreePathsEqual(worktree.path, parsed.worktreePath)
    )
    return resolved ? (summaries.get(resolved.id) ?? null) : null
  }

  private buildTerminalSummary(
    leaf: RuntimeLeafRecord,
    worktreesById: Map<string, ResolvedWorktree>
  ): RuntimeTerminalSummary {
    const worktree = worktreesById.get(leaf.worktreeId)
    const tab = this.tabs.get(leaf.tabId) ?? null

    return {
      handle: this.issueHandle(leaf),
      worktreeId: leaf.worktreeId,
      worktreePath: worktree?.path ?? '',
      branch: worktree?.branch ?? '',
      tabId: leaf.tabId,
      leafId: leaf.leafId,
      title: tab?.title ?? null,
      connected: leaf.connected,
      writable: leaf.writable,
      lastOutputAt: leaf.lastOutputAt,
      preview: leaf.preview
    }
  }

  private syncMobileSessionTabs(snapshots: RuntimeMobileSessionTabsSnapshot[] | undefined): void {
    if (snapshots === undefined) {
      return
    }
    const nextWorktrees = new Set<string>()
    for (const snapshot of snapshots) {
      nextWorktrees.add(snapshot.worktree)
      const existing = this.mobileSessionTabsByWorktree.get(snapshot.worktree)
      if (
        !existing ||
        snapshot.publicationEpoch !== existing.publicationEpoch ||
        snapshot.snapshotVersion >= existing.snapshotVersion
      ) {
        this.mobileSessionTabsByWorktree.set(snapshot.worktree, snapshot)
      }
    }
    for (const worktreeId of this.mobileSessionTabsByWorktree.keys()) {
      if (!nextWorktrees.has(worktreeId)) {
        this.mobileSessionTabsByWorktree.delete(worktreeId)
        this.notifyMobileSessionTabsRemoved(worktreeId)
      }
    }
  }

  private notifyMobileSessionTabsRemoved(worktreeId: string): void {
    const removed: RuntimeMobileSessionTabsRemovedResult = {
      worktree: worktreeId,
      publicationEpoch: `removed:${Date.now().toString(36)}`,
      snapshotVersion: 0,
      removed: true,
      activeGroupId: null,
      activeTabId: null,
      activeTabType: null,
      tabs: []
    }
    for (const listener of this.mobileSessionTabListeners) {
      listener(removed)
    }
  }

  private notifyMobileSessionTabSnapshots(): void {
    if (this.mobileSessionTabListeners.size === 0) {
      return
    }
    for (const snapshot of this.mobileSessionTabsByWorktree.values()) {
      const result = this.toMobileSessionTabsResult(snapshot)
      for (const listener of this.mobileSessionTabListeners) {
        listener(result)
      }
    }
  }

  private getMobileSessionTabsForWorktree(worktreeId: string): RuntimeMobileSessionTabsResult {
    const snapshot = this.mobileSessionTabsByWorktree.get(worktreeId)
    if (!snapshot) {
      return {
        worktree: worktreeId,
        publicationEpoch: 'none',
        snapshotVersion: 0,
        activeGroupId: null,
        activeTabId: null,
        activeTabType: null,
        tabs: []
      }
    }
    return this.toMobileSessionTabsResult(snapshot)
  }

  private async resolveMobileMarkdownWorktreeId(
    worktreeSelector: string,
    tabId: string
  ): Promise<string> {
    const worktreeId =
      getExplicitWorktreeIdSelector(worktreeSelector) ??
      (await this.resolveWorktreeSelector(worktreeSelector)).id
    const snapshot = this.mobileSessionTabsByWorktree.get(worktreeId)
    const tab = snapshot?.tabs.find(
      (candidate): candidate is RuntimeMobileSessionMarkdownTab =>
        candidate.type === 'markdown' && candidate.id === tabId
    )
    if (!tab) {
      throw new Error('tab_not_found')
    }
    return worktreeId
  }

  private toMobileSessionTabsResult(
    snapshot: RuntimeMobileSessionTabsSnapshot
  ): RuntimeMobileSessionTabsResult {
    const tabs: RuntimeMobileSessionClientTab[] = []
    for (const tab of snapshot.tabs) {
      if (tab.type === 'markdown' || tab.type === 'file') {
        tabs.push(tab)
        continue
      }
      const syncedTab = this.tabs.get(tab.parentTabId)
      const leaf = this.leaves.get(this.getLeafKey(tab.parentTabId, tab.leafId)) ?? null
      const pty = leaf ? null : this.findPtyForMobileTerminalTab(tab)
      tabs.push({
        type: 'terminal',
        id: tab.id,
        parentTabId: tab.parentTabId,
        leafId: tab.leafId,
        title: leaf?.paneTitle ?? syncedTab?.title ?? pty?.title ?? tab.title,
        isActive: tab.isActive,
        ...(leaf
          ? { status: 'ready' as const, terminal: this.issueHandle(leaf) }
          : pty
            ? { status: 'ready' as const, terminal: this.issuePtyHandle(pty) }
            : { status: 'pending-handle' as const, terminal: null })
      })
    }
    const active = tabs.find((tab) => tab.isActive) ?? null
    return {
      worktree: snapshot.worktree,
      publicationEpoch: snapshot.publicationEpoch,
      snapshotVersion: snapshot.snapshotVersion,
      activeGroupId: snapshot.activeGroupId,
      activeTabId: active?.id ?? null,
      activeTabType: active?.type ?? null,
      tabs
    }
  }

  private findPtyForMobileTerminalTab(
    tab: RuntimeMobileSessionTerminalTab
  ): RuntimePtyWorktreeRecord | null {
    const paneKeys = new Set([`${tab.parentTabId}:${tab.leafId}`])
    if (tab.leafId === `pane:${FIRST_PANE_ID}`) {
      paneKeys.add(`${tab.parentTabId}:${FIRST_PANE_ID}`)
    }
    for (const pty of this.ptysById.values()) {
      if (pty.tabId === tab.parentTabId && pty.paneKey && paneKeys.has(pty.paneKey)) {
        return pty
      }
    }
    return null
  }

  // Why: group address resolution (Section 4.5) needs to query per-handle agent
  // status without throwing on stale handles, so this returns null on any error.
  getAgentStatusForHandle(handle: string): string | null {
    try {
      const { leaf } = this.getLiveLeafForHandle(handle)
      return leaf.lastAgentStatus
    } catch {
      return null
    }
  }

  // Why: OSC title detection via onPtyData is the tightest signal for agent
  // presence, but the runtime may not see PTY data for daemon-hosted terminals
  // (the daemon adapter stubs getForegroundProcess). This checks three signals
  // in order: (1) lastAgentStatus from PTY data OSC titles, (2) the renderer-
  // synced tab title (which reflects OSC titles from the xterm instance), and
  // (3) the PTY foreground process. Returns true if any signal indicates a
  // non-shell agent is running.
  async isTerminalRunningAgent(handle: string): Promise<boolean> {
    try {
      const { leaf } = this.getLiveLeafForHandle(handle)
      if (leaf.lastAgentStatus !== null) {
        return true
      }
      // Why: check both the leaf-level pane title (synced from the renderer's
      // runtimePaneTitlesByTabId) and the tab-level title. The tab title already
      // includes OSC-enriched agent indicators (e.g. ✳ prefix) synced from the
      // renderer's xterm instance.
      const titleToCheck = leaf.paneTitle ?? this.tabs.get(leaf.tabId)?.title
      if (titleToCheck && detectAgentStatusFromTitle(titleToCheck) !== null) {
        return true
      }
      if (!leaf.ptyId || !this.ptyController) {
        return false
      }
      const fg = await this.ptyController.getForegroundProcess(leaf.ptyId)
      if (!fg) {
        return false
      }
      return !isShellProcess(fg)
    } catch {
      return false
    }
  }

  deliverPendingMessagesForHandle(handle: string): void {
    try {
      const { leaf } = this.getLiveLeafForHandle(handle)
      if (leaf.lastAgentStatus === 'idle') {
        this.deliverPendingMessages(leaf)
      }
    } catch {
      // Unknown or stale handles cannot be pushed immediately; the persisted
      // message remains available via explicit check or future idle delivery.
    }
  }

  // Why: after a message is inserted for a recipient, any blocking
  // orchestration.check --wait calls watching that handle must be woken
  // so they can return the new message immediately instead of polling.
  notifyMessageArrived(handle: string): void {
    const waiters = this.messageWaitersByHandle.get(handle)
    if (!waiters || waiters.size === 0) {
      return
    }
    for (const waiter of [...waiters]) {
      this.resolveMessageWaiter(waiter)
    }
  }

  waitForMessage(
    handle: string,
    options?: { typeFilter?: string[]; timeoutMs?: number; signal?: AbortSignal }
  ): Promise<void> {
    return new Promise((resolve) => {
      const timeoutMs = options?.timeoutMs ?? MESSAGE_WAIT_DEFAULT_TIMEOUT_MS

      const waiter: MessageWaiter = {
        handle,
        typeFilter: options?.typeFilter,
        resolve,
        timeout: null
      }

      // Why: if the caller aborts (socket closed on the RPC side — see design
      // doc §3.1 counter-lifecycle), resolve immediately so the long-poll slot
      // is released instead of counting down the full timeoutMs with a dead
      // client on the other end.
      const signal = options?.signal
      const onAbort = (): void => {
        this.removeMessageWaiter(waiter)
        resolve()
      }
      if (signal) {
        if (signal.aborted) {
          resolve()
          return
        }
        signal.addEventListener('abort', onAbort, { once: true })
      }

      waiter.timeout = setTimeout(() => {
        if (signal) {
          signal.removeEventListener('abort', onAbort)
        }
        this.removeMessageWaiter(waiter)
        resolve()
      }, timeoutMs)

      let waiters = this.messageWaitersByHandle.get(handle)
      if (!waiters) {
        waiters = new Set()
        this.messageWaitersByHandle.set(handle, waiters)
      }
      waiters.add(waiter)
    })
  }

  private resolveMessageWaiter(waiter: MessageWaiter): void {
    this.removeMessageWaiter(waiter)
    waiter.resolve()
  }

  private removeMessageWaiter(waiter: MessageWaiter): void {
    if (waiter.timeout) {
      clearTimeout(waiter.timeout)
      waiter.timeout = null
    }
    const waiters = this.messageWaitersByHandle.get(waiter.handle)
    if (waiters) {
      waiters.delete(waiter)
      if (waiters.size === 0) {
        this.messageWaitersByHandle.delete(waiter.handle)
      }
    }
  }

  private buildPtyTerminalSummary(
    pty: RuntimePtyWorktreeRecord,
    worktreesById: Map<string, ResolvedWorktree>
  ): RuntimeTerminalSummary {
    const worktree = worktreesById.get(pty.worktreeId)

    return {
      handle: this.issuePtyHandle(pty),
      worktreeId: pty.worktreeId,
      worktreePath: worktree?.path ?? '',
      branch: worktree?.branch ?? '',
      tabId: `pty:${pty.ptyId}`,
      leafId: `pty:${pty.ptyId}`,
      title: pty.title ?? pty.lastOscTitle,
      connected: pty.connected,
      writable: pty.connected,
      lastOutputAt: pty.lastOutputAt,
      preview: pty.preview
    }
  }

  private getLiveLeafForHandle(handle: string): {
    record: TerminalHandleRecord
    leaf: RuntimeLeafRecord
  } {
    this.assertGraphReady()
    const record = this.handles.get(handle)
    if (!record || record.runtimeId !== this.runtimeId) {
      throw new Error('terminal_handle_stale')
    }
    if (record.rendererGraphEpoch !== this.rendererGraphEpoch) {
      throw new Error('terminal_handle_stale')
    }

    const leaf = this.leaves.get(this.getLeafKey(record.tabId, record.leafId))
    if (!leaf || leaf.ptyId !== record.ptyId || leaf.ptyGeneration !== record.ptyGeneration) {
      throw new Error('terminal_handle_stale')
    }
    return { record, leaf }
  }

  private getLivePtyForHandle(handle: string): {
    record: TerminalHandleRecord
    pty: RuntimePtyWorktreeRecord
  } | null {
    let record = this.handles.get(handle)
    if (!record) {
      const ptyId = [...this.handleByPtyId.entries()].find(
        ([, mappedHandle]) => mappedHandle === handle
      )?.[0]
      const pty = ptyId ? this.ptysById.get(ptyId) : null
      if (pty) {
        // Why: graph reload/unavailability clears renderer handle records, but
        // runtime-owned PTY handles remain the caller's control identity.
        this.issuePtyHandle(pty)
        record = this.handles.get(handle)
      }
    }
    if (!record || record.runtimeId !== this.runtimeId || !record.tabId.startsWith('pty:')) {
      return null
    }
    if (!record.ptyId) {
      return null
    }
    const pty = this.ptysById.get(record.ptyId)
    if (!pty || pty.ptyId !== record.ptyId) {
      return null
    }
    // Why: renderer adoption can race with CLI reads. If this synthetic PTY
    // handle is valid, keep ptyId -> handle populated so summaries do not mint
    // a second handle for the same terminal.
    this.handleByPtyId.set(record.ptyId, handle)
    return { record, pty }
  }

  private readPtyTerminal(
    handle: string,
    pty: RuntimePtyWorktreeRecord,
    opts: { cursor?: number } = {}
  ): RuntimeTerminalRead {
    const allLines = buildTailLines(pty.tailBuffer, pty.tailPartialLine)

    let tail: string[]
    let truncated: boolean

    if (typeof opts.cursor === 'number' && opts.cursor >= 0) {
      const bufferStart = pty.tailLinesTotal - pty.tailBuffer.length
      const sliceFrom = Math.max(0, opts.cursor - bufferStart)
      tail = pty.tailBuffer.slice(sliceFrom)
      truncated = opts.cursor < bufferStart
    } else {
      tail = allLines
      truncated = pty.tailTruncated
    }

    return {
      handle,
      status: pty.connected ? 'running' : pty.lastExitCode !== null ? 'exited' : 'unknown',
      tail,
      truncated,
      nextCursor: String(pty.tailLinesTotal)
    }
  }

  private issueHandle(leaf: RuntimeLeafRecord): string {
    const leafKey = this.getLeafKey(leaf.tabId, leaf.leafId)
    const existingHandle = this.handleByLeafKey.get(leafKey)
    if (existingHandle) {
      const existingRecord = this.handles.get(existingHandle)
      if (
        existingRecord &&
        existingRecord.rendererGraphEpoch === this.rendererGraphEpoch &&
        existingRecord.ptyId === leaf.ptyId &&
        existingRecord.ptyGeneration === leaf.ptyGeneration
      ) {
        return existingHandle
      }
    }

    const handle = this.adoptPreAllocatedHandle(leaf) ?? `term_${randomUUID()}`
    if (this.handles.has(handle)) {
      return handle
    }
    this.handles.set(handle, {
      handle,
      runtimeId: this.runtimeId,
      rendererGraphEpoch: this.rendererGraphEpoch,
      worktreeId: leaf.worktreeId,
      tabId: leaf.tabId,
      leafId: leaf.leafId,
      ptyId: leaf.ptyId,
      ptyGeneration: leaf.ptyGeneration
    })
    this.handleByLeafKey.set(leafKey, handle)
    return handle
  }

  private adoptPreAllocatedHandle(leaf: RuntimeLeafRecord): string | null {
    if (!leaf.ptyId) {
      return null
    }
    const preAllocated = this.handleByPtyId.get(leaf.ptyId)
    if (!preAllocated) {
      return null
    }
    const leafKey = this.getLeafKey(leaf.tabId, leaf.leafId)
    this.handles.set(preAllocated, {
      handle: preAllocated,
      runtimeId: this.runtimeId,
      rendererGraphEpoch: this.rendererGraphEpoch,
      worktreeId: leaf.worktreeId,
      tabId: leaf.tabId,
      leafId: leaf.leafId,
      ptyId: leaf.ptyId,
      ptyGeneration: leaf.ptyGeneration
    })
    this.handleByLeafKey.set(leafKey, preAllocated)
    return preAllocated
  }

  private issuePtyHandle(pty: RuntimePtyWorktreeRecord): string {
    const existingHandle =
      this.handleByPtyId.get(pty.ptyId) ?? this.findHandleForPtyRecord(pty.ptyId)
    if (existingHandle) {
      const existingRecord = this.handles.get(existingHandle)
      if (
        existingRecord &&
        existingRecord.runtimeId === this.runtimeId &&
        existingRecord.ptyId === pty.ptyId
      ) {
        this.handleByPtyId.set(pty.ptyId, existingHandle)
        return existingHandle
      }
    }

    const handle = existingHandle ?? `term_${randomUUID()}`
    const syntheticId = `pty:${pty.ptyId}`
    this.handles.set(handle, {
      handle,
      runtimeId: this.runtimeId,
      rendererGraphEpoch: this.rendererGraphEpoch,
      worktreeId: pty.worktreeId,
      tabId: syntheticId,
      leafId: syntheticId,
      ptyId: pty.ptyId,
      ptyGeneration: 0
    })
    this.handleByPtyId.set(pty.ptyId, handle)
    return handle
  }

  private findHandleForPtyRecord(ptyId: string): string | null {
    for (const [handle, record] of this.handles) {
      if (
        record.runtimeId === this.runtimeId &&
        record.ptyId === ptyId &&
        record.tabId.startsWith('pty:')
      ) {
        return handle
      }
    }
    return null
  }

  private refreshWritableFlags(): void {
    for (const leaf of this.leaves.values()) {
      leaf.writable = this.graphStatus === 'ready' && leaf.connected && leaf.ptyId !== null
    }
  }

  private invalidateLeafHandle(leafKey: string): void {
    const handle = this.handleByLeafKey.get(leafKey)
    if (!handle) {
      return
    }
    this.handleByLeafKey.delete(leafKey)
    this.handles.delete(handle)
    this.rejectWaitersForHandle(handle, 'terminal_handle_stale')
  }

  private rememberDetachedPreAllocatedLeaves(): void {
    for (const leaf of this.leaves.values()) {
      if (leaf.ptyId && this.handleByPtyId.has(leaf.ptyId)) {
        // Why: ORCA_TERMINAL_HANDLE is an agent identity, so CLI control should
        // survive renderer graph loss as long as the underlying PTY is alive.
        this.detachedPreAllocatedLeaves.set(leaf.ptyId, leaf)
      }
    }
  }

  private resolveExitWaiters(leaf: RuntimeLeafRecord): void {
    const handle = this.issueHandle(leaf)
    if (!handle) {
      return
    }
    const waiters = this.waitersByHandle.get(handle)
    if (!waiters || waiters.size === 0) {
      return
    }
    for (const waiter of [...waiters]) {
      if (waiter.condition === 'exit') {
        this.resolveWaiter(waiter, buildTerminalWaitResult(handle, 'exit', leaf))
      } else {
        // Why: if the terminal exited, conditions like tui-idle can never be
        // satisfied. Reject immediately instead of letting the poll interval
        // spin until timeout on a dead process.
        this.removeWaiter(waiter)
        waiter.reject(new Error('terminal_exited'))
      }
    }
  }

  private resolveTuiIdleWaiters(leaf: RuntimeLeafRecord): void {
    const handle = this.handleByLeafKey.get(this.getLeafKey(leaf.tabId, leaf.leafId))
    if (!handle) {
      return
    }
    const waiters = this.waitersByHandle.get(handle)
    if (!waiters || waiters.size === 0) {
      return
    }
    for (const waiter of [...waiters]) {
      if (waiter.condition === 'tui-idle') {
        this.resolveWaiter(waiter, buildTerminalWaitResult(handle, 'tui-idle', leaf))
      }
    }
  }

  private resolvePtyExitWaiters(pty: RuntimePtyWorktreeRecord, ptyId: string): void {
    const handle = this.handleByPtyId.get(ptyId)
    if (!handle) {
      return
    }
    const waiters = this.waitersByHandle.get(handle)
    if (!waiters || waiters.size === 0) {
      return
    }
    for (const waiter of [...waiters]) {
      if (waiter.condition === 'exit') {
        this.resolveWaiter(waiter, buildPtyTerminalWaitResult(handle, 'exit', pty))
      } else {
        this.removeWaiter(waiter)
        waiter.reject(new Error('terminal_exited'))
      }
    }
  }

  private resolvePtyTuiIdleWaiters(pty: RuntimePtyWorktreeRecord, ptyId: string): void {
    const handle = this.handleByPtyId.get(ptyId)
    if (!handle) {
      return
    }
    const waiters = this.waitersByHandle.get(handle)
    if (!waiters || waiters.size === 0) {
      return
    }
    for (const waiter of [...waiters]) {
      if (waiter.condition === 'tui-idle') {
        this.resolveWaiter(waiter, buildPtyTerminalWaitResult(handle, 'tui-idle', pty))
      }
    }
  }

  // Why: OSC title detection via onPtyData is the primary signal for tui-idle,
  // but daemon-hosted terminals don't flow PTY data through the runtime, and
  // some agents don't emit recognized titles on startup. This fallback polls
  // two signals: (1) the renderer-synced tab title (reflects xterm's OSC title
  // handler, works even for daemon terminals), and (2) the PTY foreground process
  // + output quiescence. The poll self-cancels when the primary OSC path fires.
  private startTuiIdleFallbackPoll(waiter: TerminalWaiter, leaf: RuntimeLeafRecord): void {
    waiter.pollInterval = setInterval(async () => {
      try {
        // If OSC detection via onPtyData kicked in, stop — the primary path
        // will handle (or has already handled) resolution.
        if (leaf.lastAgentStatus !== null) {
          if (waiter.pollInterval) {
            clearInterval(waiter.pollInterval)
            waiter.pollInterval = null
          }
          return
        }
        // Why: check the renderer-synced title. For daemon-hosted terminals,
        // this is the only path where OSC titles are visible to the runtime.
        const pollTitle = leaf.paneTitle ?? this.tabs.get(leaf.tabId)?.title
        if (pollTitle) {
          const titleStatus = detectAgentStatusFromTitle(pollTitle)
          if (titleStatus === 'idle') {
            if (waiter.pollInterval) {
              clearInterval(waiter.pollInterval)
              waiter.pollInterval = null
            }
            this.resolveWaiter(waiter, buildTerminalWaitResult(waiter.handle, 'tui-idle', leaf))
            return
          }
        }
        // Foreground process fallback: if the daemon/local provider can report
        // the process and it's a non-shell with quiet output, treat as idle.
        if (leaf.ptyId && this.ptyController) {
          const fg = await this.ptyController.getForegroundProcess(leaf.ptyId)
          if (fg && !isShellProcess(fg)) {
            const quietMs = leaf.lastOutputAt ? Date.now() - leaf.lastOutputAt : 0
            if (quietMs >= TUI_IDLE_QUIESCENCE_MS) {
              if (waiter.pollInterval) {
                clearInterval(waiter.pollInterval)
                waiter.pollInterval = null
              }
              this.resolveWaiter(waiter, buildTerminalWaitResult(waiter.handle, 'tui-idle', leaf))
            }
          }
        }
      } catch {
        // Swallow transient PTY inspection errors and keep polling.
      }
    }, TUI_IDLE_POLL_INTERVAL_MS)
  }

  // Why: push-on-idle delivery — when an agent transitions working→idle, check
  // for unread orchestration messages addressed to that terminal and inject them
  // into the PTY. This is event-driven (no polling) because the runtime owns
  // both the message store and terminal status detection.
  private deliverPendingMessages(leaf: RuntimeLeafRecord): void {
    if (!this._orchestrationDb) {
      return
    }

    const handle = this.handleByLeafKey.get(this.getLeafKey(leaf.tabId, leaf.leafId))
    if (!handle) {
      return
    }

    const unread = this._orchestrationDb.getUndeliveredUnreadMessages(handle)
    if (unread.length === 0) {
      return
    }

    if (!leaf.writable || !leaf.ptyId) {
      return
    }

    const payload = formatMessagesForInjection(unread)
    const wrote = this.ptyController?.write(leaf.ptyId, payload) ?? false
    if (!wrote) {
      return
    }

    // Why: Claude Code treats large single PTY writes as paste events and
    // swallows a \r included in the same write. Send Enter separately after
    // a delay so the agent processes the pasted message first. Stamp
    // `delivered_at` only after \r is confirmed, so failed deliveries stay
    // queued.
    //
    // Important (design doc §3.2, feedback #2): we stamp `delivered_at` here
    // instead of flipping `read`. `read` is reserved for "a check-caller
    // consumed this message." Flipping `read` on push-on-idle would hide the
    // message from the coordinator's next `check --unread`, which is the
    // exact bug feedback #2 reported. The two bits must stay independent.
    const ptyId = leaf.ptyId
    setTimeout(() => {
      try {
        if (!leaf.writable) {
          return
        }
        const submitted = this.ptyController?.write(ptyId, '\r') ?? false
        if (submitted) {
          this._orchestrationDb?.markAsDelivered(unread.map((m) => m.id))
        }
      } catch {
        // Terminal may have closed during the delay — messages stay queued
        // (delivered_at still NULL) and will be re-delivered on the next
        // idle transition.
      }
    }, 500)
  }

  private resolveWaiter(waiter: TerminalWaiter, result: RuntimeTerminalWait): void {
    this.removeWaiter(waiter)
    waiter.resolve(result)
  }

  private rejectWaitersForHandle(handle: string, code: string): void {
    const waiters = this.waitersByHandle.get(handle)
    if (!waiters || waiters.size === 0) {
      return
    }
    for (const waiter of [...waiters]) {
      this.removeWaiter(waiter)
      waiter.reject(new Error(code))
    }
  }

  private rejectAllWaiters(code: string): void {
    for (const handle of [...this.waitersByHandle.keys()]) {
      this.rejectWaitersForHandle(handle, code)
    }
  }

  private removeWaiter(waiter: TerminalWaiter): void {
    if (waiter.timeout) {
      clearTimeout(waiter.timeout)
    }
    if (waiter.pollInterval) {
      clearInterval(waiter.pollInterval)
    }
    const waiters = this.waitersByHandle.get(waiter.handle)
    if (!waiters) {
      return
    }
    waiters.delete(waiter)
    if (waiters.size === 0) {
      this.waitersByHandle.delete(waiter.handle)
    }
  }

  private getLeafKey(tabId: string, leafId: string): string {
    return `${tabId}::${leafId}`
  }

  // ── Linear integration ──

  linearConnect(apiKey: string): ReturnType<typeof connectLinear> {
    return connectLinear(apiKey)
  }

  linearDisconnect(workspaceId?: string): { ok: true } {
    disconnectLinear(workspaceId)
    return { ok: true }
  }

  linearSelectWorkspace(workspaceId: LinearWorkspaceSelection): ReturnType<typeof getLinearStatus> {
    return selectLinearWorkspace(workspaceId)
  }

  linearStatus(): ReturnType<typeof getLinearStatus> {
    return getLinearStatus()
  }

  linearTestConnection(workspaceId?: string): ReturnType<typeof testLinearConnection> {
    return testLinearConnection(workspaceId)
  }

  linearSearchIssues(
    query: string,
    limit = 20,
    workspaceId?: LinearWorkspaceSelection
  ): ReturnType<typeof searchLinearIssues> {
    return searchLinearIssues(query, Math.min(Math.max(1, limit), 50), workspaceId)
  }

  linearListIssues(
    filter?: LinearListFilter,
    limit = 20,
    workspaceId?: LinearWorkspaceSelection
  ): ReturnType<typeof listLinearIssues> {
    return listLinearIssues(filter, Math.min(Math.max(1, limit), 50), workspaceId)
  }

  linearCreateIssue(
    teamId: string,
    title: string,
    description?: string,
    workspaceId?: string
  ): ReturnType<typeof createLinearIssue> {
    return createLinearIssue(teamId, title, description, workspaceId)
  }

  linearGetIssue(id: string, workspaceId?: string): ReturnType<typeof getLinearIssue> {
    return getLinearIssue(id, workspaceId)
  }

  linearUpdateIssue(
    id: string,
    updates: LinearIssueUpdate,
    workspaceId?: string
  ): ReturnType<typeof updateLinearIssue> {
    return updateLinearIssue(id, updates, workspaceId)
  }

  linearAddIssueComment(
    issueId: string,
    body: string,
    workspaceId?: string
  ): ReturnType<typeof addLinearIssueComment> {
    return addLinearIssueComment(issueId, body, workspaceId)
  }

  linearIssueComments(
    issueId: string,
    workspaceId?: string
  ): ReturnType<typeof getLinearIssueComments> {
    return getLinearIssueComments(issueId, workspaceId)
  }

  linearListTeams(workspaceId?: LinearWorkspaceSelection): ReturnType<typeof listLinearTeams> {
    return listLinearTeams(workspaceId)
  }

  linearTeamStates(teamId: string, workspaceId?: string): ReturnType<typeof getLinearTeamStates> {
    return getLinearTeamStates(teamId, workspaceId)
  }

  linearTeamLabels(teamId: string, workspaceId?: string): ReturnType<typeof getLinearTeamLabels> {
    return getLinearTeamLabels(teamId, workspaceId)
  }

  linearTeamMembers(teamId: string, workspaceId?: string): ReturnType<typeof getLinearTeamMembers> {
    return getLinearTeamMembers(teamId, workspaceId)
  }

  // ── Browser automation ──

  private readonly browserCommands = new RuntimeBrowserCommands({
    getAgentBrowserBridge: () => this.agentBrowserBridge,
    resolveWorktreeSelector: (selector) => this.resolveWorktreeSelector(selector),
    getAuthoritativeWindow: () => this.getAuthoritativeWindow(),
    getAvailableAuthoritativeWindow: () => this.getAvailableAuthoritativeWindow()
  })

  browserSnapshot: RuntimeBrowserCommands['browserSnapshot'] =
    this.browserCommands.browserSnapshot.bind(this.browserCommands)

  browserClick: RuntimeBrowserCommands['browserClick'] = this.browserCommands.browserClick.bind(
    this.browserCommands
  )

  browserGoto: RuntimeBrowserCommands['browserGoto'] = this.browserCommands.browserGoto.bind(
    this.browserCommands
  )

  browserFill: RuntimeBrowserCommands['browserFill'] = this.browserCommands.browserFill.bind(
    this.browserCommands
  )

  browserType: RuntimeBrowserCommands['browserType'] = this.browserCommands.browserType.bind(
    this.browserCommands
  )

  browserSelect: RuntimeBrowserCommands['browserSelect'] = this.browserCommands.browserSelect.bind(
    this.browserCommands
  )

  browserScroll: RuntimeBrowserCommands['browserScroll'] = this.browserCommands.browserScroll.bind(
    this.browserCommands
  )

  browserBack: RuntimeBrowserCommands['browserBack'] = this.browserCommands.browserBack.bind(
    this.browserCommands
  )

  browserReload: RuntimeBrowserCommands['browserReload'] = this.browserCommands.browserReload.bind(
    this.browserCommands
  )

  browserScreenshot: RuntimeBrowserCommands['browserScreenshot'] =
    this.browserCommands.browserScreenshot.bind(this.browserCommands)

  browserEval: RuntimeBrowserCommands['browserEval'] = this.browserCommands.browserEval.bind(
    this.browserCommands
  )

  browserTabList: RuntimeBrowserCommands['browserTabList'] =
    this.browserCommands.browserTabList.bind(this.browserCommands)

  browserTabShow: RuntimeBrowserCommands['browserTabShow'] =
    this.browserCommands.browserTabShow.bind(this.browserCommands)

  browserTabCurrent: RuntimeBrowserCommands['browserTabCurrent'] =
    this.browserCommands.browserTabCurrent.bind(this.browserCommands)

  browserTabSwitch: RuntimeBrowserCommands['browserTabSwitch'] =
    this.browserCommands.browserTabSwitch.bind(this.browserCommands)

  browserHover: RuntimeBrowserCommands['browserHover'] = this.browserCommands.browserHover.bind(
    this.browserCommands
  )

  browserDrag: RuntimeBrowserCommands['browserDrag'] = this.browserCommands.browserDrag.bind(
    this.browserCommands
  )

  browserUpload: RuntimeBrowserCommands['browserUpload'] = this.browserCommands.browserUpload.bind(
    this.browserCommands
  )

  browserWait: RuntimeBrowserCommands['browserWait'] = this.browserCommands.browserWait.bind(
    this.browserCommands
  )

  browserCheck: RuntimeBrowserCommands['browserCheck'] = this.browserCommands.browserCheck.bind(
    this.browserCommands
  )

  browserFocus: RuntimeBrowserCommands['browserFocus'] = this.browserCommands.browserFocus.bind(
    this.browserCommands
  )

  browserClear: RuntimeBrowserCommands['browserClear'] = this.browserCommands.browserClear.bind(
    this.browserCommands
  )

  browserSelectAll: RuntimeBrowserCommands['browserSelectAll'] =
    this.browserCommands.browserSelectAll.bind(this.browserCommands)

  browserKeypress: RuntimeBrowserCommands['browserKeypress'] =
    this.browserCommands.browserKeypress.bind(this.browserCommands)

  browserPdf: RuntimeBrowserCommands['browserPdf'] = this.browserCommands.browserPdf.bind(
    this.browserCommands
  )

  browserFullScreenshot: RuntimeBrowserCommands['browserFullScreenshot'] =
    this.browserCommands.browserFullScreenshot.bind(this.browserCommands)

  browserCookieGet: RuntimeBrowserCommands['browserCookieGet'] =
    this.browserCommands.browserCookieGet.bind(this.browserCommands)

  browserCookieSet: RuntimeBrowserCommands['browserCookieSet'] =
    this.browserCommands.browserCookieSet.bind(this.browserCommands)

  browserCookieDelete: RuntimeBrowserCommands['browserCookieDelete'] =
    this.browserCommands.browserCookieDelete.bind(this.browserCommands)

  browserSetViewport: RuntimeBrowserCommands['browserSetViewport'] =
    this.browserCommands.browserSetViewport.bind(this.browserCommands)

  browserSetGeolocation: RuntimeBrowserCommands['browserSetGeolocation'] =
    this.browserCommands.browserSetGeolocation.bind(this.browserCommands)

  browserInterceptEnable: RuntimeBrowserCommands['browserInterceptEnable'] =
    this.browserCommands.browserInterceptEnable.bind(this.browserCommands)

  browserInterceptDisable: RuntimeBrowserCommands['browserInterceptDisable'] =
    this.browserCommands.browserInterceptDisable.bind(this.browserCommands)

  browserInterceptList: RuntimeBrowserCommands['browserInterceptList'] =
    this.browserCommands.browserInterceptList.bind(this.browserCommands)

  browserCaptureStart: RuntimeBrowserCommands['browserCaptureStart'] =
    this.browserCommands.browserCaptureStart.bind(this.browserCommands)

  browserCaptureStop: RuntimeBrowserCommands['browserCaptureStop'] =
    this.browserCommands.browserCaptureStop.bind(this.browserCommands)

  browserConsoleLog: RuntimeBrowserCommands['browserConsoleLog'] =
    this.browserCommands.browserConsoleLog.bind(this.browserCommands)

  browserNetworkLog: RuntimeBrowserCommands['browserNetworkLog'] =
    this.browserCommands.browserNetworkLog.bind(this.browserCommands)

  browserDblclick: RuntimeBrowserCommands['browserDblclick'] =
    this.browserCommands.browserDblclick.bind(this.browserCommands)

  browserForward: RuntimeBrowserCommands['browserForward'] =
    this.browserCommands.browserForward.bind(this.browserCommands)

  browserScrollIntoView: RuntimeBrowserCommands['browserScrollIntoView'] =
    this.browserCommands.browserScrollIntoView.bind(this.browserCommands)

  browserGet: RuntimeBrowserCommands['browserGet'] = this.browserCommands.browserGet.bind(
    this.browserCommands
  )

  browserIs: RuntimeBrowserCommands['browserIs'] = this.browserCommands.browserIs.bind(
    this.browserCommands
  )

  browserKeyboardInsertText: RuntimeBrowserCommands['browserKeyboardInsertText'] =
    this.browserCommands.browserKeyboardInsertText.bind(this.browserCommands)

  browserMouseMove: RuntimeBrowserCommands['browserMouseMove'] =
    this.browserCommands.browserMouseMove.bind(this.browserCommands)

  browserMouseDown: RuntimeBrowserCommands['browserMouseDown'] =
    this.browserCommands.browserMouseDown.bind(this.browserCommands)

  browserMouseUp: RuntimeBrowserCommands['browserMouseUp'] =
    this.browserCommands.browserMouseUp.bind(this.browserCommands)

  browserMouseWheel: RuntimeBrowserCommands['browserMouseWheel'] =
    this.browserCommands.browserMouseWheel.bind(this.browserCommands)

  browserFind: RuntimeBrowserCommands['browserFind'] = this.browserCommands.browserFind.bind(
    this.browserCommands
  )

  browserSetDevice: RuntimeBrowserCommands['browserSetDevice'] =
    this.browserCommands.browserSetDevice.bind(this.browserCommands)

  browserSetOffline: RuntimeBrowserCommands['browserSetOffline'] =
    this.browserCommands.browserSetOffline.bind(this.browserCommands)

  browserSetHeaders: RuntimeBrowserCommands['browserSetHeaders'] =
    this.browserCommands.browserSetHeaders.bind(this.browserCommands)

  browserSetCredentials: RuntimeBrowserCommands['browserSetCredentials'] =
    this.browserCommands.browserSetCredentials.bind(this.browserCommands)

  browserSetMedia: RuntimeBrowserCommands['browserSetMedia'] =
    this.browserCommands.browserSetMedia.bind(this.browserCommands)

  browserClipboardRead: RuntimeBrowserCommands['browserClipboardRead'] =
    this.browserCommands.browserClipboardRead.bind(this.browserCommands)

  browserClipboardWrite: RuntimeBrowserCommands['browserClipboardWrite'] =
    this.browserCommands.browserClipboardWrite.bind(this.browserCommands)

  browserDialogAccept: RuntimeBrowserCommands['browserDialogAccept'] =
    this.browserCommands.browserDialogAccept.bind(this.browserCommands)

  browserDialogDismiss: RuntimeBrowserCommands['browserDialogDismiss'] =
    this.browserCommands.browserDialogDismiss.bind(this.browserCommands)

  browserStorageLocalGet: RuntimeBrowserCommands['browserStorageLocalGet'] =
    this.browserCommands.browserStorageLocalGet.bind(this.browserCommands)

  browserStorageLocalSet: RuntimeBrowserCommands['browserStorageLocalSet'] =
    this.browserCommands.browserStorageLocalSet.bind(this.browserCommands)

  browserStorageLocalClear: RuntimeBrowserCommands['browserStorageLocalClear'] =
    this.browserCommands.browserStorageLocalClear.bind(this.browserCommands)

  browserStorageSessionGet: RuntimeBrowserCommands['browserStorageSessionGet'] =
    this.browserCommands.browserStorageSessionGet.bind(this.browserCommands)

  browserStorageSessionSet: RuntimeBrowserCommands['browserStorageSessionSet'] =
    this.browserCommands.browserStorageSessionSet.bind(this.browserCommands)

  browserStorageSessionClear: RuntimeBrowserCommands['browserStorageSessionClear'] =
    this.browserCommands.browserStorageSessionClear.bind(this.browserCommands)

  browserDownload: RuntimeBrowserCommands['browserDownload'] =
    this.browserCommands.browserDownload.bind(this.browserCommands)

  browserHighlight: RuntimeBrowserCommands['browserHighlight'] =
    this.browserCommands.browserHighlight.bind(this.browserCommands)

  browserExec: RuntimeBrowserCommands['browserExec'] = this.browserCommands.browserExec.bind(
    this.browserCommands
  )

  browserTabCreate: RuntimeBrowserCommands['browserTabCreate'] =
    this.browserCommands.browserTabCreate.bind(this.browserCommands)

  browserTabSetProfile: RuntimeBrowserCommands['browserTabSetProfile'] =
    this.browserCommands.browserTabSetProfile.bind(this.browserCommands)

  browserTabProfileShow: RuntimeBrowserCommands['browserTabProfileShow'] =
    this.browserCommands.browserTabProfileShow.bind(this.browserCommands)

  browserTabProfileClone: RuntimeBrowserCommands['browserTabProfileClone'] =
    this.browserCommands.browserTabProfileClone.bind(this.browserCommands)

  browserProfileList: RuntimeBrowserCommands['browserProfileList'] =
    this.browserCommands.browserProfileList.bind(this.browserCommands)

  browserProfileCreate: RuntimeBrowserCommands['browserProfileCreate'] =
    this.browserCommands.browserProfileCreate.bind(this.browserCommands)

  browserProfileDelete: RuntimeBrowserCommands['browserProfileDelete'] =
    this.browserCommands.browserProfileDelete.bind(this.browserCommands)

  browserProfileDetectBrowsers: RuntimeBrowserCommands['browserProfileDetectBrowsers'] =
    this.browserCommands.browserProfileDetectBrowsers.bind(this.browserCommands)

  browserProfileImportFromBrowser: RuntimeBrowserCommands['browserProfileImportFromBrowser'] =
    this.browserCommands.browserProfileImportFromBrowser.bind(this.browserCommands)

  browserProfileClearDefaultCookies: RuntimeBrowserCommands['browserProfileClearDefaultCookies'] =
    this.browserCommands.browserProfileClearDefaultCookies.bind(this.browserCommands)

  browserTabClose: RuntimeBrowserCommands['browserTabClose'] =
    this.browserCommands.browserTabClose.bind(this.browserCommands)

  private getAuthoritativeWindow(): BrowserWindow {
    const win = this.getAvailableAuthoritativeWindow()
    if (!win || win.isDestroyed()) {
      throw new Error('No renderer window available')
    }
    return win
  }

  private getAvailableAuthoritativeWindow(): BrowserWindow | null {
    if (this.authoritativeWindowId === null) {
      return null
    }
    if (!BrowserWindow?.fromId) {
      return null
    }
    const win = BrowserWindow.fromId(this.authoritativeWindowId)
    return win && !win.isDestroyed() ? win : null
  }
}

const MAX_TAIL_LINES = 120
const MAX_TAIL_CHARS = 4000
const MAX_PREVIEW_LINES = 6
const MAX_PREVIEW_CHARS = 300
const WORKTREE_STATUS_PRIORITY: Record<RuntimeWorktreeStatus, number> = {
  inactive: 0,
  active: 1,
  done: 2,
  working: 3,
  permission: 4
}
const DEFAULT_REPO_SEARCH_REFS_LIMIT = 25
const DEFAULT_TERMINAL_LIST_LIMIT = 200
const DEFAULT_WORKTREE_LIST_LIMIT = 200
const DEFAULT_WORKTREE_PS_LIMIT = 200
const RESOLVED_WORKTREE_CACHE_TTL_MS = 1000
const RESOLVED_WORKTREE_REPO_TIMEOUT_MS = 5000
const PTY_CONTROLLER_LIST_TIMEOUT_MS = 3000
// Why (§3.3): 30s freshness window. A second worktree-create or dispatch-probe
// against the same repo+remote within this window reuses the previous successful
// fetch instead of repeating the round-trip. Chosen so rapid "new worktree"
// clicks and successive coordinator dispatches feel snappy, while still being
// short enough that a genuinely-changed remote is observed on the next action.
const FETCH_FRESHNESS_MS = 30_000
const DRIFT_PROBE_SUBJECT_LIMIT = 5

function getExplicitWorktreeIdSelector(selector: string | undefined): string | null {
  if (!selector?.startsWith('id:')) {
    return null
  }
  const id = selector.slice(3)
  return id.length > 0 ? id : null
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null
  return new Promise<T>((resolve) => {
    timeout = setTimeout(() => resolve(fallback), timeoutMs)
    promise.then(
      (value) => resolve(value),
      () => resolve(fallback)
    )
  }).finally(() => {
    if (timeout) {
      clearTimeout(timeout)
    }
  })
}

function buildPreview(lines: string[], partialLine: string): string {
  const previewLines = buildTailLines(lines, partialLine)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-MAX_PREVIEW_LINES)
  const preview = previewLines.join('\n')
  return preview.length > MAX_PREVIEW_CHARS
    ? preview.slice(preview.length - MAX_PREVIEW_CHARS)
    : preview
}

function appendToTailBuffer(
  previousLines: string[],
  previousPartialLine: string,
  chunk: string
): {
  lines: string[]
  partialLine: string
  truncated: boolean
  newCompleteLines: number
} {
  const normalizedChunk = normalizeTerminalChunk(chunk)
  if (normalizedChunk.length === 0) {
    return {
      lines: previousLines,
      partialLine: previousPartialLine,
      truncated: false,
      newCompleteLines: 0
    }
  }

  const pieces = `${previousPartialLine}${normalizedChunk}`.split('\n')
  const nextPartialLine = (pieces.pop() ?? '').replace(/[ \t]+$/g, '')
  const newCompleteLines = pieces.length
  const nextLines = [...previousLines, ...pieces.map((line) => line.replace(/[ \t]+$/g, ''))]
  let truncated = false

  while (nextLines.length > MAX_TAIL_LINES) {
    nextLines.shift()
    truncated = true
  }

  let totalChars = nextLines.reduce((sum, line) => sum + line.length, 0) + nextPartialLine.length
  while (nextLines.length > 0 && totalChars > MAX_TAIL_CHARS) {
    totalChars -= nextLines.shift()!.length
    truncated = true
  }

  return {
    lines: nextLines,
    partialLine: nextPartialLine.slice(-MAX_TAIL_CHARS),
    truncated,
    newCompleteLines
  }
}

function buildTailLines(lines: string[], partialLine: string): string[] {
  return partialLine.length > 0 ? [...lines, partialLine] : lines
}

function getTerminalState(leaf: RuntimeLeafRecord): RuntimeTerminalState {
  if (leaf.connected) {
    return 'running'
  }
  if (leaf.lastExitCode !== null) {
    return 'exited'
  }
  return 'unknown'
}

function buildSendPayload(action: {
  text?: string
  enter?: boolean
  interrupt?: boolean
}): string | null {
  let payload = ''
  if (typeof action.text === 'string' && action.text.length > 0) {
    payload += action.text
  }
  if (action.enter) {
    payload += '\r'
  }
  if (action.interrupt) {
    payload += '\x03'
  }
  return payload.length > 0 ? payload : null
}

// Why: tui-idle relies on recognized agent CLIs setting OSC titles. If the
// terminal runs an unsupported CLI (or a plain shell), no title transition
// will ever fire. A 5-minute ceiling prevents indefinite hangs while still
// giving real agent tasks plenty of time to complete.
const TUI_IDLE_DEFAULT_TIMEOUT_MS = 5 * 60 * 1000
const TUI_IDLE_POLL_INTERVAL_MS = 2000
const TUI_IDLE_QUIESCENCE_MS = 3000
const MESSAGE_WAIT_DEFAULT_TIMEOUT_MS = 2 * 60 * 1000

// Clamp range for the user-facing mobileAutoRestoreFitMs preference.
// MIN floor: a couple of seconds is the smallest useful auto-restore
// (anything tighter is the legacy 300ms debounce).
// MAX ceiling: one hour — a held PTY beyond that is almost certainly
// "I forgot" rather than intentional.
const MOBILE_AUTO_RESTORE_FIT_MIN_MS = 5_000
const MOBILE_AUTO_RESTORE_FIT_MAX_MS = 60 * 60 * 1000

function buildTerminalWaitResult(
  handle: string,
  condition: RuntimeTerminalWaitCondition,
  leaf: RuntimeLeafRecord
): RuntimeTerminalWait {
  return {
    handle,
    condition,
    satisfied: true,
    status: getTerminalState(leaf),
    exitCode: leaf.lastExitCode
  }
}

function buildPtyTerminalWaitResult(
  handle: string,
  condition: RuntimeTerminalWaitCondition,
  pty: RuntimePtyWorktreeRecord
): RuntimeTerminalWait {
  return {
    handle,
    condition,
    satisfied: true,
    status: pty.connected ? 'running' : pty.lastExitCode !== null ? 'exited' : 'unknown',
    exitCode: pty.lastExitCode
  }
}

function branchSelectorMatches(branch: string, selector: string): boolean {
  // Why: Git worktree data can report local branches as either `refs/heads/foo`
  // or `foo` depending on which plumbing path produced the record. Orca's
  // branch selectors should accept either form so newly created worktrees stay
  // discoverable without exposing internal ref-shape differences to users.
  return normalizeBranchRef(branch) === normalizeBranchRef(selector)
}

function runtimePathsEqual(left: string, right: string): boolean {
  return normalizeRuntimePathForComparison(left) === normalizeRuntimePathForComparison(right)
}

function normalizeBranchRef(branch: string): string {
  return branch.startsWith('refs/heads/') ? branch.slice('refs/heads/'.length) : branch
}

function inferWorktreeIdFromPtyId(ptyId: string): string | null {
  const separatorIndex = ptyId.lastIndexOf('@@')
  if (separatorIndex <= 0) {
    return null
  }
  const worktreeId = ptyId.slice(0, separatorIndex)
  return parseRuntimeWorktreeId(worktreeId) ? worktreeId : null
}

function parseRuntimeWorktreeId(
  worktreeId: string
): { repoId: string; worktreePath: string } | null {
  const parsed = splitWorktreeId(worktreeId)
  if (!parsed?.repoId) {
    return null
  }
  if (!parsed.worktreePath) {
    return null
  }
  return parsed
}

function findResolvedWorktreeIdForPath(
  resolvedWorktrees: ResolvedWorktree[],
  cwd: string
): string | null {
  if (!cwd) {
    return null
  }
  const matches = resolvedWorktrees
    .filter((worktree) => isPathInsideOrEqual(worktree.path, cwd))
    .sort((left, right) => right.path.length - left.path.length)
  return matches[0]?.id ?? null
}

function getLeafWorktreeStatus(
  leaf: RuntimeLeafRecord,
  tabTitle: string | null
): RuntimeWorktreeStatus {
  // Why: recompute from the live title each call so worktree.ps mirrors what
  // the desktop sidebar's getWorktreeStatus does (no sticky state). Prefer
  // the runtime-tracked OSC title (covers daemon-hosted terminals) over the
  // renderer-pushed leaf.title and the tab title. Falling back to
  // lastAgentStatus only when no title is available preserves a sensible
  // signal for very fresh leaves before any title has been observed.
  const liveTitle = leaf.lastOscTitle ?? leaf.title ?? tabTitle ?? ''
  const detected = liveTitle ? detectAgentStatusFromTitle(liveTitle) : leaf.lastAgentStatus
  if (detected === 'permission') {
    return 'permission'
  }
  if (detected === 'working') {
    return 'working'
  }
  return leaf.ptyId ? 'active' : 'inactive'
}

function getSavedTabWorktreeStatus(title: string, hasPty: boolean): RuntimeWorktreeStatus {
  const detected = detectAgentStatusFromTitle(title)
  if (detected === 'permission') {
    return 'permission'
  }
  if (detected === 'working') {
    return 'working'
  }
  return hasPty ? 'active' : 'inactive'
}

function mergeWorktreeStatus(
  current: RuntimeWorktreeStatus,
  next: RuntimeWorktreeStatus
): RuntimeWorktreeStatus {
  return WORKTREE_STATUS_PRIORITY[next] > WORKTREE_STATUS_PRIORITY[current] ? next : current
}

function normalizeTerminalChunk(chunk: string): string {
  return chunk
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-_]/g, '')
    .replace(/\u0008/g, '')
    .replace(/[^\x09\x0a\x20-\x7e]/g, '')
}

function maxTimestamp(left: number | null, right: number | null): number | null {
  if (left === null) {
    return right
  }
  if (right === null) {
    return left
  }
  return Math.max(left, right)
}

function compareWorktreePs(
  left: RuntimeWorktreePsSummary,
  right: RuntimeWorktreePsSummary
): number {
  // Pinned and unread worktrees sort above others so they survive truncation.
  if (left.isPinned !== right.isPinned) {
    return left.isPinned ? -1 : 1
  }
  if (left.unread !== right.unread) {
    return left.unread ? -1 : 1
  }
  const leftLast = left.lastOutputAt ?? -1
  const rightLast = right.lastOutputAt ?? -1
  if (leftLast !== rightLast) {
    return rightLast - leftLast
  }
  if (left.liveTerminalCount !== right.liveTerminalCount) {
    return right.liveTerminalCount - left.liveTerminalCount
  }
  return left.path.localeCompare(right.path)
}
