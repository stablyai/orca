/* eslint-disable max-lines -- Why: the Orca runtime is the authoritative live control plane for the CLI, so handle validation, selector resolution, wait state, and summaries are kept together to avoid split-brain behavior. */
/* eslint-disable unicorn/no-useless-spread -- Why: waiter sets and handle keys are cloned intentionally before mutation so resolution and rejection can safely remove entries while iterating. */
/* eslint-disable no-control-regex -- Why: terminal normalization must strip ANSI and OSC control sequences from PTY output before returning bounded text to agents. */
import {
  extractLastOscTitle,
  detectAgentStatusFromTitle,
  isShellProcess
} from '../../shared/agent-detection'
import type { AgentStatus } from '../../shared/agent-detection'
import { gitExecFileAsync } from '../git/runner'
import { isWslPath, parseWslPath, getWslHome } from '../wsl'
import { randomUUID } from 'crypto'
import { join } from 'path'
import { rm } from 'fs/promises'
import { OrchestrationDb } from './orchestration/db'
import { formatMessagesForInjection } from './orchestration/formatter'
import type {
  CreateWorktreeResult,
  Repo,
  StatsSummary,
  WorktreeStartupLaunch
} from '../../shared/types'
import { isFolderRepo } from '../../shared/repo-kind'
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
  RuntimeSyncWindowGraph,
  RuntimeWorktreeListResult,
  BrowserSnapshotResult,
  BrowserClickResult,
  BrowserGotoResult,
  BrowserFillResult,
  BrowserTypeResult,
  BrowserSelectResult,
  BrowserScrollResult,
  BrowserBackResult,
  BrowserReloadResult,
  BrowserProfileCreateResult,
  BrowserProfileDeleteResult,
  BrowserProfileListResult,
  BrowserScreenshotResult,
  BrowserEvalResult,
  BrowserTabCurrentResult,
  BrowserTabListResult,
  BrowserTabProfileCloneResult,
  BrowserTabProfileShowResult,
  BrowserTabSetProfileResult,
  BrowserTabShowResult,
  BrowserTabSwitchResult,
  BrowserHoverResult,
  BrowserDragResult,
  BrowserUploadResult,
  BrowserWaitResult,
  BrowserCheckResult,
  BrowserFocusResult,
  BrowserClearResult,
  BrowserSelectAllResult,
  BrowserKeypressResult,
  BrowserPdfResult,
  BrowserCookieGetResult,
  BrowserCookieSetResult,
  BrowserCookieDeleteResult,
  BrowserViewportResult,
  BrowserGeolocationResult,
  BrowserInterceptEnableResult,
  BrowserInterceptDisableResult,
  BrowserCaptureStartResult,
  BrowserCaptureStopResult,
  BrowserConsoleResult,
  BrowserNetworkLogResult
} from '../../shared/runtime-types'
import { BrowserWindow, ipcMain } from 'electron'
import type { AgentBrowserBridge } from '../browser/agent-browser-bridge'
import { browserManager } from '../browser/browser-manager'
import { BrowserError } from '../browser/cdp-bridge'
import { browserSessionRegistry } from '../browser/browser-session-registry'
import { waitForTabRegistration } from '../ipc/browser'
import { getPRForBranch } from '../github/client'
import {
  getGitUsername,
  getDefaultBaseRef,
  getBranchConflictKind,
  isGitRepo,
  getRepoName,
  searchBaseRefs,
  getRemoteDrift,
  getRecentDriftSubjects
} from '../git/repo'
import { listWorktrees, addWorktree, removeWorktree } from '../git/worktree'
import {
  createSetupRunnerScript,
  getEffectiveHooks,
  getEffectiveSetupRunPolicy,
  hasHooksFile,
  runHook,
  shouldRunSetupForCreate
} from '../hooks'
import { REPO_COLORS } from '../../shared/constants'
import { listRepoWorktrees } from '../repo-worktrees'
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
import { invalidateAuthorizedRootsCache } from '../ipc/filesystem-auth'
import { HeadlessEmulator } from '../daemon/headless-emulator'
import { killAllProcessesForWorktree } from './worktree-teardown'
import { MOBILE_SUBSCRIBE_SCROLLBACK_ROWS } from './scrollback-limits'
import type { IPtyProvider } from '../providers/types'

