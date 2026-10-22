import type { PaneSpawnOperation } from '../ipc/pty/pane/pane-spawn-operation'
import type { AgentLaunchRuntime } from '../../shared/agent-launch-runtime'
import type {
  AutomaticWorkResumeOutcome,
  AutomaticWorkStatus,
  SpawnIntent
} from '../../shared/host-spawn-admission'
import type {
  AgentSessionClaimedSpawnResult,
  AgentSessionExecutionClaim,
  AgentSessionSurfaceBinding
} from '../../shared/agent-session-host-authority'
import type { AgentProviderSessionMetadata } from '../../shared/agent-session-resume'
import type { TuiAgent } from '../../shared/tui-agent'
import type { WorktreeStartupLaunch } from '../../shared/worktree/launch-types'
import type { PtyIncarnationId } from '../../shared/pty-incarnation'
import type { PtyBindingSourceExpectation } from '../persistence'
import type { TerminalPanePlacement } from '../../shared/terminal-pane-placement'
import type { ExecutionHostId } from '../../shared/execution-host'
import type {
  PtyProviderBufferSnapshot,
  PtyProcessInfo,
  PtySpawnResult
} from '../providers/pty-provider-contract'
import type { PtyProcessInspection } from '../providers/pty-process-inspection'
import type { WriteSettlement } from '../../shared/pty-write-settlement'
import type { StartupCwdFallback } from '../../shared/startup-cwd-fallback'
import type { TerminalInputKind } from '../../shared/terminal-input-kind'

export type PtyInventoryRefreshOptions = {
  includeForegroundProcessEvidence?: boolean
  refreshForegroundAgents?: boolean
}

