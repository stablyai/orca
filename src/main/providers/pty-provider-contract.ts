import type {
  PtyFencedTerminationRequest,
  PtyFencedTerminationOutcome
} from '../../shared/pty-fenced-termination'
import type { SpawnIntent } from '../../shared/host-spawn-admission'
import type { TuiAgent } from '../../shared/tui-agent'
import type { AgentWorkspaceTrustSpawnRequest } from '../../shared/agent-workspace-trust-spawn-request'
import type { PtyStartupIngressIntent } from '../../shared/pty-startup-ingress'
import type { TerminalOscColorQueryReplyColors } from '../../shared/terminal-osc-color-reply'
import type { StartupCommandDelivery } from '../../shared/codex-startup-delivery'
import type { TerminalOscLinkRange } from '../../shared/terminal-osc-link-ranges'
import type { PtyBackgroundStreamEvent, PtyDataEvent } from './pty-provider-events'
import type { PtySpawnResult } from './pty-spawn-result'
import type { PtyIncarnationId } from '../../shared/pty-incarnation'
import type {
  AgentSessionExecutionClaim,
  AgentSessionSurfaceBinding
} from '../../shared/agent-session-host-authority'
import type { PtyProcessInfo } from './pty-process-info'
import type { TerminalExitCause } from '../../shared/terminal-exit-cause'
import type { TerminalOwner } from '../../shared/terminal-owner'
import type { WriteSettlement } from '../../shared/pty-write-settlement'

export type {
  PtyBackgroundStreamEvent,
  PtyDataEvent,
  PtyTransientFact
} from './pty-provider-events'

export type PtyProviderBufferSnapshot = {
  data: string
  /** Live state that can be restored without an alternate-screen frame. */
  frameRestoreAnsi?: string
  /** Authoritative normal buffer captured beside an alternate-screen frame. */
  scrollbackAnsi?: string
  cols: number
  rows: number
  cwd?: string | null
  lastTitle?: string
  seq: number
  source: 'headless'
  oscLinks?: TerminalOscLinkRange[]
  alternateScreen?: boolean
  pendingEscapeTailAnsi?: string
  /** Flags proven at this snapshot seq; absent is unknown, never zero. */
  kittyKeyboardFlags?: number
  /** Ordered ownership evidence proven at this snapshot's `seq`. */
  terminalOwner?: TerminalOwner
}

export type PtySpawnOptions = {
  cols: number
  rows: number
  cwd?: string
  /** Exact per-spawn cwd already proven by main; providers validate any other resolved path. */
  prevalidatedCwd?: string
  env?: Record<string, string>
  envToDelete?: string[]
  /** Main-validated home provenance for an automatic Codex session resume. */
  codexHomePathOverride?: { value: string | null }
  command?: string
  commandDelivery?: 'renderer' | 'provider'
  startupCommandDelivery?: StartupCommandDelivery
  /** Minimal allowlisted launch ownership preserved by daemon reattach. */
  launchAgent?: TuiAgent
  /** Workspace identity also scopes local shell history. */
  worktreeId?: string
  /** Stable pane metadata for remote routing even when it cannot be exported into the shell env. */
  paneKey?: string
  /** Coarser attach guard when pane identity is unavailable. */
  tabId?: string
  /** Caller IDs request attachment; hosts also mint fresh IDs for state needed before spawn returns. */
  sessionId?: string
  /** Freshly minted session only; attaching a live PTY must not authorize daemon replacement. */
  isNewSession?: boolean
  /** Host setting forwarded additively to the process owner; old owners ignore it. */
  historyIsolationEnabled?: boolean
  /** SSH only: workspace the relay pre-trusts for `launchAgent` before spawning; old relays ignore it. */
  agentWorkspaceTrust?: AgentWorkspaceTrustSpawnRequest
  /** Attach the named session atomically or fail without creating a process. */
  attachOnly?: boolean
  /** Exact persisted owner expected by an attach-only routing decision. */
  expectedIncarnationId?: PtyIncarnationId
  /** True when runtime state makes the expected incarnation a hard attach fence. */
  expectedIncarnationIsAuthoritative?: boolean
  /** Windows-only per-tab shell selection without changing the persistent default. */
  shellOverride?: string
  /** Optional Unix interactive profile args; ignored for command and agent launches. */
  terminalShellArgs?: string[]
  /** Default WSL distro for generic wsl.exe; workspace/session cwd identity takes precedence. */
  terminalWindowsWslDistro?: string | null
  /** Persisted inbox/pwsh choice keeps local and daemon PowerShell-family launches aligned. */
  terminalWindowsPowerShellImplementation?: 'auto' | 'powershell.exe' | 'pwsh.exe'
  /** Fresh-spawn-only source authority installed before any PTY output is released. */
  startupIngress?: PtyStartupIngressIntent
  /** Why the caller is starting this terminal; presence lets the host defer an automatic restore. */
  spawnIntent?: SpawnIntent
  /** A restore no user act asked for: a WSL bridge pane whose distro is stopped is held, not started. */
  wslPassiveRestore?: true
  /** A main-side start no user act asked for (orchestration, automations, recovery): held like a passive restore. */
  wslBackgroundStart?: true
  agentSessionEnsure?: {
    claim: AgentSessionExecutionClaim
    surface: AgentSessionSurfaceBinding
  }
  /** Host-scoped structured-create identity used only for lower-owner replay. */
  agentSessionCreateOperationId?: string
  /** Signals that the native process exists even if later publication fails. */
  onPtySpawnCommitted?: () => void
  /** Cancels only before physical dispatch; operation identity fences later ambiguity. */
  signal?: AbortSignal
}

