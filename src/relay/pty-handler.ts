/* oxlint-disable max-lines */
import type { IPty } from 'node-pty'
import type * as NodePty from 'node-pty'
import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { resolveWindowsGitBashShellPath } from '../main/git-bash'
import { WINDOWS_GIT_BASH_SHELL } from '../shared/windows-terminal-shell'
import type { RelayDispatcher, RequestContext } from './dispatcher'
import {
  resolveDefaultShell,
  resolveProcessCwd,
  processHasChildren,
  getForegroundProcessName,
  isProcessAlive,
  listShellProfiles
} from './pty-shell-utils'
import { getRelayShellLaunchConfig, isRelayWslShell } from './pty-shell-launch'
import { RetiredPaneSurfaceRegistry } from './retired-pane-surfaces'
import { addWslEnvKeys } from '../shared/wsl-env'
import { SHELL_STARTUP_FEATURE_ENV } from '../main/shell-startup-features'
import { DEFAULT_SSH_RELAY_GRACE_PERIOD_SECONDS } from '../shared/ssh-types'
import { shouldUseShellReadyStartupDelivery } from '../shared/codex-startup-delivery'
import { buildStartupCommandSubmission } from '../shared/startup-command-submission'
import { resolveSetupAgentSequenceLaunchCommand } from '../shared/setup-agent-sequencing'
import {
  isPathInsideOrEqual,
  normalizeRuntimePathForComparison
} from '../shared/cross-platform-path'
import { splitWorktreeIdForFilesystem } from '../shared/worktree/id'
import {
  formatUnresolvedRelaySpawnCwdMessage,
  relayHostDirectoryExists,
  resolveRelaySpawnCwd,
  type RelaySpawnCwdResolution
} from './pty-spawn-cwd'
import { PhysicalExitTracker } from '../shared/physical-exit-tracker'
import { SHELL_READY_MARKER_PREFIX } from '../main/shell-ready-marker-scanner'
import {
  createShellStartupOutputScanState,
  drainShellStartupOutputScanState,
  scanShellStartupOutput,
  type ShellStartupOutputScanState
} from '../main/shell-startup-output-scanner'
import {
  createShellPromptReadinessProbe,
  type ShellPromptReadinessProbe
} from '../main/shell-prompt-readiness-probe'
import { applyTerminalGitCredentialPromptGuard } from '../shared/terminal-git-credential-guard'
import {
  gitCredentialPromptGuardEnv,
  mergeGitConfigEnvProtocol
} from '../shared/git-credential-prompt-env'
import { isTuiAgent } from '../shared/tui-agent-config'
import type { TuiAgent } from '../shared/tui-agent'
import { forceKillPosixPtyProcessGroups } from '../main/pty/posix-pty-process-groups'
import { terminatePtyJob } from '../main/windows/windows-pty-job'
import { stripInheritedBuildModeEnv } from '../main/pty/build-mode-env'
import { stripLegacyTerminalShimEnv } from '../main/pty/legacy-terminal-shim-dir'
import { dropIncoherentCondaActivationEnv } from '../main/pty/conda-activation-env'
import { dropInheritedOrcaFishHistory } from '../main/fish-history-session'
import { dropInheritedOrcaHistFile } from '../main/worktree-history-file-path'
import {
  PTY_STARTUP_INGRESS_VERSION,
  PtyStartupIngress,
  parsePtyStartupIngressIntent,
  type PtyIngressEmission
} from '../shared/pty-startup-ingress'
import { resolvePtyOwnerBackend, type PtyOwnerBackend } from '../shared/pty-owner-backend'
import { RecentPtyOutputBuffer } from '../main/runtime/recent-pty-output-buffer'
import {
  resolveAgentForegroundProcessesBatch,
  resolveRemoteForegroundEvidence,
  toForegroundProcessEvidence,
  type BatchedForegroundProcessResult
} from '../main/providers/agent-foreground-process'
import type { ProcessTableRow } from '../shared/process-table-snapshot'
import { getStrictProcessTableSnapshotWithAge } from '../shared/process-table-snapshot-reader'
import type {
  ForegroundProcessEvidence,
  RemoteForegroundEvidence
} from '../shared/foreground-process-evidence'
import { expandWindowsPathEnvironmentVariables } from '../shared/windows-environment-expansion'
import { pruneRetiredPtyIncarnations } from '../shared/retired-pty-incarnations'
import {
  agentSessionOwnerBindingsEqual,
  ClaimedAgentPtyOwnerRegistry
} from '../shared/claimed-agent-pty-owner'
import type { RelayPtySourceOutput } from './relay-pty-source-output'
import { signalPosixPtyForegroundGroup } from '../main/pty/posix-pty-foreground-group'
import { readPtsName } from '../main/pty/node-pty-pts-name'
import type { RelayPtySourcePublication } from './relay-pty-source-publication'
import type {
  PtySourceRecoveryRequest,
  PtySourceRecoveryResult
} from '../shared/pty-source-recovery-contract'
import type { PtySourceReceivingActivation } from '../shared/pty-source-receiving-activation'
import {
  AGENT_SESSION_CREATE_OPERATION_PROTOCOL_VERSION,
  AGENT_SESSION_EXECUTION_OWNER_PROTOCOL_VERSION,
  isAgentSessionExecutionClaim,
  isAgentSessionSurfaceBinding,
  type AgentSessionOwnerBinding
} from '../shared/agent-session-host-authority'
import { readPtySlavePath } from '../shared/pty-slave-line-discipline-echo'
import { chargedPtyRetainedStringBytes } from '../shared/pty-retained-string-memory'
import {
  deleteRelayFishHistory,
  deleteRelayHistory,
  injectRelayFishHistoryEnv,
  injectRelayHistoryEnv
} from './terminal-history'
import { isFlattenedNodePtyLoaderMessage } from '../main/orcad/node-pty-loader-diagnosis'
import { collectNodePtyUnavailableDiagnosis } from './node-pty-binding-survey'
import {
  formatNodePtyUnavailableMessage,
  toTerminalUnavailableCause
} from './node-pty-unavailable-diagnosis'
import { TERMINAL_UNAVAILABLE_RPC_ERROR_CODE } from '../shared/terminal-unavailable-cause'

/**
 * The shell a spawn will actually launch, resolved the same way `spawnAfterAdmission` resolves it.
 *
 * Non-throwing on an unsupported override: that override fails the spawn later regardless, and this
 * is only asked in order to decide whose filesystem the cwd lives on.
 */
function resolveRelaySpawnShell(
  params: Record<string, unknown>,
  env: Record<string, string> | undefined
): string {
  const shellOverride = typeof params.shellOverride === 'string' ? params.shellOverride.trim() : ''
  const requestedEnvShell =
    process.platform !== 'win32' && typeof env?.SHELL === 'string' ? env.SHELL.trim() : ''
  return resolveRevivedShellOverride(shellOverride) || requestedEnvShell || resolveDefaultShell()
}

/**
 * Spawn cwd, or a refusal. Both `spawnOnce` (admission fence) and `spawnAfterAdmission` (the native
 * spawn) resolve through here so the fence can never be keyed on a directory the spawn won't use.
 */
function requireRelaySpawnCwd(
  params: Record<string, unknown>,
  env: Record<string, string> | undefined
): string {
  const resolution: RelaySpawnCwdResolution = resolveRelaySpawnCwd({
    requestedCwd: params.cwd,
    worktreeId: typeof params.worktreeId === 'string' ? params.worktreeId : env?.ORCA_WORKTREE_ID,
    env,
    launchAgent: isTuiAgent(params.launchAgent) ? params.launchAgent : undefined,
    // A WSL shell executes in a guest, so the relay's own statSync is not the right question.
    executesOnRelayFilesystem: !isRelayWslShell(resolveRelaySpawnShell(params, env))
  })
  if (resolution.kind === 'unresolved') {
    throw new Error(formatUnresolvedRelaySpawnCwdMessage(resolution.workspaceId))
  }
  return resolution.cwd
}

function isMissingNodePtyNativeBinding(error: unknown): boolean {
  return error instanceof Error && isFlattenedNodePtyLoaderMessage(error.message)
}

function parseSourceRecoveryRequest(value: unknown): PtySourceRecoveryRequest | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }
  const input = value as Record<string, unknown>
  if (input.status === 'checkpointUnavailable') {
    return Object.freeze({ status: 'checkpointUnavailable' })
  }
  if (
    input.status !== 'checkpoint' ||
    typeof input.deliveryToken !== 'string' ||
    input.deliveryToken.length === 0 ||
    typeof input.ptyIncarnation !== 'string' ||
    input.ptyIncarnation.length === 0 ||
    !Number.isSafeInteger(input.clientGeneration) ||
    Number(input.clientGeneration) <= 0 ||
    !Number.isSafeInteger(input.ownerGeneration) ||
    Number(input.ownerGeneration) <= 0 ||
    !Number.isSafeInteger(input.acceptedSourceEndSu) ||
    Number(input.acceptedSourceEndSu) < 0
  ) {
    return Object.freeze({ status: 'checkpointUnavailable' })
  }
  return Object.freeze({
    status: 'checkpoint',
    deliveryToken: input.deliveryToken,
    ptyIncarnation: input.ptyIncarnation,
    clientGeneration: Number(input.clientGeneration),
    ownerGeneration: Number(input.ownerGeneration),
    acceptedSourceEndSu: Number(input.acceptedSourceEndSu)
  })
}

type ManagedPty = {
  id: string
  incarnationId: string
  pty: IPty
  initialCwd: string
  /** Why a chunk deque: rebuilding a rolling 100KB string per PTY chunk copied the
   * whole window on every write once saturated. Readers are attach/adopt/revive only. */
  buffered: RecentPtyOutputBuffer
  /** Timer for SIGKILL fallback after a graceful SIGTERM shutdown. */
  killTimer?: ReturnType<typeof setTimeout>
  /** Timer for the post-shutdown reap sweep: re-probes liveness after a kill request instead of
   *  assuming the request landed. */
  reapTimer?: ReturnType<typeof setTimeout>
  /** True once disposeManagedPty has run; blocks double-dispose and makes post-dispose calls fail "not found" not silently. */
  disposed?: boolean
  /** True once external cleanup observers have been notified. */
  exitListenerNotified?: boolean
  /** Renderer-supplied paneKey (ORCA_PANE_KEY); captured so exit observers can evict per-pane cache state. */
  paneKey?: string
  tabId?: string
  /** Attach-only identity metadata (RPC). Separate from paneKey/tabId, which also drive shell env/revive hooks. */
  attachIdentity?: PtyIdentity
  worktreeId?: string
  terminalHandle?: string
  explicitTerm?: string
  shellPath?: string
  /** The raw client-requested shell override, kept so revive can re-resolve it on this host. */
  shellOverride?: string
  /** Requested WSL distro; only meaningful when the override launched wsl.exe. */
  wslDistro?: string
  shellCwd?: string
  shellPathEnv?: string
  envToDelete: string[]
  gitCredentialPromptGuarded: boolean
  historyIsolationEnabled?: boolean
  startupCommand?: ManagedStartupCommand
  physicalExit?: PhysicalExitTracker
  forceKillSent?: boolean
  gracefulKillSent?: boolean
  startupIngress?: PtyStartupIngress
  startupIngressIntent?: ReturnType<typeof parsePtyStartupIngressIntent>
  ownerBackend: PtyOwnerBackend
  agentSessionOwners?: AgentSessionOwnerBinding[]
  /** Host clock, host-relative only: published as an age so no client has to trust our wall clock. */
  createdAt: number
  /** The authenticated consumer identity that asked this host to create this PTY, read from the
   *  live grant rather than from a spawn parameter. Absent whenever the host could not attest one
   *  (no consumer session, or a revive replaying state some other client serialized), and absence
   *  must never be read as "nobody owns it". */
  ownerClientInstanceId?: string
}

type RelayAgentSessionCreateResult = {
  id: string
  incarnationId: string
  replay?: string
  agentSessionEnsure?: unknown
  sourceActivation?: PtySourceReceivingActivation
}

const AGENT_SESSION_CREATE_OPERATION_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/
const AGENT_SESSION_CREATE_OPERATION_RETENTION_MS = 24 * 60 * 60 * 1000
const AGENT_SESSION_CREATE_OPERATION_LIMIT = 4_096

type PendingPtyOutput = RelayPtySourceOutput & {
  data: string
  interactive?: boolean
  sourceChunk?: RelayPtySourceOutput
  /** Cached producer-retention charge; kept off the wire and refreshed on data mutations. */
  producerChargeBytes?: number
}

type ManagedStartupCommand = {
  command: string | null
  providerDelivery: boolean
  delivered: boolean
  waitForShellReady: boolean
  outputScanState: ShellStartupOutputScanState | null
  shellPid: number | null
  promptProbe: ShellPromptReadinessProbe | null
  timer: ReturnType<typeof setTimeout> | null
}

// Why: Windows ConPTY rejects signals; forward them only on POSIX.
function killPtyProcess(pty: IPty, signal: string): void {
  if (process.platform === 'win32') {
    pty.kill()
    return
  }
  if (signal === 'SIGKILL') {
    forceKillPosixPtyProcessGroups(pty.pid, () => pty.kill(signal))
    return
  }
  pty.kill(signal)
}

function finishPtyCreationOperations(operations: readonly (() => void)[]): void {
  // Why: the relay still targets Node 18, which lacks Array.prototype.toReversed.
  for (let index = operations.length - 1; index >= 0; index--) {
    operations[index]()
  }
}

function disposeManagedPty(managed: ManagedPty): void {
  if (managed.disposed) {
    return
  }
  managed.disposed = true
  // Why: clear the SIGKILL fallback timer so it can't fire pty.kill on an already-disposed instance.
  if (managed.killTimer) {
    clearTimeout(managed.killTimer)
    managed.killTimer = undefined
  }
  if (managed.reapTimer) {
    clearTimeout(managed.reapTimer)
    managed.reapTimer = undefined
  }
  // Why: neutralize pty.kill before destroy() so UnixTerminal's async 'close' SIGHUP can't hit a recycled pid.
  // Windows exempt: its destroy() IS a kill() (via _deferNoArgs), so neutralizing leaks the ConPTY agent.
  if (process.platform !== 'win32') {
    ;(managed.pty as unknown as { kill: (sig?: string) => void }).kill = () => {}
  } else if (managed.gracefulKillSent || managed.forceKillSent) {
    // Why: WindowsTerminal.destroy() calls kill(); a prior bare kill already closed ConPTY, so skip to avoid double-close.
    return
  }
  try {
    ;(managed.pty as unknown as { destroy?: () => void }).destroy?.()
  } catch {
    /* swallow */
  }
}
const DEFAULT_GRACE_TIME_MS = DEFAULT_SSH_RELAY_GRACE_PERIOD_SECONDS * 1000
export const IMMEDIATE_PTY_EXIT_TIMEOUT_MS = 8_000
/** Longer than the 5s armed SIGKILL fallback, so the first sweep observes the post-kill state. */
export const SHUTDOWN_REAP_VERIFY_DELAY_MS = 6_000
export const SHUTDOWN_REAP_MAX_SWEEPS = 3
export const MAX_RELAY_PTY_SESSIONS = 50
export const REPLAY_BUFFER_MAX = 100 * 1024
const PTY_OUTPUT_BATCH_INTERVAL_MS = 8
const PTY_OUTPUT_DRAIN_CONTINUE_MS = 1
const PTY_OUTPUT_FLUSH_CHUNK_CHARS = 16 * 1024
const PTY_OUTPUT_FLUSH_MAX_WRITES = 2
const PTY_OUTPUT_PRODUCER_HIGH_BYTES = 128 * 1024
const PTY_OUTPUT_PRODUCER_LOW_BYTES = 64 * 1024
const INTERACTIVE_OUTPUT_WINDOW_MS = 100
const INTERACTIVE_OUTPUT_MAX_CHARS = 1024
const INTERACTIVE_REDRAW_MAX_CHARS = PTY_OUTPUT_FLUSH_CHUNK_CHARS
const INTERACTIVE_OUTPUT_BUDGET_CHARS = 32 * 1024
const STARTUP_COMMAND_WRITE_DELAY_MS = 50
const STARTUP_COMMAND_SHELL_READY_FALLBACK_MS = 1500
const RENDERER_SHELL_READY_RETENTION_MS = 15_000
const PTY_FORCE_KILL_RETRY_DELAY_MS = 250
const PTY_FORCE_KILL_MAX_ATTEMPTS = 2
const ALLOWED_SIGNALS = new Set([
  'SIGINT',
  'SIGTERM',
  'SIGHUP',
  'SIGKILL',
  'SIGTSTP',
  'SIGCONT',
  'SIGWINCH',
  'SIGUSR1',
  'SIGUSR2'
])