export type RuntimePtyController = {
  claimStablePaneCreate?(args: {
    worktreeId: string
    connectionId: string | null
    tabId: string
    leafId: string
  }): () => void
  adoptStablePane?(opts: {
    signal?: AbortSignal
    spawnFresh?: (operation: PaneSpawnOperation) => Promise<PtySpawnResult>
    cols: number
    rows: number
    cwd?: string
    connectionId: string | null
    worktreeId: string
    preAllocatedHandle: string
    tabId: string
    leafId: string
  }): Promise<{
    result: PtySpawnResult
    owner: {
      handle?: string
      tabId: string
      leafId: string
      ptyId: string
      incarnationId?: string
    }
    materialized?: true
  } | null>
  spawn?(opts: {
    cols: number
    rows: number
    cwd?: string
    command?: string
    launchAgent?: TuiAgent
    commandDelivery?: 'renderer' | 'provider'
    startupCommandDelivery?: WorktreeStartupLaunch['startupCommandDelivery']
    env?: Record<string, string>
    envToDelete?: string[]
    resumeProviderSession?: AgentProviderSessionMetadata
    telemetry?: WorktreeStartupLaunch['telemetry']
    connectionId?: string | null
    worktreeId?: string
    preAllocatedHandle?: string
    tabId?: string
    leafId?: string
    sessionId?: string
    /** Windows shell to spawn AS this PTY, instead of the host default. */
    shellOverride?: string
    /** The agent launch's runtime fact; when present the PTY shell comes only from it. */
    launchRuntime?: AgentLaunchRuntime
    isNewSession?: boolean
    /** No renderer view exists at spawn; main owns delivery and query replies until one mounts. */
    initiallyHidden?: boolean
    persistHostSessionBinding?: boolean
    expectedSourceBinding?: PtyBindingSourceExpectation
    placement?: TerminalPanePlacement
    terminalKittyKeyboardProtocol?: boolean
    terminalColorQueryReplies?: { foreground?: string; background?: string }
    agentSessionEnsure?: {
      claim: AgentSessionExecutionClaim
      surface: AgentSessionSurfaceBinding
    }
    agentSessionCreateOperationId?: string
    spawnIntent?: SpawnIntent
    signal?: AbortSignal
    refuseSleptWorktree?: boolean
    onPtySpawnCommitted?: () => void
    paneSpawnOperation?: PaneSpawnOperation
    adoptedStablePane?: {
      result: PtySpawnResult
      owner: {
        handle?: string
        tabId: string
        leafId: string
        ptyId: string
        incarnationId?: string
      }
      materialized?: true
    }
  }): Promise<{
    id: string
    pid?: number | null
    incarnationId?: PtyIncarnationId
    wslDistro?: string
    stablePaneOwner?: { handle: string; tabId: string; leafId: string }
    agentSessionEnsure?: AgentSessionClaimedSpawnResult
    /** The host started this process at the workspace root because the requested folder is gone. */
    startupCwdFallback?: StartupCwdFallback
    savedStartupCwd?: string
  }>
  /** The local terminal owner's automatic-restore state; null when it has no fork gate. */
  getAutomaticWorkStatus?(): Promise<AutomaticWorkStatus | null>
  resumeAutomaticWork?(): Promise<AutomaticWorkResumeOutcome>
  write(ptyId: string, data: string, inputKind: TerminalInputKind): boolean
  /** Three-valued settlement; local providers settle synchronously. */
  writeWithSettlement?(
    ptyId: string,
    data: string,
    inputKind: TerminalInputKind
  ): WriteSettlement | Promise<WriteSettlement>
  /** Attach-only adoption of a live local daemon session so its output streams
   *  to main without a renderer pane; never creates, resizes, or focuses.
   *  False on doubt (absent session, SSH-scoped id, non-daemon provider). */
  attach?(ptyId: string): Promise<boolean>
  kill(ptyId: string): boolean
  /** `incarnationId` is the rejected spawn's; a same-id respawn since then is left alone. */
  retireRejectedPty?(ptyId: string, stopConfirmed: boolean, incarnationId: string | undefined): void
  stopAndWait?(
    ptyId: string,
    opts?: { keepHistory?: boolean; deadlineMs?: number }
  ): Promise<boolean>
  getCwd?(ptyId: string): Promise<string | null>
  getForegroundProcess(ptyId: string): Promise<string | null>
  inspectProcess?(
    ptyId: string,
    options?: { expectedIncarnationId?: PtyIncarnationId; scanChildProcesses?: boolean }
  ): Promise<PtyProcessInspection>
  confirmForegroundProcess?(ptyId: string): Promise<string | null>
  confirmShellForeground?(ptyId: string): Promise<boolean>
  hasChildProcesses?(ptyId: string): Promise<boolean>
  clearBuffer?(ptyId: string): Promise<void>
  resetInputModes?(ptyId: string): Promise<void>
  resize?(ptyId: string, cols: number, rows: number): boolean
  // Why: exact-id mobile polls should not enumerate every local and SSH PTY.
  hasPty?(ptyId: string): boolean | null
  /** Omitting the host lists every registered host. */
  listProcesses?(
    hostId?: ExecutionHostId,
    opts?: { deadlineMs?: number; includeForegroundProcessEvidence?: boolean }
  ): Promise<PtyProcessInfo[]>
  listProcessesWithHostScope?(opts?: {
    deadlineMs?: number
    includeForegroundProcessEvidence?: boolean
  }): Promise<{
    processes: PtyProcessInfo[]
    hostIds: ExecutionHostId[]
  }>
  supportsForegroundProcessEvidence?(hostId?: ExecutionHostId): Promise<boolean>
  serializeBuffer?(
    ptyId: string,
    opts?: { scrollbackRows?: number }
  ): Promise<{
    data: string
    cols: number
    rows: number
    seq?: number
    lastTitle?: string
    kittyKeyboardFlags?: number
  } | null>
  /** Authoritative provider-owned snapshot for restored PTYs with no mounted renderer. */
  serializeProviderBuffer?(
    ptyId: string,
    opts?: { scrollbackRows?: number }
  ): Promise<PtyProviderBufferSnapshot | null>
  // Why: synchronous probe used by maybeHydrateHeadlessFromRenderer to skip
  // hydration when no renderer is authoritative for this PTY. See
  // docs/mobile-prefer-renderer-scrollback.md.
  hasRendererSerializer?(ptyId: string): boolean
  getRendererSerializerGeneration?(ptyId: string): number
  waitForRendererSerializer?(
    ptyId: string,
    afterGeneration: number,
    timeoutMs?: number,
    signal?: AbortSignal
  ): Promise<boolean>
  getSize?(ptyId: string): { cols: number; rows: number } | null
  /** False only when the owning provider proved the PTY absent; null = unknown (never a denial). */
  probePtyLiveness?(ptyId: string): Promise<boolean | null>
}

export type PtyControllerTerminalIdentity = Readonly<{
  handle: string
  incarnationId: string
  wslDistro?: string | null
}>

export type PtyControllerInventory = Readonly<{
  livePtyIds: ReadonlySet<string>
  // Why: livePtyIds is worktree-scoped when a target is given; absence proofs
  // must consult the unscoped inventory or a misattributed live PTY reads as dead.
  allLivePtyIds: ReadonlySet<string>
  terminalIdentityByPtyId: ReadonlyMap<string, PtyControllerTerminalIdentity>
  queriedHostIds: ReadonlySet<ExecutionHostId>
  /** Live PTYs the host is killing: still live work, but no longer any pane's to show. */
  exitingPtyIds?: ReadonlySet<string>
}>
