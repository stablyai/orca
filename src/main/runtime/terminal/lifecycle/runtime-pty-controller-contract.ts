import type { DaemonLaunchNoteChange } from '../../../daemon/protocol/daemon-launch-note-protocol'
import type {
  TerminalLimitStatus,
  TerminalLimitUpdate
} from '../../../../shared/terminal/runtime-policy/terminal-limit-policy'
import type { TerminalViewAttributes } from '../../../../shared/terminal/protocol/queries/terminal-view-attributes'
import type { PtySpawnOutcome } from '../../../ipc/pty/spawn-outcome'
import type { RuntimePaneCreateClaim } from '../../../ipc/pty/pane/spawn-reservation'
import type { PaneSpawnOperation } from '../../../ipc/pty/pane/pane-spawn-operation'
import type { TerminalWorkspaceLaunchScope } from '../../orchestration/terminal-authority/structured-sessions/runtime-legacy-worker-terminal-recovery-types'
import type { AgentLaunchRuntime } from '../../../../shared/agent-launch/startup/agent-launch-runtime'
import type {
  AutomaticWorkResumeOutcome,
  AutomaticWorkStatus,
  SpawnIntent
} from '../../../../shared/terminal/pty/admission/spawn-admission-contract'
import type {
  AgentSessionExecutionClaim,
  AgentSessionSurfaceBinding
} from '../../../../shared/agent-session/agent-session-host-authority'
import type { AgentProviderSessionMetadata } from '../../../../shared/agent-session/lifecycle/agent-session-resume'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import type { WorktreeStartupLaunch } from '../../../../shared/worktree/launch-types'
import type { PtyIncarnationId } from '../../../../shared/terminal/pty/lifecycle/pty-incarnation'
import type { PtyBindingSourceExpectation } from '../../../persistence/loading-store/store'
import type { TerminalPanePlacement } from '../../../../shared/workspace-layout/terminal-topology/terminal-pane-placement'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type {
  PtyProviderBufferSnapshot,
  TerminalHistoryAuthority
} from '../../../providers/pty-provider-contract'
import type { PtyProcessInfo } from '../../../providers/pty-process-info'
import type { PtySpawnResult } from '../../../providers/pty-spawn-result'
import type { TerminalProcessInspection as PtyProcessInspection } from '../../../../shared/terminal/pty/lifecycle/terminal-process-inspection'
import type { WriteSettlement } from '../../../../shared/terminal/pty/lifecycle/pty-write-settlement'
import type { StartupCwdFallback } from '../../../../shared/startup-cwd-fallback'
import type { TerminalInputKind } from '../../../../shared/terminal/input/terminal-input-kind'
import type { PaneResumeOutcome } from '../../../../shared/workspace-layout/published-layout/workspace-layout-published'

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
  }): RuntimePaneCreateClaim
  adoptStablePane?(opts: {
    onOutcome?: (outcome: PtySpawnOutcome, operation: PaneSpawnOperation) => void
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
    resolvedWorkspace?: TerminalWorkspaceLaunchScope
    cols: number
    rows: number
    cwd?: string
    command?: string
    launchAgent?: TuiAgent
    trustWorktreeId?: string
    launchConfig?: WorktreeStartupLaunch['launchConfig']
    launchToken?: string
    commandDelivery?: 'renderer' | 'provider'
    startupCommandDelivery?: WorktreeStartupLaunch['startupCommandDelivery']
    env?: Record<string, string>
    envToDelete?: string[]
    resumeProviderSession?: AgentProviderSessionMetadata
    resumeOrigin?: 'saved'
    telemetry?: WorktreeStartupLaunch['telemetry']
    connectionId?: string | null
    worktreeId?: string
    preAllocatedHandle?: string
    tabId?: string
    leafId?: string
    sessionId?: string
    /** Windows shell to spawn AS this PTY, instead of the host default. */
    shellOverride?: string
    /** The user's own act (a CLI command, a paired client's create, a launch); without it a stopped WSL distro holds the start. */
    wslUserAct?: true
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
    /** A paired launcher's theme: its PTY answers OSC 10/11 with it over the host-wide theme. */
    launcherColorQueryReplies?: { foreground?: string; background?: string }
    /** That launcher's palette and cursor, so its PTY's OSC 4/12 agree with its OSC 10/11. */
    launcherViewAttributes?: TerminalViewAttributes
    agentSessionEnsure?: {
      claim: AgentSessionExecutionClaim
      surface: AgentSessionSurfaceBinding
    }
    agentSessionCreateOperationId?: string
    spawnIntent?: SpawnIntent
    signal?: AbortSignal
    refuseSleptWorktree?: boolean
    onPtySpawnCommitted?: () => void
    /** Layout-owner build: whether a fresh start resumed its agent, told before its bind is written. */
    onResumeOutcome?: (ptyId: string, outcome: PaneResumeOutcome) => void
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
  }): Promise<
    PtySpawnResult & {
      stablePaneOwner?: { handle: string; tabId: string; leafId: string }
      startupCwdFallback?: StartupCwdFallback
      savedStartupCwd?: string
    }
  >
  /** The local terminal owner's automatic-restore state; null when it has no fork gate. */
  terminalLimit?(update?: TerminalLimitUpdate): Promise<TerminalLimitStatus | null>
  getAutomaticWorkStatus?(): Promise<AutomaticWorkStatus | null>
  resumeAutomaticWork?(): Promise<AutomaticWorkResumeOutcome>
  write(ptyId: string, data: string, inputKind: TerminalInputKind): boolean
  /** Three-valued settlement; local providers settle synchronously. */
  writeWithSettlement?(
    ptyId: string,
    data: string,
    inputKind: TerminalInputKind
  ): WriteSettlement | Promise<WriteSettlement>
  /** Attach existing local daemon output without creating, resizing or focusing; refuse uncertain, SSH-scoped or non-daemon sessions. */
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
    options?: {
      expectedIncarnationId?: PtyIncarnationId
      scanChildProcesses?: boolean
      foregroundOnly?: boolean
    }
  ): Promise<PtyProcessInspection>
  supportsForegroundObservation?(ptyId: string): boolean
  confirmForegroundProcess?(ptyId: string): Promise<string | null>
  confirmShellForeground?(ptyId: string): Promise<boolean>
  setLaunchNote?(ptyId: string, change: DaemonLaunchNoteChange): void
  hasChildProcesses?(ptyId: string): Promise<boolean>
  clearBuffer?(ptyId: string): Promise<void>
  resetInputModes?(ptyId: string): Promise<void>
  reportFocusLost?(ptyId: string): Promise<void>
  resize?(ptyId: string, cols: number, rows: number): boolean
  // Exact-id mobile polls must not enumerate every local/SSH PTY.
  hasPty?(ptyId: string): boolean | null
  getPtyAvailability?(ptyId: string): boolean | null
  /** Omitting the host lists every registered host. */
  listProcesses?(
    hostId?: ExecutionHostId,
    opts?: {
      deadlineMs?: number
      includeForegroundProcessEvidence?: boolean
      ptyIds?: readonly string[]
      targetOwnerOnly?: boolean
    }
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
  /** Set for a host-owned binding: its provider read is first and terminal, null is unavailable. */
  getTerminalHistoryAuthority?(ptyId: string): TerminalHistoryAuthority | undefined
  // Probe renderer authority before hydration (docs/mobile-prefer-renderer-scrollback.md).
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
  // Use unscoped inventory for absence proof; worktree-scoped livePtyIds could misclassify misattributed live terminals.
  allLivePtyIds: ReadonlySet<string>
  terminalIdentityByPtyId: ReadonlyMap<string, PtyControllerTerminalIdentity>
  queriedHostIds: ReadonlySet<ExecutionHostId>
  /** Live PTYs the host is killing: still live work, but no longer any pane's to show. */
  exitingPtyIds?: ReadonlySet<string>
}>