const ALLOWED_WINDOWS_SHELL_OVERRIDES = new Set([
  'powershell.exe',
  'powershell',
  'pwsh.exe',
  'pwsh',
  'cmd.exe',
  'cmd',
  'wsl.exe',
  'wsl',
  // Why: both spellings classify as a POSIX startup family, so rejecting them here made the relay
  // the one host that hard-failed a setting the local and daemon PTYs accept.
  'bash.exe',
  'bash',
  WINDOWS_GIT_BASH_SHELL
])

function resolvePtyShellOverride(shellOverride: string): string {
  if (!shellOverride) {
    return ''
  }
  if (process.platform !== 'win32') {
    return ''
  }
  const normalized = shellOverride.toLowerCase()
  if (!ALLOWED_WINDOWS_SHELL_OVERRIDES.has(normalized)) {
    throw new Error(`Unsupported Windows shell override: ${shellOverride}`)
  }
  return resolveWindowsGitBashShellPath(shellOverride) ?? shellOverride
}

/**
 * Longest WSL distro name revive will carry into `wsl.exe -d <name>`.
 *
 * Why bounded here and not at spawn: spawn's value is a live RPC parameter,
 * while this one is replayed from state the relay hands a client and takes back
 * unvalidated. It reaches an argv, not a shell, so an over-long name costs a
 * failed spawn rather than anything worse -- but revive's whole job here is to
 * re-apply fresh-spawn bounds, and an unbounded value had no business in it.
 * Real distro names are registry keys, far below this.
 */
const MAX_REVIVED_WSL_DISTRO_LENGTH = 256

/**
 * Same bounds as a fresh spawn, but one unusable entry may not fail the whole
 * revive batch — an override this host no longer allows degrades that single
 * pane to the default shell instead of throwing away every other pane's state.
 */
function resolveRevivedShellOverride(shellOverride: string): string {
  try {
    return resolvePtyShellOverride(shellOverride)
  } catch {
    return ''
  }
}

type PtyProcessSummary = {
  id: string
  incarnationId: string
  cwd: string
  title: string
  worktreeId?: string
  terminalHandle?: string
  foregroundProcessEvidence?: ForegroundProcessEvidence
  agentSessionOwners?: AgentSessionOwnerBinding[]
  /** Age on the HOST's clock. Published instead of a creation timestamp so a client with a skewed
   *  clock cannot compute a negative or enormous age and act on it. */
  hostAgeMs?: number
  /** True when this PTY was spawned for an Orca pane (`ORCA_PANE_KEY`). False means a bare relay
   *  shell. Absent from a host that predates the field — which is neither. */
  paneBound?: boolean
  /** See {@link ManagedPty.ownerClientInstanceId}. Omitted when this host cannot attest one. */
  ownerClientInstanceId?: string
}

type SerializedPtyEntry = {
  id: string
  pid: number
  cols: number
  rows: number
  cwd: string
  paneKey?: string
  tabId?: string
  attachIdentity?: PtyIdentity
  worktreeId?: string
  terminalHandle?: string
  explicitTerm?: string
  envToDelete?: string[]
  /** Optional for state serialized by relays predating the credential guard. */
  gitCredentialPromptGuarded?: boolean
  /** Optional for state serialized by relays predating scoped history. */
  historyIsolationEnabled?: boolean
  /**
   * The shell override this pane was spawned with, re-resolved (and re-bounded)
   * on revive. Optional: state from a relay predating it revives the host
   * default shell, which is what those relays did anyway.
   */
  shellOverride?: string
  terminalWindowsWslDistro?: string
  agentSessionOwners?: AgentSessionOwnerBinding[]
}

function sanitizeEnvToDelete(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((key): key is string => typeof key === 'string' && key.length > 0)
        .slice(0, 1_024)
    : []
}

export type PtyExitListener = (event: { id: string; paneKey?: string }) => void

/** Notified when a client retires a pane's surface (`pty.shutdown`). Deliberately separate from
 *  {@link PtyExitListener}: retirement says the tab is gone, never that the process exited. */
export type PtySurfaceRetiredListener = (event: { id: string; paneKey: string }) => void

type PtyIdentity = { paneKey?: string; tabId?: string }

/**
 * True when a reattach's expected pane identity contradicts the target PTY's own.
 * Rejects legacy cross-relay-generation id collisions (a reset relay reused `pty-N`).
 * Only compares fields present on both sides; absent identity stays permissive.
 */
export function attachIdentityMismatches(expected: PtyIdentity, managed: PtyIdentity): boolean {
  return Boolean(
    (expected.paneKey && managed.paneKey && expected.paneKey !== managed.paneKey) ||
    (expected.tabId && managed.tabId && expected.tabId !== managed.tabId)
  )
}
/** Returns env to merge into the PTY's spawn env. Receives spawn context so augmenters can derive per-PTY identity from paneKey.
 *  `command` is the renderer-chosen agent launch command (`pi`, `omp`, …); undefined for CLI-launched bare shells. */
export type PtyEnvAugmenter = (ctx: {
  id: string
  paneKey?: string
  shell: string
  env: Record<string, string>
  command?: string
  launchAgent?: TuiAgent
}) => Record<string, string>

export type RelayPtyWorktreeRemovalCoordinator = {
  beginWorktreePtySpawn(operationPath: string): () => void
}

export class PtyHandler {
  private ptys = new Map<string, ManagedPty>()
  private readonly ptyIdMintEpoch: string
  private foregroundEvidenceEpoch = 0
  private nextId = 1
  private dispatcher: RelayDispatcher
  private graceTimeMs: number
  private graceTimer: ReturnType<typeof setTimeout> | null = null
  private outputFlushTimer: ReturnType<typeof setTimeout> | null = null
  private pendingOutputByPty = new Map<string, PendingPtyOutput[]>()
  private pendingProducerBytesByPty = new Map<string, number>()
  private pendingExitByPty = new Map<string, { id: string; code: number; incarnationId: string }>()
  private retiredIncarnations = new Map<
    string,
    { id: string; code: number; incarnationId: string; expiresAt: number }
  >()
  private pausedOutputPtys = new Set<string>()
  private consumerPausedOutputPtys = new Set<string>()
  private removeLegacyCapacityListener: (() => void) | null = null
  private sourcePublication: RelayPtySourcePublication | null = null
  private consumerIdentityResolver: ((clientId: number) => string | null) | null = null
  private lastInputAtByPty = new Map<string, number>()
  private interactiveOutputCharsByPty = new Map<string, number>()
  private pendingSpawnCount = 0
  private pendingReviveIds = new Set<string>()
  private creationFenced = false
  private pendingCreationDrainResolvers = new Set<() => void>()
  private worktreeRemovalCoordinator: RelayPtyWorktreeRemovalCoordinator | null = null
  private disposePromise: Promise<void> | null = null
  private ptyModule: typeof NodePty | null = null
  private ptyModuleLoadPromise: Promise<typeof NodePty | null> | null = null
  private reloadPtyModuleFromDisk = false
  /** The last thing `require('node-pty')` threw, kept because it is the only cause anyone has. */
  private lastPtyLoadError: unknown = null
  // Why: single optional slot is intentional — callers compose externally; a throw is swallowed so it can't block cleanup.
  private exitListener: PtyExitListener | null = null
  private surfaceRetiredListener: PtySurfaceRetiredListener | null = null
  private readonly retiredPaneSurfaces = new RetiredPaneSurfaceRegistry()
  private ptyPoolEmptyListener: (() => void) | null = null
  private ptyPoolActiveListener: (() => void) | null = null
  // Why: augment environment on every spawn so PTYs receive current hook coordinates.
  private envAugmenters: PtyEnvAugmenter[] = []
  private readonly agentSessionOwners = new ClaimedAgentPtyOwnerRegistry()
  private readonly agentSessionCreateOperations = new Map<
    string,
    Promise<RelayAgentSessionCreateResult>
  >()

  constructor(
    dispatcher: RelayDispatcher,
    graceTimeMs = DEFAULT_GRACE_TIME_MS,
    ptyIdMintEpoch: string = randomUUID()
  ) {
    this.dispatcher = dispatcher
    this.graceTimeMs = graceTimeMs
    this.ptyIdMintEpoch = ptyIdMintEpoch
    this.registerHandlers()
    this.removeLegacyCapacityListener =
      this.dispatcher.onLegacyPtyCapacity?.(() => this.handleLegacyCapacity()) ?? null
  }

  setConsumerDeliveryPaused(id: string, paused: boolean): void {
    if (paused) {
      this.consumerPausedOutputPtys.add(id)
      this.pausePtyOutput(id)
      return
    }
    this.consumerPausedOutputPtys.delete(id)
    this.maybeResumePtyOutput(id)
  }

  setSourcePublication(publication: RelayPtySourcePublication): void {
    this.sourcePublication = publication
  }

  /** Supplies the authenticated client identity behind a transport connection, so a spawn can be
   *  attributed to the consumer session that requested it. */
  setConsumerIdentityResolver(resolve: ((clientId: number) => string | null) | null): void {
    this.consumerIdentityResolver = resolve
  }

  handleSourceCreditAvailable(id: string): void {
    this.sourcePublication?.onCreditAvailable(id)
  }

  handleSourcePublicationCapacity(id: string): void {
    if (this.pendingOutputByPty.has(id)) {
      this.scheduleOutputFlush(0)
    }
    this.maybeResumePtyOutput(id)
    this.publishPendingExit(id)
  }

  private async loadPty(): Promise<typeof NodePty | null> {
    if (this.ptyModule) {
      return this.ptyModule
    }
    if (this.ptyModuleLoadPromise) {
      return this.ptyModuleLoadPromise
    }
    this.ptyModuleLoadPromise = this.loadPtyUncached()
    try {
      return await this.ptyModuleLoadPromise
    } finally {
      this.ptyModuleLoadPromise = null
    }
  }

  private async loadPtyUncached(): Promise<typeof NodePty | null> {
    if (!this.reloadPtyModuleFromDisk) {
      try {
        this.ptyModule = await import('node-pty')
        return this.ptyModule
      } catch (error) {
        // Why keep it: this is the only place the load error exists. Discarding it here is
        // what left the relay able to say "unavailable" and never why.
        this.lastPtyLoadError = error
        this.reloadPtyModuleFromDisk = true
      }
    }
    // Why: tie module resolution to the deployed bundle dir, not cwd.
    const moduleEntry = join(this.relayNodePtyDir(), 'lib', 'index.js')
    if (!existsSync(moduleEntry)) {
      this.lastPtyLoadError = this.lastPtyLoadError ?? new Error(`no node-pty at ${moduleEntry}`)
      return null
    }
    try {
      this.ptyModule = require(moduleEntry) as typeof NodePty
      return this.ptyModule
    } catch (error) {
      this.lastPtyLoadError = error
      return null
    }
  }

  /** Where the relay's own node-pty lives — the deployed bundle dir, never cwd. */
  private relayNodePtyDir(): string {
    return join(__dirname, 'node_modules', 'node-pty')
  }

  /**
   * The rejection for a spawn that cannot happen: prose for a human, and the structured
   * cause for a client that can repair the host instead of printing a paragraph.
   *
   * Runs the survey and out-of-process load probe only here, on the failure path, so a
   * healthy relay never pays for them.
   */
  private async nodePtyUnavailableError(spawnError?: unknown): Promise<Error> {
    const nodePtyDir = this.relayNodePtyDir()
    const diagnosis = await collectNodePtyUnavailableDiagnosis({
      nodePtyDir: existsSync(nodePtyDir) ? nodePtyDir : null,
      error: spawnError ?? this.lastPtyLoadError
    })
    return Object.assign(new Error(formatNodePtyUnavailableMessage(diagnosis)), {
      code: TERMINAL_UNAVAILABLE_RPC_ERROR_CODE,
      data: toTerminalUnavailableCause(diagnosis)
    })
  }

  private invalidatePtyModuleAfterBindingFailure(): void {
    this.ptyModule = null
    this.reloadPtyModuleFromDisk = true
    const moduleRoot = this.relayNodePtyDir()
    for (const cachedPath of Object.keys(require.cache)) {
      if (isPathInsideOrEqual(moduleRoot, cachedPath)) {
        delete require.cache[cachedPath]
      }
    }
  }

  // Why: this value never reaches the grace *timer* — startGraceTimer's only caller always passes an
  // explicit timeoutMs — but relay.startGrace reads it back through configuredGraceTimeMs to pick the
  // grace branch, so a host-sent change does affect shutdown behavior. Callers and the host-sleep
  // consequence: docs/reference/relay-grace-time-reconfiguration.md.
  setGraceTimeMs(graceTimeMs: number): void {
    this.graceTimeMs = Math.max(0, Math.floor(graceTimeMs))
  }

  setWorktreeRemovalCoordinator(coordinator: RelayPtyWorktreeRemovalCoordinator | null): void {
    this.worktreeRemovalCoordinator = coordinator
  }

  async shutdownForWorktreePath(rootPath: string): Promise<void> {
    const matchingIds = [...this.ptys.values()]
      .filter((managed) => {
        const ownedPath = managed.worktreeId
          ? splitWorktreeIdForFilesystem(managed.worktreeId)?.worktreePath
          : undefined
        return (
          (ownedPath !== undefined && isPathInsideOrEqual(rootPath, ownedPath)) ||
          isPathInsideOrEqual(rootPath, managed.initialCwd)
        )
      })
      .map((managed) => managed.id)
    await Promise.all(matchingIds.map((id) => this.shutdown({ id, immediate: true })))
  }

  get configuredGraceTimeMs(): number {
    return this.graceTimeMs
  }

  /** Subscribe to PTY-exit events (relay-hook server uses this to evict per-paneKey caches). */
  setExitListener(listener: PtyExitListener | null): void {
    this.exitListener = listener
  }

  /** Subscribe to pane-surface retirement (relay-hook server uses this to drop the pane's cached
   *  agent status the moment the tab goes away, rather than waiting for a process exit that a
   *  surviving shell may never produce). */
  setSurfaceRetiredListener(listener: PtySurfaceRetiredListener | null): void {
    this.surfaceRetiredListener = listener
  }

  /** True when the client has told this host the pane's tab is gone and no PTY has re-bound the
   *  paneKey since. Nothing this pane emits can belong to a surface any client still owns. */
  isPaneSurfaceRetired(paneKey: string): boolean {
    return this.retiredPaneSurfaces.isRetired(paneKey)
  }

  /** Notified when the last PTY leaves the pool, so the relay can re-arm its idle grace. */
  onPtyPoolEmpty(listener: () => void): () => void {
    this.ptyPoolEmptyListener = listener
    return () => {
      if (this.ptyPoolEmptyListener === listener) {
        this.ptyPoolEmptyListener = null
      }
    }
  }

  /**
   * Notified when a PTY creation is admitted or a PTY joins the pool.
   *
   * Why: the relay arms its idle cap on an empty pool, and a spawn/revive that lands after that
   * decision must disarm it — creation is asynchronous, so the pool-empty edge alone can't see it.
   */
  onPtyPoolActive(listener: () => void): () => void {
    this.ptyPoolActiveListener = listener
    return () => {
      if (this.ptyPoolActiveListener === listener) {
        this.ptyPoolActiveListener = null
      }
    }
  }

  private notifyPoolListener(listener: (() => void) | null, label: string): void {
    if (!listener) {
      return
    }
    try {
      listener()
    } catch (err) {
      process.stderr.write(
        `[pty-handler] ${label} listener threw: ${err instanceof Error ? err.message : String(err)}\n`
      )
    }
  }

