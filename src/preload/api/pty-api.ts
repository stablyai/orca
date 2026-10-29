import type { PaintedRestorePane } from '../../shared/painted-restore-ack'
import type {
  PtyFencedTerminationRequest,
  PtyFencedTerminationOutcome
} from '../../shared/pty-fenced-termination'
import type { ResourceViewAdmission } from '../../shared/resource-view-admission'
import type { SpawnIntent } from '../../shared/host-spawn-admission'
import type {
  SavedResumeDecision,
  TerminalLaunchResult,
  AgentProviderSessionMetadata,
  SleepingAgentLaunchConfig
} from '../../shared/agent-session-resume'
import type { StartupCommandDelivery } from '../../shared/codex-startup-delivery'
import type { TerminalInputKind } from '../../shared/terminal-input-kind'
import type {
  TerminalLeafMoveRequest,
  TerminalLeafMoveResult
} from '../../shared/terminal-leaf-move'
import type { ProjectExecutionRuntimeResolution } from '../../shared/project-execution-runtime'
import type {
  PtyListedSession,
  PtySessionListScope,
  PtySessionLifecycle
} from '../../shared/pty-listed-session'
import type { PtyMainDeliveryDiagnostics } from '../../shared/pty-delivery-diagnostics'
import type { PtyModelRestoreNeededEvent } from '../../shared/pty-model-restore-marker'
import type {
  PtyRendererDeliveryHealthReply,
  PtyRendererDeliveryStateReport
} from '../../shared/pty-renderer-delivery-health'
import type { AgentKind, LaunchSource, RequestKind } from '../../shared/telemetry-events'
import type { TerminalSideEffectBatch } from '../../shared/terminal-side-effect-facts'
import type { TerminalViewAttributes } from '../../shared/terminal-view-attributes'
import type { TuiAgent } from '../../shared/tui-agent'
import type { TerminalPanePlacement } from '../../shared/terminal-pane-placement'
import type { AgentPaneLaunchRequest } from '../../shared/agent-pane-launch-request'
import type { PtyManagementApi } from './pty-management-api'
import type { TerminalProcessInspection } from '../../shared/terminal-process-inspection'
import type { CodexSharedServerStatus } from '../../shared/codex-shared-server-command'
import type { NewerDaemonHeldScreen, NewerDaemonReopenResult } from '../../shared/newer-daemon-hold'

