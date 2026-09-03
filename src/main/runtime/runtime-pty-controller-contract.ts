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
import type { ExecutionHostId } from '../../shared/execution-host'
import type { PtyProviderBufferSnapshot, PtyProcessInfo, PtySpawnResult } from '../providers/types'
import type { PtyProcessInspection } from '../providers/pty-process-inspection'

export type RuntimePtyController = {
  claimStablePaneCreate?(args: {
    worktreeId: string
    connectionId: string | null
    tabId: string
    leafId: string
  }): () => void
  adoptStablePane?(opts: {
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
    isNewSession?: boolean
    persistHostSessionBinding?: boolean
    expectedSourceBinding?: PtyBindingSourceExpectation
    terminalColorQueryReplies?: { foreground?: string; background?: string }
    agentSessionEnsure?: {
      claim: AgentSessionExecutionClaim
      surface: AgentSessionSurfaceBinding
    }
    agentSessionCreateOperationId?: string
    signal?: AbortSignal
    onPtySpawnCommitted?: () => void
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
  }>
  write(ptyId: string, data: string): boolean
  writeAgentSessionProof?(
    ptyId: string,
    data: string,
    authority: { sessionId: string; spawnToken: string }
  ): boolean
  writeWithSettlement?(ptyId: string, data: string): Promise<boolean>
  /** Attach-only adoption of a live local daemon session so its output streams
   *  to main without a renderer pane; never creates, resizes, or focuses.
   *  False on doubt (absent session, SSH-scoped id, non-daemon provider). */
  attach?(ptyId: string): Promise<boolean>
  kill(ptyId: string): boolean
  retireRejectedPty?(ptyId: string, stopConfirmed: boolean): void
  stopAndWait?(
    ptyId: string,
    opts?: { keepHistory?: boolean; deadlineMs?: number }
  ): Promise<boolean>
  markReversibleStops?(ptyIds: readonly string[]): () => void
  getCwd?(ptyId: string): Promise<string | null>
  getForegroundProcess(ptyId: string): Promise<string | null>
  inspectProcess?(
    ptyId: string,
    options?: { expectedIncarnationId?: PtyIncarnationId }
  ): Promise<PtyProcessInspection>
  confirmForegroundProcess?(ptyId: string): Promise<string | null>
  confirmShellForeground?(ptyId: string): Promise<boolean>
  hasChildProcesses?(ptyId: string): Promise<boolean>
  clearBuffer?(ptyId: string): Promise<void>
  resize?(ptyId: string, cols: number, rows: number): boolean
  // Why: exact-id mobile polls should not enumerate every local and SSH PTY.
  hasPty?(ptyId: string): boolean | null
  listProcesses?(
    connectionId?: string | null,
    opts?: { deadlineMs?: number; includeForegroundProcessEvidence?: boolean }
  ): Promise<PtyProcessInfo[]>
  listProcessesWithHostScope?(opts?: {
    deadlineMs?: number
    includeForegroundProcessEvidence?: boolean
  }): Promise<{
    processes: PtyProcessInfo[]
    hostIds: ExecutionHostId[]
  }>
  supportsForegroundProcessEvidence?(connectionId?: string | null): Promise<boolean>
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
}>