  // Why: the sole removal path, so the three exit routes can't drift on who announces an empty pool.
  private removePty(id: string): void {
    this.ptys.delete(id)
    if (this.ptys.size > 0) {
      return
    }
    this.notifyPoolListener(this.ptyPoolEmptyListener, 'pty-pool-empty')
  }

  /** Register an env augmenter merged into every spawn env *after* process.env and renderer env.
   *  Used by the relay-hook server to inject ORCA_AGENT_HOOK_* coords: evaluated per spawn (not captured once), so a late or restarted hook-server bind still reaches the next PTY. */
  addEnvAugmenter(augmenter: PtyEnvAugmenter): () => void {
    this.envAugmenters.push(augmenter)
    return () => {
      const idx = this.envAugmenters.indexOf(augmenter)
      if (idx !== -1) {
        this.envAugmenters.splice(idx, 1)
      }
    }
  }

  /** Build augmented spawn env; augmenter values win over process.env/renderer env. Shared by spawn()/revive() so precedence can't drift. */
  private buildSpawnEnv(
    rendererEnv: Record<string, string> | undefined,
    ctx: {
      id: string
      paneKey?: string
      shell: string
      command?: string
      launchAgent?: TuiAgent
    },
    envToDelete: readonly string[] = []
  ): Record<string, string> {
    const baseEnv = mergeGitConfigEnvProtocol(
      {
        ...stripInheritedBuildModeEnv(process.env),
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        TERM_PROGRAM: 'Orca',
        TERM_PROGRAM_VERSION:
          rendererEnv?.ORCA_APP_VERSION || process.env.ORCA_APP_VERSION || '0.0.0-dev',
        FORCE_HYPERLINK: '1'
      },
      rendererEnv
    ) as Record<string, string>
    const augmented: Record<string, string> = {}
    for (const augmenter of this.envAugmenters) {
      try {
        Object.assign(augmented, augmenter({ ...ctx, env: baseEnv }))
      } catch (err) {
        process.stderr.write(
          `[pty-handler] env augmenter threw: ${err instanceof Error ? err.message : String(err)}\n`
        )
      }
    }
    const result = mergeGitConfigEnvProtocol(baseEnv, augmented) as Record<string, string>
    // Why: an older client may not ask a newly upgraded relay to delete inherited shim state.
    stripLegacyTerminalShimEnv(result, process.platform)
    // Why unconditionally here, not in injectRelayFishHistoryEnv: that runs only for a
    // fish pane with isolation on, yet an Orca-minted `fish_history` (fish EXPORTS it,
    // so the relay inherits one when launched from an Orca fish pane) must never scope
    // any pane to someone else's worktree. Matches the desktop, which drops it on both
    // branches (STA-4682).
    dropInheritedOrcaFishHistory(result)
    // Why here as well as in injectRelayHistoryEnv: that runs only with isolation
    // on, yet an inherited Orca HISTFILE must not scope a pane to someone else's
    // worktree on the disabled and revive paths either.
    dropInheritedOrcaHistFile(result)
    // Why unconditionally: ORCA_HISTFILE is Orca-owned and minted below by
    // injectRelayHistoryEnv, which also runs only with isolation on. An
    // inherited one (the relay can be launched from an Orca pane) would
    // otherwise reach the wrapper on the disabled and revive paths, scoping the
    // pane to another worktree's history file — and wrapping a zsh pane that
    // nothing asked to wrap, since `history` is selected on its presence.
    delete result.ORCA_HISTFILE
    // Why: match local/daemon precedence so defaults/augmenters can't resurrect explicitly-removed values.
    for (const key of envToDelete) {
      delete result[key]
    }
    if (!envToDelete.includes('TERM') && rendererEnv && Object.hasOwn(rendererEnv, 'TERM')) {
      result.TERM = rendererEnv.TERM
    }
    // Why: node-pty defaults missing/empty TERM per-platform; normalize so POSIX and Windows children agree.
    if (!result.TERM) {
      result.TERM = 'xterm-256color'
    }
    // Why last, not beside the scrubbers above: the relay runs those BEFORE envToDelete,
    // so an envToDelete of CONDA_PREFIX would otherwise re-create the broken pair.
    dropIncoherentCondaActivationEnv(result, process.platform)
    expandWindowsPathEnvironmentVariables(result)
    return result
  }

  private clearStartupCommandTimer(managed: ManagedPty): void {
    if (managed.startupCommand?.timer) {
      clearTimeout(managed.startupCommand.timer)
      managed.startupCommand.timer = null
    }
  }

  private appendReplayBuffer(managed: ManagedPty, data: string): void {
    if (data.length === 0) {
      return
    }
    managed.buffered.append(data)
  }

  private releaseStartupCommand(managed: ManagedPty): void {
    this.clearStartupCommandTimer(managed)
    managed.startupCommand?.promptProbe?.dispose()
    managed.startupCommand = undefined
  }

  private drainStartupScanBytes(startup: ManagedStartupCommand): string {
    if (!startup.outputScanState) {
      return ''
    }
    const heldBytes = drainShellStartupOutputScanState(startup.outputScanState)
    startup.outputScanState = null
    return heldBytes
  }

  private scheduleStartupCommandResolution(managed: ManagedPty, delayMs: number): void {
    const startup = managed.startupCommand
    if (!startup || startup.delivered || managed.disposed) {
      return
    }
    this.clearStartupCommandTimer(managed)
    startup.timer = setTimeout(() => {
      startup.timer = null
      if (startup.providerDelivery) {
        this.deliverStartupCommand(managed)
      } else {
        this.signalRendererShellReady(managed)
      }
    }, delayMs)
  }

  private deliverStartupCommand(managed: ManagedPty): void {
    const startup = managed.startupCommand
    if (!startup?.providerDelivery || !startup.command || startup.delivered || managed.disposed) {
      return
    }
    startup.delivered = true
    this.clearStartupCommandTimer(managed)
    startup.promptProbe?.dispose()
    const heldBytes = this.drainStartupScanBytes(startup)
    if (heldBytes) {
      managed.startupIngress?.accept(heldBytes)
    }
    const submit = process.platform === 'win32' ? '\r' : '\n'
    // Why: only the shell-ready wrapper arms bracketed-paste; other shells use raw submit so ESC[200~ markers aren't echoed.
    const payload = buildStartupCommandSubmission(startup.command, {
      submit,
      bracketedPasteSafe: startup.waitForShellReady
    })
    managed.startupCommand = undefined
    managed.pty.write(payload)
  }

  private signalRendererShellReady(managed: ManagedPty): void {
    const startup = managed.startupCommand
    if (!startup || startup.providerDelivery || startup.delivered || managed.disposed) {
      return
    }
    startup.delivered = true
    this.clearStartupCommandTimer(managed)
    startup.promptProbe?.dispose()
    managed.startupIngress?.accept(this.drainStartupScanBytes(startup))
    managed.startupIngress?.accept(`${SHELL_READY_MARKER_PREFIX}\x07`)
    managed.startupCommand = undefined
  }

  /** Wire onData/onExit listeners for a managed PTY and store it. */
  private wireAndStore(managed: ManagedPty): void {
    managed.physicalExit = new PhysicalExitTracker()
    this.ptys.set(managed.id, managed)
    // Why: a PTY joining the pool under this paneKey means the surface exists again (reopened pane
    // or revive), so a prior retirement no longer describes anything and must not mute its hooks.
    const boundPaneKey = managed.paneKey ?? managed.attachIdentity?.paneKey
    if (boundPaneKey) {
      this.retiredPaneSurfaces.restore(boundPaneKey)
    }
    // Why: a second announce covers any store whose admission window has already closed.
    this.notifyPoolListener(this.ptyPoolActiveListener, 'pty-pool-active')
    const emitIngressData = (emission: PtyIngressEmission): void => {
      const rawLength = emission.rawEndSeq - emission.rawStartSeq
      this.appendReplayBuffer(managed, emission.data)
      this.enqueuePtyOutput(
        managed.id,
        emission.data,
        emission.transformed || rawLength !== emission.data.length
          ? { rawLength, seq: emission.rawEndSeq, transformed: true }
          : {}
      )
    }
    managed.startupIngress ??= new PtyStartupIngress({
      ...(managed.startupIngressIntent ? { intent: managed.startupIngressIntent } : {}),
      ownerBackend: managed.ownerBackend,
      write: (data) => managed.pty.write(data),
      onEmission: emitIngressData
    })
    const startup = managed.startupCommand
    if (startup?.waitForShellReady) {
      startup.promptProbe = createShellPromptReadinessProbe({
        slavePath: readPtySlavePath(managed.pty),
        shellPath: managed.shellPath,
        shellCwd: managed.shellCwd,
        shellPathEnv: managed.shellPathEnv,
        getShellPid: () => startup.shellPid,
        onPromptReady: () => {
          if (startup.providerDelivery) {
            this.scheduleStartupCommandResolution(managed, STARTUP_COMMAND_WRITE_DELAY_MS)
          } else {
            this.signalRendererShellReady(managed)
          }
        }
      })
    }
    managed.pty.onData((data: string) => {
      const startup = managed.startupCommand
      if (startup?.waitForShellReady && startup.outputScanState && !startup.delivered) {
        const scanned = scanShellStartupOutput(startup.outputScanState, data)
        data = scanned.output
        if (scanned.shellPid) {
          startup.shellPid = scanned.shellPid
        }
        if (scanned.ready) {
          if (startup.providerDelivery) {
            this.scheduleStartupCommandResolution(managed, STARTUP_COMMAND_WRITE_DELAY_MS)
          } else {
            this.signalRendererShellReady(managed)
          }
        }
      }
      managed.startupIngress?.accept(data)
      if (startup && !startup.delivered && data.length > 0) {
        startup.promptProbe?.notifyOutput(data)
      }
    })
    managed.pty.onExit(({ exitCode }: { exitCode: number }) => {
      managed.physicalExit?.markExited()
      if (managed.disposed) {
        return
      }
      // Why: neutralize pty.kill synchronously so node-pty's 'close' SIGHUP can't hit a recycled pid on POSIX.
      if (process.platform !== 'win32') {
        ;(managed.pty as unknown as { kill: (sig?: string) => void }).kill = () => {}
      }
      // Why: clear the SIGKILL fallback timer on clean exit so it doesn't fire later.
      if (managed.killTimer) {
        clearTimeout(managed.killTimer)
        managed.killTimer = undefined
      }
      this.clearStartupCommandTimer(managed)
      this.releaseRelayIngress(managed)
      this.pausedOutputPtys.delete(managed.id)
      this.consumerPausedOutputPtys.delete(managed.id)
      this.flushPtyOutput(managed.id)
      this.pendingExitByPty.set(managed.id, {
        id: managed.id,
        code: exitCode,
        incarnationId: managed.incarnationId
      })
      this.retiredIncarnations.set(managed.id, {
        id: managed.id,
        code: exitCode,
        incarnationId: managed.incarnationId,
        expiresAt: Date.now() + 5_000
      })
      pruneRetiredPtyIncarnations(this.retiredIncarnations)
      this.publishPendingExit(managed.id)
      this.notifyExitListener(managed)
      this.agentSessionOwners.release(managed.id)
      this.removePty(managed.id)
      this.clearPtyInputState(managed.id)
      // Why: release the ptmx fd on natural exit, else the master fd leaks until GC (docs/fix-pty-fd-leak.md).
      disposeManagedPty(managed)
    })
  }

  private releaseRelayIngress(managed: ManagedPty): void {
    const startupCommand = managed.startupCommand
    if (startupCommand) {
      this.clearStartupCommandTimer(managed)
      startupCommand.promptProbe?.dispose()
      managed.startupIngress?.accept(this.drainStartupScanBytes(startupCommand))
      managed.startupCommand = undefined
    }
    managed.startupIngress?.drainAndClose()
  }

  private notifyExitListener(managed: ManagedPty): void {
    if (managed.exitListenerNotified) {
      return
    }
    managed.exitListenerNotified = true
    // Why: notify exactly once — both physical exit and whole-relay disposal reach here.
    if (this.exitListener) {
      try {
        this.exitListener({ id: managed.id, paneKey: managed.paneKey })
      } catch (err) {
        process.stderr.write(
          `[pty-handler] exit listener threw: ${err instanceof Error ? err.message : String(err)}\n`
        )
      }
    }
  }

  private registerHandlers(): void {
    this.dispatcher.onRequest('pty.spawn', (p, context) => this.spawn(p, context))
    this.dispatcher.onRequest('pty.attach', (p, context) => this.attach(p, context))
    this.dispatcher.onRequest('pty.shutdown', (p, context) => this.shutdown(p, context))
    this.dispatcher.onRequest('pty.sendSignal', (p) => this.sendSignal(p))
    this.dispatcher.onRequest('pty.getCwd', (p) => this.getCwd(p))
    this.dispatcher.onRequest('pty.getInitialCwd', (p) => this.getInitialCwd(p))
    this.dispatcher.onRequest('pty.getSize', (p) => this.getSize(p))
    this.dispatcher.onRequest('pty.clearBuffer', (p) => this.clearBuffer(p))
    this.dispatcher.onRequest('pty.hasChildProcesses', (p) => this.hasChildProcesses(p))
    this.dispatcher.onRequest('pty.getForegroundProcess', (p) => this.getForegroundProcess(p))
    this.dispatcher.onRequest('pty.inspectProcess', (p) => this.inspectProcess(p))
    this.dispatcher.onRequest('pty.getCapabilities', async () => ({
      startupIngressVersion: PTY_STARTUP_INGRESS_VERSION,
      agentSessionClaimVersion: AGENT_SESSION_EXECUTION_OWNER_PROTOCOL_VERSION,
      agentSessionCreateOperationVersion: AGENT_SESSION_CREATE_OPERATION_PROTOCOL_VERSION,
      // Additive capability: clients may request the no-process-table inventory
      // projection and consume fenced inspect evidence on this host.
      foregroundProcessEvidenceVersion: 1
    }))
    this.dispatcher.onRequest('pty.listProcesses', (params) => this.listProcesses(params))
    this.dispatcher.onRequest('pty.getDefaultShell', async () => resolveDefaultShell())
    this.dispatcher.onRequest('pty.serialize', (p) => this.serialize(p))
    this.dispatcher.onRequest('pty.revive', (p) => this.revive(p))
    this.dispatcher.onRequest('pty.getProfiles', async () => listShellProfiles())
    this.dispatcher.onRequest('pty.deleteWorktreeHistory', async (p) => {
      if (typeof p.worktreeId === 'string') {
        deleteRelayFishHistory(p.worktreeId)
        deleteRelayHistory(p.worktreeId)
      }
      return { ok: true }
    })
    this.dispatcher.onRequest('pty.closeStartupQueryAuthority', (p) =>
      this.closeStartupQueryAuthority(p)
    )

    this.dispatcher.onNotification('pty.data', (p) => this.writeData(p))
    this.dispatcher.onNotification('pty.resize', (p) => this.resize(p))
  }

  private isLikelyInteractiveRedraw(data: string): boolean {
    if (data.length <= INTERACTIVE_OUTPUT_MAX_CHARS) {
      return true
    }
    return data.length <= INTERACTIVE_REDRAW_MAX_CHARS && data.includes('\x1b[')
  }

  private async closeStartupQueryAuthority(
    params: Record<string, unknown>
  ): Promise<{ appliedSeq: number }> {
    const id = params.id as string
    const managed = this.ptys.get(id)
    if (!managed || managed.disposed) {
      throw new Error(`PTY "${id}" not found`)
    }
    return { appliedSeq: managed.startupIngress?.closeQueryAuthority() ?? 0 }
  }

  private shouldSendInteractiveOutputNow(id: string, data: string): boolean {
    const lastInputAt = this.lastInputAtByPty.get(id)
    const now = performance.now()
    if (lastInputAt === undefined || now - lastInputAt > INTERACTIVE_OUTPUT_WINDOW_MS) {
      this.interactiveOutputCharsByPty.delete(id)
      return false
    }
    if (!this.isLikelyInteractiveRedraw(data)) {
      this.interactiveOutputCharsByPty.set(id, INTERACTIVE_OUTPUT_BUDGET_CHARS)
      return false
    }
    const usedChars = this.interactiveOutputCharsByPty.get(id) ?? 0
    if (usedChars + data.length > INTERACTIVE_OUTPUT_BUDGET_CHARS) {
      this.interactiveOutputCharsByPty.set(id, INTERACTIVE_OUTPUT_BUDGET_CHARS)
      return false
    }
    this.interactiveOutputCharsByPty.set(id, usedChars + data.length)
    return true
  }