export type { PtyProcessInfo, PtySpawnResult }

type PtyProbeOptions = { signal?: AbortSignal }

export type IPtyProvider = {
  /** SSH providers only: the relay session generation that registered them. */
  readonly providerGeneration?: number
  requestHostRpc?: (
    method: string,
    params: unknown,
    options?: { signal?: AbortSignal; timeoutMs?: number }
  ) => Promise<unknown>
  /** Fresh local spawns currently route to an in-process, non-persistent fallback. */
  readonly routesFreshSpawnsToLocalProvider?: true
  /** Re-probes a degraded durable host before main commits to fallback spawn semantics. */
  recoverFreshSpawnRouting?: () => Promise<boolean>
  spawn(opts: PtySpawnOptions): Promise<PtySpawnResult>
  /** Process-owner cleanup for history stored outside the workspace tree. */
  deleteWorktreeHistory?: (worktreeId: string) => Promise<void>
  /** Whether this spawn target can append the Git guard after its final env merge. */
  supportsGitCredentialGuardHost?: (sessionId?: string) => boolean
  /** Explicit false selects pre-claim legacy spawn for a preserved old daemon. */
  supportsAgentSessionClaims?: (options?: PtyProbeOptions) => boolean | Promise<boolean>
  /** Whether missing claim metadata in this PTY's process listing proves absence. */
  providesAgentSessionOwnerListings?: (ptyId: string) => boolean
  supportsFencedTermination?: (id: string) => boolean
  killFenced?: (request: PtyFencedTerminationRequest) => Promise<PtyFencedTerminationOutcome>
  /** Whether fresh structured creates can replay one spawn across a lost relay response. */
  supportsAgentSessionCreateOperations?: (options?: PtyProbeOptions) => boolean | Promise<boolean>
  attach(id: string): Promise<Pick<PtySpawnResult, 'providerSequence' | 'lastTitle'> | void>
  hasPty?: (id: string) => boolean
  /** Exact provider readback: false only when the provider answered that the PTY is absent. */
  probePtyLiveness?: (id: string) => Promise<boolean | null>
  write(id: string, data: string): boolean | void
  /** Durable claims require real write settlement; fire-and-forget providers must report inability to settle. */
  writeWithSettlement: (id: string, data: string) => WriteSettlement | Promise<WriteSettlement>
  resize(id: string, cols: number, rows: number): void
  /** Best-effort kernel backpressure; unsupported/legacy providers omit or no-op, leaving output caps to bound memory. */
  pauseProducer?: (id: string) => void
  resumeProducer?: (id: string) => void
  /** Optional hidden-view hint allows keep-tail thinning so unwatched output cannot bury visible-pane echo. */
  setPtyBackgrounded?: (id: string, background: boolean) => void
  /** Thinning transports preserve byte order for scan-authority markers, gaps and notification facts from dropped bytes. */
  onBackgroundStreamEvent?: (callback: (payload: PtyBackgroundStreamEvent) => void) => () => void
  /** Endpoint-wide failure requires every affected PTY to remount/reattach; only respawnable providers emit it (STA-2373). */
  onWriteUnavailable?: (callback: (payload: { id: string }) => void) => () => void
  /** Authoritative provider model snapshot after monitoring-stream gaps; optional for other providers. */
  getBufferSnapshot?: (
    id: string,
    opts?: { scrollbackRows?: number }
  ) => Promise<PtyProviderBufferSnapshot | null>
  /** Whether this exact PTY can return a sequence-safe provider snapshot. */
  canProvideAuthoritativeBufferSnapshot?: (id: string) => boolean
  /** Applied size readback detects dropped/clamped remote resize requests.
   * Null means unconfirmed: callers re-forward once; providers without an authoritative source may omit this. */
  getAppliedSize?: (id: string) => Promise<{ cols: number; rows: number } | null>
  /** Optional host capability used to suppress expensive legacy remote inventory polls. */
  supportsForegroundProcessEvidence?(options?: { signal?: AbortSignal }): Promise<boolean>

  // Absolute deadlines bound leaf RPCs within the destructive sweep budget; each leaf converts to a relative timeout.
  shutdown(
    id: string,
    opts: {
      immediate?: boolean
      keepHistory?: boolean
      deadlineMs?: number
      expectedIncarnationId?: PtyIncarnationId
      /** Require the host-attested creator and current authenticated client to match before destructive ownership-based stops.
       * Optional/ignored on older hosts; ordinary teardown and unattested revived PTYs may omit it. */
      expectedOwnerClientInstanceId?: string
    }
  ): Promise<void>
  sendSignal(id: string, signal: string): Promise<void>
  getCwd(id: string): Promise<string>
  getInitialCwd(id: string): Promise<string>
  clearBuffer(id: string): Promise<void>
  /** Grounds the host's own terminal models (Reset Terminal); renderers ground themselves. */
  resetInputModes(id: string): Promise<void>
  /** Ends the startup Kitty-query window; OSC 10/11 authority stays with the owner for life. */
  closeStartupQueryAuthority?: (id: string) => Promise<number> | number
  /** Host-wide viewer colours the PTY owner answers OSC 10/11 from. */
  setColorQueryReplyColors?: (colors: TerminalOscColorQueryReplyColors) => void
  acknowledgeDataEvent(id: string, charCount: number): void
  hasChildProcesses(id: string): Promise<boolean>
  getForegroundProcess(id: string): Promise<string | null>
  /** Strong process evidence captured after the caller's command boundary. */
  confirmForegroundProcess?: (id: string) => Promise<string | null>
  /** Fresh execution-host proof that the spawned shell owns the PTY foreground. */
  confirmShellForeground?: (id: string) => Promise<boolean>
  serialize(ids: string[]): Promise<string>
  revive(state: string): Promise<void>
  listProcesses(opts?: {
    deadlineMs?: number
    includeForegroundProcessEvidence?: boolean
    /** Scope route validation to this workspace; providers may return a broader inventory. */
    worktreeId?: string
    /** Scope route validation to these PTYs; absence still requires a complete inventory. */
    ptyIds?: readonly string[]
    /** Diagnostic display only: include generations whose routing owner is unverifiable. */
    includeUnrouted?: boolean
  }): Promise<PtyProcessInfo[]>
  getDefaultShell(): Promise<string>
  getProfiles(): Promise<{ name: string; path: string }[]>
  onData(callback: (payload: PtyDataEvent) => void): () => void
  onReplay(callback: (payload: { id: string; data: string }) => void): () => void
  onExit(
    callback: (payload: {
      id: string
      code: number
      incarnationId?: PtyIncarnationId
      /** Absent when the provider predates exit causes; readers must not infer one from `code`. */
      cause?: TerminalExitCause
      /** Main ended the session to restart the daemon; the pane stays for its next process. */
      replacedByRestart?: true
      /** The session's host went away; its pane and history stay to cold-restore. */
      hostLost?: true
      /** The emitting provider already reported this exit to the runtime through configure().onExit. */
      runtimeFed?: true
    }) => void
  ): () => void
}