export type PtyApi = {
  spawn: (opts: {
    cols: number
    rows: number
    cwd?: string
    env?: Record<string, string>
    envToDelete?: string[]
    command?: string
    commandDelivery?: 'renderer' | 'provider'
    launchConfig?: SleepingAgentLaunchConfig
    resumeProviderSession?: AgentProviderSessionMetadata
    resumeOrigin?: 'saved'
    launchToken?: string
    launchAgent?: TuiAgent
    startupCommandDelivery?: StartupCommandDelivery
    connectionId?: string | null
    worktreeId?: string
    sessionId?: string
    shellOverride?: string
    projectRuntime?: ProjectExecutionRuntimeResolution
    terminalKittyKeyboardProtocol?: boolean
    terminalColorQueryReplies?: { foreground?: string; background?: string }
    // Set before the first byte so the delivery gate owns spawn-time queries.
    initiallyHidden?: boolean
    // Layout-owner build: attach to `sessionId` or start nothing; older mains ignore it.
    attachOnlyView?: boolean
    // Main persists the pane-to-PTY binding before replying so SIGKILL cannot lose ownership.
    tabId?: string
    leafId?: string
    // Stop this PTY before restarting; otherwise a live pane owner is reattached.
    replacesPtyId?: string
    // Which tab and leaf a fresh PTY joins; older mains ignore it.
    placement?: TerminalPanePlacement
    // Visible restores are `user-resume`, hidden ones `automatic-restore`; the fork gate validates.
    spawnIntent?: SpawnIntent
    // A restore no user act asked for; main holds it for a stopped WSL distro. Older mains ignore it.
    wslPassiveRestore?: true
    agentLaunch?: AgentPaneLaunchRequest
    // Main emits agent_started only after a successful spawn.
    telemetry?: { agent_kind: AgentKind; launch_source: LaunchSource; request_kind: RequestKind }
  }) => Promise<{
    id: string
    /** Which lifetime of `id` this reply named; absent when the execution host predates the field. */
    incarnationId?: string
    launchAgent?: TuiAgent
    launchConfig?: SleepingAgentLaunchConfig
    snapshot?: string
    snapshotCols?: number
    snapshotRows?: number
    snapshotPrefixAnsi?: string
    snapshotFrameAnsi?: string
    snapshotFrameRestoreAnsi?: string
    snapshotKittyKeyboardFlags?: number
    snapshotTerminalOwner?: 'shell'
    snapshotSeq?: number
    isReattach?: boolean
    isAlternateScreen?: boolean
    replay?: string
    sessionExpired?: boolean
    coldRestore?: { scrollback: string; cwd: string; cols?: number; rows?: number }
    startupCwdFallback?: { kind: 'worktree'; cwd: string }
    agentResumeUnavailable?: true
    agentResumeRefused?: 'chat-home' | 'chat-writing' | 'unverifiable'
    savedResumeDecision?: SavedResumeDecision
    refusedResume?: TerminalLaunchResult['refusedResume']
    launchToken?: string
    resumeProviderSession?: TerminalLaunchResult['resumeProviderSession']
    /** Host verdict on the shell-ready marker; absent when the execution host predates the field. */
    shellReadyArmed?: boolean
  }>
  write: (id: string, data: string, inputKind: TerminalInputKind) => void
  /** `requireWriteSettlement` waits for the provider's acknowledgment on any provider. */
  writeAccepted: (
    id: string,
    data: string,
    inputKind: TerminalInputKind,
    options?: { requireWriteSettlement?: true }
  ) => Promise<boolean>
  onWriteUnavailable?: (callback: (payload: { id: string }) => void) => () => void
  resize: (id: string, cols: number, rows: number) => void
  claimViewport: (id: string, cols: number, rows: number) => void
  reportGeometry: (id: string, cols: number, rows: number) => void
  signal: (id: string, signal: string) => void
  clearBuffer: (id: string) => void
  resetInputModes: (id: string) => void
  killFenced: (request: PtyFencedTerminationRequest) => Promise<PtyFencedTerminationOutcome>
  kill: (id: string, opts?: { keepHistory?: boolean }) => Promise<void>
  /** Acknowledge the pane that actually painted the restored frame. */
  ackColdRestore: (id: string, pane?: PaintedRestorePane) => void
  /** Hidden-output recovery painted main's snapshot; retires the hidden-delivery drop latch. */
  ackHiddenOutputRestoreApplied: (id: string, hiddenDropEpisode?: number) => void
  ackData: (id: string, charCount: number, processedChars?: number) => void
  onDeliveryResyncRequest: (callback: (payload: { requestId: number }) => void) => () => void
  respondDeliveryResync: (payload: {
    requestId: number
    processedCharsByPty: Record<string, number>
  }) => void
  /** Invoke still reaches main when main-to-renderer push delivery is broken. */
  reportRendererDeliveryState: (
    report: PtyRendererDeliveryStateReport
  ) => Promise<PtyRendererDeliveryHealthReply>
  /** Distinguishes a detached pty:data listener from a dead push channel. */
  getPtyDataListenerCount: () => number
  /** Releases sends main held until this page registered its pty:data dispatcher. */
  rendererDispatcherReady: () => void
  setActiveRendererPty: (id: string, active: boolean) => void
  setRendererPtyVisible: (id: string, visible: boolean) => void
  /** Hidden panes may skip renderer bytes after model ingestion; reveal restores a snapshot. */
  setHiddenRendererPty: (id: string, hidden: boolean) => void
  /** Ref-counted raw-byte consumers suppress the hidden-delivery gate. */
  setPtyDeliveryInterest: (id: string, interested: boolean) => void
  /** Main uses the composed appearance for hidden-PTY OSC/DSR color replies. */
  publishTerminalViewAttributes: (attributes: TerminalViewAttributes) => void
  hasChildProcesses: (id: string) => Promise<boolean>
  getForegroundProcess: (id: string) => Promise<string | null>
  inspectProcess: (
    id: string,
    options?: {
      expectedIncarnationId?: string
      scanChildProcesses?: boolean
      steadyState?: boolean
    }
  ) => Promise<TerminalProcessInspection>
  confirmForegroundProcess: (id: string) => Promise<string | null>
  /** Local panes only; never joined for any other pane. */
  isCodexOnSharedServer: (id: string) => Promise<CodexSharedServerStatus>
  /** Runs the fix with the pane's own Codex; true only once verified. Local panes only. */
  disableCodexSharedServerAutoStart: (id: string) => Promise<boolean>
  stopCodexSharedServer: (id: string) => Promise<boolean>
  /** True only for local panes missing the daemon claude function and using a deselected account. */
  openedBeforeClaudeAccounts: (
    id: string,
    target: { runtime: 'host' } | { runtime: 'wsl'; wslDistro: string }
  ) => Promise<boolean>
  /** Checks saved Claude config for local host panes; false for other panes. */
  claudeDiffPanelMayAutoOpen: (
    id: string,
    target: { runtime: 'host' } | { runtime: 'wsl'; wslDistro: string }
  ) => Promise<boolean>
  /** A held local session's last saved screen, read without spawning. */
  readNewerDaemonHeldScreen: (sessionId: string) => Promise<NewerDaemonHeldScreen | null>
  /** Stops the newer daemons; reopened only once each is confirmed exited. */
  reopenNewerDaemonTerminals: () => Promise<NewerDaemonReopenResult>
  getCwd: (id: string) => Promise<string>
  getSize: (id: string) => Promise<{ cols: number; rows: number } | null>
  listSessions: (
    scope?: PtySessionListScope,
    admission?: ResourceViewAdmission
  ) => Promise<PtyListedSession[]>
  getAuthoritativeBufferSnapshotCapabilities?: (
    ids: string[]
  ) => Promise<{ id: string; authoritative: boolean | null }[]>
  hasPty: (id: string) => Promise<boolean | null>
  moveLeafToNewTab: (request: TerminalLeafMoveRequest) => Promise<TerminalLeafMoveResult>
  getMainBufferSnapshot: (
    id: string,
    opts?: { scrollbackRows?: number }
  ) => Promise<{
    data: string
    frameRestoreAnsi?: string
    cols: number
    rows: number
    cwd?: string | null
    seq?: number
    /** Bounds post-restore duplicates; equals seq when the pending delivery queue is empty. */
    pendingDeliveryStartSeq?: number
    source?: 'headless' | 'renderer'
    alternateScreen?: boolean
    /** Authoritative normal buffer paired with an alternate-screen frame. */
    scrollbackAnsi?: string
    /** Write the incomplete escape after post-replay resets, just before live chunks. */
    pendingEscapeTailAnsi?: string
    /** Effective flags at seq; absent means unknown, never zero. */
    kittyKeyboardFlags?: number
    terminalOwner?: 'shell'
  } | null>
  getRendererDeliveryDebugSnapshot: () => Promise<{
    pendingPtyCount: number
    pendingChars: number
    maxPendingCharsByPty: number
    rendererInFlightPtyCount: number
    rendererInFlightChars: number
    maxRendererInFlightCharsByPty: number
    activeRendererPtyCount: number
    flushScheduled: boolean
    peakPendingChars: number
    peakMaxPendingCharsByPty: number
    peakRendererInFlightChars: number
    peakMaxRendererInFlightCharsByPty: number
    ackGatedFlushSkipCount: number
    hiddenDeliveryGatedPtyCount: number
    hiddenDeliveryGatedVisiblePtyCount: number
    hiddenDeliveryGatedActivePtyCount: number
    deliveryInterestPtyCount: number
    hiddenDeliveryDroppedChars: number
    hiddenDeliveryDroppedChunks: number
    pendingDroppedChars: number
    diagnostics: PtyMainDeliveryDiagnostics
    rendererLifecycleResetCount: number
    lastLifecycleResetClearedChars: number
    rendererPtyDispatcherReady: boolean
    rendererDispatcherReadyForcedCount: number
  }>
  resetRendererDeliveryDebug: () => Promise<void>
  onData: (
    callback: (data: {
      id: string
      data: string
      seq?: number
      rawLength?: number
      transformed?: boolean
      background?: boolean
      droppedOutput?: boolean
      gapEscapeState?: string
    }) => void
  ) => () => void
  onReplay: (callback: (data: { id: string; data: string }) => void) => () => void
  /** Out-of-band byte-drop signal; restore the model snapshot instead of waiting on pty:data. */
  onModelRestoreNeeded: (callback: (event: PtyModelRestoreNeededEvent) => void) => () => void
  /** Covers only PTYs whose bytes transit local main. */
  onSideEffect: (callback: (batch: TerminalSideEffectBatch) => void) => () => void
  /** Title-only replay snapshot for (re)attach; attention facts never replay. */
  getSideEffectSnapshot: (id: string) => Promise<TerminalSideEffectBatch | null>
  onExit: (
    callback: (data: {
      id: string
      code: number
      preserveRendererBinding?: boolean
      /** Which lifetime of `id` died; absent when the execution host predates the field. */
      incarnationId?: string
      hostId?: string
      /** Set only when the owning relay disowned this id; never a claim that the process died. */
      ptySourceDisowned?: true
      /** Main stopped this PTY so a new process could take its pane; the pane is not dying. */
      replacedByRestart?: true
    }) => void
  ) => () => void
  onSpawned: (callback: (data: PtySessionLifecycle) => void) => () => void
  onSerializeBufferRequest: (
    callback: (data: {
      requestId: string
      ptyId: string
      opts?: { scrollbackRows?: number }
    }) => void
  ) => () => void
  onClearBufferRequest: (callback: (data: { ptyId: string }) => void) => () => void
  onResetInputModesRequest: (callback: (data: { ptyId: string }) => void) => () => void
  sendSerializedBuffer: (
    requestId: string,
    snapshot: {
      data: string
      cols: number
      rows: number
      seq?: number
      lastTitle?: string
      kittyKeyboardFlags?: number
    } | null
  ) => void
  declarePendingPaneSerializer: (paneKey: string) => Promise<number>
  settlePaneSerializer: (paneKey: string, gen: number) => Promise<void>
  clearPendingPaneSerializer: (paneKey: string, gen: number) => Promise<void>
  reportRendererSerializerReady?: (ptyId: string) => Promise<void>
  management: PtyManagementApi
}