  private enqueuePtyOutput(
    id: string,
    data: string,
    meta: { rawLength?: number; transformed?: boolean; seq?: number } = {}
  ): void {
    const queue = this.pendingOutputByPty.get(id) ?? []
    if (this.sourcePublication?.accepts(id)) {
      const pending = this.initializePendingProducerCharge({ data, ...meta })
      queue.push(pending)
      this.pendingOutputByPty.set(id, queue)
      this.addPendingProducerBytes(id, pending)
      if (queue.length === 1 && this.shouldSendInteractiveOutputNow(id, data)) {
        queue[0].interactive = true
        if (this.flushPtyOutput(id)) {
          return
        }
      }
      if (this.pendingProducerBytes(id) >= PTY_OUTPUT_PRODUCER_HIGH_BYTES) {
        this.pausePtyOutput(id)
      }
      this.scheduleOutputFlush(PTY_OUTPUT_BATCH_INTERVAL_MS)
      return
    }
    const existing = queue.at(-1)
    if (meta.transformed === true) {
      if (queue.length === 0) {
        const transformed = this.initializePendingProducerCharge({ data, ...meta })
        if (this.publishPtyOutput(id, transformed, false)) {
          return
        }
        queue.push(transformed)
        // Registering after direct publish preserves legacy overwrite semantics for re-entrant ingress.
        this.replacePendingOutputQueue(id, queue, this.pendingProducerChargeForEntry(transformed))
      } else if (existing?.transformed) {
        const previousCharge = this.pendingProducerChargeForEntry(existing)
        existing.data += data
        existing.rawLength = (existing.rawLength ?? 0) + (meta.rawLength ?? data.length)
        existing.seq = meta.seq
        this.refreshPendingProducerCharge(id, existing, previousCharge)
      } else {
        const transformed = this.initializePendingProducerCharge({ data, ...meta })
        queue.push(transformed)
        this.addPendingProducerBytes(id, transformed)
      }
      this.pendingOutputByPty.set(id, queue)
      this.pausePtyOutput(id)
      return
    }
    const pending: PendingPtyOutput = existing && !existing.transformed ? existing : { data: '' }
    const previousCharge =
      existing && !existing.transformed ? this.pendingProducerChargeForEntry(pending) : 0
    const previousLength = pending.data.length
    pending.data += data
    if (pending.rawLength !== undefined || meta.rawLength !== undefined) {
      pending.rawLength = (pending.rawLength ?? previousLength) + (meta.rawLength ?? data.length)
    }
    if (meta.seq !== undefined) {
      pending.seq = meta.seq
    }
    if (!existing || existing.transformed) {
      this.initializePendingProducerCharge(pending)
      queue.push(pending)
      this.addPendingProducerBytes(id, pending)
    } else {
      this.refreshPendingProducerCharge(id, pending, previousCharge)
    }
    this.pendingOutputByPty.set(id, queue)
    if (queue.length === 1 && this.shouldSendInteractiveOutputNow(id, pending.data)) {
      pending.interactive = true
      if (this.flushPtyOutput(id)) {
        return
      }
    }
    if (this.pendingProducerBytes(id) >= PTY_OUTPUT_PRODUCER_HIGH_BYTES) {
      this.pausePtyOutput(id)
    }
    this.scheduleOutputFlush(PTY_OUTPUT_BATCH_INTERVAL_MS)
  }

  private scheduleOutputFlush(delayMs: number): void {
    if (this.outputFlushTimer !== null) {
      return
    }
    this.outputFlushTimer = setTimeout(() => this.flushPendingOutput(), delayMs)
  }

  private flushPendingOutput(): void {
    this.outputFlushTimer = null
    // Why batch before the first send: a re-entrant sink must read the values a whole-map snapshot
    // would have frozen. Why the raw iterator: `for...of` would consume one entry past the limit.
    const pendingEntries = this.pendingOutputByPty[Symbol.iterator]()
    const batch: [string, PendingPtyOutput[], number][] = []
    while (batch.length < PTY_OUTPUT_FLUSH_MAX_WRITES) {
      const next = pendingEntries.next()
      if (next.done === true) {
        break
      }
      const [id, queue] = next.value
      batch.push([
        id,
        queue.map((pending) => ({ ...pending })),
        this.pendingProducerBytesByPty.get(id) ?? 0
      ])
    }
    let writes = 0
    for (const [id, queue, chargedBytes] of batch) {
      this.deletePendingOutput(id)
      if (this.flushPtyOutput(id, queue, chargedBytes)) {
        writes++
      }
    }
    if (this.pendingOutputByPty.size > 0 && writes > 0) {
      // Why: yield between slices of a large chunk so client input and control frames can interleave.
      this.scheduleOutputFlush(PTY_OUTPUT_DRAIN_CONTINUE_MS)
    }
  }

  private flushPtyOutput(
    id: string,
    capturedQueue?: PendingPtyOutput[],
    capturedProducerBytes?: number
  ): boolean {
    const queue = capturedQueue ?? this.pendingOutputByPty.get(id)
    const pending = queue?.[0]
    if (!queue || !pending) {
      this.publishPendingExit(id)
      return true
    }
    const queueWasCaptured = capturedQueue !== undefined
    const capturedQueueBytes = queueWasCaptured
      ? (capturedProducerBytes ?? this.pendingProducerChargeForEntry(pending))
      : (this.pendingProducerBytesByPty.get(id) ?? this.pendingProducerChargeForEntry(pending))
    const desiredChars = pending.transformed
      ? pending.data.length
      : Math.min(pending.data.length, PTY_OUTPUT_FLUSH_CHUNK_CHARS)
    const sourceOnlyEmission =
      pending.transformed === true && pending.data.length === 0 && (pending.rawLength ?? 0) > 0
    const paramsWithoutData = {
      id,
      ...(pending.seq === undefined ? {} : { seq: pending.seq }),
      ...(pending.rawLength === undefined ? {} : { rawLength: pending.rawLength }),
      ...(pending.transformed ? { transformed: true } : {})
    }
    // Why: a failed publish may already have reserved this exact span (source-ledger append,
    // partial legacy fan-out), so a retry must resend it verbatim and slice the remainder at
    // the memo boundary — capacity and coalesced data can both have changed since. The capacity
    // search is skipped on retry: its result is discarded, and publish re-checks capacity.
    let chunkChars =
      pending.transformed || pending.sourceChunk
        ? desiredChars
        : (this.dispatcher.maxLegacyPtyDataChars?.(paramsWithoutData, pending.data, desiredChars) ??
          desiredChars)
    if (
      chunkChars > 0 &&
      chunkChars < pending.data.length &&
      pending.data.charCodeAt(chunkChars - 1) >= 0xd800 &&
      pending.data.charCodeAt(chunkChars - 1) <= 0xdbff
    ) {
      chunkChars--
    }
    if (
      (!sourceOnlyEmission && chunkChars <= 0) ||
      (pending.transformed && chunkChars !== pending.data.length)
    ) {
      this.restorePendingOutputAfterFlush(id, queue, capturedQueueBytes, queueWasCaptured)
      this.pausePtyOutput(id)
      return false
    }
    const chunk = pending.sourceChunk?.data ?? pending.data.slice(0, chunkChars)
    const remaining = pending.data.slice(chunk.length)
    const chunkRawLength = pending.transformed
      ? pending.rawLength
      : pending.rawLength === undefined
        ? undefined
        : chunk.length
    const chunkSeq =
      pending.seq === undefined ? undefined : pending.seq - (pending.data.length - chunk.length)
    const sourceChunk =
      pending.sourceChunk ??
      ({
        data: chunk,
        ...(chunkSeq === undefined ? {} : { seq: chunkSeq }),
        ...(chunkRawLength === undefined ? {} : { rawLength: chunkRawLength }),
        ...(pending.transformed ? { transformed: true } : {})
      } satisfies RelayPtySourceOutput)
    pending.sourceChunk = sourceChunk
    const published = this.publishPtyOutput(id, sourceChunk, pending.interactive === true)
    if (!published) {
      this.restorePendingOutputAfterFlush(id, queue, capturedQueueBytes, queueWasCaptured)
      this.pausePtyOutput(id)
      return false
    }
    const queueStillTracked = !queueWasCaptured && this.pendingOutputByPty.get(id) === queue
    const queueChargeAfterPublish = queueStillTracked
      ? (this.pendingProducerBytesByPty.get(id) ?? capturedQueueBytes)
      : capturedQueueBytes
    const pendingChargeAfterPublish = this.pendingProducerChargeForEntry(pending)
    // rawLength fallback is defensive only: transformed memos always carry rawLength (ingress meta).
    const publishedRawLength = sourceChunk.rawLength ?? sourceChunk.data.length
    const remainingRawLength = pending.transformed
      ? (pending.rawLength ?? 0) - publishedRawLength
      : remaining.length
    if (remaining || (pending.transformed && remainingRawLength > 0)) {
      const remainder = this.initializePendingProducerCharge({
        data: remaining,
        ...(pending.transformed ? { transformed: true } : {}),
        ...(pending.rawLength === undefined ? {} : { rawLength: remainingRawLength }),
        seq: pending.seq
      })
      queue[0] = remainder
      const nextQueueBytes =
        queueChargeAfterPublish -
        pendingChargeAfterPublish +
        this.pendingProducerChargeForEntry(remainder)
      this.replacePendingOutputQueue(id, queue, nextQueueBytes)
    } else {
      queue.shift()
      const nextQueueBytes = queueChargeAfterPublish - pendingChargeAfterPublish
      if (queue.length === 0) {
        this.deletePendingOutput(id)
        this.publishPendingExit(id)
      } else {
        this.replacePendingOutputQueue(id, queue, nextQueueBytes)
      }
    }
    this.maybeResumePtyOutput(id)
    this.clearOutputFlushTimerIfIdle()
    return true
  }

  private clearOutputFlushTimerIfIdle(): void {
    if (this.pendingOutputByPty.size > 0 || this.outputFlushTimer === null) {
      return
    }
    clearTimeout(this.outputFlushTimer)
    this.outputFlushTimer = null
  }

  private clearPtyFlowState(id: string): void {
    this.deletePendingOutput(id)
    this.pendingExitByPty.delete(id)
    this.pausedOutputPtys.delete(id)
    this.consumerPausedOutputPtys.delete(id)
    this.clearPtyInputState(id)
    this.clearOutputFlushTimerIfIdle()
  }

  private clearPtyInputState(id: string): void {
    this.lastInputAtByPty.delete(id)
    this.interactiveOutputCharsByPty.delete(id)
  }

  private publishPtyOutput(
    id: string,
    output: RelayPtySourceOutput,
    interactive: boolean
  ): boolean {
    if (this.sourcePublication?.accepts(id)) {
      return this.sourcePublication.publish(id, output, interactive)
    }
    if (this.dispatcher.tryNotifyPtyData) {
      return this.dispatcher.tryNotifyPtyData(
        {
          id,
          data: output.data,
          ...(output.seq === undefined ? {} : { seq: output.seq }),
          ...(output.rawLength === undefined ? {} : { rawLength: output.rawLength }),
          ...(output.transformed ? { transformed: true } : {})
        },
        { interactive }
      )
    }
    this.dispatcher.notify('pty.data', {
      id,
      data: output.data,
      ...(output.seq === undefined ? {} : { seq: output.seq }),
      ...(output.rawLength === undefined ? {} : { rawLength: output.rawLength }),
      ...(output.transformed ? { transformed: true } : {})
    })
    return true
  }

  private publishPendingExit(id: string): void {
    if (this.pendingOutputByPty.has(id)) {
      return
    }
    const exit = this.pendingExitByPty.get(id)
    if (!exit) {
      return
    }
    if (this.sourcePublication?.accepts(id)) {
      try {
        // Why: after the exit settlement, re-entering sealAndPublishExit would pump a closed
        // ledger delivery; the settled state alone decides completion.
        if (this.sourcePublication.exitPublicationSettled(id)) {
          this.pendingExitByPty.delete(id)
          return
        }
        if (!this.sourcePublication.sealAndPublishExit(exit)) {
          return
        }
        if (
          this.sourcePublication.accepts(id) &&
          !this.sourcePublication.exitPublicationSettled(id)
        ) {
          return
        }
        this.pendingExitByPty.delete(id)
        return
      } catch (err) {
        // Why: a source-publication fault must never escape onExit — it reaches
        // uncaughtException and kills the whole relay daemon. Fall back to the legacy exit.
        process.stderr.write(
          `[pty-handler] pty source exit publication failed for ${id}: ${
            err instanceof Error ? (err.stack ?? err.message) : String(err)
          }\n`
        )
      }
    }
    // Why: a retired record can already have projected this exit to the legacy subscribers, and
    // the broadcast below would hand them a second copy.
    let retiredExitPublished: boolean | null | undefined
    try {
      retiredExitPublished = this.sourcePublication?.publishExitAfterRetire?.(exit)
    } catch (err) {
      process.stderr.write(
        `[pty-handler] retired pty exit publication failed for ${id}: ${
          err instanceof Error ? (err.stack ?? err.message) : String(err)
        }\n`
      )
    }
    const published =
      retiredExitPublished ??
      (this.dispatcher.tryNotifyPtyExit
        ? this.dispatcher.tryNotifyPtyExit(exit)
        : (this.dispatcher.notify('pty.exit', exit), true))
    if (!published) {
      return
    }
    this.pendingExitByPty.delete(id)
  }

  private pendingProducerCharge(data: string): number {
    return chargedPtyRetainedStringBytes(data)
  }

  private initializePendingProducerCharge(pending: PendingPtyOutput): PendingPtyOutput {
    pending.producerChargeBytes = this.pendingProducerCharge(pending.data)
    return pending
  }

  private pendingProducerChargeForEntry(pending: PendingPtyOutput): number {
    if (pending.producerChargeBytes === undefined) {
      pending.producerChargeBytes = this.pendingProducerCharge(pending.data)
    }
    return pending.producerChargeBytes
  }

  private addPendingProducerBytes(id: string, pending: PendingPtyOutput): void {
    const charge = this.pendingProducerChargeForEntry(pending)
    this.pendingProducerBytesByPty.set(id, (this.pendingProducerBytesByPty.get(id) ?? 0) + charge)
  }

  private refreshPendingProducerCharge(
    id: string,
    pending: PendingPtyOutput,
    previousCharge: number
  ): void {
    const nextCharge = this.pendingProducerCharge(pending.data)
    pending.producerChargeBytes = nextCharge
    const currentTotal = this.pendingProducerBytesByPty.get(id)
    if (currentTotal === undefined) {
      return
    }
    this.pendingProducerBytesByPty.set(id, currentTotal + nextCharge - previousCharge)
  }

  private deletePendingOutput(id: string): void {
    this.pendingOutputByPty.delete(id)
    this.pendingProducerBytesByPty.delete(id)
  }

  private replacePendingOutputQueue(
    id: string,
    queue: PendingPtyOutput[],
    chargedBytes: number
  ): void {
    if (queue.length === 0) {
      this.deletePendingOutput(id)
      return
    }
    this.pendingOutputByPty.set(id, queue)
    this.pendingProducerBytesByPty.set(id, chargedBytes)
  }

  private restorePendingOutputAfterFlush(
    id: string,
    queue: PendingPtyOutput[],
    capturedBytes: number,
    wasCaptured: boolean
  ): void {
    if (wasCaptured || this.pendingOutputByPty.get(id) !== queue) {
      this.replacePendingOutputQueue(id, queue, capturedBytes)
      return
    }
    // A live queue remains tracked through a failed send; ingress may have coalesced into it while
    // the sink was called, so keep the incrementally maintained total instead of replacing it.
    this.pendingOutputByPty.set(id, queue)
  }

  private pendingProducerBytes(id: string): number {
    return this.pendingProducerBytesByPty.get(id) ?? 0
  }

  private pausePtyOutput(id: string): void {
    if (this.pausedOutputPtys.has(id)) {
      return
    }
    const managed = this.ptys.get(id)
    if (!managed || managed.disposed) {
      return
    }
    this.pausedOutputPtys.add(id)
    managed.pty.pause()
  }