type RuntimeStore = {
  getRepos: Store['getRepos']
  getRepo: Store['getRepo']
  addRepo: Store['addRepo']
  updateRepo: Store['updateRepo']
  getAllWorktreeMeta: Store['getAllWorktreeMeta']
  getWorktreeMeta: Store['getWorktreeMeta']
  setWorktreeMeta: Store['setWorktreeMeta']
  removeWorktreeMeta: Store['removeWorktreeMeta']
  getGitHubCache: Store['getGitHubCache']
  getWorkspaceSession?: Store['getWorkspaceSession']
  getSettings(): {
    workspaceDir: string
    nestWorkspaces: boolean
    refreshLocalBaseRefOnWorktreeCreate: boolean
    branchPrefix: string
    branchPrefixCustom: string
  }
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
  connected: boolean
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
  write(ptyId: string, data: string): boolean
  kill(ptyId: string): boolean
  getForegroundProcess(ptyId: string): Promise<string | null>
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
  reposChanged(): void
  activateWorktree(
    repoId: string,
    worktreeId: string,
    setup?: CreateWorktreeResult['setup'],
    startup?: WorktreeStartupLaunch
  ): void
  createTerminal(worktreeId: string, opts: { command?: string; title?: string }): void
  splitTerminal(
    tabId: string,
    paneRuntimeId: number,
    opts: { direction: 'horizontal' | 'vertical'; command?: string }
  ): void
  renameTerminal(tabId: string, title: string | null): void
  focusTerminal(tabId: string, worktreeId: string): void
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

type ResolvedWorktree = {
  id: string
  repoId: string
  path: string
  branch: string
  linkedIssue: number | null
  git: {
    path: string
    head: string
    branch: string
    isBare: boolean
    isMainWorktree: boolean
  }
  displayName: string
  comment: string
}

type BrowserCommandTargetParams = {
  worktree?: string
  page?: string
}

type ResolvedBrowserCommandTarget = {
  worktreeId?: string
  browserPageId?: string
}

type ResolvedWorktreeCache = {
  expiresAt: number
  worktrees: ResolvedWorktree[]
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
export type DriverState =
  | { kind: 'idle' }
  | { kind: 'desktop' }
  | { kind: 'mobile'; clientId: string }

export class OrcaRuntimeService {
  private readonly runtimeId = randomUUID()
  private readonly startedAt = Date.now()
  private readonly store: RuntimeStore | null
  private rendererGraphEpoch = 0
  private graphStatus: RuntimeGraphStatus = 'unavailable'
  private authoritativeWindowId: number | null = null
  private tabs = new Map<string, RuntimeSyncedTab>()
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
  private subscriptionCleanups = new Map<string, () => void>()
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

  // Why: server-authoritative display mode per terminal. 'auto' (default) means
  // phone-fit when mobile subscribes, desktop otherwise. 'phone'/'desktop' lock
  // the mode regardless of subscriber state. In-memory only — modes reset on restart.
  private mobileDisplayModes = new Map<string, 'auto' | 'phone' | 'desktop'>()

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
  private resizeListeners = new Map<
    string,
    Set<(event: { cols: number; rows: number; displayMode: string; reason: string }) => void>
  >()

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
  private fetchInflight = new Map<string, Promise<void>>()
  private fetchLastCompletedAt = new Map<string, number>()
  private readonly getLocalProviderFn: (() => IPtyProvider) | null

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
      liveLeafCount: this.leaves.size
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
          preview: existing?.ptyId === leaf.ptyId ? existing.preview : ''
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
    }

    for (const leaf of this.leaves.values()) {
      if (leaf.ptyId !== ptyId) {
        continue
      }
      this.recordPtyWorktree(ptyId, leaf.worktreeId, {
        connected: true,
        lastOutputAt: pty?.lastOutputAt ?? at,
        preview: pty?.preview ?? leaf.preview
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

  registerSubscriptionCleanup(subscriptionId: string, cleanup: () => void): void {
    // Why: mobile clients reconnect frequently (phone lock, network switch).
    // The RPC client re-sends terminal.subscribe on reconnect, creating a new
    // handler before the old one is cleaned up. Without this, the old data
    // listener leaks in dataListeners and duplicates every PTY data event.
    const existing = this.subscriptionCleanups.get(subscriptionId)
    if (existing) {
      existing()
    }
    this.subscriptionCleanups.set(subscriptionId, cleanup)
  }

  cleanupSubscription(subscriptionId: string): void {
    const cleanup = this.subscriptionCleanups.get(subscriptionId)
    if (cleanup) {
      this.subscriptionCleanups.delete(subscriptionId)
      cleanup()
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

  // ─── Mobile Fit Override Management ─────────────────────────

  resizeForClient(
    ptyId: string,
    mode: 'mobile-fit' | 'restore',
    clientId: string,
    cols?: number,
    rows?: number
  ): {
    cols: number
    rows: number
    previousCols: number | null
    previousRows: number | null
    mode: 'mobile-fit' | 'desktop-fit'
  } {
    if (mode === 'mobile-fit') {
      if (cols == null || rows == null || !Number.isFinite(cols) || !Number.isFinite(rows)) {
        throw new Error('invalid_dimensions')
      }
      const clampedCols = Math.max(20, Math.min(240, Math.round(cols)))
      const clampedRows = Math.max(8, Math.min(120, Math.round(rows)))

      const currentSize = this.getTerminalSize(ptyId)
      const existing = this.terminalFitOverrides.get(ptyId)
      // Why: preserve the original desktop size from before any mobile-fit,
      // so restore returns to the right dimensions even after multiple re-fits.
      const previousCols = existing?.previousCols ?? currentSize?.cols ?? null
      const previousRows = existing?.previousRows ?? currentSize?.rows ?? null

      this.terminalFitOverrides.set(ptyId, {
        mode: 'mobile-fit',
        cols: clampedCols,
        rows: clampedRows,
        previousCols,
        previousRows,
        updatedAt: Date.now(),
        clientId
      })

      const resized = this.ptyController?.resize?.(ptyId, clampedCols, clampedRows)
      if (!resized) {
        this.terminalFitOverrides.delete(ptyId)
        throw new Error('resize_failed')
      }
      this.resizeHeadlessTerminal(ptyId, clampedCols, clampedRows)

      console.log(
        `[mobile-fit] handleMobileSubscribe notifier=${!!this.notifier} ptyId=${ptyId} mode=mobile-fit cols=${clampedCols} rows=${clampedRows}`
      )
      this.notifier?.terminalFitOverrideChanged(ptyId, 'mobile-fit', clampedCols, clampedRows)

      // Why: mobile-fit via resizeForClient is a deliberate mobile action;
      // the actor takes the floor. mobileTookFloor updates the actor's
      // lastActedAt and re-applies phone-fit if previously in desktop mode.
      this.mobileTookFloor(ptyId, clientId)

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
    // Why: only the owning client can restore, preventing one phone from
    // undoing another phone's active fit.
    if (override.clientId !== clientId) {
      throw new Error('not_override_owner')
    }

    const { previousCols: prevCols, previousRows: prevRows } = override
    this.terminalFitOverrides.delete(ptyId)

    // Why: always resize the PTY back to pre-fit dimensions immediately,
    // even for mounted leaves. Relying solely on the renderer chain
    // (IPC notification → safeFit → fitAddon.fit → onResize → transport.resize)
    // is fragile — any async gap leaves the PTY at phone dims while xterm
    // looks correct, causing text to wrap at the wrong column. The renderer
    // will still run safeFit and may send a second resize with the exact
    // current pane geometry, which is harmless (SIGWINCH is idempotent).
    if (prevCols != null && prevRows != null) {
      this.ptyController?.resize?.(ptyId, prevCols, prevRows)
      this.resizeHeadlessTerminal(ptyId, prevCols, prevRows)
    }

    // Why: send the restored dimensions so the renderer can fall back to a
    // direct terminal.resize() if fitAddon.fit() silently fails. The renderer
    // normally computes desktop dims from the container, but passing them here
    // provides a guaranteed fallback to avoid leaving xterm at phone dims.
    this.notifier?.terminalFitOverrideChanged(ptyId, 'desktop-fit', prevCols ?? 0, prevRows ?? 0)
    // Why: mobile clients subscribed to this terminal need to know the desktop
    // restored, so they can update their UI (clear fitted state, resubscribe).
    this.notifyFitOverrideListeners(ptyId, 'desktop-fit', prevCols ?? 0, prevRows ?? 0)

    return {
      cols: prevCols ?? 0,
      rows: prevRows ?? 0,
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

  onClientDisconnected(clientId: string): void {
    // Cancel all pending restore timers for this client — the client is gone,
    // so the debounce is meaningless and could fire against a stale PTY state.
    for (const [ptyId, entry] of this.pendingRestoreTimers) {
      if (entry.clientId === clientId) {
        clearTimeout(entry.timer)
        this.pendingRestoreTimers.delete(ptyId)
      }
    }
    // Why: if the disconnecting client was in soft-leave grace, the grace
    // is meaningless now (the client is gone for real). Promote each
    // matching grace into immediate finalization: restore PTY dims to the
    // captured baseline, drop driver to idle, and clear fit overrides.
    // Without this, a phone that exited the screen (router.back → WS
    // close) would leave the PTY stuck at phone dims forever — the soft
    // grace held the inner-map empty so the mobileSubscribers loop below
    // can't see it, and the 300ms restore timer could mis-fire after the
    // grace if the PTY had already been mutated.
    for (const [ptyId, soft] of this.pendingSoftLeavers) {
      if (soft.clientId !== clientId) {
        continue
      }
      clearTimeout(soft.timer)
      this.pendingSoftLeavers.delete(ptyId)

      // Cancel any in-flight 300ms restore timer too — we'll do it now.
      const pending = this.pendingRestoreTimers.get(ptyId)
      if (pending) {
        clearTimeout(pending.timer)
        this.pendingRestoreTimers.delete(ptyId)
      }

      const mode = this.mobileDisplayModes.get(ptyId) ?? 'auto'
      const { previousCols, previousRows, wasResizedToPhone } = soft.record
      if (mode === 'auto' && wasResizedToPhone) {
        const fallback = this.lastRendererSizes.get(ptyId)
        const cols = previousCols ?? fallback?.cols ?? null
        const rows = previousRows ?? fallback?.rows ?? null
        if (cols != null && rows != null) {
          this.ptyController?.resize?.(ptyId, cols, rows)
          this.resizeHeadlessTerminal(ptyId, cols, rows)
        }
        this.lastRendererSizes.delete(ptyId)
        this.suppressResizesForMs(500)
        this.terminalFitOverrides.delete(ptyId)
        this.notifier?.terminalFitOverrideChanged(ptyId, 'desktop-fit', cols ?? 0, rows ?? 0)
        this.notifyFitOverrideListeners(ptyId, 'desktop-fit', cols ?? 0, rows ?? 0)
      }
      this.setDriver(ptyId, { kind: 'idle' })
    }

    // Immediately restore PTYs that this client had phone-fitted (no debounce —
    // client is gone, no point waiting for a re-subscribe that won't come).
    // With the multi-mobile rekey, only the disconnecting client's record is
    // removed from the inner map; peer mobile clients keep the floor and the
    // banner stays mounted.
    const ptysWithSurvivingPeers: string[] = []
    for (const [ptyId, inner] of this.mobileSubscribers) {
      const subscriber = inner.get(clientId)
      if (!subscriber) {
        continue
      }
      const wasResizedToPhone = subscriber.wasResizedToPhone
      const { previousCols, previousRows } = subscriber
      inner.delete(clientId)
      if (inner.size > 0) {
        ptysWithSurvivingPeers.push(ptyId)
        continue
      }
      this.mobileSubscribers.delete(ptyId)
      if (wasResizedToPhone) {
        if (previousCols != null && previousRows != null) {
          this.ptyController?.resize?.(ptyId, previousCols, previousRows)
          this.resizeHeadlessTerminal(ptyId, previousCols, previousRows)
        }
        this.terminalFitOverrides.delete(ptyId)
        this.notifier?.terminalFitOverrideChanged(
          ptyId,
          'desktop-fit',
          previousCols ?? 0,
          previousRows ?? 0
        )
        this.notifyFitOverrideListeners(ptyId, 'desktop-fit', previousCols ?? 0, previousRows ?? 0)
      }
      this.setDriver(ptyId, { kind: 'idle' })
    }
    // Why: if peers survived but the disconnecting client was the active
    // driver, re-elect the most-recent surviving subscriber as the driver
    // and re-fit if needed. This keeps the lock/dim-selection invariant.
    for (const ptyId of ptysWithSurvivingPeers) {
      const driver = this.getDriver(ptyId)
      if (driver.kind === 'mobile' && driver.clientId === clientId) {
        const inner = this.mobileSubscribers.get(ptyId)
        const next = inner ? this.pickMostRecentActor(inner) : null
        if (next) {
          this.setDriver(ptyId, { kind: 'mobile', clientId: next.clientId })
          this.applyMobileDisplayMode(ptyId)
        }
      }
    }

    // Legacy cleanup for any terminalFitOverrides not covered by mobileSubscribers
    for (const [ptyId, override] of this.terminalFitOverrides) {
      if (override.clientId !== clientId) {
        continue
      }
      try {
        this.resizeForClient(ptyId, 'restore', clientId)
      } catch {
        this.terminalFitOverrides.delete(ptyId)
        this.notifier?.terminalFitOverrideChanged(ptyId, 'desktop-fit', 0, 0)
        this.notifyFitOverrideListeners(ptyId, 'desktop-fit', 0, 0)
      }
    }
  }

  onPtyExit(ptyId: string, exitCode: number): void {
    // Clean up new mobile state for this PTY
    this.mobileSubscribers.delete(ptyId)
    this.mobileDisplayModes.delete(ptyId)
    this.resizeListeners.delete(ptyId)
    this.lastRendererSizes.delete(ptyId)
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
  }

  // Why: invoked from mobile RPC method handlers (terminal.send / setDisplayMode /
  // resizeForClient / fresh subscribe with auto/phone). Records the actor as
  // the most recent mobile driver and re-applies phone-fit if we were previously
  // in `desktop` mode (mobile reclaims a take-back). Mobile-to-mobile hand-offs
  // are no-ops for resize.
  mobileTookFloor(ptyId: string, clientId: string): void {
    const inner = this.mobileSubscribers.get(ptyId)
    const sub = inner?.get(clientId)
    if (sub) {
      sub.lastActedAt = Date.now()
    }
    const prev = this.getDriver(ptyId)
    const currentMode = this.mobileDisplayModes.get(ptyId)
    // Why: a deliberate mobile action implies mobile is resuming control.
    // If the display mode is currently 'desktop' (set by an earlier
    // take-back), flip it back to 'auto' and re-apply so phone-fit takes
    // hold again. Without flipping the mode, applyMobileDisplayMode would
    // take the desktop branch and leave the PTY at desktop dims while the
    // driver says `mobile`. The same path also covers the case where the
    // driver flipped to `desktop` and we're returning to mobile control.
    // See docs/mobile-presence-lock.md.
    if (prev.kind === 'desktop' || currentMode === 'desktop') {
      if (currentMode === 'desktop' || currentMode === undefined) {
        this.mobileDisplayModes.set(ptyId, 'auto')
      }
      this.applyMobileDisplayMode(ptyId)
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
  updateMobileViewport(
    ptyId: string,
    clientId: string,
    viewport: { cols: number; rows: number }
  ): boolean {
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

    const currentSize = this.getTerminalSize(ptyId)
    const alreadyAtTarget = currentSize?.cols === clampedCols && currentSize?.rows === clampedRows
    if (!alreadyAtTarget) {
      this.ptyController?.resize?.(ptyId, clampedCols, clampedRows)
      this.resizeHeadlessTerminal(ptyId, clampedCols, clampedRows)
    }

    sub.wasResizedToPhone = true
    this.terminalFitOverrides.set(ptyId, {
      mode: 'mobile-fit',
      cols: clampedCols,
      rows: clampedRows,
      previousCols: sub.previousCols,
      previousRows: sub.previousRows,
      updatedAt: Date.now(),
      clientId
    })
    this.notifier?.terminalFitOverrideChanged(ptyId, 'mobile-fit', clampedCols, clampedRows)

    // Why: emit a 'resized' event on the mobile subscription stream so the
    // mobile xterm reinits inline at the new dims — same shape as a
    // setDisplayMode-triggered resize, so the existing client-side handler
    // path applies without changes.
    this.notifyTerminalResize(ptyId, {
      cols: clampedCols,
      rows: clampedRows,
      displayMode: mode,
      reason: 'viewport-update'
    })

    // The driver is already mobile{this client} when we got here; refresh it
    // to update lastActedAt-based ordering on later actor selection.
    this.setDriver(ptyId, { kind: 'mobile', clientId })
    return true
  }

  // Why: invoked from `runtime:restoreTerminalFit` IPC (the desktop "Take
  // back" button). Forces the PTY back to desktop dims and flips the driver
  // to `desktop`, suppressing further mobile-driven dim changes until a
  // mobile actor takes the floor again.
  reclaimTerminalForDesktop(ptyId: string): boolean {
    if (!this.isMobileSubscriberActive(ptyId)) {
      return false
    }
    this.setMobileDisplayMode(ptyId, 'desktop')
    this.applyMobileDisplayMode(ptyId)
    this.setDriver(ptyId, { kind: 'desktop' })
    return true
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

  // ─── Server-Authoritative Mobile Display Mode ─────────────────────

  setMobileDisplayMode(ptyId: string, mode: 'auto' | 'phone' | 'desktop'): void {
    if (mode === 'auto') {
      this.mobileDisplayModes.delete(ptyId)
    } else {
      this.mobileDisplayModes.set(ptyId, mode)
    }
  }

  getMobileDisplayMode(ptyId: string): 'auto' | 'phone' | 'desktop' {
    return this.mobileDisplayModes.get(ptyId) ?? 'auto'
  }

  isMobileSubscriberActive(ptyId: string): boolean {
    const inner = this.mobileSubscribers.get(ptyId)
    return inner !== undefined && inner.size > 0
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
  handleMobileSubscribe(
    ptyId: string,
    clientId: string,
    viewport?: { cols: number; rows: number }
  ): boolean {
    const mode = this.mobileDisplayModes.get(ptyId) ?? 'auto'
    if (!viewport) {
      return false
    }

    // Why: cancel ALL pending restore timers for this ptyId on any new
    // subscribe — the timer is keyed by ptyId+old-clientId but with the
    // multi-mobile rekey, "any new subscriber" supersedes "any old client's
    // restore". Without this, A unsub → B sub within 300ms could fire A's
    // timer and snap PTY to desktop dims while B is meant to drive.
    const pendingRestore = this.pendingRestoreTimers.get(ptyId)
    if (pendingRestore) {
      clearTimeout(pendingRestore.timer)
      this.pendingRestoreTimers.delete(ptyId)
    }

    // Why: resubscribe-grace honor. If the same client just unsubscribed
    // within the soft-leave window, restore its prior record (preserving
    // previousCols/Rows so we don't capture an already-phone-fitted PTY
    // size as the new baseline). The driver state was kept at
    // mobile{clientId} during the window, so no banner flash occurred.
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
        // Refresh viewport from the new subscribe payload — the keyboard
        // state may have changed during the window.
        viewport,
        lastActedAt: Date.now()
      })
      // The driver was already mobile{clientId}; refresh to update
      // listener wiring (and re-emit, harmless if unchanged).
      this.setDriver(ptyId, { kind: 'mobile', clientId })
      // If display-mode is auto/phone, reapply the fit at the new viewport
      // so a keyboard show/hide that resubscribes (older clients) still
      // updates dims correctly. updateMobileViewport is the preferred path
      // and avoids the unsubscribe → subscribe cycle entirely.
      if (mode !== 'desktop') {
        this.applyMobileDisplayMode(ptyId)
      }
      return true
    }

    let inner = this.mobileSubscribers.get(ptyId)
    if (!inner) {
      inner = new Map()
      this.mobileSubscribers.set(ptyId, inner)
    }

    // Why: prefer lastRendererSizes (the actual pane geometry reported by the
    // desktop renderer's safeFit via pty:resize IPC) over getTerminalSize (the
    // server-side PTY size, which may be stale — e.g. 214 full-width when the
    // pane is actually in a split at ~105). Fall back to existing subscriber's
    // previousCols (re-subscribe case) then currentSize (first subscribe).
    //
    // Multi-mobile: if an existing subscriber on this PTY is already
    // phone-fitted, the current PTY size is NOT a valid restore baseline for
    // a *new* subscriber — it would point to a phone-fit dim, not the
    // pre-mobile desktop size. Set previousCols/Rows to null so the new
    // joiner is skipped from earliest-restore selection; the original
    // subscriber's captured baseline remains the source of truth. See
    // docs/mobile-presence-lock.md.
    const existing = inner.get(clientId)
    const someoneAlreadyFitted = [...inner.values()].some((s) => s.wasResizedToPhone)
    const currentSize = this.getTerminalSize(ptyId)
    const rendererSize = this.lastRendererSizes.get(ptyId)
    const previousCols =
      existing?.previousCols ??
      (someoneAlreadyFitted ? null : (rendererSize?.cols ?? currentSize?.cols ?? null))
    const previousRows =
      existing?.previousRows ??
      (someoneAlreadyFitted ? null : (rendererSize?.rows ?? currentSize?.rows ?? null))
    const now = Date.now()
    const subscribedAt = existing?.subscribedAt ?? now

    if (mode === 'desktop') {
      // Why: set previousCols/Rows to null so we don't capture a stale PTY
      // size that may not match the actual pane geometry (e.g. 214 when the
      // pane is in a split at 105). When the user later toggles to auto/phone,
      // handleMobileSubscribe will capture currentSize at that point, which
      // will be correct because safeFit has had time to adjust the PTY.
      inner.set(clientId, {
        clientId,
        viewport,
        wasResizedToPhone: false,
        previousCols: null,
        previousRows: null,
        subscribedAt,
        lastActedAt: now
      })
      // Subscribe-in-desktop-mode is passive: leave driver at idle/desktop.
      // Do not transition to mobile{clientId}.
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

    const clampedCols = Math.max(20, Math.min(240, Math.round(viewport.cols)))
    const clampedRows = Math.max(8, Math.min(120, Math.round(viewport.rows)))

    // Why: skip the PTY resize if already at the target dims. Re-subscribing
    // to a terminal that was left at phone dims (no restore on tab switch)
    // should not trigger another SIGWINCH → shell prompt redraw.
    const alreadyAtTarget = currentSize?.cols === clampedCols && currentSize?.rows === clampedRows
    if (!alreadyAtTarget) {
      this.ptyController?.resize?.(ptyId, clampedCols, clampedRows)
      this.resizeHeadlessTerminal(ptyId, clampedCols, clampedRows)
    }
    this.notifier?.terminalFitOverrideChanged(ptyId, 'mobile-fit', clampedCols, clampedRows)

    // Update terminalFitOverrides for desktop safeFit compatibility
    this.terminalFitOverrides.set(ptyId, {
      mode: 'mobile-fit',
      cols: clampedCols,
      rows: clampedRows,
      previousCols,
      previousRows,
      updatedAt: Date.now(),
      clientId
    })

    // Subscribe-fresh with auto/phone mode counts as "take the floor".
    this.setDriver(ptyId, { kind: 'mobile', clientId })

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

    // Why: snapshot the earliest-by-subscribe-time restore target BEFORE
    // mutating the inner map. If the disconnecting client is the original
    // baseline-holder, that information must survive into the last-leaver
    // restore path even after their record is deleted. See
    // docs/mobile-presence-lock.md "Restore-target selection".
    const restoreTargetSnapshot = this.pickEarliestRestoreTarget(inner)
    inner.delete(clientId)

    if (inner.size > 0) {
      // Why: if the leaving client was the only one with a non-null restore
      // baseline (typical when peer joiners subscribed against an
      // already-phone-fitted PTY and got null prevCols), donate the baseline
      // to the earliest surviving subscriber so a future last-leaver can
      // still restore correctly. Without this, A leaves first, B leaves
      // last with null prevCols → no restore fires. See
      // docs/mobile-presence-lock.md.
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
          this.applyMobileDisplayMode(ptyId)
        }
      }
      return
    }

    // Last subscriber leaving — clean up.
    this.mobileSubscribers.delete(ptyId)
    const mode = this.mobileDisplayModes.get(ptyId) ?? 'auto'

    // Why: resubscribe-grace. Hold the driver=mobile{clientId} state and
    // the leaving subscriber's record for ~250ms. If the same client
    // re-subscribes in that window, handleMobileSubscribe cancels the
    // pending-soft-leaver and re-inserts the record (preserving
    // previousCols and avoiding a desktop-banner flash). Otherwise the
    // grace timer fires, sets driver=idle, and lets the existing 300ms
    // restore debounce (kept below) run as before.
    const SOFT_LEAVE_GRACE_MS = 250
    const existingSoft = this.pendingSoftLeavers.get(ptyId)
    if (existingSoft) {
      clearTimeout(existingSoft.timer)
      this.pendingSoftLeavers.delete(ptyId)
    }
    const softTimer = setTimeout(() => {
      this.pendingSoftLeavers.delete(ptyId)
      // Why: only flip to idle if no peer has reclaimed in the meantime.
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
      const existing = this.pendingRestoreTimers.get(ptyId)
      if (existing) {
        clearTimeout(existing.timer)
      }

      // Restore target: earliest-by-subscribe-time among non-null
      // previousCols/Rows captured BEFORE deletion. Falls back to the
      // disconnecting subscriber's own dims and finally lastRendererSizes
      // (matches the existing first-insert capture path).
      const fallback = this.lastRendererSizes.get(ptyId)
      const previousCols =
        restoreTargetSnapshot?.previousCols ?? subscriber.previousCols ?? fallback?.cols ?? null
      const previousRows =
        restoreTargetSnapshot?.previousRows ?? subscriber.previousRows ?? fallback?.rows ?? null
      const timer = setTimeout(() => {
        this.pendingRestoreTimers.delete(ptyId)
        if (this.isMobileSubscriberActive(ptyId)) {
          return
        }
        if (previousCols != null && previousRows != null) {
          this.ptyController?.resize?.(ptyId, previousCols, previousRows)
          this.resizeHeadlessTerminal(ptyId, previousCols, previousRows)
        }
        this.lastRendererSizes.delete(ptyId)
        this.suppressResizesForMs(500)
        this.terminalFitOverrides.delete(ptyId)
        this.notifier?.terminalFitOverrideChanged(
          ptyId,
          'desktop-fit',
          previousCols ?? 0,
          previousRows ?? 0
        )
        this.notifyFitOverrideListeners(ptyId, 'desktop-fit', previousCols ?? 0, previousRows ?? 0)
      }, 300)

      this.pendingRestoreTimers.set(ptyId, { timer, clientId })
    }
    // 'phone' mode: keep phone dims (no restore needed)
    // 'desktop' mode: was never resized, nothing to restore
  }

  // Why: called when mode changes via terminal.setDisplayMode. Applies the
  // mode change immediately if there's an active subscriber, and emits a
  // 'resized' event so the mobile client can reinitialize xterm inline.
  //
  // Multi-mobile: the most recent mobile actor's viewport drives the active
  // phone-fit dims. The earliest-by-subscribe-time subscriber's
  // previousCols/Rows drive the desktop-restore target.
  applyMobileDisplayMode(ptyId: string): void {
    const mode = this.mobileDisplayModes.get(ptyId) ?? 'auto'
    const inner = this.mobileSubscribers.get(ptyId)
    const subscriber = inner ? this.pickMostRecentActor(inner) : null
    const subscriberRecord = subscriber && inner ? inner.get(subscriber.clientId) : null

    if (mode === 'desktop') {
      // Find the first subscriber (any clientId) that was previously
      // phone-fitted, and reset its flag. The desktop-restore target uses
      // earliest-by-subscribe-time among non-null prevCols/Rows.
      if (inner) {
        const restore = this.pickEarliestRestoreTarget(inner)
        let anyWasResized = false
        for (const sub of inner.values()) {
          if (sub.wasResizedToPhone) {
            anyWasResized = true
            sub.wasResizedToPhone = false
          }
        }
        if (anyWasResized && restore) {
          this.ptyController?.resize?.(ptyId, restore.previousCols, restore.previousRows)
          this.resizeHeadlessTerminal(ptyId, restore.previousCols, restore.previousRows)
          // Why: clear stale renderer size so the next mobile subscribe falls
          // through to currentSize (which is correct after the server restore).
          // Without this, a polluted 214 from a prior collateral safeFit cascade
          // persists in lastRendererSizes and gets used as previousCols.
          this.lastRendererSizes.delete(ptyId)
          // Why: 500ms not 200ms — the desktop renderer's collateral safeFit
          // cascade (IPC → React re-render → rAF → DOM measure → IPC back)
          // takes ~360ms to propagate to background-tab terminals.
          this.suppressResizesForMs(500)
          this.terminalFitOverrides.delete(ptyId)
          this.notifier?.terminalFitOverrideChanged(
            ptyId,
            'desktop-fit',
            restore.previousCols,
            restore.previousRows
          )
        }
      }
      const size = this.getTerminalSize(ptyId)
      this.notifyTerminalResize(ptyId, {
        cols: size?.cols ?? 0,
        rows: size?.rows ?? 0,
        displayMode: 'desktop',
        reason: 'mode-change'
      })
    } else if (mode === 'phone' || mode === 'auto') {
      if (subscriberRecord && !subscriberRecord.wasResizedToPhone) {
        const viewport = subscriberRecord.viewport
        if (viewport) {
          this.handleMobileSubscribe(ptyId, subscriberRecord.clientId, viewport)
        }
      }
      // Why: always emit the mode change even when no resize occurred (e.g.
      // subscriber missing, wasResizedToPhone already true, or no viewport).
      // Without this the mobile client never learns the mode changed and its
      // toggle button gets stuck showing the old state.
      const size = this.getTerminalSize(ptyId)
      this.notifyTerminalResize(ptyId, {
        cols: size?.cols ?? 0,
        rows: size?.rows ?? 0,
        displayMode: mode,
        reason: 'mode-change'
      })
    }
  }

  // Why: called from the pty:resize IPC handler whenever the desktop renderer
  // resizes a PTY (e.g. via safeFit after window resize, split, or desktop-mode
  // restore). Stores the renderer-reported size so handleMobileSubscribe can use
  // the actual pane geometry instead of a stale PTY size for previousCols.
  onExternalPtyResize(ptyId: string, cols: number, rows: number): void {
    this.lastRendererSizes.set(ptyId, { cols, rows })

    const inner = this.mobileSubscribers.get(ptyId)
    if (!inner) {
      return
    }
    // Capture the renderer-reported size as the next-restore target on any
    // subscriber that hasn't yet been phone-fitted. Subscribers in
    // wasResizedToPhone state already have a captured pre-fit baseline.
    for (const sub of inner.values()) {
      if (!sub.wasResizedToPhone) {
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
    listener: (event: { cols: number; rows: number; displayMode: string; reason: string }) => void
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
    event: { cols: number; rows: number; displayMode: string; reason: string }
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
      ? (await this.resolveWorktreeSelector(worktreeSelector)).id
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
      const wrote = this.ptyController?.write(pty.pty.ptyId, payload) ?? false
      if (!wrote) {
        throw new Error('terminal_not_writable')
      }
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

    // Why: TUI apps (Claude Code, etc.) treat a single large write as a paste
    // event. If \r is included in the same write as multi-line text, the TUI
    // interprets it as part of the paste rather than a discrete Enter keypress.
    // Splitting the text and the trailing control characters into separate
    // writes with a small delay ensures the TUI processes the paste first,
    // then receives Enter as a distinct input event.
    const hasText = typeof action.text === 'string' && action.text.length > 0
    const hasSuffix = action.enter || action.interrupt
    if (hasText && hasSuffix) {
      const textWrote = this.ptyController?.write(leaf.ptyId, action.text!) ?? false
      if (!textWrote) {
        throw new Error('terminal_not_writable')
      }
      const suffix = (action.enter ? '\r' : '') + (action.interrupt ? '\x03' : '')
      await new Promise((resolve) => setTimeout(resolve, 500))
      const suffixWrote = this.ptyController?.write(leaf.ptyId, suffix) ?? false
      if (!suffixWrote) {
        throw new Error('terminal_not_writable')
      }
    } else {
      const wrote = this.ptyController?.write(leaf.ptyId, payload) ?? false
      if (!wrote) {
        throw new Error('terminal_not_writable')
      }
    }

    return {
      handle,
      accepted: true,
      bytesWritten: Buffer.byteLength(payload, 'utf8')
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
    if (kind === 'git' && !isGitRepo(path)) {
      throw new Error(`Not a valid git repository: ${path}`)
    }

    const existing = this.store.getRepos().find((repo) => repo.path === path)
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
    const refs = await searchBaseRefs(repo.path, query, limit + 1)
    return {
      refs: refs.slice(0, limit),
      truncated: refs.length > limit
    }
  }

  async getRepoHooks(repoSelector: string) {
    const repo = await this.resolveRepoSelector(repoSelector)
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
    comment?: string
    runHooks?: boolean
    setupDecision?: 'run' | 'skip' | 'inherit'
    startup?: WorktreeStartupLaunch
  }): Promise<CreateWorktreeResult> {
    if (!this.store) {
      throw new Error('runtime_unavailable')
    }

    const repo = await this.resolveRepoSelector(args.repoSelector)
    if (isFolderRepo(repo)) {
      throw new Error('Folder mode does not support creating worktrees.')
    }
    const settings = this.store.getSettings()
    const requestedName = args.name
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

    await addWorktree(
      repo.path,
      worktreePath,
      branchName,
      baseBranch,
      settings.refreshLocalBaseRefOnWorktreeCreate
    )
    const gitWorktrees = await listWorktrees(repo.path)
    const created = gitWorktrees.find((gw) => areWorktreePathsEqual(gw.path, worktreePath))
    if (!created) {
      throw new Error('Worktree created but not found in listing')
    }

    const worktreeId = `${repo.id}::${created.path}`
    const meta = this.store.setWorktreeMeta(worktreeId, {
      lastActivityAt: Date.now(),
      ...(shouldSetDisplayName(requestedName, branchName, sanitizedName)
        ? { displayName: requestedName }
        : {}),
      ...(args.linkedIssue !== undefined ? { linkedIssue: args.linkedIssue } : {}),
      ...(args.comment !== undefined ? { comment: args.comment } : {})
    })
    const worktree = mergeWorktree(repo.id, created, meta)

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

    this.notifier?.worktreesChanged(repo.id)
    // Why: the editor currently creates the first Orca-managed terminal as a
    // renderer-side consequence of activating a worktree. CLI-created
    // worktrees must trigger that same activation path or they will exist on
    // disk without becoming the active workspace in the UI.
    if (args.startup) {
      this.notifier?.activateWorktree(repo.id, worktree.id, setup, args.startup)
    } else {
      this.notifier?.activateWorktree(repo.id, worktree.id, setup)
    }
    this.invalidateResolvedWorktreeCache()
    // Why: the filesystem-auth layer maintains a separate cache of registered
    // worktree roots used by git IPC handlers (branchCompare, diff, status, etc.)
    // to authorize paths. Without invalidating it here, CLI-created worktrees
    // are not recognized and all git operations fail with "Access denied:
    // unknown repository or worktree path".
    invalidateAuthorizedRootsCache()
    return {
      worktree,
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
  async fetchRemoteWithCache(repoPath: string, remote: string): Promise<void> {
    const key = `${repoPath}::${remote}`
    const lastAt = this.fetchLastCompletedAt.get(key)
    if (lastAt !== undefined && Date.now() - lastAt < FETCH_FRESHNESS_MS) {
      // Why: freshness window hit — skip the fetch entirely. Do NOT reuse any
      // in-flight promise here; the timestamp is only written on success, so
      // hitting this branch means a previous fetch did succeed recently.
      return
    }

    const existing = this.fetchInflight.get(key)
    if (existing) {
      // Why: genuine serialization (not check-then-set). Two callers racing
      // on the same repo+remote share the single underlying `git fetch`.
      return existing
    }

    const promise = gitExecFileAsync(['fetch', remote], { cwd: repoPath })
      .then(() => {
        // Why (§3.3 Lifecycle): timestamp on success ONLY. Writing on rejection
        // would make the freshness cache lie about the last known remote state.
        this.fetchLastCompletedAt.set(key, Date.now())
      })
      .catch((err) => {
        // Why: swallow here so awaiters don't throw at the await site. Outer
        // create/dispatch paths are already tolerant of offline fetch failure;
        // this is the behavioral contract of this helper.
        console.warn(`[fetchRemoteWithCache] ${remote} fetch failed for ${repoPath}:`, err)
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
    const base = getDefaultBaseRef(repo.path)
    if (!base) {
      // Why: brand-new repo with no remote primary — nothing to compare
      // against, so there's no meaningful drift to report. Dispatch should
      // not block on a probe that cannot form an opinion.
      return null
    }
    const remote = base.includes('/') ? base.split('/')[0] : 'origin'
    // Why: fetch failures are non-fatal; we proceed with whatever the
    // last-known remote ref points at. `fetchRemoteWithCache` never throws.
    await this.fetchRemoteWithCache(wt.path, remote)
    const drift = getRemoteDrift(wt.path, 'HEAD', base)
    if (!drift) {
      return null
    }
    const recentSubjects = getRecentDriftSubjects(wt.path, 'HEAD', base, DRIFT_PROBE_SUBJECT_LIMIT)
    return { base, behind: drift.behind, recentSubjects }
  }

  async updateManagedWorktreeMeta(
    worktreeSelector: string,
    updates: {
      displayName?: string
      linkedIssue?: number | null
      comment?: string
      isPinned?: boolean
    }
  ) {
    if (!this.store) {
      throw new Error('runtime_unavailable')
    }
    const worktree = await this.resolveWorktreeSelector(worktreeSelector)
    const meta = this.store.setWorktreeMeta(worktree.id, {
      ...(updates.displayName !== undefined ? { displayName: updates.displayName } : {}),
      ...(updates.linkedIssue !== undefined ? { linkedIssue: updates.linkedIssue } : {}),
      ...(updates.comment !== undefined ? { comment: updates.comment } : {}),
      ...(updates.isPinned !== undefined ? { isPinned: updates.isPinned } : {})
    })
    // Why: unlike renderer-initiated optimistic updates, CLI callers need an
    // explicit push so the editor refreshes metadata changed outside the UI.
    this.invalidateResolvedWorktreeCache()
    this.notifier?.worktreesChanged(worktree.repoId)
    return mergeWorktree(worktree.repoId, worktree.git, meta)
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
        await rm(worktree.path, { recursive: true, force: true }).catch(() => {})
        // Why: `git worktree remove` failed, so git's internal worktree tracking
        // (`.git/worktrees/<name>`) is still intact. Without pruning, `git worktree
        // list` continues to show the stale entry and the branch it had checked out
        // remains locked — other worktrees cannot check it out.
        await gitExecFileAsync(['worktree', 'prune'], { cwd: repo.path }).catch(() => {})
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
    const { leaf } = this.getLiveLeafForHandle(handle)
    this.notifier?.renameTerminal(leaf.tabId, title)
    return { handle, tabId: leaf.tabId, title }
  }

  async createTerminal(
    worktreeSelector?: string,
    opts: { command?: string; title?: string } = {}
  ): Promise<RuntimeTerminalCreate> {
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
    return { handle, worktreeId: worktreeId ?? '', title: reply.title }
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
      return { handle, tabId: pty.record.tabId, worktreeId: pty.pty.worktreeId }
    }
    const { leaf } = this.getLiveLeafForHandle(handle)
    this.notifier?.focusTerminal(leaf.tabId, leaf.worktreeId)
    return { handle, tabId: leaf.tabId, worktreeId: leaf.worktreeId }
  }

  async closeTerminal(handle: string): Promise<RuntimeTerminalClose> {
    this.assertGraphReady()
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

    let stopped = 0
    for (const ptyId of ptyIds) {
      if (this.ptyController?.kill(ptyId)) {
        stopped += 1
      }
    }
    return { stopped }
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
      candidates = worktrees.filter((worktree) => worktree.path === selector.slice(5))
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
          worktree.path === selector ||
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

  private async resolveRepoSelector(selector: string): Promise<Repo> {
    if (!this.store) {
      throw new Error('repo_not_found')
    }
    const repos = this.store.getRepos()
    let candidates: Repo[]

    if (selector.startsWith('id:')) {
      candidates = repos.filter((repo) => repo.id === selector.slice(3))
    } else if (selector.startsWith('path:')) {
      candidates = repos.filter((repo) => repo.path === selector.slice(5))
    } else if (selector.startsWith('name:')) {
      candidates = repos.filter((repo) => repo.displayName === selector.slice(5))
    } else {
      candidates = repos.filter(
        (repo) => repo.id === selector || repo.path === selector || repo.displayName === selector
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

  private async listResolvedWorktrees(): Promise<ResolvedWorktree[]> {
    if (!this.store) {
      return []
    }
    const now = Date.now()
    if (this.resolvedWorktreeCache && this.resolvedWorktreeCache.expiresAt > now) {
      return this.resolvedWorktreeCache.worktrees
    }

    const metaById = this.store.getAllWorktreeMeta()
    const worktrees: ResolvedWorktree[] = []
    for (const repo of this.store.getRepos()) {
      const gitWorktrees = await listRepoWorktrees(repo)
      for (const gitWorktree of gitWorktrees) {
        const worktreeId = `${repo.id}::${gitWorktree.path}`
        const merged = mergeWorktree(repo.id, gitWorktree, metaById[worktreeId], repo.displayName)
        worktrees.push({
          id: merged.id,
          repoId: repo.id,
          path: merged.path,
          branch: merged.branch,
          linkedIssue: metaById[worktreeId]?.linkedIssue ?? null,
          git: {
            path: gitWorktree.path,
            head: gitWorktree.head,
            branch: gitWorktree.branch,
            isBare: gitWorktree.isBare,
            isMainWorktree: gitWorktree.isMainWorktree
          },
          displayName: merged.displayName,
          comment: merged.comment
        })
      }
    }
    // Why: terminal polling can be frequent, but git worktree state is still
    // allowed to change outside Orca. A short TTL avoids shelling out on every
    // read without pretending the cache is authoritative for long.
    this.resolvedWorktreeCache = {
      worktrees,
      expiresAt: now + RESOLVED_WORKTREE_CACHE_TTL_MS
    }
    return worktrees
  }

  private async getResolvedWorktreeMap(): Promise<Map<string, ResolvedWorktree>> {
    return new Map((await this.listResolvedWorktrees()).map((worktree) => [worktree.id, worktree]))
  }

  private invalidateResolvedWorktreeCache(): void {
    this.resolvedWorktreeCache = null
  }

  private recordPtyWorktree(
    ptyId: string,
    worktreeId: string,
    state: Partial<Pick<RuntimePtyWorktreeRecord, 'connected' | 'lastOutputAt' | 'preview'>> = {}
  ): RuntimePtyWorktreeRecord {
    let pty = this.ptysById.get(ptyId)
    if (!pty) {
      pty = {
        ptyId,
        worktreeId,
        connected: state.connected ?? true,
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
    const sessions = await this.ptyController.listProcesses().catch(() => [])
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
      title: null,
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
    const record = this.handles.get(handle)
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
      status: pty.connected ? 'running' : 'unknown',
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
    const existingHandle = this.handleByPtyId.get(pty.ptyId)
    if (existingHandle) {
      const existingRecord = this.handles.get(existingHandle)
      if (
        existingRecord &&
        existingRecord.runtimeId === this.runtimeId &&
        existingRecord.ptyId === pty.ptyId
      ) {
        return existingHandle
      }
    }

    const handle = `term_${randomUUID()}`
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

    const unread = this._orchestrationDb.getUnreadMessages(handle)
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

  // ── Browser automation ──

  private requireAgentBrowserBridge(): AgentBrowserBridge {
    if (!this.agentBrowserBridge) {
      throw new BrowserError('browser_no_tab', 'No browser session is active')
    }
    return this.agentBrowserBridge
  }

  // Why: the CLI sends worktree selectors (e.g. "path:/Users/...") but the
  // bridge stores worktreeIds in "repoId::path" format (from the renderer's
  // Zustand store). This helper resolves the selector to the store-compatible
  // ID so the bridge can filter tabs correctly.
  private async resolveBrowserWorktreeId(selector?: string): Promise<string | undefined> {
    if (!selector) {
      // Why: after app restart, webviews only mount when the browser pane is visible.
      // Without --worktree, we still need to activate the view so persisted tabs
      // become operable via registerGuest.
      const bridge = this.agentBrowserBridge
      if (bridge && bridge.getRegisteredTabs().size === 0) {
        try {
          const win = this.getAuthoritativeWindow()
          win.webContents.send('browser:activateView', {})
          await new Promise((resolve) => setTimeout(resolve, 500))
        } catch {
          // Window may not exist yet (e.g. during startup or in tests)
        }
      }
      return undefined
    }

    const worktreeId = (await this.resolveWorktreeSelector(selector)).id
    // Why: explicit worktree selectors are user intent, so resolution errors
    // must surface instead of silently widening browser routing scope. Only the
    // activation step remains best-effort because missing windows during tests
    // or startup should not erase the validated worktree target itself.
    const bridge = this.agentBrowserBridge
    if (bridge && bridge.getRegisteredTabs(worktreeId).size === 0) {
      try {
        await this.ensureBrowserWorktreeActive(worktreeId)
      } catch {
        // Fall through with the validated worktree id so downstream routing
        // still stays scoped to the caller's explicit selector.
      }
    }
    return worktreeId
  }

  private async resolveBrowserCommandTarget(
    params: BrowserCommandTargetParams
  ): Promise<ResolvedBrowserCommandTarget> {
    const browserPageId =
      typeof params.page === 'string' && params.page.length > 0 ? params.page : undefined
    if (!browserPageId) {
      return {
        worktreeId: await this.resolveBrowserWorktreeId(params.worktree)
      }
    }

    return {
      // Why: explicit browserPageId is already a stable tab identity, so we do
      // not auto-resolve cwd worktree scoping on top of it. Only honor an
      // explicit --worktree when the caller asked for that extra validation.
      worktreeId: params.worktree
        ? await this.resolveBrowserWorktreeId(params.worktree)
        : undefined,
      browserPageId
    }
  }

  // Why: browser tabs only mount (and become operable) when their worktree is
  // the active worktree in the renderer AND activeTabType is 'browser'. If either
  // condition is false, the webview stays in display:none and Electron won't start
  // its guest process — dom-ready never fires, registerGuest never runs, and CLI
  // browser commands fail with "CDP connection refused".
  private async ensureBrowserWorktreeActive(worktreeId: string): Promise<void> {
    const win = this.getAuthoritativeWindow()
    const repoId = worktreeId.split('::')[0]
    if (!repoId) {
      return
    }
    win.webContents.send('ui:activateWorktree', { repoId, worktreeId })
    // Why: switching worktree alone sets activeView='terminal'. Browser webviews
    // won't mount until activeTabType is 'browser'. Send a second IPC to flip it.
    win.webContents.send('browser:activateView', { worktreeId })
    // Why: give the renderer time to mount the webview after switching worktrees.
    // The webview needs to attach and fire dom-ready before registerGuest runs.
    await new Promise((resolve) => setTimeout(resolve, 500))
  }

  // Why: agent-browser drives navigation via CDP, which bypasses Electron's
  // webview event system. The renderer's did-navigate / page-title-updated
  // listeners never fire, leaving the Zustand store (and thus the Orca UI's
  // address bar and tab title) stale. Push updates from main → renderer after
  // any navigation-causing command so the UI stays in sync.
  private notifyRendererNavigation(browserPageId: string, url: string, title: string): void {
    try {
      const win = this.getAuthoritativeWindow()
      win.webContents.send('browser:navigation-update', { browserPageId, url, title })
    } catch {
      // Window may not exist during shutdown
    }
  }

  async browserSnapshot(params: BrowserCommandTargetParams): Promise<BrowserSnapshotResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().snapshot(target.worktreeId, target.browserPageId)
  }

  async browserClick(
    params: { element: string } & BrowserCommandTargetParams
  ): Promise<BrowserClickResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    const bridge = this.requireAgentBrowserBridge()
    const result = await bridge.click(params.element, target.worktreeId, target.browserPageId)
    // Why: clicks can trigger navigation (e.g. submitting a form, clicking a link).
    // Read the target tab's live URL/title after the click and push to the
    // renderer so the UI updates even when automation targeted a non-active page.
    const page = bridge.getPageInfo(target.worktreeId, target.browserPageId)
    if (page) {
      this.notifyRendererNavigation(page.browserPageId, page.url, page.title)
    }
    return result
  }

  async browserGoto(
    params: { url: string } & BrowserCommandTargetParams
  ): Promise<BrowserGotoResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    const bridge = this.requireAgentBrowserBridge()
    const result = await bridge.goto(params.url, target.worktreeId, target.browserPageId)
    const pageId = bridge.getActivePageId(target.worktreeId, target.browserPageId)
    if (pageId) {
      this.notifyRendererNavigation(pageId, result.url, result.title)
    }
    return result
  }

  async browserFill(
    params: {
      element: string
      value: string
    } & BrowserCommandTargetParams
  ): Promise<BrowserFillResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().fill(
      params.element,
      params.value,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserType(
    params: { input: string } & BrowserCommandTargetParams
  ): Promise<BrowserTypeResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().type(
      params.input,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserSelect(
    params: {
      element: string
      value: string
    } & BrowserCommandTargetParams
  ): Promise<BrowserSelectResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().select(
      params.element,
      params.value,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserScroll(
    params: { direction: 'up' | 'down'; amount?: number } & BrowserCommandTargetParams
  ): Promise<BrowserScrollResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().scroll(
      params.direction,
      params.amount,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserBack(params: BrowserCommandTargetParams): Promise<BrowserBackResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    const bridge = this.requireAgentBrowserBridge()
    const result = await bridge.back(target.worktreeId, target.browserPageId)
    const pageId = bridge.getActivePageId(target.worktreeId, target.browserPageId)
    if (pageId) {
      this.notifyRendererNavigation(pageId, result.url, result.title)
    }
    return result
  }

  async browserReload(params: BrowserCommandTargetParams): Promise<BrowserReloadResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    const bridge = this.requireAgentBrowserBridge()
    const result = await bridge.reload(target.worktreeId, target.browserPageId)
    const pageId = bridge.getActivePageId(target.worktreeId, target.browserPageId)
    if (pageId) {
      this.notifyRendererNavigation(pageId, result.url, result.title)
    }
    return result
  }

  async browserScreenshot(
    params: {
      format?: 'png' | 'jpeg'
    } & BrowserCommandTargetParams
  ): Promise<BrowserScreenshotResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().screenshot(
      params.format,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserEval(
    params: { expression: string } & BrowserCommandTargetParams
  ): Promise<BrowserEvalResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().evaluate(
      params.expression,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserTabList(params: { worktree?: string }): Promise<BrowserTabListResult> {
    const worktreeId = await this.resolveBrowserWorktreeId(params.worktree)
    const result = this.requireAgentBrowserBridge().tabList(worktreeId)
    return {
      tabs: result.tabs.map((tab) => this.enrichBrowserTabInfo(tab))
    }
  }

  async browserTabShow(params: { page: string; worktree?: string }): Promise<BrowserTabShowResult> {
    const worktreeId = await this.resolveBrowserWorktreeId(params.worktree)
    return { tab: this.describeBrowserTab(params.page, worktreeId) }
  }

  async browserTabCurrent(params: { worktree?: string }): Promise<BrowserTabCurrentResult> {
    const worktreeId = await this.resolveBrowserWorktreeId(params.worktree)
    const browserPageId = this.requireAgentBrowserBridge().getActivePageId(worktreeId)
    if (!browserPageId) {
      throw new BrowserError('browser_no_tab', 'No browser tab open in this worktree')
    }
    return { tab: this.describeBrowserTab(browserPageId, worktreeId) }
  }

  async browserTabSwitch(
    params: {
      index?: number
    } & BrowserCommandTargetParams
  ): Promise<BrowserTabSwitchResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().tabSwitch(
      params.index,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserHover(
    params: { element: string } & BrowserCommandTargetParams
  ): Promise<BrowserHoverResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().hover(
      params.element,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserDrag(
    params: {
      from: string
      to: string
    } & BrowserCommandTargetParams
  ): Promise<BrowserDragResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().drag(
      params.from,
      params.to,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserUpload(
    params: { element: string; files: string[] } & BrowserCommandTargetParams
  ): Promise<BrowserUploadResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().upload(
      params.element,
      params.files,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserWait(
    params: {
      selector?: string
      timeout?: number
      text?: string
      url?: string
      load?: string
      fn?: string
      state?: string
    } & BrowserCommandTargetParams
  ): Promise<BrowserWaitResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    const { worktree: _, page: __, ...options } = params
    return this.requireAgentBrowserBridge().wait(options, target.worktreeId, target.browserPageId)
  }

  async browserCheck(
    params: { element: string; checked: boolean } & BrowserCommandTargetParams
  ): Promise<BrowserCheckResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().check(
      params.element,
      params.checked,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserFocus(
    params: { element: string } & BrowserCommandTargetParams
  ): Promise<BrowserFocusResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().focus(
      params.element,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserClear(
    params: { element: string } & BrowserCommandTargetParams
  ): Promise<BrowserClearResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().clear(
      params.element,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserSelectAll(
    params: { element: string } & BrowserCommandTargetParams
  ): Promise<BrowserSelectAllResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().selectAll(
      params.element,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserKeypress(
    params: { key: string } & BrowserCommandTargetParams
  ): Promise<BrowserKeypressResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().keypress(
      params.key,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserPdf(params: BrowserCommandTargetParams): Promise<BrowserPdfResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().pdf(target.worktreeId, target.browserPageId)
  }

  async browserFullScreenshot(
    params: {
      format?: 'png' | 'jpeg'
    } & BrowserCommandTargetParams
  ): Promise<BrowserScreenshotResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().fullPageScreenshot(
      params.format,
      target.worktreeId,
      target.browserPageId
    )
  }

  // ── Cookie management ──

  async browserCookieGet(
    params: { url?: string } & BrowserCommandTargetParams
  ): Promise<BrowserCookieGetResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().cookieGet(
      params.url,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserCookieSet(
    params: {
      name: string
      value: string
      domain?: string
      path?: string
      secure?: boolean
      httpOnly?: boolean
      sameSite?: string
      expires?: number
    } & BrowserCommandTargetParams
  ): Promise<BrowserCookieSetResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().cookieSet(
      params,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserCookieDelete(
    params: {
      name: string
      domain?: string
      url?: string
    } & BrowserCommandTargetParams
  ): Promise<BrowserCookieDeleteResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().cookieDelete(
      params.name,
      params.domain,
      params.url,
      target.worktreeId,
      target.browserPageId
    )
  }

  // ── Viewport ──

  async browserSetViewport(
    params: {
      width: number
      height: number
      deviceScaleFactor?: number
      mobile?: boolean
    } & BrowserCommandTargetParams
  ): Promise<BrowserViewportResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().setViewport(
      params.width,
      params.height,
      params.deviceScaleFactor,
      params.mobile,
      target.worktreeId,
      target.browserPageId
    )
  }

  // ── Geolocation ──

  async browserSetGeolocation(
    params: {
      latitude: number
      longitude: number
      accuracy?: number
    } & BrowserCommandTargetParams
  ): Promise<BrowserGeolocationResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().setGeolocation(
      params.latitude,
      params.longitude,
      params.accuracy,
      target.worktreeId,
      target.browserPageId
    )
  }

  // ── Request interception ──

  async browserInterceptEnable(
    params: {
      patterns?: string[]
    } & BrowserCommandTargetParams
  ): Promise<BrowserInterceptEnableResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().interceptEnable(
      params.patterns,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserInterceptDisable(
    params: BrowserCommandTargetParams
  ): Promise<BrowserInterceptDisableResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().interceptDisable(
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserInterceptList(params: BrowserCommandTargetParams): Promise<{ requests: unknown[] }> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().interceptList(target.worktreeId, target.browserPageId)
  }

  // ── Console/network capture ──

  async browserCaptureStart(
    params: BrowserCommandTargetParams
  ): Promise<BrowserCaptureStartResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().captureStart(target.worktreeId, target.browserPageId)
  }

  async browserCaptureStop(params: BrowserCommandTargetParams): Promise<BrowserCaptureStopResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().captureStop(target.worktreeId, target.browserPageId)
  }

  async browserConsoleLog(
    params: { limit?: number } & BrowserCommandTargetParams
  ): Promise<BrowserConsoleResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().consoleLog(
      params.limit,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserNetworkLog(
    params: { limit?: number } & BrowserCommandTargetParams
  ): Promise<BrowserNetworkLogResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().networkLog(
      params.limit,
      target.worktreeId,
      target.browserPageId
    )
  }

  // ── Additional core commands ──

  async browserDblclick(
    params: { element: string } & BrowserCommandTargetParams
  ): Promise<unknown> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().dblclick(
      params.element,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserForward(params: BrowserCommandTargetParams): Promise<unknown> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().forward(target.worktreeId, target.browserPageId)
  }

  async browserScrollIntoView(
    params: { element: string } & BrowserCommandTargetParams
  ): Promise<unknown> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().scrollIntoView(
      params.element,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserGet(
    params: {
      what: string
      selector?: string
    } & BrowserCommandTargetParams
  ): Promise<unknown> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().get(
      params.what,
      params.selector,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserIs(
    params: { what: string; selector: string } & BrowserCommandTargetParams
  ): Promise<unknown> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().is(
      params.what,
      params.selector,
      target.worktreeId,
      target.browserPageId
    )
  }

  // ── Keyboard insert text ──

  async browserKeyboardInsertText(
    params: { text: string } & BrowserCommandTargetParams
  ): Promise<unknown> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().keyboardInsertText(
      params.text,
      target.worktreeId,
      target.browserPageId
    )
  }

  // ── Mouse commands ──

  async browserMouseMove(
    params: { x: number; y: number } & BrowserCommandTargetParams
  ): Promise<unknown> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().mouseMove(
      params.x,
      params.y,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserMouseDown(
    params: { button?: string } & BrowserCommandTargetParams
  ): Promise<unknown> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().mouseDown(
      params.button,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserMouseUp(params: { button?: string } & BrowserCommandTargetParams): Promise<unknown> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().mouseUp(
      params.button,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserMouseWheel(
    params: {
      dy: number
      dx?: number
    } & BrowserCommandTargetParams
  ): Promise<unknown> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().mouseWheel(
      params.dy,
      params.dx,
      target.worktreeId,
      target.browserPageId
    )
  }

  // ── Find (semantic locators) ──

  async browserFind(
    params: {
      locator: string
      value: string
      action: string
      text?: string
    } & BrowserCommandTargetParams
  ): Promise<unknown> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().find(
      params.locator,
      params.value,
      params.action,
      params.text,
      target.worktreeId,
      target.browserPageId
    )
  }

  // ── Set commands ──

  async browserSetDevice(params: { name: string } & BrowserCommandTargetParams): Promise<unknown> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().setDevice(
      params.name,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserSetOffline(
    params: { state?: string } & BrowserCommandTargetParams
  ): Promise<unknown> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().setOffline(
      params.state,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserSetHeaders(
    params: { headers: string } & BrowserCommandTargetParams
  ): Promise<unknown> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().setHeaders(
      params.headers,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserSetCredentials(
    params: {
      user: string
      pass: string
    } & BrowserCommandTargetParams
  ): Promise<unknown> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().setCredentials(
      params.user,
      params.pass,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserSetMedia(
    params: {
      colorScheme?: string
      reducedMotion?: string
    } & BrowserCommandTargetParams
  ): Promise<unknown> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().setMedia(
      params.colorScheme,
      params.reducedMotion,
      target.worktreeId,
      target.browserPageId
    )
  }

  // ── Clipboard commands ──

  async browserClipboardRead(params: BrowserCommandTargetParams): Promise<unknown> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().clipboardRead(target.worktreeId, target.browserPageId)
  }

  async browserClipboardWrite(
    params: { text: string } & BrowserCommandTargetParams
  ): Promise<unknown> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().clipboardWrite(
      params.text,
      target.worktreeId,
      target.browserPageId
    )
  }

  // ── Dialog commands ──

  async browserDialogAccept(
    params: { text?: string } & BrowserCommandTargetParams
  ): Promise<unknown> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().dialogAccept(
      params.text,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserDialogDismiss(params: BrowserCommandTargetParams): Promise<unknown> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().dialogDismiss(target.worktreeId, target.browserPageId)
  }

  // ── Storage commands ──

  async browserStorageLocalGet(
    params: { key: string } & BrowserCommandTargetParams
  ): Promise<unknown> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().storageLocalGet(
      params.key,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserStorageLocalSet(
    params: {
      key: string
      value: string
    } & BrowserCommandTargetParams
  ): Promise<unknown> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().storageLocalSet(
      params.key,
      params.value,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserStorageLocalClear(params: BrowserCommandTargetParams): Promise<unknown> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().storageLocalClear(
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserStorageSessionGet(
    params: { key: string } & BrowserCommandTargetParams
  ): Promise<unknown> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().storageSessionGet(
      params.key,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserStorageSessionSet(
    params: {
      key: string
      value: string
    } & BrowserCommandTargetParams
  ): Promise<unknown> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().storageSessionSet(
      params.key,
      params.value,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserStorageSessionClear(params: BrowserCommandTargetParams): Promise<unknown> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().storageSessionClear(
      target.worktreeId,
      target.browserPageId
    )
  }

  // ── Download command ──

  async browserDownload(
    params: {
      selector: string
      path: string
    } & BrowserCommandTargetParams
  ): Promise<unknown> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().download(
      params.selector,
      params.path,
      target.worktreeId,
      target.browserPageId
    )
  }

  // ── Highlight command ──

  async browserHighlight(
    params: { selector: string } & BrowserCommandTargetParams
  ): Promise<unknown> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().highlight(
      params.selector,
      target.worktreeId,
      target.browserPageId
    )
  }

  // ── New: exec passthrough + tab lifecycle ──

  async browserExec(params: { command: string } & BrowserCommandTargetParams): Promise<unknown> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().exec(
      params.command,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserTabCreate(params: {
    url?: string
    worktree?: string
    profileId?: string
  }): Promise<{ browserPageId: string }> {
    const url = params.url ?? 'about:blank'
    const worktreeId = params.worktree
      ? (await this.resolveWorktreeSelector(params.worktree)).id
      : undefined
    const { browserPageId } = await this.createBrowserTabInRenderer(
      url,
      worktreeId,
      params.profileId
    )

    // Why: the renderer creates the Zustand tab immediately, but the webview must
    // mount and fire dom-ready before registerGuest runs. Waiting here ensures the
    // tab is operable by subsequent CLI commands (snapshot, click, etc.).
    // If registration doesn't complete within timeout, return the ID anyway — the
    // tab exists in the UI but may not be ready for automation commands yet.
    try {
      await waitForTabRegistration(browserPageId)
    } catch {
      // Tab was created in the renderer but the webview hasn't finished mounting.
      // Return success since the tab exists; subsequent commands will fail with a
      // clear "tab not available" error if the webview never loads.
    }

    // Why: newly created tabs should be auto-activated so subsequent commands
    // (snapshot, click, goto) target the new tab without requiring an explicit
    // tab switch. Without this, the bridge's active tab still points at the
    // previously active tab and the new tab shows active: false in tab list.
    const bridge = this.requireAgentBrowserBridge()
    const wcId = bridge.getRegisteredTabs(worktreeId).get(browserPageId)
    if (wcId != null) {
      bridge.setActiveTab(wcId, worktreeId)
    }

    // Why: the renderer sets webview.src=url on mount, but agent-browser connects
    // via CDP after the webview loads about:blank. Without an explicit goto, the
    // page stays blank from agent-browser's perspective. Navigate via the bridge
    // so agent-browser's CDP session tracks the correct page state.
    if (url && url !== 'about:blank') {
      try {
        const result = await bridge.goto(url, worktreeId, browserPageId)
        this.notifyRendererNavigation(browserPageId, result.url, result.title)
      } catch {
        // Tab exists but navigation failed — caller can retry with explicit goto
      }
    }

    return { browserPageId }
  }

  async browserTabSetProfile(
    params: {
      profileId: string
    } & BrowserCommandTargetParams
  ): Promise<BrowserTabSetProfileResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    const browserPageId =
      target.browserPageId ?? this.requireAgentBrowserBridge().getActivePageId(target.worktreeId)
    if (!browserPageId) {
      throw new BrowserError('browser_no_tab', 'No browser tab open in this worktree')
    }
    const profile = browserSessionRegistry.getProfile(params.profileId)
    if (!profile) {
      throw new BrowserError(
        'invalid_argument',
        `Browser profile ${params.profileId} was not found`
      )
    }

    // Why: short-circuit no-op switches so the renderer doesn't tear down and
    // remount the webview when the tab is already on the requested profile.
    const currentProfileId = browserManager.getSessionProfileIdForTab(browserPageId) ?? 'default'
    if (currentProfileId === profile.id) {
      return {
        browserPageId,
        profileId: profile.id,
        profileLabel: profile.label
      }
    }

    const win = this.getAuthoritativeWindow()
    const requestId = randomUUID()
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        ipcMain.removeListener('browser:tabSetProfileReply', handler)
        reject(new Error('Tab profile update timed out'))
      }, 10_000)

      const handler = (
        _event: Electron.IpcMainEvent,
        reply: { requestId: string; error?: string }
      ): void => {
        if (reply.requestId !== requestId) {
          return
        }
        clearTimeout(timer)
        ipcMain.removeListener('browser:tabSetProfileReply', handler)
        if (reply.error) {
          reject(new Error(reply.error))
        } else {
          resolve()
        }
      }
      ipcMain.on('browser:tabSetProfileReply', handler)
      win.webContents.send('browser:requestTabSetProfile', {
        requestId,
        browserPageId,
        profileId: profile.id
      })
    })

    // Why: the renderer destroys the old webview and remounts on the new
    // partition. Wait for the re-register so a follow-up tab list
    // --show-profile reads the updated sessionProfileId from BrowserManager
    // instead of stale data, and so subsequent CLI ops (snapshot, click, etc.)
    // hit a guest that's already attached.
    try {
      await waitForTabRegistration(browserPageId)
    } catch {
      // Best-effort: re-register won't fire if the worktree is hidden. The
      // store already reflects the new profile; downstream commands retry
      // once the pane re-mounts.
    }

    return {
      browserPageId,
      profileId: profile.id,
      profileLabel: profile.label
    }
  }

  async browserTabProfileShow(params: {
    page: string
    worktree?: string
  }): Promise<BrowserTabProfileShowResult> {
    const worktreeId = await this.resolveBrowserWorktreeId(params.worktree)
    const tab = this.describeBrowserTab(params.page, worktreeId)
    return {
      browserPageId: tab.browserPageId,
      worktreeId: tab.worktreeId ?? null,
      profileId: tab.profileId ?? null,
      profileLabel: tab.profileLabel ?? null
    }
  }

  async browserTabProfileClone(
    params: {
      profileId: string
    } & BrowserCommandTargetParams
  ): Promise<BrowserTabProfileCloneResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    const sourceBrowserPageId =
      target.browserPageId ?? this.requireAgentBrowserBridge().getActivePageId(target.worktreeId)
    if (!sourceBrowserPageId) {
      throw new BrowserError('browser_no_tab', 'No browser tab open in this worktree')
    }
    const sourceTab = this.describeBrowserTab(sourceBrowserPageId, target.worktreeId)
    const profile = browserSessionRegistry.getProfile(params.profileId)
    if (!profile) {
      throw new BrowserError(
        'invalid_argument',
        `Browser profile ${params.profileId} was not found`
      )
    }
    const created = await this.createBrowserTabInRenderer(
      sourceTab.url,
      sourceTab.worktreeId ?? target.worktreeId,
      profile.id
    )
    // Why: parity with browserTabCreate. Wait for the cloned tab's webview to
    // register so the returned browserPageId is operable by the next CLI call.
    try {
      await waitForTabRegistration(created.browserPageId)
    } catch {
      // Best-effort: registration may not fire if the worktree is hidden.
    }
    return {
      browserPageId: created.browserPageId,
      sourceBrowserPageId,
      profileId: profile.id,
      profileLabel: profile.label
    }
  }

  async browserProfileList(): Promise<BrowserProfileListResult> {
    return { profiles: browserSessionRegistry.listProfiles() }
  }

  async browserProfileCreate(params: {
    label: string
    scope: 'isolated' | 'imported'
  }): Promise<BrowserProfileCreateResult> {
    return {
      profile: browserSessionRegistry.createProfile(params.scope, params.label)
    }
  }

  async browserProfileDelete(params: { profileId: string }): Promise<BrowserProfileDeleteResult> {
    return {
      deleted: await browserSessionRegistry.deleteProfile(params.profileId),
      profileId: params.profileId
    }
  }

  async browserTabClose(params: {
    index?: number
    page?: string
    worktree?: string
  }): Promise<{ closed: boolean }> {
    const bridge = this.requireAgentBrowserBridge()
    const worktreeId = await this.resolveBrowserWorktreeId(params.worktree)

    let tabId: string | null = null
    if (typeof params.page === 'string' && params.page.length > 0) {
      if (!bridge.getRegisteredTabs(worktreeId).has(params.page)) {
        const scope = worktreeId ? ' in this worktree' : ''
        throw new BrowserError(
          'browser_tab_not_found',
          `Browser page ${params.page} was not found${scope}`
        )
      }
      tabId = params.page
    } else if (params.index !== undefined) {
      const tabs = bridge.getRegisteredTabs(worktreeId)
      const entries = [...tabs.entries()]
      if (params.index < 0 || params.index >= entries.length) {
        throw new Error(`Tab index ${params.index} out of range (0-${entries.length - 1})`)
      }
      tabId = entries[params.index][0]
    } else {
      // Why: try the bridge first (registered tabs with webviews), then fall back
      // to asking the renderer to close its active browser tab (handles cases where
      // the webview hasn't mounted yet, e.g. tab was just created).
      const tabs = bridge.getRegisteredTabs(worktreeId)
      const entries = [...tabs.entries()]
      const activeEntry = entries.find(([, wcId]) => wcId === bridge.getActiveWebContentsId())
      if (activeEntry) {
        tabId = activeEntry[0]
      }
    }

    const win = this.getAuthoritativeWindow()
    const requestId = randomUUID()
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        ipcMain.removeListener('browser:tabCloseReply', handler)
        reject(new Error('Tab close timed out'))
      }, 10_000)

      const handler = (
        _event: Electron.IpcMainEvent,
        reply: { requestId: string; error?: string }
      ): void => {
        if (reply.requestId !== requestId) {
          return
        }
        clearTimeout(timer)
        ipcMain.removeListener('browser:tabCloseReply', handler)
        if (reply.error) {
          reject(new Error(reply.error))
        } else {
          resolve()
        }
      }
      ipcMain.on('browser:tabCloseReply', handler)
      // Why: when main cannot resolve a concrete tab id itself (for example if a
      // browser workspace exists in the renderer before its guest mounts), the
      // renderer still needs the intended worktree scope. Otherwise it falls
      // back to the globally active browser tab and can close a tab in the
      // wrong worktree.
      win.webContents.send('browser:requestTabClose', { requestId, tabId, worktreeId })
    })

    return { closed: true }
  }

  private enrichBrowserTabInfo(
    tab: BrowserTabListResult['tabs'][number]
  ): BrowserTabListResult['tabs'][number] {
    const rawProfileId = browserManager.getSessionProfileIdForTab(tab.browserPageId)
    const profile =
      browserSessionRegistry.getProfile(rawProfileId ?? 'default') ??
      browserSessionRegistry.getDefaultProfile()
    return {
      ...tab,
      worktreeId: browserManager.getWorktreeIdForTab(tab.browserPageId) ?? null,
      profileId: profile.id,
      profileLabel: profile.label
    }
  }

  private describeBrowserTab(
    browserPageId: string,
    explicitWorktreeId?: string
  ): BrowserTabListResult['tabs'][number] {
    const worktreeId = explicitWorktreeId ?? browserManager.getWorktreeIdForTab(browserPageId)
    const tab = this.requireAgentBrowserBridge()
      .tabList(worktreeId)
      .tabs.find((entry) => entry.browserPageId === browserPageId)
    if (!tab) {
      const scope = worktreeId ? ' in this worktree' : ''
      throw new BrowserError(
        'browser_tab_not_found',
        `Browser page ${browserPageId} was not found${scope}`
      )
    }
    return this.enrichBrowserTabInfo(tab)
  }

  private async createBrowserTabInRenderer(
    url: string,
    worktreeId?: string,
    profileId?: string
  ): Promise<{ browserPageId: string }> {
    const win = this.getAuthoritativeWindow()
    const requestId = randomUUID()

    if (worktreeId) {
      await this.ensureBrowserWorktreeActive(worktreeId)
    }

    const browserPageId = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        ipcMain.removeListener('browser:tabCreateReply', handler)
        reject(new Error('Tab creation timed out'))
      }, 10_000)

      const handler = (
        _event: Electron.IpcMainEvent,
        reply: { requestId: string; browserPageId?: string; error?: string }
      ): void => {
        if (reply.requestId !== requestId) {
          return
        }
        clearTimeout(timer)
        ipcMain.removeListener('browser:tabCreateReply', handler)
        if (reply.error) {
          reject(new Error(reply.error))
        } else {
          resolve(reply.browserPageId!)
        }
      }
      ipcMain.on('browser:tabCreateReply', handler)
      win.webContents.send('browser:requestTabCreate', {
        requestId,
        url,
        worktreeId,
        sessionProfileId: profileId
      })
    })

    return { browserPageId }
  }

  private getAuthoritativeWindow(): BrowserWindow {
    if (this.authoritativeWindowId === null) {
      throw new Error('No renderer window available')
    }
    const win = BrowserWindow.fromId(this.authoritativeWindowId)
    if (!win || win.isDestroyed()) {
      throw new Error('No renderer window available')
    }
    return win
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
// Why (§3.3): 30s freshness window. A second worktree-create or dispatch-probe
// against the same repo+remote within this window reuses the previous successful
// fetch instead of repeating the round-trip. Chosen so rapid "new worktree"
// clicks and successive coordinator dispatches feel snappy, while still being
// short enough that a genuinely-changed remote is observed on the next action.
const FETCH_FRESHNESS_MS = 30_000
const DRIFT_PROBE_SUBJECT_LIMIT = 5
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

function branchSelectorMatches(branch: string, selector: string): boolean {
  // Why: Git worktree data can report local branches as either `refs/heads/foo`
  // or `foo` depending on which plumbing path produced the record. Orca's
  // branch selectors should accept either form so newly created worktrees stay
  // discoverable without exposing internal ref-shape differences to users.
  return normalizeBranchRef(branch) === normalizeBranchRef(selector)
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
  const separatorIndex = worktreeId.indexOf('::')
  if (separatorIndex <= 0) {
    return null
  }
  const worktreePath = worktreeId.slice(separatorIndex + 2)
  if (!worktreePath) {
    return null
  }
  return {
    repoId: worktreeId.slice(0, separatorIndex),
    worktreePath
  }
}

function findResolvedWorktreeIdForPath(
  resolvedWorktrees: ResolvedWorktree[],
  cwd: string
): string | null {
  if (!cwd) {
    return null
  }
  const matches = resolvedWorktrees
    .filter(
      (worktree) =>
        areWorktreePathsEqual(worktree.path, cwd) || isPathInsideWorktree(cwd, worktree.path)
    )
    .sort((left, right) => right.path.length - left.path.length)
  return matches[0]?.id ?? null
}

function isPathInsideWorktree(candidatePath: string, worktreePath: string): boolean {
  if (candidatePath === worktreePath) {
    return true
  }
  const normalizedCandidate = candidatePath.replace(/\\/g, '/').replace(/\/+$/, '')
  const normalizedWorktree = worktreePath.replace(/\\/g, '/').replace(/\/+$/, '')
  return normalizedCandidate.startsWith(`${normalizedWorktree}/`)
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
