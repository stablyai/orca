import type {
  AgentProviderSessionMetadata,
  SleepingAgentLaunchConfig
} from '../../shared/agent-session-resume'
import type { StartupCommandDelivery } from '../../shared/codex-startup-delivery'
import type { ProjectExecutionRuntimeResolution } from '../../shared/project-execution-runtime'
import type { PtyListedSession } from '../../shared/pty-listed-session'
import type { PtyMainDeliveryDiagnostics } from '../../shared/pty-delivery-diagnostics'
import type { PtyModelRestoreNeededEvent } from '../../shared/pty-model-restore-marker'
import type {
  PtyRendererDeliveryHealthReply,
  PtyRendererDeliveryStateReport
} from '../../shared/pty-renderer-delivery-health'
import type { AgentKind, LaunchSource, RequestKind } from '../../shared/telemetry-events'
import type {
  AgentLaunchNoticeCode,
  PersistedLaunchNoticeState
} from '../../shared/agent-launch-contract'
import type {
  AgentLaunchInput,
  AgentLaunchSpawnOutcome
} from '../../shared/agent-launch-spawn-request'
import type { TerminalSideEffectBatch } from '../../shared/terminal-side-effect-facts'
import type { TerminalViewAttributes } from '../../shared/terminal-view-attributes'
import type { TuiAgent } from '../../shared/tui-agent'
import type { PtyManagementApi } from './pty-management-api'