  private maybeResumePtyOutput(id: string): void {
    if (
      !this.pausedOutputPtys.has(id) ||
      this.consumerPausedOutputPtys.has(id) ||
      this.pendingProducerBytes(id) > PTY_OUTPUT_PRODUCER_LOW_BYTES ||
      this.dispatcher.legacyRetentionBelowLowWater === false
    ) {
      return
    }
    const managed = this.ptys.get(id)
    this.pausedOutputPtys.delete(id)
    if (managed && !managed.disposed) {
      managed.pty.resume()
    }
  }

  private handleLegacyCapacity(): void {
    if (this.pendingOutputByPty.size > 0) {
      this.scheduleOutputFlush(0)
    }
    for (const id of Array.from(this.pendingExitByPty.keys())) {
      this.publishPendingExit(id)
    }
    for (const id of Array.from(this.pausedOutputPtys)) {
      this.maybeResumePtyOutput(id)
    }
  }

  private beginPtyCreation(operationPaths: readonly (string | undefined)[]): () => void {
    if (this.creationFenced) {
      throw new Error('PTY handler is shutting down')
    }
    const distinctPaths = new Map<string, string>()
    for (const operationPath of operationPaths) {
      if (operationPath) {
        distinctPaths.set(normalizeRuntimePathForComparison(operationPath), operationPath)
      }
    }
    const finishRemovalOperations: (() => void)[] = []
    try {
      if (this.worktreeRemovalCoordinator) {
        for (const operationPath of distinctPaths.values()) {
          finishRemovalOperations.push(
            this.worktreeRemovalCoordinator.beginWorktreePtySpawn(operationPath)
          )
        }
      }
      if (this.ptys.size + this.pendingSpawnCount >= MAX_RELAY_PTY_SESSIONS) {
        throw new Error('Maximum number of PTY sessions reached (50)')
      }
    } catch (error) {
      // Why: a later rejection must release every earlier admission before propagating.
      finishPtyCreationOperations(finishRemovalOperations)
      throw error
    }
    this.pendingSpawnCount++
    // Why: announce at admission, not at store — the relay must stop treating itself as idle before
    // the creation parks on its first await, or an armed idle timer kills the shell it produces.
    this.notifyPoolListener(this.ptyPoolActiveListener, 'pty-pool-active')
    let finished = false
    return () => {
      if (finished) {
        return
      }
      finished = true
      this.pendingSpawnCount--
      if (this.pendingSpawnCount === 0) {
        for (const resolve of this.pendingCreationDrainResolvers) {
          resolve()
        }
        this.pendingCreationDrainResolvers.clear()
      }
      finishPtyCreationOperations(finishRemovalOperations)
      // Why: a creation that failed before wireAndStore still leaves the pool empty, and removePty
      // can't announce a PTY that was never stored — without this the relay never re-arms its idle cap.
      if (this.ptys.size === 0 && this.pendingSpawnCount === 0) {
        this.notifyPoolListener(this.ptyPoolEmptyListener, 'pty-pool-empty')
      }
    }
  }

  private waitForPendingPtyCreations(): Promise<void> {
    if (this.pendingSpawnCount === 0) {
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      this.pendingCreationDrainResolvers.add(resolve)
    })
  }

  private async spawn(
    params: Record<string, unknown>,
    context?: RequestContext
  ): Promise<RelayAgentSessionCreateResult> {
    const operationId = params.agentSessionCreateOperationId
    if (operationId === undefined) {
      return await this.spawnOnce(params, context)
    }
    if (
      typeof operationId !== 'string' ||
      !AGENT_SESSION_CREATE_OPERATION_ID_PATTERN.test(operationId)
    ) {
      throw new Error('agent_session_operation_invalid')
    }
    const existing = this.agentSessionCreateOperations.get(operationId)
    if (existing) {
      const result = await existing
      this.sourcePublication?.activate(result.id, result.incarnationId, context)
      const sourceActivation =
        context && this.sourcePublication?.receivingActivation?.(result.id, context.clientId)
      const { sourceActivation: _staleActivation, ...stableResult } = result
      return { ...stableResult, ...(sourceActivation ? { sourceActivation } : {}) }
    }
    if (this.agentSessionCreateOperations.size >= AGENT_SESSION_CREATE_OPERATION_LIMIT) {
      throw new Error('agent_session_operation_capacity')
    }
    const operation = this.spawnOnce(params, context)
    this.agentSessionCreateOperations.set(operationId, operation)
    try {
      const result = await operation
      this.expireAgentSessionCreateOperation(operationId, operation)
      return result
    } catch (error) {
      const outcomeUnknown =
        typeof error === 'object' &&
        error !== null &&
        'agentSessionOperationOutcome' in error &&
        error.agentSessionOperationOutcome === 'unknown'
      if (outcomeUnknown) {
        // Why: the native PTY may be live; replay the same failure instead of spawning again.
        this.expireAgentSessionCreateOperation(operationId, operation)
      } else if (this.agentSessionCreateOperations.get(operationId) === operation) {
        this.agentSessionCreateOperations.delete(operationId)
      }
      throw error
    }
  }

  private expireAgentSessionCreateOperation(
    operationId: string,
    operation: Promise<RelayAgentSessionCreateResult>
  ): void {
    const timer = setTimeout(() => {
      if (this.agentSessionCreateOperations.get(operationId) === operation) {
        this.agentSessionCreateOperations.delete(operationId)
      }
    }, AGENT_SESSION_CREATE_OPERATION_RETENTION_MS)
    timer.unref?.()
  }

  private async spawnOnce(
    params: Record<string, unknown>,
    context?: RequestContext
  ): Promise<RelayAgentSessionCreateResult> {
    const env = params.env as Record<string, string> | undefined
    const worktreeId =
      typeof params.worktreeId === 'string' ? params.worktreeId : env?.ORCA_WORKTREE_ID
    // Must be the filesystem split, matching requireRelaySpawnCwd: a `::workspace:<uuid>` id would
    // otherwise fence a directory the spawn never enters.
    const worktreePath = worktreeId
      ? splitWorktreeIdForFilesystem(worktreeId)?.worktreePath
      : undefined
    const cwd = requireRelaySpawnCwd(params, env)
    const finishCreation = this.beginPtyCreation([worktreePath, cwd])
    let physicalSpawnCommitted = false
    const markPhysicalSpawnCommitted = (): void => {
      physicalSpawnCommitted = true
    }
    try {
      const ensure = params.agentSessionEnsure as { claim?: unknown; surface?: unknown } | undefined
      if (!ensure) {
        return await this.spawnAfterAdmission(params, context, markPhysicalSpawnCommitted)
      }
      if (
        !isAgentSessionExecutionClaim(ensure.claim) ||
        !isAgentSessionSurfaceBinding(ensure.surface)
      ) {
        throw new Error('agent_session_identity_required')
      }
      const claim = ensure.claim
      const surface = ensure.surface
      const result = await this.agentSessionOwners.ensure({
        claim,
        surface,
        spawn: async ({ generation }) => {
          const created = await this.spawnAfterAdmission(
            params,
            context,
            markPhysicalSpawnCommitted
          )
          const managed = this.ptys.get(created.id)
          if (managed) {
            managed.agentSessionOwners = [
              {
                claim,
                generation,
                phase: 'live',
                ptyId: created.id,
                surface
              }
            ]
          }
          return { ptyId: created.id }
        },
        isLive: (owner) => {
          const managed = this.ptys.get(owner.ptyId)
          return Boolean(
            managed &&
            !managed.disposed &&
            (!managed.pty.pid || isProcessAlive(managed.pty.pid)) &&
            managed.agentSessionOwners?.some((candidate) =>
              agentSessionOwnerBindingsEqual(candidate, owner)
            )
          )
        }
      })
      const managed = this.ptys.get(result.owner.ptyId)
      if (!managed || managed.disposed) {
        this.agentSessionOwners.release(result.owner.ptyId, result.owner.generation)
        throw new Error('agent_session_exited_during_start')
      }
      managed.agentSessionOwners = this.agentSessionOwners.listForPty(managed.id)
      const adoptedReplay = result.disposition === 'adopted' ? managed.buffered.read() : ''
      this.sourcePublication?.activate(managed.id, managed.incarnationId, context)
      const sourceActivation =
        context && this.sourcePublication?.receivingActivation?.(managed.id, context.clientId)
      return {
        id: managed.id,
        incarnationId: managed.incarnationId,
        agentSessionEnsure: result,
        ...(sourceActivation ? { sourceActivation } : {}),
        ...(adoptedReplay ? { replay: adoptedReplay } : {})
      }
    } catch (error) {
      if (!physicalSpawnCommitted) {
        throw error
      }
      const message = error instanceof Error ? error.message : String(error)
      throw Object.assign(new Error(message), {
        agentSessionOperationOutcome: 'unknown' as const
      })
    } finally {
      finishCreation()
    }
  }

  private async spawnAfterAdmission(
    params: Record<string, unknown>,
    context?: RequestContext,
    onPhysicalSpawnCommitted?: () => void
  ): Promise<{
    id: string
    incarnationId: string
    sourceActivation?: PtySourceReceivingActivation
  }> {
    const pty = await this.loadPty()
    if (!pty) {
      throw await this.nodePtyUnavailableError()
    }

    const cols = (params.cols as number) || 80
    const rows = (params.rows as number) || 24
    const env = params.env as Record<string, string> | undefined
    const cwd = requireRelaySpawnCwd(params, env)
    const envToDelete = sanitizeEnvToDelete(params.envToDelete)
    const explicitTerm =
      !envToDelete.includes('TERM') &&
      env &&
      Object.hasOwn(env, 'TERM') &&
      typeof env.TERM === 'string' &&
      env.TERM.length > 0
        ? env.TERM
        : undefined
    const shellOverride =
      typeof params.shellOverride === 'string' ? params.shellOverride.trim() : ''
    const resolvedShellOverride = resolvePtyShellOverride(shellOverride)
    const requestedEnvShell =
      process.platform !== 'win32' && typeof env?.SHELL === 'string' ? env.SHELL.trim() : ''
    const shell = resolvedShellOverride || requestedEnvShell || resolveDefaultShell()
    let id: string
    do {
      id = `pty2:${encodeURIComponent(this.ptyIdMintEpoch)}:${this.nextId++}`
    } while (this.ptys.has(id) || this.pendingReviveIds.has(id))

    // Why: augmenter values override renderer env so remote paths and hook coords win over local userData.
    const paneKey = typeof env?.ORCA_PANE_KEY === 'string' ? env.ORCA_PANE_KEY : undefined
    // Why: kept so a restarted runtime can re-adopt this PTY under its original handle (survives revive).
    const terminalHandle =
      typeof env?.ORCA_TERMINAL_HANDLE === 'string' ? env.ORCA_TERMINAL_HANDLE : undefined
    const command = typeof params.command === 'string' ? params.command : undefined
    const launchAgent = isTuiAgent(params.launchAgent) ? params.launchAgent : undefined
    const terminalWindowsWslDistro =
      typeof params.terminalWindowsWslDistro === 'string' ? params.terminalWindowsWslDistro : null
    const commandDelivery = params.commandDelivery === 'provider' ? 'provider' : 'renderer'
    const shouldProviderDeliverCommand = commandDelivery === 'provider' && command !== undefined
    const spawnEnv = this.buildSpawnEnv(
      env,
      { id, paneKey, shell, command, launchAgent },
      envToDelete
    )
    const worktreeId =
      typeof params.worktreeId === 'string' ? params.worktreeId : env?.ORCA_WORKTREE_ID
    const historyIsolationEnabled = params.historyIsolationEnabled === true
    // Deliberately not reached by wsl.exe: a guest fish writes its history file
    // inside the distro, where relay deletion cannot reach it (STA-4682).
    if (historyIsolationEnabled && worktreeId && basename(shell).toLowerCase().startsWith('fish')) {
      injectRelayFishHistoryEnv(spawnEnv, worktreeId)
    }
    const wslShell = isRelayWslShell(shell)
    if (historyIsolationEnabled && worktreeId) {
      const historyRoot = injectRelayHistoryEnv(spawnEnv, worktreeId, shell, { wsl: wslShell })
      if (wslShell && historyRoot) {
        // WSLENV is the only channel that carries a host env var into the guest.
        addWslEnvKeys(spawnEnv, ['HISTFILE'])
      }
    }
    const launchCommandHint = resolveSetupAgentSequenceLaunchCommand(spawnEnv, command)
    // Why: SSH PTYs bypass main's host-env builder, so apply the guard after the relay merges its authoritative env.
    const gitCredentialPromptGuarded = applyTerminalGitCredentialPromptGuard(spawnEnv, {
      launchCommand: launchCommandHint,
      isUnattended: launchAgent !== undefined,
      platform: process.platform
    })
    const shouldEmitShellReadyMarker =
      launchCommandHint !== undefined &&
      shouldUseShellReadyStartupDelivery({
        command: launchCommandHint,
        startupCommandDelivery:
          params.startupCommandDelivery === 'shell-ready' ? 'shell-ready' : undefined
      })
    const managedStartupCommand = shouldProviderDeliverCommand ? command : launchCommandHint
    // Why: both renderer- and provider-delivered startup commands use this marker; the delivering side strips it from output.
    const shellLaunch = getRelayShellLaunchConfig(shell, spawnEnv, process.platform, {
      terminalWindowsWslDistro,
      emitReadyMarker: shouldEmitShellReadyMarker,
      emitStartupIdentity: shouldEmitShellReadyMarker
    })
    const rendererShellReadySupported =
      !shouldProviderDeliverCommand && shellLaunch.supportsReadyMarker

    if (context?.signal?.aborted || context?.isStale()) {
      // Why: cancellation remains side-effect-free until the exact native spawn seam.
      throw new Error('client_disconnected')
    }

    // Why: SSH exec channels give the relay a minimal environment without
    // .zprofile/.bash_profile sourced. Spawning a login shell ensures PATH
    // includes Homebrew, nvm, and user-installed CLIs (claude, codex, gh).
    // When overlays are injected, the launch wrapper keeps those paths after
    // user startup files re-export their defaults.
    let term: IPty
    try {
      term = pty.spawn(shell, shellLaunch.args, {
        // Why: node-pty overwrites env.TERM with `name`; pass caller-selected TERM so it isn't lost.
        name: spawnEnv.TERM ?? 'xterm-256color',
        cols,
        rows,
        cwd,
        // Why the empty default: relay shells inherit process.env, and the launch
        // config is the only thing allowed to name features for this shell.
        env: {
          ...spawnEnv,
          [SHELL_STARTUP_FEATURE_ENV]: '',
          ...shellLaunch.env
        }
      })
    } catch (error) {
      // Why: Windows loads conpty.node only on first spawn, so handle that late binding failure here.
      if (isMissingNodePtyNativeBinding(error)) {
        this.invalidatePtyModuleAfterBindingFailure()
        throw await this.nodePtyUnavailableError(error)
      }
      throw error
    }
    onPhysicalSpawnCommitted?.()

    // Why: capture paneKey so the exit listener can evict per-pane caches without a separate ptyId→paneKey map.
    const tabId = typeof env?.ORCA_TAB_ID === 'string' ? env.ORCA_TAB_ID : undefined
    const attachIdentity = {
      paneKey: typeof params.paneKey === 'string' ? params.paneKey : paneKey,
      tabId: typeof params.tabId === 'string' ? params.tabId : tabId
    }
    const startupIngressIntent =
      params.startupIngressVersion === PTY_STARTUP_INGRESS_VERSION
        ? parsePtyStartupIngressIntent(params.startupIngress)
        : undefined
    const ownerClientInstanceId =
      context === undefined ? null : (this.consumerIdentityResolver?.(context.clientId) ?? null)
    const managed: ManagedPty = {
      id,
      incarnationId: randomUUID(),
      pty: term,
      initialCwd: cwd,
      createdAt: Date.now(),
      ...(ownerClientInstanceId ? { ownerClientInstanceId } : {}),
      buffered: new RecentPtyOutputBuffer({
        preserveChunkBoundaries: false,
        limit: REPLAY_BUFFER_MAX
      }),
      paneKey,
      tabId,
      ...(attachIdentity.paneKey || attachIdentity.tabId ? { attachIdentity } : {}),
      worktreeId,
      ...(explicitTerm !== undefined ? { explicitTerm } : {}),
      envToDelete,
      gitCredentialPromptGuarded,
      ...(historyIsolationEnabled ? { historyIsolationEnabled: true } : {}),
      shellPath: shell,
      // Why the resolved one gates it: on a POSIX relay an override is rejected
      // outright, and storing one revive would only reject again is noise.
      ...(resolvedShellOverride ? { shellOverride } : {}),
      ...(terminalWindowsWslDistro ? { wslDistro: terminalWindowsWslDistro } : {}),
      shellCwd: cwd,
      shellPathEnv: spawnEnv.PATH,
      ownerBackend: resolvePtyOwnerBackend({
        platform: process.platform,
        shellPath: shell,
        wslDistro: terminalWindowsWslDistro
      }),
      ...(startupIngressIntent ? { startupIngressIntent } : {}),
      ...(terminalHandle ? { terminalHandle } : {}),
      ...(managedStartupCommand && (shouldProviderDeliverCommand || rendererShellReadySupported)
        ? {
            startupCommand: {
              command: shouldProviderDeliverCommand ? managedStartupCommand : null,
              providerDelivery: shouldProviderDeliverCommand,
              delivered: false,
              waitForShellReady: shellLaunch.supportsReadyMarker,
              outputScanState: shellLaunch.supportsReadyMarker
                ? createShellStartupOutputScanState()
                : null,
              shellPid: null,
              promptProbe: null,
              timer: null
            }
          }
        : {})
    }
    this.retiredIncarnations.delete(id)
    this.sourcePublication?.activate(id, managed.incarnationId, context)
    const sourceActivation =
      context && this.sourcePublication?.receivingActivation?.(id, context.clientId)
    this.wireAndStore(managed)
    if (context?.isStale() && !params.agentSessionEnsure && !params.agentSessionCreateOperationId) {
      // Why: if the client reconnected while pty.spawn was in flight, the
      // response is discarded and no renderer can own this PTY. Shut it down
      // immediately so it does not linger as an unreachable remote shell.
      this.releaseStartupCommand(managed)
      this.requestGracefulKill(managed, 'terminate stale')
    } else if (managed.startupCommand) {
      this.scheduleStartupCommandResolution(
        managed,
        managed.startupCommand.providerDelivery
          ? managed.startupCommand.waitForShellReady
            ? STARTUP_COMMAND_SHELL_READY_FALLBACK_MS
            : STARTUP_COMMAND_WRITE_DELAY_MS
          : RENDERER_SHELL_READY_RETENTION_MS
      )
    }
    return {
      id,
      incarnationId: managed.incarnationId,
      ...(sourceActivation ? { sourceActivation } : {})
    }
  }

  private async attach(
    params: Record<string, unknown>,
    context?: RequestContext
  ): Promise<{
    incarnationId: string
    replay?: string
    sourceRecovery?: PtySourceRecoveryResult
    sourceActivation?: PtySourceReceivingActivation
  }> {
    const id = params.id as string
    const managed = this.ptys.get(id)
    // Why: after dispose, pty.kill is a POSIX no-op; treat disposed as not-found so failures aren't silent.
    if (!managed || managed.disposed) {
      throw new Error(`PTY "${id}" not found`)
    }

    // Why: verify liveness because shells can exit without node-pty onExit.
    if (this.reapPtyProvenExited(managed)) {
      throw new Error(`PTY "${id}" not found`)
    }

    // Why: legacy `pty-N` ids repeated across relay generations; reject conflicting identities.
    const mismatch = attachIdentityMismatches(
      {
        paneKey: typeof params.expectedPaneKey === 'string' ? params.expectedPaneKey : undefined,
        tabId: typeof params.expectedTabId === 'string' ? params.expectedTabId : undefined
      },
      managed.attachIdentity ?? { paneKey: managed.paneKey, tabId: managed.tabId }
    )
    if (mismatch) {
      throw new Error(`PTY "${id}" not found (identity mismatch)`)
    }

    // Why: an accepted attach is a client surface for this pane, so a prior retirement no longer
    // describes anything — without this a reattach to a shut-down-but-surviving PTY would keep the
    // pane's agent hooks muted for the rest of the daemon's life.
    const attachedPaneKey = managed.paneKey ?? managed.attachIdentity?.paneKey
    if (attachedPaneKey) {
      this.retiredPaneSurfaces.restore(attachedPaneKey)
    }

    managed.startupIngress?.snapshotBarrier()
    let sourceRecovery = parseSourceRecoveryRequest(params.sourceRecovery)
    if (
      sourceRecovery?.status === 'checkpoint' &&
      this.sourcePublication &&
      !(await this.sourcePublication.waitForPendingSend(id))
    ) {
      sourceRecovery = Object.freeze({ status: 'checkpointUnavailable' })
    }
    const activation = this.sourcePublication?.activate(
      id,
      managed.incarnationId,
      context,
      sourceRecovery
    )
    const sourceActivation =
      context && this.sourcePublication?.receivingActivation?.(id, context.clientId)
    if (typeof activation === 'object') {
      return {
        incarnationId: managed.incarnationId,
        sourceRecovery: activation,
        ...(sourceActivation ? { sourceActivation } : {})
      }
    }
    // `existing` means a delivery is already open for this client, so it is already receiving live
    // output and does not need its screen re-sent. That is true for a duplicate attach — and false
    // for the case this skipped: an SSH reconnect. The client keeps its id there (the dispatcher
    // refuses to detach the primary, and setWrite revives that same id), so the delivery outlives
    // the dead transport, while the renderer has thrown its terminal away — a reconnect bumps
    // tab.generation, which is the React key, so the pane remounts with a brand-new empty xterm and
    // nothing captures the old buffer. Answering "you already have it" leaves the pane blank
    // forever, until new output happens to arrive.
    //
    // So the client says which it is. Falling through rather than returning the replay inline is
    // deliberate: the path below already drops the pending batched bytes that are also in the
    // buffer, which is what stops the live delivery double-rendering them.
    if (
      activation === 'existing' &&
      this.sourcePublication?.accepts(id) &&
      params.requireReplay !== true
    ) {
      return {
        incarnationId: managed.incarnationId,
        ...(sourceActivation ? { sourceActivation } : {})
      }
    }

    // Why: return replay during spawn before renderer handlers register.
    // Why: retain replay buffers so later restarts receive full history.
    const replay = managed.buffered.read()
    if (replay) {
      // Why: drop pending batched bytes already in the replay buffer so attach doesn't render them twice.
      this.deletePendingOutput(id)
      this.clearOutputFlushTimerIfIdle()
      this.maybeResumePtyOutput(id)
      if (params.suppressReplayNotification) {
        return {
          incarnationId: managed.incarnationId,
          replay,
          ...(sourceActivation ? { sourceActivation } : {})
        }
      }
      this.dispatcher.notify('pty.replay', { id, data: replay })
    }
    return {
      incarnationId: managed.incarnationId,
      ...(sourceActivation ? { sourceActivation } : {})
    }
  }

  private writeData(params: Record<string, unknown>): void {
    const id = params.id as string
    const data = params.data as string
    if (typeof data !== 'string') {
      return
    }
    const managed = this.ptys.get(id)
    if (managed && !managed.disposed) {
      this.lastInputAtByPty.set(id, performance.now())
      this.interactiveOutputCharsByPty.set(id, 0)
      // Relay PTYs need the local provider's cooked-echo containment (#13137).
      // DA1/CPR stay immediate unless an echo-risk reply is already held (#13892, #15559).
      if (managed.startupIngress?.answerLiveQueryReply(data)) {
        return
      }
      managed.pty.write(data)
    }
  }

  private resize(params: Record<string, unknown>): void {
    const id = params.id as string
    const cols = Math.max(1, Math.min(500, Math.floor(Number(params.cols) || 80)))
    const rows = Math.max(1, Math.min(500, Math.floor(Number(params.rows) || 24)))
    const managed = this.ptys.get(id)
    if (!managed || managed.disposed) {
      return
    }
    // Why probe (same probe attach() and listProcesses() run): a shell that
    // exited without node-pty's `onExit` leaves an undisposed entry behind, and
    // while it stays the relay keeps advertising a dead shell and keeps holding
    // `activePtyCount` above zero, which is what stops a relay with
    // `relayGracePeriodSeconds: 0` from ever reaching its idle-no-ptys exit
    // (#12423). This is retirement, not ioctl safety: only ESRCH from the host
    // that owns the pid is evidence of `exited`.
    if (this.reapPtyProvenExited(managed)) {
      return
    }
    // The patched node-pty retires `_fd` in the same block that gives up the
    // master (config/patches/node-pty@1.1.0.patch), which makes a resize past
    // that point a no-op rather than a TIOCSWINSZ aimed at a reused descriptor.
    // That covers only part of the window and does not cover this process at
    // all: libuv closes the fd synchronously inside `uv_close`, before the JS
    // `'close'` that runs `_close()`, and a relay host installs node-pty from
    // npm, where the patch is not applied. So the catch below stays.
    try {
      managed.pty.resize(cols, rows)
    } catch (err) {
      // A failed ioctl observed the handle, not the host's process table, so on
      // its own it is `unverifiable`. Re-probe: a now-absent pid retires the
      // entry, anything else keeps it and is contained here rather than
      // escaping as a parse error on every later resize.
      if (this.reapPtyProvenExited(managed)) {
        return
      }
      process.stderr.write(
        `[pty-handler] resize failed for PTY ${id} whose process is still live or unverifiable: ${err instanceof Error ? err.message : String(err)}\n`
      )
    }
  }

  private async getSize(
    params: Record<string, unknown>
  ): Promise<{ cols: number; rows: number } | null> {
    const managed = this.ptys.get(params.id as string)
    if (!managed || managed.disposed) {
      return null
    }
    return { cols: managed.pty.cols, rows: managed.pty.rows }
  }

  private async shutdown(params: Record<string, unknown>, context?: RequestContext): Promise<void> {
    const id = params.id as string
    const immediate = params.immediate as boolean
    const expectedIncarnationId = params.expectedIncarnationId
    if (
      expectedIncarnationId !== undefined &&
      (typeof expectedIncarnationId !== 'string' || expectedIncarnationId.length === 0)
    ) {
      throw new Error('Invalid expectedIncarnationId')
    }
    const expectedOwnerClientInstanceId = params.expectedOwnerClientInstanceId
    if (
      expectedOwnerClientInstanceId !== undefined &&
      (typeof expectedOwnerClientInstanceId !== 'string' ||
        expectedOwnerClientInstanceId.length === 0)
    ) {
      throw new Error('Invalid expectedOwnerClientInstanceId')
    }
    const managed = this.ptys.get(id)
    if (!managed) {
      return
    }
    if (expectedIncarnationId !== undefined && expectedIncarnationId !== managed.incarnationId) {
      throw new Error(`PTY incarnation mismatch for ${id}`)
    }
    if (expectedOwnerClientInstanceId !== undefined) {
      this.assertShutdownOwnership(id, managed, expectedOwnerClientInstanceId, context)
    }
    // Why: `pty.shutdown` is the only authoritative statement this host ever gets that a tab is
    // gone. Record it before the kill request, because the kill is the part that can fail: an agent
    // that survives teardown otherwise keeps posting hooks the relay forwards as a live agent pane
    // with no tab, and that advertisement is what drives a second `--resume` onto its transcript.
    // Why gated on an actual retirement: the teardown below is fire-and-forget — one SIGTERM, one
    // armed SIGKILL, and nobody ever looks again. Re-probing is what stops a retired pane's shell
    // outliving its tab; a PTY with no pane surface has nothing to outlive, so its long-standing
    // teardown contract is left exactly as it was.
    if (this.retirePaneSurface(managed)) {
      this.armShutdownReapSweep(managed, SHUTDOWN_REAP_MAX_SWEEPS)
    }

    if (immediate) {
      this.releaseStartupCommand(managed)
      this.flushPtyOutput(id)
      this.requestForceKill(managed)
      // Why: preserve timed-out entries so onExit/retry owns native handles.
      await this.waitForPhysicalExit(managed, IMMEDIATE_PTY_EXIT_TIMEOUT_MS)
    } else {
      this.releaseStartupCommand(managed)
      this.requestGracefulKill(managed, 'force-kill')
    }
  }

  /** Re-decide, on the host, whether the caller may destroy this PTY.
   *
   *  `pty.shutdown` is irreversible and its siblings `pty.spawn`/`pty.attach` already take a
   *  request context; without this the whole ownership rule lived on the client, on the one call
   *  that cannot be taken back. Both halves are checked here because either alone is an echo: the
   *  connection must still authenticate as that consumer identity (so a claim cannot be asserted),
   *  and this host must have recorded that same identity as the PTY's creator at spawn (so the
   *  caller cannot reach a PTY it never made).
   *
   *  Only callers that opt in are checked. An ordinary pane teardown does not pass the field, and
   *  must not: a revived PTY carries no attested owner at all, and a host predating the attestation
   *  would refuse stops it is obliged to honour. */
  private assertShutdownOwnership(
    id: string,
    managed: ManagedPty,
    expectedOwnerClientInstanceId: string,
    context: RequestContext | undefined
  ): void {
    const requester =
      context === undefined ? null : (this.consumerIdentityResolver?.(context.clientId) ?? null)
    if (requester !== expectedOwnerClientInstanceId) {
      throw new Error(`PTY "${id}" stop refused: requester is not the attested owner`)
    }
    if (managed.ownerClientInstanceId !== expectedOwnerClientInstanceId) {
      throw new Error(`PTY "${id}" stop refused: this host attested no such owner`)
    }
  }

  /** Record that this pane's client surface is gone, and tell the hook server so the pane's cached
   *  agent status stops being replayed to reconnecting clients. Returns false when there is no pane
   *  surface to retire. */
  private retirePaneSurface(managed: ManagedPty): boolean {
    const paneKey = managed.paneKey ?? managed.attachIdentity?.paneKey
    if (!paneKey) {
      return false
    }
    this.retiredPaneSurfaces.retire(paneKey)
    const listener = this.surfaceRetiredListener
    if (!listener) {
      return true
    }
    try {
      listener({ id: managed.id, paneKey })
    } catch (err) {
      process.stderr.write(
        `[pty-handler] surface-retired listener threw: ${err instanceof Error ? err.message : String(err)}\n`
      )
    }
    return true
  }

  /**
   * After a retirement, verify the host actually reaped the shell rather than trusting the kill
   * request. Two outcomes matter and both are bookkeeping the relay previously never did:
   *
   * - the pid is gone but node-pty never produced `onExit` — retire the record here, so the entry
   *   and its agent-session owners stop being published by `pty.listProcesses`;
   * - the pid is still alive — re-issue the force kill instead of leaving a detached shell (and the
   *   agent inside it) outliving its tab for the life of the daemon.
   *
   * Bounded: after {@link SHUTDOWN_REAP_MAX_SWEEPS} the owner claim is deliberately *retained*.
   * Releasing a claim we cannot prove dead is what lets a reopened project spawn a second agent
   * over one transcript; keeping it makes the next `pty.spawn` adopt this PTY instead.
   */
  private armShutdownReapSweep(managed: ManagedPty, attemptsRemaining: number): void {
    if (managed.reapTimer) {
      return
    }
    const timer = setTimeout(() => {
      managed.reapTimer = undefined
      if (this.ptys.get(managed.id) !== managed || managed.disposed) {
        return
      }
      if (this.reapPtyProvenExited(managed)) {
        return
      }
      if (attemptsRemaining <= 0) {
        process.stderr.write(
          `[pty-handler] retired pane PTY ${managed.id} still alive after force kill; ownership retained as unverifiable\n`
        )
        return
      }
      // Why POSIX-only: a SIGKILL that returned success is not proof of death there — the group
      // probe can degrade to a root-pid kill, leaving the agent running under a shell nobody is
      // watching. On Windows ConPTY's kill is already force-final and closing its handle twice is
      // the hazard disposeManagedPty guards against, so the probe above is the whole sweep.
      if (process.platform !== 'win32') {
        managed.forceKillSent = false
        try {
          this.requestForceKill(managed)
        } catch {
          /* Re-probed on the next sweep; a transient failure must not end the escalation. */
        }
      }
      this.armShutdownReapSweep(managed, attemptsRemaining - 1)
    }, SHUTDOWN_REAP_VERIFY_DELAY_MS)
    timer.unref?.()
    managed.reapTimer = timer
  }

  /**
   * Retire every record for a PTY whose process is proven gone. Shared by the attach probe, the
   * listing probe and the post-shutdown sweep so the three cannot drift on what "gone" retires.
   *
   * `evidence` is not decoration: `exited` publishes a verdict to the client, and only ESRCH from
   * the host that owns the pid earns it. The disposed-record sweep retires off our own
   * bookkeeping, which says we tore the record down — not that the shell died — so it stays
   * silent (docs/reference/ssh-execution-boundary.md).
   */
  private reapExitedPty(managed: ManagedPty, evidence: 'exited' | 'record-torn-down'): void {
    managed.physicalExit?.markExited()
    this.releaseRelayIngress(managed)
    this.flushPtyOutput(managed.id)
    if (evidence === 'exited') {
      this.publishReapedExit(managed)
    }
    this.notifyExitListener(managed)
    this.agentSessionOwners.release(managed.id)
    this.retiredIncarnations.set(managed.id, {
      id: managed.id,
      code: 0,
      incarnationId: managed.incarnationId,
      expiresAt: Date.now() + 5_000
    })
    pruneRetiredPtyIncarnations(this.retiredIncarnations)
    disposeManagedPty(managed)
    this.removePty(managed.id)
    this.clearPtyFlowState(managed.id)
  }

  /**
   * A reap is an exit the client has to hear about. `notifyExitListener` is
   * relay-internal, so a retirement that stops there leaves the pane mounted
   * against a session the relay has already forgotten — the next attach answers
   * `PTY "<id>" not found` and nothing before it said why. `resize` made that
   * user-triggered.
   *
   * `-1` is this wire's "gone, status unrecoverable": the pid is proven absent
   * (ESRCH from the host that owns it) but nothing waited on the shell, so no
   * status exists. `ssh-relay-session` already publishes the same code for a
   * dropped lease. Reached only from the proven-exited path — a client that acts
   * on this retires the pane, so nothing weaker than ESRCH may reach it.
   */
  private publishReapedExit(managed: ManagedPty): void {
    // Why the guard: node-pty's own `onExit` already queued and published this
    // pty's real exit code before reaching here, and the sweep also reaps
    // entries that path left behind.
    if (managed.exitListenerNotified || this.pendingExitByPty.has(managed.id)) {
      return
    }
    this.pendingExitByPty.set(managed.id, {
      id: managed.id,
      code: -1,
      incarnationId: managed.incarnationId
    })
    this.publishPendingExit(managed.id)
  }

  /**
   * Retire this entry when the host proves its pid is gone; report whether it was.
   *
   * `managed.disposed` is bookkeeping, not liveness: it says we tore the record
   * down, not that the shell died. A shell can exit without node-pty producing
   * `onExit`, which leaves a non-disposed entry holding a handle whose master fd
   * is already closed. Only `isProcessAlive` (ESRCH, from the host that owns the
   * process) is positive evidence of absence; every other outcome is
   * `unverifiable` and keeps its record and owner claim
   * (docs/reference/ssh-execution-boundary.md).
   */
  private reapPtyProvenExited(managed: ManagedPty): boolean {
    if (!managed.pty.pid || isProcessAlive(managed.pty.pid)) {
      return false
    }
    this.reapExitedPty(managed, 'exited')
    return true
  }

  private async sendSignal(params: Record<string, unknown>): Promise<void> {
    const id = params.id as string
    const signal = params.signal as string
    if (!ALLOWED_SIGNALS.has(signal)) {
      throw new Error(`Signal not allowed: ${signal}`)
    }
    const managed = this.ptys.get(id)
    // Why: dispose neutralizes pty.kill on POSIX; treat disposed as not-found so signals don't silently no-op.
    if (!managed || managed.disposed) {
      throw new Error(`PTY "${id}" not found`)
    }
    // Why only SIGWINCH: a real resize reaches the tty's foreground process group,
    // and node-pty's kill targets the root pid, which the shell setpgid's away from.
    // Host-local behavior only — no wire change, so an older client simply gets a
    // SIGWINCH that now lands. Destructive signals keep node-pty's own path.
    if (signal === 'SIGWINCH') {
      signalPosixPtyForegroundGroup(managed.pty.pid, readPtsName(managed.pty), signal, () => {
        managed.pty.kill(signal)
      })
      return
    }
    managed.pty.kill(signal)
  }

  private waitForPhysicalExit(managed: ManagedPty, timeoutMs: number): Promise<void> {
    const physicalExit = managed.physicalExit
    if (!physicalExit) {
      return Promise.reject(new Error(`PTY "${managed.id}" exit tracking unavailable`))
    }
    return physicalExit.waitForExit(
      timeoutMs,
      () => new Error(`Timed out waiting for PTY process exit: ${managed.id}`)
    )
  }

  private requestGracefulKill(
    managed: ManagedPty,
    fallbackAction: 'terminate stale' | 'force-kill'
  ): void {
    if (managed.gracefulKillSent) {
      return
    }
    managed.gracefulKillSent = true
    if (process.platform === 'win32') {
      // Why: ConPTY's bare kill is already force-final; block any later close of the handle.
      managed.forceKillSent = true
    }
    try {
      killPtyProcess(managed.pty, 'SIGTERM')
    } catch (error) {
      managed.gracefulKillSent = false
      managed.forceKillSent = false
      throw error
    }
    if (process.platform === 'win32') {
      return
    }
    // Why: POSIX children may ignore SIGTERM; arm a bounded SIGKILL fallback.
    this.armForceKillFallback(managed, fallbackAction, 5000, PTY_FORCE_KILL_MAX_ATTEMPTS)
  }

  private armForceKillFallback(
    managed: ManagedPty,
    fallbackAction: 'terminate stale' | 'force-kill',
    delayMs: number,
    attemptsRemaining: number
  ): void {
    managed.killTimer = setTimeout(() => {
      managed.killTimer = undefined
      const still = this.ptys.get(managed.id)
      if (!still || still.disposed) {
        return
      }
      try {
        this.requestForceKill(still)
      } catch (error) {
        process.stderr.write(
          `[pty-handler] failed to ${fallbackAction} PTY ${managed.id}: ${error instanceof Error ? error.message : String(error)}\n`
        )
        // Why: a transient SIGKILL failure must not strand an unreachable remote shell.
        if (attemptsRemaining > 1 && this.ptys.get(still.id) === still && !still.disposed) {
          this.armForceKillFallback(
            still,
            fallbackAction,
            PTY_FORCE_KILL_RETRY_DELAY_MS,
            attemptsRemaining - 1
          )
        }
      }
    }, delayMs)
  }

  private requestForceKill(managed: ManagedPty): void {
    if (managed.forceKillSent || (process.platform === 'win32' && managed.gracefulKillSent)) {
      return
    }
    managed.forceKillSent = true
    try {
      killPtyProcess(managed.pty, 'SIGKILL')
    } catch (error) {
      managed.forceKillSent = false
      throw error
    }
  }

  private async getCwd(params: Record<string, unknown>): Promise<string> {
    const id = params.id as string
    const managed = this.ptys.get(id)
    if (!managed || managed.disposed) {
      throw new Error(`PTY "${id}" not found`)
    }
    return resolveProcessCwd(managed.pty.pid, managed.initialCwd)
  }

  private async getInitialCwd(params: Record<string, unknown>): Promise<string> {
    const id = params.id as string
    const managed = this.ptys.get(id)
    if (!managed || managed.disposed) {
      throw new Error(`PTY "${id}" not found`)
    }
    return managed.initialCwd
  }

  private async clearBuffer(params: Record<string, unknown>): Promise<void> {
    const id = params.id as string
    const managed = this.ptys.get(id)
    if (managed && !managed.disposed) {
      managed.startupIngress?.snapshotBarrier()
      managed.pty.clear()
    }
  }

  private async hasChildProcesses(params: Record<string, unknown>): Promise<boolean> {
    const id = params.id as string
    const managed = this.ptys.get(id)
    if (!managed || managed.disposed) {
      return false
    }
    // Fresh, not TTL-cached: this RPC exists to gate destructive decisions (the
    // window-close confirmation, workspace cleanup's idle evidence), which act
    // on the answer once. `pty.inspectProcess` below stays on the shared
    // snapshot because it is the polled path, where a scan per pane per tick is
    // the fork storm the cache removed.
    return await processHasChildren(managed.pty.pid, { fresh: true })
  }

  private async getForegroundProcess(params: Record<string, unknown>): Promise<string | null> {
    const id = params.id as string
    const managed = this.ptys.get(id)
    if (!managed || managed.disposed) {
      return null
    }
    return await getForegroundProcessName(managed.pty.pid, managed.pty.process || null)
  }

  private async inspectProcess(params: Record<string, unknown>): Promise<{
    foregroundProcess: string | null
    hasChildProcesses: boolean
    foregroundProcessEvidence?: RemoteForegroundEvidence
  }> {
    pruneRetiredPtyIncarnations(this.retiredIncarnations)
    const id = params.id as string
    const managed = this.ptys.get(id)
    if (!managed || managed.disposed) {
      const tombstone = this.retiredIncarnations.get(id)
      if (
        tombstone &&
        tombstone.expiresAt > Date.now() &&
        typeof params.expectedIncarnationId === 'string' &&
        params.expectedIncarnationId === tombstone.incarnationId
      ) {
        return {
          foregroundProcess: null,
          hasChildProcesses: false,
          foregroundProcessEvidence: {
            authorityGeneration: this.ptyIdMintEpoch,
            observationEpoch: ++this.foregroundEvidenceEpoch,
            capturedAgeMs: 0,
            ptyId: id,
            ptyIncarnationId: tombstone.incarnationId,
            verdict: 'exited',
            reason: `pty_exit_${tombstone.code}`
          }
        }
      }
      throw new Error('terminal_gone')
    }
    const expectedIncarnationId = params.expectedIncarnationId
    if (
      expectedIncarnationId !== undefined &&
      (typeof expectedIncarnationId !== 'string' ||
        expectedIncarnationId.length === 0 ||
        expectedIncarnationId !== managed.incarnationId)
    ) {
      return {
        foregroundProcess: null,
        hasChildProcesses: false,
        foregroundProcessEvidence: {
          authorityGeneration: this.ptyIdMintEpoch,
          observationEpoch: ++this.foregroundEvidenceEpoch,
          capturedAgeMs: 0,
          ptyId: id,
          ptyIncarnationId: managed.incarnationId,
          verdict: 'unverifiable',
          reason: 'incarnation_mismatch'
        }
      }
    }
    let rows: readonly ProcessTableRow[] | null = null
    let evidence: RemoteForegroundEvidence | undefined
    if (process.platform === 'win32') {
      // Why SSH-to-Windows is always unverifiable: POSIX has a real foreground primitive
      // (the controlling terminal's foreground process group, tpgid/pgid), so the host can
      // read which process is in front. Windows has no equivalent. Local Windows approximates
      // it by reading the native process table and walking descendants of the PTY root pid
      // (windows-foreground-process-rows.ts), but the relay has neither piece: it does not
      // import windows-process-table, its getForegroundProcessName is POSIX-shaped
      // (/proc, pgrep, lsof), and relay hosts run stock node-pty, so no ConPTY job/console
      // association is available. Returning a descendant name without a creation-time and
      // session fence would be a guess. Lifting this requires teaching the relay the Windows
      // process table plus a measured creation-time/session fence - a separate change.
      evidence = {
        authorityGeneration: this.ptyIdMintEpoch,
        observationEpoch: ++this.foregroundEvidenceEpoch,
        capturedAgeMs: 0,
        ptyId: id,
        ptyIncarnationId: managed.incarnationId,
        verdict: 'unverifiable',
        reason: 'windows_ssh_foreground_unavailable'
      }
    } else {
      try {
        const snapshot = await getStrictProcessTableSnapshotWithAge()
        rows = snapshot.rows
        evidence = resolveRemoteForegroundEvidence(
          { rootPid: managed.pty.pid, fallbackProcess: managed.pty.process || null },
          {
            ptyId: id,
            ptyIncarnationId: managed.incarnationId,
            authorityGeneration: this.ptyIdMintEpoch,
            observationEpoch: ++this.foregroundEvidenceEpoch,
            capturedAgeMs: snapshot.capturedAgeMs,
            platform: process.platform
          },
          rows
        )
      } catch {
        evidence = {
          authorityGeneration: this.ptyIdMintEpoch,
          observationEpoch: ++this.foregroundEvidenceEpoch,
          capturedAgeMs: 0,
          ptyId: id,
          ptyIncarnationId: managed.incarnationId,
          verdict: 'unverifiable',
          reason: 'process_table_unreadable'
        }
      }
    }
    // Preserve the compatibility field for older clients. New remote identity
    // consumers ignore it unless the fenced evidence member is also accepted.
    const foregroundProcess =
      evidence?.verdict === 'live'
        ? (evidence.processName ?? managed.pty.process) || null
        : managed.pty.process || null
    return {
      foregroundProcess,
      // Derive child liveness from the same capture; do not fork a second
      // process-table probe for each field/pane in an event burst. Windows
      // has no evidence capture, so preserve the compatibility child probe.
      hasChildProcesses: rows
        ? rows.some((row) => row.ppid === managed.pty.pid)
        : await processHasChildren(managed.pty.pid),
      ...(evidence ? { foregroundProcessEvidence: evidence } : {})
    }
  }

  private async listProcesses(params: Record<string, unknown> = {}): Promise<PtyProcessSummary[]> {
    const results: PtyProcessSummary[] = []
    // Why (SSH-v3 P2 — the host is the authoritative liveness source, so it has to look): this
    // listing is what publishes `agentSessionOwners`, i.e. "there is a live agent session here you
    // can adopt". A shell can exit without node-pty's onExit, and an unverified entry advertised
    // that session forever. Snapshot the map because reaping mutates it.
    const managedEntries = Array.from(this.ptys)
    // R1 seed evidence is additive and POSIX-only. Windows authorities retain
    // the existing title/liveness path until the measured relay adapter lands.
    // Desktop callers omit this additive field and retain the shipped list
    // shape/cost; automatic inventory callers pass false explicitly to skip
    // process-table work on the host.
    const includeForegroundProcessEvidence = params.includeForegroundProcessEvidence !== false
    let evidenceRows: readonly ProcessTableRow[] | null = null
    let evidenceResults: BatchedForegroundProcessResult[] = []
    const evidenceEpoch = ++this.foregroundEvidenceEpoch
    // Worst-case capture time for the snapshot below, not the instant its await settled: the
    // reader may serve a TTL-cached table. The WithAge reader returns the real age, so the
    // stamp is exact rather than assuming the full staleness window.
    let evidenceCapturedAtMs = Date.now()
    if (
      includeForegroundProcessEvidence &&
      process.platform !== 'win32' &&
      managedEntries.length > 0
    ) {
      try {
        const evidenceSnapshot = await getStrictProcessTableSnapshotWithAge()
        evidenceRows = evidenceSnapshot.rows
        evidenceCapturedAtMs = Date.now() - evidenceSnapshot.capturedAgeMs
        evidenceResults = await resolveAgentForegroundProcessesBatch(
          managedEntries.map(([, managed]) => ({
            rootPid: managed.pty.pid,
            fallbackProcess: managed.pty.process || null
          })),
          { rows: evidenceRows }
        )
      } catch {
        // An unreadable capture is represented as unverifiable evidence below;
        // existing inventory fields remain available for old clients.
      }
    }
    for (const [entryIndex, [id, managed]] of managedEntries.entries()) {
      if (managed.disposed) {
        this.reapExitedPty(managed, 'record-torn-down')
        continue
      }
      if (this.reapPtyProvenExited(managed)) {
        continue
      }
      // Reuse batched correlation; per-PTY tree scans recreate O(PTY × rows) work.
      const title =
        (evidenceRows
          ? (evidenceResults[entryIndex]?.processName ?? managed.pty.process ?? null)
          : includeForegroundProcessEvidence
            ? await getForegroundProcessName(managed.pty.pid, managed.pty.process || null)
            : managed.pty.process || null) || 'shell'
      const foregroundProcessEvidence =
        includeForegroundProcessEvidence && process.platform !== 'win32'
          ? toForegroundProcessEvidence(
              evidenceResults[entryIndex] ?? {
                available: false,
                processName: managed.pty.process || null,
                reason: 'table_unreadable'
              },
              {
                authorityGeneration: this.ptyIdMintEpoch,
                observationEpoch: evidenceEpoch,
                capturedAgeMs: Math.max(0, Date.now() - evidenceCapturedAtMs)
              }
            )
          : undefined
      results.push({
        id,
        incarnationId: managed.incarnationId,
        cwd: managed.initialCwd,
        title,
        hostAgeMs: Math.max(0, Date.now() - managed.createdAt),
        paneBound: Boolean(managed.paneKey ?? managed.attachIdentity?.paneKey),
        ...(managed.ownerClientInstanceId
          ? { ownerClientInstanceId: managed.ownerClientInstanceId }
          : {}),
        ...(managed.worktreeId ? { worktreeId: managed.worktreeId } : {}),
        ...(managed.terminalHandle ? { terminalHandle: managed.terminalHandle } : {}),
        ...(foregroundProcessEvidence ? { foregroundProcessEvidence } : {}),
        ...(this.agentSessionOwners.listForPty(id).length
          ? { agentSessionOwners: this.agentSessionOwners.listForPty(id) }
          : {})
      })
    }
    return results
  }

  private async serialize(params: Record<string, unknown>): Promise<string> {
    const ids = params.ids as string[]
    const entries: SerializedPtyEntry[] = []
    for (const id of ids) {
      const managed = this.ptys.get(id)
      if (!managed) {
        continue
      }
      const { pid, cols, rows } = managed.pty
      entries.push({
        id,
        pid,
        cols,
        rows,
        cwd: managed.initialCwd,
        paneKey: managed.paneKey,
        tabId: managed.tabId,
        attachIdentity: managed.attachIdentity,
        worktreeId: managed.worktreeId,
        ...(managed.explicitTerm !== undefined ? { explicitTerm: managed.explicitTerm } : {}),
        envToDelete: managed.envToDelete,
        gitCredentialPromptGuarded: managed.gitCredentialPromptGuarded,
        ...(managed.historyIsolationEnabled ? { historyIsolationEnabled: true } : {}),
        // Why serialized: revive re-spawns the shell, and without these a WSL
        // pane came back as the host default shell in another distro's history.
        ...(managed.shellOverride ? { shellOverride: managed.shellOverride } : {}),
        ...(managed.wslDistro ? { terminalWindowsWslDistro: managed.wslDistro } : {}),
        ...(managed.terminalHandle ? { terminalHandle: managed.terminalHandle } : {})
      })
    }
    return JSON.stringify(entries)
  }

  private async revive(params: Record<string, unknown>): Promise<void> {
    const state = params.state as string
    const entries = JSON.parse(state) as SerializedPtyEntry[]

    for (const entry of entries) {
      if (this.ptys.has(entry.id) || this.pendingReviveIds.has(entry.id)) {
        continue
      }
      // Only re-attach if the original process is still alive
      try {
        process.kill(entry.pid, 0)
      } catch {
        continue
      }
      const ownedPath = entry.worktreeId
        ? splitWorktreeIdForFilesystem(entry.worktreeId)?.worktreePath
        : undefined
      const finishCreation = this.beginPtyCreation([ownedPath, entry.cwd])
      this.pendingReviveIds.add(entry.id)
      try {
        await this.reviveEntry(entry)
      } finally {
        this.pendingReviveIds.delete(entry.id)
        finishCreation()
      }
    }
  }

  private async reviveEntry(entry: SerializedPtyEntry): Promise<void> {
    const ptyMod = await this.loadPty()
    if (!ptyMod) {
      return
    }
    // Why: pane identity comes from the serialized entry (not env) since hook scripts exit without ORCA_PANE_KEY.
    const revivedEnv: Record<string, string> = {}
    if (entry.paneKey) {
      revivedEnv.ORCA_PANE_KEY = entry.paneKey
    }
    if (entry.tabId) {
      revivedEnv.ORCA_TAB_ID = entry.tabId
    }
    if (entry.worktreeId) {
      revivedEnv.ORCA_WORKTREE_ID = entry.worktreeId
    }
    if (entry.terminalHandle) {
      revivedEnv.ORCA_TERMINAL_HANDLE = entry.terminalHandle
    }
    const explicitTerm =
      typeof entry.explicitTerm === 'string' && entry.explicitTerm.length > 0
        ? entry.explicitTerm
        : undefined
    if (explicitTerm !== undefined) {
      revivedEnv.TERM = explicitTerm
    }
    // Why: serialized state may come from an older/untrusted client; reapply fresh-spawn bounds.
    const envToDelete = sanitizeEnvToDelete(entry.envToDelete)
    const shellOverride = typeof entry.shellOverride === 'string' ? entry.shellOverride.trim() : ''
    const resolvedShellOverride = resolveRevivedShellOverride(shellOverride)
    const shell = resolvedShellOverride || resolveDefaultShell()
    // Mirrors spawn: the entry's override is what gets re-launched, so a WSL
    // pane needs the same guest-visible HISTFILE and the same WSLENV carrier.
    const wslShell = isRelayWslShell(shell)
    // Why cwd is re-checked: it is the one serialized field revive still took on trust, and it only
    // proves the directory existed when the client wrote it down. A worktree removed since leaves
    // node-pty to _exit(1) the child on POSIX (a pane revived already dead) and to throw on Windows,
    // which escapes the loop and costs every later entry its state. Same call as the shell override
    // below: drop this one pane rather than substitute a directory it was never pointed at. Skipped
    // for a WSL shell, whose cwd lives in a guest that never stats on this host.
    if (!wslShell && !relayHostDirectoryExists(entry.cwd)) {
      return
    }
    const terminalWindowsWslDistro =
      typeof entry.terminalWindowsWslDistro === 'string' &&
      entry.terminalWindowsWslDistro.length <= MAX_REVIVED_WSL_DISTRO_LENGTH
        ? entry.terminalWindowsWslDistro
        : null
    const historyIsolationEnabled = entry.historyIsolationEnabled === true
    const spawnEnv = this.buildSpawnEnv(
      revivedEnv,
      { id: entry.id, paneKey: entry.paneKey, shell },
      envToDelete
    )
    if (
      historyIsolationEnabled &&
      entry.worktreeId &&
      basename(shell).toLowerCase().startsWith('fish')
    ) {
      injectRelayFishHistoryEnv(spawnEnv, entry.worktreeId)
    }
    if (historyIsolationEnabled && entry.worktreeId) {
      const historyRoot = injectRelayHistoryEnv(spawnEnv, entry.worktreeId, shell, {
        wsl: wslShell
      })
      if (wslShell && historyRoot) {
        addWslEnvKeys(spawnEnv, ['HISTFILE'])
      }
    }
    // Why: revive lacks the original launch command, so reuse the fresh-spawn guard decision (legacy defaults to unguarded).
    const gitCredentialPromptGuarded = entry.gitCredentialPromptGuarded === true
    if (gitCredentialPromptGuarded) {
      Object.assign(spawnEnv, gitCredentialPromptGuardEnv(spawnEnv, process.platform))
    }
    const shellLaunch = getRelayShellLaunchConfig(shell, spawnEnv, process.platform, {
      terminalWindowsWslDistro
    })
    let term: IPty
    try {
      term = ptyMod.spawn(shell, shellLaunch.args, {
        name: spawnEnv.TERM ?? 'xterm-256color',
        cols: entry.cols,
        rows: entry.rows,
        cwd: entry.cwd,
        // Why: no provider-delivered command is waiting for a ready marker.
        env: {
          ...spawnEnv,
          [SHELL_STARTUP_FEATURE_ENV]: '',
          ...shellLaunch.env
        }
      })
    } catch (error) {
      // Why skip rather than retry the host default shell: the stored override
      // names a shell that existed at serialize time and may not now (an
      // uninstalled WSL takes wsl.exe with it), and substituting a different
      // shell is the defect this override exists to fix -- its args and its
      // history env are built for the shell that is gone. Dropping one pane is
      // the honest outcome; letting the throw escape the revive loop would cost
      // every later entry its state too. The worktree-removal fence throws
      // before this, outside reviveEntry, so it stays a hard failure.
      if (!resolvedShellOverride) {
        throw error
      }
      return
    }
    this.wireAndStore({
      id: entry.id,
      incarnationId: randomUUID(),
      pty: term,
      initialCwd: entry.cwd,
      createdAt: Date.now(),
      // Deliberately no ownerClientInstanceId: revive replays state a client serialized, which is
      // not this host observing who asked for the shell. Unattested means never swept.

      buffered: new RecentPtyOutputBuffer({
        preserveChunkBoundaries: false,
        limit: REPLAY_BUFFER_MAX
      }),
      paneKey: entry.paneKey,
      tabId: entry.tabId,
      attachIdentity: entry.attachIdentity,
      worktreeId: entry.worktreeId,
      ...(explicitTerm !== undefined ? { explicitTerm } : {}),
      envToDelete,
      gitCredentialPromptGuarded,
      ...(historyIsolationEnabled ? { historyIsolationEnabled: true } : {}),
      shellPath: shell,
      // Why re-stored: a revived pane can be serialized again, and losing the
      // override on the second round trip is the same bug one restart later.
      ...(resolvedShellOverride ? { shellOverride } : {}),
      ...(terminalWindowsWslDistro ? { wslDistro: terminalWindowsWslDistro } : {}),
      ownerBackend: resolvePtyOwnerBackend({
        platform: process.platform,
        shellPath: shell,
        wslDistro: terminalWindowsWslDistro
      }),
      ...(entry.terminalHandle ? { terminalHandle: entry.terminalHandle } : {})
    })

    const match = entry.id.match(/^pty-(\d+)$/)
    if (match) {
      this.nextId = Math.max(this.nextId, Number.parseInt(match[1], 10) + 1)
    }
  }

  startGraceTimer(onExpire: () => void, timeoutMs = this.graceTimeMs): void {
    this.cancelGraceTimer()
    if (timeoutMs === 0) {
      return
    }
    // Why: connected relays keep the configured grace so live PTYs survive restarts/reconnects.
    this.graceTimer = setTimeout(() => {
      onExpire()
    }, timeoutMs)
  }

  cancelGraceTimer(): void {
    if (this.graceTimer) {
      clearTimeout(this.graceTimer)
      this.graceTimer = null
    }
  }

  /**
   * Reap every owned PTY synchronously, for the fatal-exit path only.
   *
   * Runs to completion across all PTYs: one shell that refuses to die must not
   * strand the rest. The first failure is rethrown so the caller can record it --
   * a reap that failed on a remote host is otherwise invisible.
   */
  forceKillAllPtyProcesses(): void {
    let firstError: unknown
    let hasError = false
    for (const managed of this.ptys.values()) {
      try {
        // Why mark rather than skip: the job already took the whole tree, and the
        // flag is what suppresses the redundant signal -- here in requestForceKill,
        // and in any dispose that still runs after this.
        if (process.platform === 'win32' && terminatePtyJob(managed.pty) === 'terminated') {
          managed.forceKillSent = true
        }
        this.requestForceKill(managed)
      } catch (error) {
        if (!hasError) {
          firstError = error
          hasError = true
        }
      }
    }
    if (hasError) {
      throw firstError
    }
  }

  dispose(options: { waitForPhysicalExit?: boolean } = {}): Promise<void> {
    // Why: fence synchronously before the first await so a spawn/revive can't slip past disposal and escape exit.
    this.creationFenced = true
    if (this.disposePromise) {
      return this.disposePromise
    }
    this.removeLegacyCapacityListener?.()
    this.removeLegacyCapacityListener = null
    this.agentSessionCreateOperations.clear()
    const disposePromise = this.disposePtys(options.waitForPhysicalExit !== false)
    this.disposePromise = disposePromise
    void disposePromise.catch(() => {
      // Why: clear on rejected kill so a later shutdown can retry instead of joining a rejected promise.
      if (this.disposePromise === disposePromise) {
        this.disposePromise = null
      }
    })
    return disposePromise
  }

  private async disposePtys(waitForPhysicalExit: boolean): Promise<void> {
    this.cancelGraceTimer()
    await this.waitForPendingPtyCreations()
    for (const managed of this.ptys.values()) {
      this.releaseRelayIngress(managed)
      this.flushPtyOutput(managed.id)
    }
    if (this.outputFlushTimer !== null) {
      clearTimeout(this.outputFlushTimer)
      this.outputFlushTimer = null
    }
    this.pendingOutputByPty.clear()
    this.pendingProducerBytesByPty.clear()
    this.pendingExitByPty.clear()
    this.pausedOutputPtys.clear()
    this.consumerPausedOutputPtys.clear()
    this.lastInputAtByPty.clear()
    this.interactiveOutputCharsByPty.clear()
    this.sourcePublication?.dispose()
    this.sourcePublication = null
    const results = await Promise.allSettled(
      [...this.ptys.values()].map((managed) =>
        this.disposePtyForRelayShutdown(managed, waitForPhysicalExit)
      )
    )
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    )
    if (rejected) {
      throw rejected.reason
    }
  }

  private async disposePtyForRelayShutdown(
    managed: ManagedPty,
    waitForPhysicalExit: boolean
  ): Promise<void> {
    if (managed.killTimer) {
      clearTimeout(managed.killTimer)
      managed.killTimer = undefined
    }
    this.clearStartupCommandTimer(managed)
    this.releaseRelayIngress(managed)
    // Why: retain the native owner until SIGKILL is accepted (one bounded retry) or onExit proves it gone.
    await this.requestForceKillForRelayShutdown(managed)
    if (waitForPhysicalExit && this.ptys.get(managed.id) === managed && !managed.disposed) {
      try {
        await this.waitForPhysicalExit(managed, IMMEDIATE_PTY_EXIT_TIMEOUT_MS)
      } catch {
        // An accepted SIGKILL is the final boundary when an uninterruptible child can't report exit.
      }
    }
    if (this.ptys.get(managed.id) === managed && !managed.disposed) {
      this.notifyExitListener(managed)
      this.agentSessionOwners.release(managed.id)
      disposeManagedPty(managed)
      this.removePty(managed.id)
      this.clearPtyFlowState(managed.id)
    }
  }

  private async requestForceKillForRelayShutdown(managed: ManagedPty): Promise<void> {
    let lastError: unknown
    for (let attempt = 0; attempt < PTY_FORCE_KILL_MAX_ATTEMPTS; attempt++) {
      if (this.ptys.get(managed.id) !== managed || managed.disposed) {
        return
      }
      try {
        this.requestForceKill(managed)
        return
      } catch (error) {
        lastError = error
      }
      if (attempt + 1 < PTY_FORCE_KILL_MAX_ATTEMPTS) {
        const tracker = managed.physicalExit
        if (!tracker) {
          throw lastError
        }
        try {
          await tracker.waitForExit(
            PTY_FORCE_KILL_RETRY_DELAY_MS,
            () => new Error(`Retrying force-kill for PTY ${managed.id}`)
          )
          return
        } catch {
          // The bounded waiter detached; retry the still-owned native handle.
        }
      }
    }
    throw lastError
  }

  get activePtyCount(): number {
    return this.ptys.size
  }

  /** Spawns admitted but not yet in the pool — each already owns a shell the relay must not treat as idle. */
  get pendingPtyCreationCount(): number {
    return this.pendingSpawnCount
  }

  get retainedStartupCommandCount(): number {
    let count = 0
    for (const managed of this.ptys.values()) {
      if (managed.startupCommand) {
        count += 1
      }
    }
    return count
  }

  get retainedStartupCommandBytes(): number {
    let bytes = 0
    for (const managed of this.ptys.values()) {
      bytes += managed.startupCommand?.command?.length ?? 0
    }
    return bytes
  }

  get graceTimerActive(): boolean {
    return this.graceTimer !== null
  }
}