export type PtyApi = {
  dismissLaunchNotice: (args: {
    worktreeId: string
    tabId: string
    launchToken: string
    code: AgentLaunchNoticeCode
  }) => Promise<{ ok: boolean; changed: boolean }>
  spawn: (opts: {
    cols: number
    rows: number
    cwd?: string
    cwdFallback?: 'worktree'
    env?: Record<string, string>
    envToDelete?: string[]
    command?: string
    commandDelivery?: 'renderer' | 'provider'
    // Host-owned launch request (U3): identity/session + prompt policy only. When
    // set, main resolves the command and mints the token, superseding the
    // command/launchConfig/launchToken/launchAgent fields.
    agentLaunch?: AgentLaunchInput
    launchConfig?: SleepingAgentLaunchConfig
    resumeProviderSession?: AgentProviderSessionMetadata
    launchToken?: string
    launchAgent?: TuiAgent
    startupCommandDelivery?: StartupCommandDelivery
    connectionId?: string | null
    worktreeId?: string
    sessionId?: string
    // Why: lets a single tab open in a different shell than the user's default.
    shellOverride?: string
    projectRuntime?: ProjectExecutionRuntimeResolution
    terminalColorQueryReplies?: { foreground?: string; background?: string }
    // Why: mark the PTY hidden before its first byte so the delivery gate owns spawn-time queries (terminal-query-authority.md §races).
    initiallyHidden?: boolean
    // Why: main sync-flushes the (worktreeId,tabId,leafId→ptyId) binding before pty:spawn returns to close a SIGKILL race (INVESTIGATION.md).
    tabId?: string
    leafId?: string
    // Why: main fires `agent_started` only on spawn success, so launch metadata rides this field (telemetry-plan.md §Agent launch semantics).
    // agent_kind is optional because the host-resolved agentLaunch path overwrites
    // it from the validated receipt (a custom id has no client-known kind); the
    // surface still owns launch_source/request_kind.
    telemetry?: { agent_kind?: AgentKind; launch_source: LaunchSource; request_kind: RequestKind }
  }) => Promise<
    | {
        id: string
        launchAgent?: TuiAgent
        launchConfig?: SleepingAgentLaunchConfig
        snapshot?: string
        snapshotCols?: number
        snapshotRows?: number
        snapshotPrefixAnsi?: string
        snapshotFrameAnsi?: string
        snapshotFrameRestoreAnsi?: string
        snapshotKittyKeyboardFlags?: number
        snapshotSeq?: number
        isReattach?: boolean
        isAlternateScreen?: boolean
        replay?: string
        sessionExpired?: boolean
        coldRestore?: { scrollback: string; cwd: string; cols?: number; rows?: number }
        startupCwdFallback?: { kind: 'worktree'; cwd: string }
        agentResumeUnavailable?: true
        agentLaunch?: Extract<AgentLaunchSpawnOutcome, { status: 'launched' }>
        followupPrompt?: string
        launchNotices?: PersistedLaunchNoticeState
      }
    | { agentLaunch: AgentLaunchSpawnOutcome }
  >
  write: (id: string, data: string) => void
  writeAccepted: (id: string, data: string) => Promise<boolean>
  onWriteUnavailable?: (callback: (payload: { id: string }) => void) => () => void
  resize: (id: string, cols: number, rows: number) => void
  claimViewport: (id: string, cols: number, rows: number) => void
  reportGeometry: (id: string, cols: number, rows: number) => void
  signal: (id: string, signal: string) => void
  clearBuffer: (id: string) => void
  kill: (id: string, opts?: { keepHistory?: boolean }) => Promise<void>
  ackColdRestore: (id: string) => void
  ackData: (id: string, charCount: number, processedChars?: number) => void
  onDeliveryResyncRequest: (callback: (payload: { requestId: number }) => void) => () => void
  respondDeliveryResync: (payload: {
    requestId: number
    processedCharsByPty: Record<string, number>
  }) => void
  /** Renderer-initiated delivery health/heal lane over invoke — reaches main
   *  even when every main→renderer push channel is dead (field wedge). */
  reportRendererDeliveryState: (
    report: PtyRendererDeliveryStateReport
  ) => Promise<PtyRendererDeliveryHealthReply>
  /** Live pty:data listener count on the preload emitter (sync) — heal-time
   *  discriminator between a detached listener and a dead channel. */
  getPtyDataListenerCount: () => number
  /** One-shot signal that this page's pty:data dispatcher is registered, so
   *  main can release sends held during the load/reload boot window. */
  rendererDispatcherReady: () => void
  setActiveRendererPty: (id: string, active: boolean) => void
  setRendererPtyVisible: (id: string, visible: boolean) => void
  /** Hidden-delivery gate (Phase 4): hidden=true lets main drop renderer
   *  byte delivery after model ingestion; reveal restores from snapshots. */
  setHiddenRendererPty: (id: string, hidden: boolean) => void
  /** Ref-counted-on-the-renderer delivery-interest signal that suppresses
   *  the hidden-delivery gate while any raw-byte consumer is registered. */
  setPtyDeliveryInterest: (id: string, interested: boolean) => void
  /** View-attribute bridge (Phase 5 slice 2): app-global composed terminal
   *  appearance push backing main's hidden-PTY OSC/DSR color replies. */
  publishTerminalViewAttributes: (attributes: TerminalViewAttributes) => void
  hasChildProcesses: (id: string) => Promise<boolean>
  getForegroundProcess: (id: string) => Promise<string | null>
  inspectProcess: (id: string) => Promise<{
    foregroundProcess: string | null
    hasChildProcesses: boolean
    unavailable?: true
  }>
  confirmForegroundProcess: (id: string) => Promise<string | null>
  getCwd: (id: string) => Promise<string>
  getSize: (id: string) => Promise<{ cols: number; rows: number } | null>
  listSessions: () => Promise<PtyListedSession[]>
  getAuthoritativeBufferSnapshotCapabilities?: (
    ids: string[]
  ) => Promise<{ id: string; authoritative: boolean | null }[]>
  hasPty: (id: string) => Promise<boolean | null>
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
    /** Start of main's pending renderer-delivery queue at snapshot time
     *  (equals `seq` when empty) — bounds the renderer's post-restore
     *  duplicate window. */
    pendingDeliveryStartSeq?: number
    source?: 'headless' | 'renderer'
    alternateScreen?: boolean
    /** Authoritative normal buffer paired with an alternate-screen frame. */
    scrollbackAnsi?: string
    /** Trailing incomplete escape the emulator ingested; the restorer must
     *  write it after its post-replay resets, last before live chunks. */
    pendingEscapeTailAnsi?: string
    /** Effective kitty flags the snapshot owner proved at `seq`. Absent means
     *  unknown; consumers must not turn that into a known `0`. */
    kittyKeyboardFlags?: number
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
    }) => void
  ) => () => void
  onReplay: (callback: (data: { id: string; data: string }) => void) => () => void
  /** Out-of-band main→renderer signal that renderer-bound bytes were
   *  dropped (hidden-delivery gate / pending cap); the pane restores from
   *  the model snapshot. Never delivered in-band on pty:data. */
  onModelRestoreNeeded: (callback: (event: PtyModelRestoreNeededEvent) => void) => () => void
  /** Batched derived side-effect facts for PTYs whose bytes transit local
   *  main. */
  onSideEffect: (callback: (batch: TerminalSideEffectBatch) => void) => () => void
  /** Title-only replay snapshot for (re)attach; attention facts never replay. */
  getSideEffectSnapshot: (id: string) => Promise<TerminalSideEffectBatch | null>
  onExit: (
    callback: (data: { id: string; code: number; preserveRendererBinding?: boolean }) => void
  ) => () => void
  onSpawned: (callback: (data: { id: string }) => void) => () => void
  onSerializeBufferRequest: (
    callback: (data: {
      requestId: string
      ptyId: string
      opts?: { scrollbackRows?: number; altScreenForcesZeroRows?: boolean }
    }) => void
  ) => () => void
  onClearBufferRequest: (callback: (data: { ptyId: string }) => void) => () => void
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
