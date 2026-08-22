/* oxlint-disable max-lines -- Why: history .catch() safety wiring spread across spawn/event-routing is tightly coupled to the adapter↔history lifecycle. */
import { basename } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { DaemonClient } from './client'
import { DAEMON_ENDPOINT_LOST_MESSAGE } from './daemon-endpoint-ownership'
import { getMacDaemonSystemResolverHealth } from './daemon-health'
import { getMacDaemonTccAttributionHealth } from './daemon-tcc-attribution'
import { isDaemonStaleForCurrentBundle } from './daemon-bundle-staleness'
import { parseDaemonPidFile, type ParsedDaemonPid } from './daemon-pid-file-parse'
import {
  HistoryManager,
  type HistoryCheckpointResult,
  type HistoryRecoveryFreeze
} from './history-manager'
import { HistoryReader, type ColdRestoreInfo } from './history-reader'
import { getRecoveredHistorySeedSegments } from './terminal-history-seed-segments'
import { mintPtySessionId, parsePtySessionId } from './pty-session-id'
import { supportsPtyStartupBarrier } from './shell-ready'
import { CODEX_SHELL_READY_TIMEOUT_MS } from './session-shell-ready-barrier'
import {
  CLEAN_DISCONNECT_PROTOCOL_VERSION,
  COMPLETION_PROCESS_INSPECTION_PROTOCOL_VERSION,
  GET_FOREGROUND_PROCESS_PROTOCOL_VERSION,
  AGENT_SESSION_CLAIM_DAEMON_PROTOCOL_VERSION,
  AGENT_SESSION_CREATE_OPERATION_DAEMON_PROTOCOL_VERSION,
  DAEMON_UNAVAILABLE_RECONNECT_MESSAGE,
  GIT_CREDENTIAL_GUARD_HOST_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  supportsMode2031UnsubscribeFact,
  supportsPtyStartupIngress,
  type CreateOrAttachResult,
  type DaemonEvent,
  type GetSnapshotResult,
  type ListSessionsResult,
  SessionNotFoundError,
  type SessionInfo,
  type TakePendingOutputResult
} from './types'
import {
  GET_SIZE_PROTOCOL_VERSION,
  HISTORY_SEED_TRANSFER_PROTOCOL_VERSION,
  SNAPSHOT_SERIALIZER_FIDELITY_DAEMON_PROTOCOL_VERSION,
  STABLE_PANE_ATTACH_ONLY_DAEMON_PROTOCOL_VERSION
} from './daemon-protocol-version'
import {
  isAgentSessionClaimedSpawnResult,
  isAgentSessionOwnerBinding,
  type AgentSessionOwnerBinding
} from '../../shared/agent-session-host-authority'
import { MAX_CLAIMED_AGENT_PTY_OWNER_ENTRIES } from '../../shared/claimed-agent-pty-owner'
import { cloneAgentSessionOwnerBinding } from '../../shared/claimed-agent-pty-owner-snapshot'
import type {
  IPtyProvider,
  PtyBackgroundStreamEvent,
  PtyProviderBufferSnapshot,
  PtyProcessInfo,
  PtySpawnOptions,
  PtySpawnResult
} from '../providers/types'
import type { PtyProcessInspection } from '../providers/pty-process-inspection'
import { parseTerminalKittyKeyboardFlags } from '../../shared/terminal-kitty-keyboard-flags'
import { isShellProcess } from '../../shared/agent-detection'
import { resolveWslSessionContext } from './wsl-session-context'
import { normalizeWslColdRestoreCwd } from './wsl-cold-restore-cwd'
import { recognizeAgentProcessFromCommandLine } from '../../shared/agent-process-recognition'
import { shouldUseShellReadyStartupDelivery } from '../../shared/codex-startup-delivery'
import type { PtyIncarnationId } from '../../shared/pty-incarnation'
import { resolveSafePtyDefaultCwd } from '../providers/pty-default-cwd'
import { resolveUnixShellPath } from '../providers/local-pty-utils'
import { injectHistoryEnv, injectWslFishHistoryEnv, logHistoryInjection } from '../terminal-history'
import { addWslEnvKeys } from '../wsl-env'
import { PtyWriteUnavailableError } from '../providers/pty-write-unavailable-error'
import { ColdRestorePayloadCache, type ColdRestorePayload } from './cold-restore-payload-cache'
import { CheckpointSessionQueue } from './daemon-checkpoint-session-queue'
import { buildDurableCheckpointSnapshot } from './daemon-durable-history-snapshot'
import { DAEMON_RESTORE_SCROLLBACK_ROWS } from './daemon-restore-scrollback-depth'
import { DAEMON_SESSION_SCROLLBACK_ROWS } from './daemon-session-scrollback-window'
import { PtyProcessListAdmission } from '../providers/pty-process-list-admission'
import {
  iterateTerminalHistorySeedChunks,
  measureTerminalHistorySeed,
  TERMINAL_HISTORY_INLINE_SEED_CODE_UNITS
} from './terminal-history-seed-chunks'
import { NdjsonLineTooLongError } from './ndjson'
import type { DaemonEndpointIdentity } from './daemon-hello-protocol'
import {
  classifyDaemonAuditFailure,
  recordAuthenticatedInventory,
  type DaemonAuditContext,
  type DaemonAuditObservation,
  type DaemonAuditTrigger
} from './daemon-audit-classifier'
import type { DaemonEvidenceSource, ExactDaemonIncarnation } from './daemon-incarnation-evidence'
import { createDaemonAuditEligibilityTracker } from './daemon-audit-eligibility-event'
import { normalizeDesktopTerminalSnapshotRows } from '../../shared/terminal-scrollback-policy'
import type { TerminalExitCause } from '../../shared/terminal-exit-cause'

type PendingDaemonSpawnOperation = {
  exitsBySessionId: Map<string, { incarnationId?: string }[]>
  ignoredExitIncarnationIds: Set<string>
  ignoreNextExit: boolean
}

type HistoryRecoveryContext = {
  freeze: HistoryRecoveryFreeze | null
  unreadableSessionId: string | null
  identityChanged: boolean
}

type SnapshotCheckpointResult = {
  checkpoint: HistoryCheckpointResult
  snapshot: NonNullable<TakePendingOutputResult['snapshot']> | null
}

// Why take-and-clear together: every consuming branch must reset the field, so pairing them stops one from forgetting.
function takeRecoveryFreeze(
  historyRecovery: HistoryRecoveryContext,
  sessionId: string
): HistoryRecoveryFreeze | undefined {
  const freeze =
    historyRecovery.freeze?.sessionId === sessionId ? historyRecovery.freeze : undefined
  historyRecovery.freeze = null
  return freeze
}
function providerSequenceFromCreateOrAttach(
  result: CreateOrAttachResult
): PtySpawnResult['providerSequence'] {
  if (result.isNew) {
    return { value: 0, generation: 'reset' }
  }
  return typeof result.snapshot?.outputSequence === 'number'
    ? { value: result.snapshot.outputSequence, generation: 'continued' }
    : undefined
}

export type DaemonPtyAdapterOptions = {
  socketPath: string
  tokenPath: string
  pidPath?: string
  profileScope?: string
  protocolVersion?: number
  /** Directory for disk-based terminal history; when set, raw PTY output is written to disk for cold restore on daemon crash. */
  historyPath?: string
  /** Runtime profile directory used to verify daemon TCC attribution. */
  runtimeDir?: string
  /** Current packaged version, or null for unpackaged builds. */
  packagedAppVersion?: string | null
  /** Forks a fresh daemon after endpoint death or a confirmed health replacement. */
  respawn?: (reason: DaemonRespawnReason) => Promise<void | (() => void)>
}

export type DaemonRespawnReason =
  | 'daemon_died'
  | 'unhealthy_resolver'
  | 'stale_bundle'
  | 'severed_tcc_attribution'

export type DaemonIdentityChangeEvent = {
  previous: DaemonEndpointIdentity
  current: DaemonEndpointIdentity
}

const MAX_TOMBSTONES = 1000
const MAX_CONCURRENT_CHECKPOINTS = 4

// Why a reattach deadline at all: a warm reattach is a user click, so it must never wait on a
// stalled history filesystem. Why 5s: a healthy deep-history rebuild replays at most
// DAEMON_RESTORE_SCROLLBACK_ROWS through the headless emulator in well under a second, so this
// only fires when the write path is genuinely wedged (STA-4173).
const DURABLE_HISTORY_OVERLAY_DEADLINE_MS = 5_000

// Why far below the client's 30s default: a wedged daemon holds its socket open, so an unbounded
// probe stalls a pane mount for the full request timeout — and the owner fan-out waits on every
// adapter, so one hung daemon stalls each restoring pane. Answering "unknown" quickly is strictly
// better here: unknown never authorizes retirement, it only defers it.
export const LIVENESS_PROBE_TIMEOUT_MS = 2_000

// Why: providers take an absolute teardown deadline, but the client RPC takes a
// relative timeout — convert only here, at the request itself, so sequential RPCs
// naturally share the remaining budget (undefined keeps the client's 30s default).
function remainingRequestTimeoutMs(deadlineMs: number | undefined): number | undefined {
  return deadlineMs === undefined ? undefined : Math.max(1, deadlineMs - Date.now())
}

// Why a distinct error: teardown callers must read this as "not proven stopped" and leave the PTY
// alive, not as a kill that failed. It never matches isPtyAlreadyGoneError, so `stopAndWait` reports
// the pty unverified and worktree sleep declines to commit it.
export class FinalCheckpointWaitExpiredError extends Error {
  constructor(sessionId: string) {
    super(`Final history checkpoint did not settle within the teardown deadline: ${sessionId}`)
    this.name = 'FinalCheckpointWaitExpiredError'
  }
}

// Why only the caller's wait is bounded and never the work itself: cancelling durable work would
// silently drop what the user left on screen. This decides how long a caller blocks, nothing more —
// `work` keeps running behind an abandoned wait and still commits. False means the caller gave up.
// A rejection before the deadline still propagates, so a genuinely failed operation is not masked.
async function awaitWithinCallerDeadline(
  work: Promise<void>,
  deadlineMs: number
): Promise<boolean> {
  // Why up front: once the race is abandoned nothing observes a later rejection here.
  void work.catch(() => {})
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), Math.max(1, deadlineMs - Date.now()))
        timer.unref?.()
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

export class TerminalKilledError extends Error {
  constructor(sessionId: string) {
    super(`Session "${sessionId}" was explicitly killed`)
    this.name = 'TerminalKilledError'
  }
}

export class DaemonPtyAdapter implements IPtyProvider {
  readonly protocolVersion: number
  private socketPath: string
  private tokenPath: string
  private pidPath: string | null
  private pidRecord: ParsedDaemonPid | null
  private client: DaemonClient
  private auditContext: DaemonAuditContext
  private lastAuthenticatedIdentity: DaemonEndpointIdentity | null = null
  private exactDaemonIncarnation: ExactDaemonIncarnation | null = null
  private lastAuditObservation: DaemonAuditObservation | null = null
  // Why: every listProcesses call republishes the same observation; unthrottled it drains the shared per-session telemetry ceiling.
  private readonly trackAuditEligibility = createDaemonAuditEligibilityTracker()
  private auditObservationListeners: ((observation: DaemonAuditObservation) => void)[] = []
  private identityChangeListeners: ((event: DaemonIdentityChangeEvent) => void)[] = []
  private historyManager: HistoryManager | null
  private historyReader: HistoryReader | null
  private respawnFn: DaemonPtyAdapterOptions['respawn'] | null
  private runtimeDir: string | null
  private packagedAppVersion: string | null
  private pendingRespawnAdoptionRelease: (() => void) | null = null
  private respawnAdoptionClosed = false
  // Why: concurrent spawn() calls hitting a dead daemon would each fork their own; this promise coalesces respawns so only the first forks and the rest await it.
  private respawnPromise: Promise<void> | null = null
  private staleBundleReplacementPromise: Promise<void> | null = null
  private writeRecoveryPromise: Promise<void> | null = null
  private writeRecoveryAttempted = false
  private dataListeners: ((payload: {
    id: string
    data: string
    sequenceChars?: number
    transformed?: boolean
    seq?: number
  }) => void)[] = []
  private exitListeners: ((payload: {
    id: string
    code: number
    incarnationId?: PtyIncarnationId
    cause?: TerminalExitCause
  }) => void)[] = []
  private backgroundStreamListeners: ((payload: PtyBackgroundStreamEvent) => void)[] = []
  // Why: lets main fan a dead-endpoint signal to every affected pane, not just the written one (STA-2373 sibling-freeze).
  private writeUnavailableListeners: ((payload: { id: string }) => void)[] = []
  private removeEventListener: (() => void) | null = null
  private initialCwds = new Map<string, string>()
  private wslDistrosBySessionId = new Map<string, string>()
  // Why: StrictMode/re-render remounts can call createOrAttach for a just-killed session; tombstones stop the daemon resurrecting it (Map evicts oldest-first, per terminal-host.ts).
  private killedSessionTombstones = new Map<string, number>()
  // Why: React StrictMode double-mounts; this sticky cache returns the same cold restore data on remount until the renderer acknowledges it.
  private sleepRestoreSessionIds = new Set<string>()
  private coldRestoreCache = new ColdRestorePayloadCache(undefined, (sessionId) => {
    this.sleepRestoreSessionIds.delete(sessionId)
  })
  private activeSessionIds = new Set<string>()
  // Set only once this daemon has rejected `getSize` as unknown; its protocol number cannot prove it.
  private getSizeUnsupported = false
  // A replacement daemon has none of the old PTYs; only createOrAttach can make their bindings writable again.
  private sessionsAwaitingDaemonRecovery = new Set<string>()
  private sessionIncarnations = new Map<string, string>()
  private pendingSpawnOperationsBySessionId = new Map<string, Set<PendingDaemonSpawnOperation>>()
  private pendingClaimSpawnOperations = new Set<PendingDaemonSpawnOperation>()
  private historySpawnLocks = new Map<string, Promise<void>>()
  private dirtySessionVersions = new Map<string, number>()
  // Why: a cold-restored session is a fresh shell atop a pre-crash log; incremental appends would be rejected on restore, so the first tick re-anchors with a full snapshot.
  private sessionsNeedingFullCheckpoint = new Set<string>()
  // Why: overflow or an unpersisted drain breaks disk-to-queue continuity, so only the daemon emulator can safely re-anchor the next checkpoint.
  private sessionsNeedingLiveCheckpoint = new Set<string>()
  // Why: a fresh adapter may reuse deep disk history only when the checkpoint proves it ends at the daemon's preceding pending-output batch.
  private sessionsNeedingContinuityCheckpoint = new Set<string>()
  private checkpointTimer: ReturnType<typeof setTimeout> | null = null
  private checkpointInFlight: Promise<void> | null = null
  // Why per session: exclusivity protects one session directory's tmp-write/rename, so ordering
  // every session behind one tail let a single stalled checkpoint block all reattaches (STA-4173).
  private checkpointQueue = new CheckpointSessionQueue()
  private nonFinalCheckpointAdmissionSessionIds = new Set<string>()
  private nonFinalAdmissionDeniedSessionIds = new Set<string>()
  private nonFinalGlobalAdmissionWarningActive = false
  private overlayDeadlineWarnedSessionIds = new Set<string>()
  private periodicDeadlineWarnedSessionIds = new Set<string>()
  private keepHistoryShutdowns = new Set<Promise<void>>()
  private disconnectOnlyPromise: Promise<void> | null = null
  // Why: checkpoint persistence needs the getSnapshot RPC (v4+); legacy daemons reject it, spamming logs every 5s.
  private supportsCheckpoints: boolean
  // Why: incremental checkpoints need the takePendingOutput RPC (v13+); older daemons fall back to full-snapshot checkpoints.
  private supportsIncrementalCheckpoints: boolean
  // Why: producer pause/resume notifications require v19+; gate them to silent no-ops on legacy daemons.
  private supportsProducerFlowControl: boolean
  private supportsAuthoritativeBufferSnapshots: boolean
  private supportsStartupIngress: boolean
  private pausedProducerSessionIds = new Set<string>()
  // Why tracked here: the daemon's background set dies with the daemon process/socket; re-sync on a fresh connection so hidden panes stay thinned.
  private backgroundedSessionIds = new Set<string>()
  // Why: a daemon surviving a socket drop can hold a pause whose resume died with the connection; owe a resume on reconnect (daemon's 5s failsafe covers the gap).
  private producerResumesOwedOnReconnect = new Set<string>()
  private static CHECKPOINT_INTERVAL_MS = 5_000
  // Why the background pass gets a longer deadline: deferral keeps the session dirty, so this
  // should sit above slow-but-working disk rather than churn it.
  private static PERIODIC_CHECKPOINT_DEADLINE_MS = 15_000
  // Why: streaming sessions re-trigger full multi-MB checkpoints every tick; this cooldown caps cap/overflow snapshots per session (~9x less writes, bounded cold-crash staleness).
  private static FULL_CHECKPOINT_COOLDOWN_MS = 45_000
  private lastFullCheckpointAt = new Map<string, number>()

  supportsGitCredentialGuardHost(): boolean {
    return this.protocolVersion >= GIT_CREDENTIAL_GUARD_HOST_PROTOCOL_VERSION
  }

  canProvideAuthoritativeBufferSnapshot(_id: string): boolean {
    return this.supportsAuthoritativeBufferSnapshots
  }

  // Why one predicate (#9993): the attach-time clear and setPtyBackgrounded must agree on
  // which daemons may hold a background hint. Daemons outlive the desktop that set it, so
  // if these two drift a preserved daemon keeps a hint this process would never grant.
  private get canDelegateBackgroundToDaemon(): boolean {
    return (
      this.supportsAuthoritativeBufferSnapshots &&
      supportsMode2031UnsubscribeFact(this.protocolVersion)
    )
  }

  constructor(opts: DaemonPtyAdapterOptions) {
    this.protocolVersion = opts.protocolVersion ?? PROTOCOL_VERSION
    this.socketPath = opts.socketPath
    this.tokenPath = opts.tokenPath
    this.pidPath = opts.pidPath ?? null
    this.pidRecord = readDaemonPidRecord(this.pidPath)
    this.auditContext = {
      protocolGeneration: this.protocolVersion,
      provider: 'local-daemon',
      endpoint: opts.socketPath,
      tokenPath: opts.tokenPath,
      endpointKind: process.platform === 'win32' ? 'windows-named-pipe' : 'unix-socket',
      profileScope: opts.profileScope ?? ''
    }
    this.client = new DaemonClient({
      socketPath: opts.socketPath,
      tokenPath: opts.tokenPath,
      protocolVersion: opts.protocolVersion
    })
    this.historyManager = opts.historyPath ? new HistoryManager(opts.historyPath) : null
    this.historyReader = opts.historyPath ? new HistoryReader(opts.historyPath) : null
    this.respawnFn = opts.respawn ?? null
    this.runtimeDir = opts.runtimeDir ?? opts.profileScope ?? null
    this.packagedAppVersion = opts.packagedAppVersion ?? null
    this.supportsCheckpoints = this.protocolVersion >= 4
    this.supportsIncrementalCheckpoints = this.protocolVersion >= 13
    this.supportsProducerFlowControl = this.protocolVersion >= 19
    this.supportsAuthoritativeBufferSnapshots =
      this.protocolVersion >= SNAPSHOT_SERIALIZER_FIDELITY_DAEMON_PROTOCOL_VERSION
    this.supportsStartupIngress = supportsPtyStartupIngress(this.protocolVersion)
    this.client.onDisconnected(() => {
      if (!this.respawnAdoptionClosed) {
        // Why re-arm here: the latch is otherwise only cleared when every awaiting
        // session rebinds, and background sessions (no mounted pane, so nothing ever
        // calls createOrAttach for them) never do — which would leave the fan-out
        // permanently latched off after the first death. Fires once per connection.
        this.writeRecoveryAttempted = false
        for (const id of this.activeSessionIds) {
          this.sessionsAwaitingDaemonRecovery.add(id)
        }
      }
      for (const id of this.pausedProducerSessionIds) {
        this.producerResumesOwedOnReconnect.add(id)
      }
      this.pausedProducerSessionIds.clear()
      this.observeAuditFailure('transport_closed')
    })
  }

  getHistoryManager(): HistoryManager | null {
    return this.historyManager
  }

  getLastAuthenticatedDaemonIdentity(): DaemonEndpointIdentity | null {
    return this.lastAuthenticatedIdentity ? { ...this.lastAuthenticatedIdentity } : null
  }

  getLastAuditObservation(): DaemonAuditObservation | null {
    return this.lastAuditObservation
  }

  onDaemonIdentityChanged(listener: (event: DaemonIdentityChangeEvent) => void): () => void {
    this.identityChangeListeners.push(listener)
    return () => removeListener(this.identityChangeListeners, listener)
  }

  onAuditEligibilityObservation(
    listener: (observation: DaemonAuditObservation) => void
  ): () => void {
    this.auditObservationListeners.push(listener)
    return () => removeListener(this.auditObservationListeners, listener)
  }

  supportsAgentSessionClaims(): boolean {
    return this.protocolVersion >= AGENT_SESSION_CLAIM_DAEMON_PROTOCOL_VERSION
  }

  providesAgentSessionOwnerListings(_ptyId: string): boolean {
    return this.supportsAgentSessionClaims()
  }

  supportsAgentSessionCreateOperations(): boolean {
    // Why: old daemons never advertised the lower-owner protocol, so preserve their legacy launch.
    return this.protocolVersion >= AGENT_SESSION_CREATE_OPERATION_DAEMON_PROTOCOL_VERSION
  }

  async spawn(opts: PtySpawnOptions): Promise<PtySpawnResult> {
    const spawnOpts = this.withHistoryIsolation(opts)
    const sessionId = spawnOpts.sessionId ?? mintPtySessionId(spawnOpts.worktreeId)
    const operation = {
      exitsBySessionId: new Map<string, { incarnationId?: string }[]>(),
      ignoredExitIncarnationIds: new Set<string>(),
      ignoreNextExit: false
    }
    const operations = this.pendingSpawnOperationsBySessionId.get(sessionId) ?? new Set()
    operations.add(operation)
    this.pendingSpawnOperationsBySessionId.set(sessionId, operations)
    if (opts.agentSessionEnsure) {
      this.pendingClaimSpawnOperations.add(operation)
    }
    const historyRecovery: HistoryRecoveryContext = {
      freeze: null,
      unreadableSessionId: null,
      identityChanged: false
    }
    try {
      return await this.withHistorySpawnLock(sessionId, () =>
        this.withDaemonRetry(() =>
          this.doSpawn({ ...spawnOpts, sessionId }, operation, historyRecovery)
        )
      )
    } finally {
      if (historyRecovery.freeze) {
        this.historyManager?.abandonRecoveryFreeze(historyRecovery.freeze)
      }
      this.pendingClaimSpawnOperations.delete(operation)
      operations.delete(operation)
      if (operations.size === 0) {
        this.pendingSpawnOperationsBySessionId.delete(sessionId)
      }
    }
  }

  private withHistoryIsolation(opts: PtySpawnOptions): PtySpawnOptions {
    const wslContext = resolveWslSessionContext({
      cwd: opts.cwd,
      sessionId: opts.sessionId,
      shellOverride: opts.shellOverride,
      terminalWindowsWslDistro: opts.terminalWindowsWslDistro
    })
    if (
      opts.attachOnly === true ||
      (opts.sessionId !== undefined && opts.isNewSession !== true) ||
      !opts.worktreeId ||
      opts.historyIsolationEnabled !== true ||
      (process.platform === 'win32' && !wslContext)
    ) {
      return opts
    }
    const env = { ...opts.env }
    const preferredShell = wslContext
      ? 'bash'
      : opts.shellOverride || env.SHELL || process.env.SHELL || '/bin/zsh'
    const shellPath = resolveUnixShellPath(preferredShell)
    const historyArgs = [
      env,
      opts.worktreeId,
      shellPath,
      opts.cwd ?? resolveSafePtyDefaultCwd()
    ] as const
    const result = wslContext
      ? injectHistoryEnv(...historyArgs, { wslDistro: wslContext.distro })
      : injectHistoryEnv(...historyArgs)
    if (wslContext) {
      injectWslFishHistoryEnv(env, opts.worktreeId, wslContext.distro)
      addWslEnvKeys(env, ['HISTFILE', 'fish_history'])
    }
    logHistoryInjection(opts.worktreeId, result)
    return { ...opts, env }
  }

  private async doSpawn(
    opts: PtySpawnOptions,
    operation: PendingDaemonSpawnOperation,
    historyRecovery: HistoryRecoveryContext
  ): Promise<PtySpawnResult> {
    if (
      opts.agentSessionEnsure &&
      this.protocolVersion < AGENT_SESSION_CLAIM_DAEMON_PROTOCOL_VERSION
    ) {
      throw new Error('agent_session_claim_unavailable')
    }
    const requestedSessionId = opts.sessionId!
    // Why: v30 daemons survive upgrades; reject their accidental create result before publication.
    const attachOnly = opts.attachOnly === true
    const emulateLegacyAttachOnly =
      attachOnly && this.protocolVersion < STABLE_PANE_ATTACH_ONLY_DAEMON_PROTOCOL_VERSION
    let sessionId = requestedSessionId
    let wslDistro = resolveWslSessionContext({
      cwd: opts.cwd,
      sessionId,
      shellOverride: opts.shellOverride,
      terminalWindowsWslDistro: opts.terminalWindowsWslDistro
    })?.distro
    const freezeHistory = async (): Promise<void> => {
      if (!this.historyManager) {
        return
      }
      if (historyRecovery.freeze?.sessionId === sessionId) {
        return
      }
      if (historyRecovery.freeze) {
        this.historyManager.abandonRecoveryFreeze(historyRecovery.freeze)
      }
      historyRecovery.freeze = await this.historyManager.freezeForRecovery(sessionId)
      historyRecovery.unreadableSessionId = null
    }
    const detectColdRestore = async (options?: {
      ignoreCleanEnd?: boolean
    }): Promise<ColdRestoreInfo | null> => {
      if (!this.historyReader) {
        return null
      }
      await freezeHistory()
      const detection = await this.historyReader.detectColdRestoreState(sessionId, {
        ...options,
        wslDistro
      })
      if (detection.status === 'unreadable') {
        historyRecovery.unreadableSessionId = detection.sessionId
        return null
      }
      const restoreInfo = detection.status === 'restored' ? detection.restoreInfo : null
      if (detection.status === 'restored' && detection.hasUnreadableRecovery) {
        historyRecovery.unreadableSessionId = detection.sessionId
      }
      if (!restoreInfo) {
        return null
      }
      return {
        ...restoreInfo,
        cwd:
          normalizeWslColdRestoreCwd({
            recoveredCwd: restoreInfo.cwd,
            requestedCwd: opts.cwd ?? resolveSafePtyDefaultCwd(),
            wslDistro
          }) ?? ''
      }
    }

    if (this.killedSessionTombstones.has(sessionId)) {
      throw new TerminalKilledError(sessionId)
    }

    if (opts.isNewSession) {
      await this.replaceUnhealthyMacResolverDaemonBeforeNewPty()
      await this.replaceStaleBundleDaemonBeforeNewPty()
      await this.replaceSeveredMacTccDaemonBeforeNewPty()
    }

    await this.ensureConnected()
    // Why before createOrAttach: a preserved daemon may still think this session is backgrounded — from
    // a v19 that thins without a recoverable seq, or (#9993) from a pre-v29 that a previous desktop
    // handed 2031 scan authority to and can never retract it. Clear it before any bytes are attached.
    if (!this.canDelegateBackgroundToDaemon) {
      this.setPtyBackgrounded(sessionId, false)
    }

    // Why detect crash-recovery history before spawning: the revived shell should inherit the recovered cwd/dims, not the renderer's mount-time request.
    // Why probe aliveness first: detectColdRestore replays up to ~5MB on the main process, but a live session's snapshot supersedes disk, so the replay would be wasted.
    let restoreInfo: ColdRestoreInfo | null = null
    let restoreSkippedForLiveSession = false
    const historyProbe = opts.attachOnly
      ? undefined
      : this.historyReader?.probeRestorableHistory(sessionId)
    if (historyProbe && historyProbe.status !== 'none') {
      if ((await this.getAppliedSize(sessionId)) !== null) {
        restoreSkippedForLiveSession = true
        if (this.historyManager && !this.historyManager.hasWriter(sessionId)) {
          await detectColdRestore()
          restoreInfo = null
        }
      } else {
        restoreInfo = await detectColdRestore()
      }
    }
    let effectiveCwd = restoreInfo?.cwd ?? opts.cwd
    let effectiveCols = restoreInfo?.cols ?? opts.cols
    let effectiveRows = restoreInfo?.rows ?? opts.rows

    const shellReadySupported = opts.command ? supportsPtyStartupBarrier(opts.env ?? {}) : false
    const isCodexStartupCommand =
      recognizeAgentProcessFromCommandLine(opts.command)?.agent === 'codex'
    const shouldWaitForShellReady =
      isCodexStartupCommand &&
      shouldUseShellReadyStartupDelivery({
        command: opts.command,
        startupCommandDelivery: opts.startupCommandDelivery
      })
    const shellReadyTimeoutMs =
      shellReadySupported && isCodexStartupCommand && !shouldWaitForShellReady
        ? CODEX_SHELL_READY_TIMEOUT_MS
        : undefined

    const requestCreateOrAttach = (
      historySeed: string | undefined,
      historySeedTransferId: string | undefined
    ) => {
      if (opts.signal?.aborted) {
        throw new Error('client_disconnected')
      }
      const payload = {
        sessionId,
        cols: effectiveCols,
        rows: effectiveRows,
        cwd: attachOnly ? undefined : effectiveCwd,
        env: attachOnly ? undefined : opts.env,
        envToDelete: attachOnly ? undefined : opts.envToDelete,
        command: attachOnly ? undefined : opts.command,
        startupCommandDelivery: attachOnly ? undefined : opts.startupCommandDelivery,
        launchAgent: attachOnly ? undefined : opts.launchAgent,
        ...(attachOnly && !emulateLegacyAttachOnly ? { attachOnly: true } : {}),
        // Why: without forwarding the override, the daemon falls back to cmd.exe/PowerShell, ignoring the shell the renderer chose; this matches LocalPtyProvider.
        shellOverride: attachOnly ? undefined : opts.shellOverride,
        terminalWindowsWslDistro: attachOnly ? undefined : opts.terminalWindowsWslDistro,
        terminalWindowsPowerShellImplementation: attachOnly
          ? undefined
          : opts.terminalWindowsPowerShellImplementation,
        shellReadySupported: attachOnly ? false : shellReadySupported,
        ...(!attachOnly && shellReadyTimeoutMs !== undefined ? { shellReadyTimeoutMs } : {}),
        ...(historySeed ? { historySeed } : {}),
        ...(historySeedTransferId ? { historySeedTransferId } : {}),
        ...(this.supportsStartupIngress && !attachOnly && opts.startupIngress
          ? { startupIngress: opts.startupIngress }
          : {}),
        ...(!attachOnly && opts.agentSessionEnsure
          ? { agentSessionEnsure: opts.agentSessionEnsure }
          : {})
      }
      return opts.signal
        ? this.client.request<CreateOrAttachResult>(
            'createOrAttach',
            payload,
            undefined,
            opts.signal
          )
        : this.client.request<CreateOrAttachResult>('createOrAttach', payload)
    }

    const createOrAttach = async (
      historySeedSegments: readonly string[] | null
    ): Promise<CreateOrAttachResult> => {
      // Why scoped per call: the aliveness-probe retry re-runs this with its own seed, so a first-call
      // delivery failure must not force historySeeded=false on a retry that seeded successfully.
      let historySeedUnavailable = false
      const deliverSeedAndCreate = async (): Promise<CreateOrAttachResult> => {
        if (!historySeedSegments || historySeedSegments.length === 0) {
          return requestCreateOrAttach(undefined, undefined)
        }
        const metrics = measureTerminalHistorySeed(historySeedSegments)
        if (metrics.codeUnits <= TERMINAL_HISTORY_INLINE_SEED_CODE_UNITS) {
          try {
            return await requestCreateOrAttach(historySeedSegments.join(''), undefined)
          } catch (error) {
            if (!(error instanceof NdjsonLineTooLongError)) {
              throw error
            }
            historySeedUnavailable = true
            return requestCreateOrAttach(undefined, undefined)
          }
        }
        if (this.protocolVersion < HISTORY_SEED_TRANSFER_PROTOCOL_VERSION) {
          historySeedUnavailable = true
          return requestCreateOrAttach(undefined, undefined)
        }

        let transferId: string | undefined
        try {
          const started = await this.client.request<{ transferId: string }>(
            'startHistorySeedTransfer',
            metrics
          )
          transferId = started.transferId
          let index = 0
          for (const data of iterateTerminalHistorySeedChunks(historySeedSegments)) {
            await this.client.request('appendHistorySeedTransfer', { transferId, index, data })
            index += 1
          }
          await this.client.request('finishHistorySeedTransfer', { transferId })
        } catch (error) {
          if (transferId) {
            await this.client.request('abortHistorySeedTransfer', { transferId }).catch(() => {})
          }
          if (isDaemonGoneError(error)) {
            throw error
          }
          historySeedUnavailable = true
          return requestCreateOrAttach(undefined, undefined)
        }
        return requestCreateOrAttach(undefined, transferId)
      }
      const result = await deliverSeedAndCreate()
      return historySeedUnavailable && result.historySeeded === undefined
        ? { ...result, historySeeded: false }
        : result
    }

    let historySeedSegments = restoreInfo ? getRecoveredHistorySeedSegments(restoreInfo) : null
    const adoptSpawnResultSession = async (spawnResult: CreateOrAttachResult): Promise<void> => {
      const requestedSessionId = sessionId
      if (
        opts.agentSessionEnsure &&
        !isAgentSessionClaimedSpawnResult(spawnResult.agentSessionEnsure)
      ) {
        // Why: a claim-incapable owner may already have spawned before returning
        // a malformed response; retire only this requested session before failing closed.
        await this.client.request('kill', { sessionId: requestedSessionId }).catch(() => {})
        throw new Error('agent_session_claim_unavailable')
      }
      sessionId = spawnResult.agentSessionEnsure?.owner.ptyId ?? requestedSessionId
      if (requestedSessionId === sessionId) {
        return
      }
      if (historyRecovery.freeze) {
        this.historyManager?.abandonRecoveryFreeze(historyRecovery.freeze)
        historyRecovery.freeze = null
      }
      historyRecovery.unreadableSessionId = null
      historyRecovery.identityChanged = true
      restoreInfo = null
      historySeedSegments = null
    }
    let result = await createOrAttach(historySeedSegments)
    if (emulateLegacyAttachOnly && result.isNew) {
      operation.ignoreNextExit = true
      await this.client.request('kill', { sessionId: requestedSessionId, immediate: true })
      throw new SessionNotFoundError(requestedSessionId)
    }
    await adoptSpawnResultSession(result)
    // Both ids: adoptSpawnResultSession may have rewritten sessionId to the claim owner.
    this.clearSessionAwaitingDaemonRecovery(requestedSessionId)
    this.clearSessionAwaitingDaemonRecovery(sessionId)
    const exitedResult = this.resultForExitBeforeSpawnReply(sessionId, result, operation)
    if (exitedResult) {
      return exitedResult
    }
    if (result.incarnationId) {
      this.sessionIncarnations.set(sessionId, result.incarnationId)
    }
    const claimResult = (): Pick<PtySpawnResult, 'agentSessionEnsure'> | Record<string, never> =>
      result.agentSessionEnsure ? { agentSessionEnsure: result.agentSessionEnsure } : {}
    const incarnationResult = (): Pick<PtySpawnResult, 'incarnationId'> | Record<string, never> =>
      result.incarnationId ? { incarnationId: result.incarnationId } : {}
    let providerWslDistro = result.wslDistro === undefined ? wslDistro : result.wslDistro
    // Why: explicit null from a current daemon overrides the caller's WSL preference; undefined keeps compatibility with older daemons.
    wslDistro = providerWslDistro ?? undefined
    if (wslDistro) {
      this.wslDistrosBySessionId.set(sessionId, wslDistro)
    } else if (providerWslDistro === null || result.isNew) {
      this.wslDistrosBySessionId.delete(sessionId)
    }
    const launchIdentity = (): { launchAgent?: NonNullable<typeof result.launchAgent> } =>
      result.launchAgent ? { launchAgent: result.launchAgent } : {}

    if (effectiveCwd) {
      this.initialCwds.set(sessionId, effectiveCwd)
    }

    // Why: surface the daemon's shell pid via PtySpawnResult so ipc/pty registers with the memory collector without a provider-specific accessor.
    let pid = typeof result.pid === 'number' && result.pid > 0 ? result.pid : null

    // Why: check sticky cache first — StrictMode double-mounts call spawn twice; the second call (isNew=false) must still return cached cold restore data.
    const cachedRestore = this.coldRestoreCache.get(sessionId)
    if (cachedRestore) {
      // Why: wake-after-sleep lands here too; sleep dropped active tracking + the history writer, so re-register both or the next sleep/wake restores a blank terminal.
      this.activeSessionIds.add(sessionId)
      if (this.historyManager && !historyRecovery.identityChanged) {
        const recoveryFreeze = takeRecoveryFreeze(historyRecovery, sessionId)
        if (historyRecovery.unreadableSessionId === sessionId) {
          this.historyManager.suspendSession(sessionId, recoveryFreeze)
        } else {
          this.historyManager.reopenSession(sessionId, recoveryFreeze)
        }
      }
      return {
        id: sessionId,
        ...incarnationResult(),
        pid,
        ...claimResult(),
        ...launchIdentity(),
        coldRestore: cachedRestore,
        ...(providerWslDistro !== undefined ? { wslDistro: providerWslDistro } : {}),
        ...(!result.isNew ? { isReattach: true } : {})
      }
    }

    // Why: the probe→createOrAttach gap is racy — the session can exit in between, so re-detect to match the unprobed restore path.
    // Why ignoreCleanEnd: the raced exit event can write endedAt before the reply; nulling the restore here would delete the checkpoint instead of restoring it.
    if (!historyRecovery.identityChanged && result.isNew && restoreSkippedForLiveSession) {
      restoreInfo = await detectColdRestore({ ignoreCleanEnd: true })
      historySeedSegments = restoreInfo ? getRecoveredHistorySeedSegments(restoreInfo) : null
      if (restoreInfo && historySeedSegments && historySeedSegments.length > 0) {
        // Why: the aliveness probe raced with session death, so the first
        // create lacked recovery bytes. Replace it before exposing the PTY.
        if (result.incarnationId) {
          operation.ignoredExitIncarnationIds.add(result.incarnationId)
        }
        operation.ignoreNextExit = true
        await this.client.request('kill', { sessionId, immediate: true })
        effectiveCwd = restoreInfo.cwd
        effectiveCols = restoreInfo.cols
        effectiveRows = restoreInfo.rows
        result = await createOrAttach(historySeedSegments)
        await adoptSpawnResultSession(result)
        const exitedRetryResult = this.resultForExitBeforeSpawnReply(sessionId, result, operation)
        if (exitedRetryResult) {
          return exitedRetryResult
        }
        if (result.incarnationId) {
          this.sessionIncarnations.set(sessionId, result.incarnationId)
        }
        providerWslDistro = result.wslDistro === undefined ? wslDistro : result.wslDistro
        wslDistro = providerWslDistro ?? undefined
        if (wslDistro) {
          this.wslDistrosBySessionId.set(sessionId, wslDistro)
        } else if (providerWslDistro === null || result.isNew) {
          this.wslDistrosBySessionId.delete(sessionId)
        }
        pid = typeof result.pid === 'number' && result.pid > 0 ? result.pid : null
        this.initialCwds.set(sessionId, effectiveCwd)
      }
    } else if (
      !historyRecovery.identityChanged &&
      !result.isNew &&
      result.historySeeded === false
    ) {
      restoreInfo = await detectColdRestore()
      historySeedSegments = restoreInfo ? getRecoveredHistorySeedSegments(restoreInfo) : null
    }

    const wasAlreadyManaged = this.activeSessionIds.has(sessionId)
    this.activeSessionIds.add(sessionId)
    const providerSequence = providerSequenceFromCreateOrAttach(result)

    // Cold restore: daemon made a new session but disk history shows an unclean shutdown → return saved scrollback.
    if (restoreInfo && (result.isNew || result.historySeeded === false)) {
      const coldRestore = this.buildColdRestorePayload(restoreInfo)
      const canReanchorHistory =
        !historySeedSegments || historySeedSegments.length === 0 || result.historySeeded === true
      // Why: registerWriter (not openSession) avoids deleting checkpoint.json — the only recovery data if the revived daemon crashes before the next tick.
      if (this.historyManager && !historyRecovery.identityChanged) {
        const recoveryFreeze = takeRecoveryFreeze(historyRecovery, sessionId)
        if (historyRecovery.unreadableSessionId === sessionId) {
          await this.historyManager.openSession(sessionId, {
            cwd: effectiveCwd ?? '',
            cols: effectiveCols,
            rows: effectiveRows,
            ...(recoveryFreeze ? { recoveryFreeze } : {}),
            quarantineUnreadableRecovery: true
          })
          if (this.historyManager.hasWriter(sessionId)) {
            this.sessionsNeedingFullCheckpoint.add(sessionId)
            this.sessionsNeedingLiveCheckpoint.add(sessionId)
            this.lastFullCheckpointAt.delete(sessionId)
          }
        } else if (canReanchorHistory) {
          this.historyManager.registerWriter(sessionId, recoveryFreeze)
          this.sessionsNeedingFullCheckpoint.add(sessionId)
          // Why: the revived generation has no valid checkpoint yet; a cooldown inherited from the pre-crash generation must not defer this re-anchor.
          this.lastFullCheckpointAt.delete(sessionId)
        } else {
          // Preserve old recovery files when the new daemon can't include them; a fresh-only checkpoint would make the data loss permanent.
          this.historyManager.suspendSession(sessionId, recoveryFreeze)
        }
      }
      if (coldRestore) {
        this.coldRestoreCache.set(sessionId, coldRestore)
        return {
          id: sessionId,
          ...incarnationResult(),
          pid,
          ...claimResult(),
          ...launchIdentity(),
          coldRestore,
          ...(providerWslDistro !== undefined ? { wslDistro: providerWslDistro } : {}),
          ...(providerSequence ? { providerSequence } : {}),
          ...(!result.isNew ? { isReattach: true } : {})
        }
      }
      return {
        id: sessionId,
        ...incarnationResult(),
        pid,
        ...claimResult(),
        ...launchIdentity(),
        ...(providerWslDistro !== undefined ? { wslDistro: providerWslDistro } : {}),
        ...(providerSequence ? { providerSequence } : {})
      }
    }

    if (this.historyManager && !historyRecovery.identityChanged && result.isNew) {
      const recoveryFreeze = takeRecoveryFreeze(historyRecovery, sessionId)
      await this.historyManager.openSession(sessionId, {
        cwd: effectiveCwd ?? '',
        cols: effectiveCols,
        rows: effectiveRows,
        ...(recoveryFreeze ? { recoveryFreeze } : {}),
        ...(historyRecovery.unreadableSessionId === sessionId
          ? { quarantineUnreadableRecovery: true }
          : {})
      })
    } else if (
      this.historyManager &&
      !historyRecovery.identityChanged &&
      (result.historySeeded === false || historyRecovery.unreadableSessionId === sessionId)
    ) {
      // Why: the daemon keeps this failure bit with the live session, so a new adapter can't promote its fresh-only snapshot after restart.
      this.historyManager.suspendSession(sessionId, takeRecoveryFreeze(historyRecovery, sessionId))
    } else if (this.historyManager && !historyRecovery.identityChanged) {
      // Why: on warm reattach after relaunch the HistoryManager is fresh; registerWriter adds a writer without deleting the still-only-valid checkpoint.
      this.historyManager.registerWriter(sessionId, takeRecoveryFreeze(historyRecovery, sessionId))
      if (!wasAlreadyManaged) {
        // Why: a previous adapter may have drained records it never persisted, so the first compact must prove disk-to-daemon continuity.
        this.sessionsNeedingFullCheckpoint.add(sessionId)
        this.sessionsNeedingContinuityCheckpoint.add(sessionId)
        this.lastFullCheckpointAt.delete(sessionId)
      }
    }

    const isReattach = !result.isNew
    if (!isReattach || !result.snapshot) {
      return {
        id: sessionId,
        ...incarnationResult(),
        pid,
        ...claimResult(),
        ...launchIdentity(),
        ...(providerWslDistro !== undefined ? { wslDistro: providerWslDistro } : {}),
        ...(providerSequence ? { providerSequence } : {}),
        ...(isReattach ? { isReattach: true } : {})
      }
    }

    const reattachSnapshot = await this.overlayDurableRestoreSnapshot(sessionId, result.snapshot)
    const reattachProviderSequence =
      typeof reattachSnapshot.outputSequence === 'number'
        ? { value: reattachSnapshot.outputSequence, generation: 'continued' as const }
        : providerSequence
    const isAltScreen = reattachSnapshot.modes.alternateScreen
    const snapshotPrefix = reattachSnapshot.scrollbackAnsi + reattachSnapshot.rehydrateSequences
    const snapshotFrame = reattachSnapshot.snapshotAnsi
    const snapshotPayload = snapshotPrefix + snapshotFrame
    // Why kitty flags ride beside the payload, not inside it: the snapshot reaches renderer xterms where POST_REPLAY_REATTACH_RESET's kitty reset must win (terminal-query-authority.md §kitty).
    // Why known `0` is no longer dropped: the pane tracker must be able to tell
    // "the app negotiated nothing" from "this reattach proved nothing".
    const kittyKeyboardFlags = parseTerminalKittyKeyboardFlags(
      reattachSnapshot.modes.kittyKeyboardFlags
    )
    return {
      id: sessionId,
      ...incarnationResult(),
      pid,
      ...claimResult(),
      ...launchIdentity(),
      ...(providerWslDistro !== undefined ? { wslDistro: providerWslDistro } : {}),
      snapshot: snapshotPayload,
      snapshotCols: reattachSnapshot.cols,
      snapshotRows: reattachSnapshot.rows,
      // Why only for an alt frame: normal history remains safe to replay at its capture grid.
      ...(isAltScreen && snapshotFrame && reattachSnapshot.frameRestoreAnsi
        ? {
            snapshotPrefixAnsi: snapshotPrefix,
            snapshotFrameAnsi: snapshotFrame,
            snapshotFrameRestoreAnsi: reattachSnapshot.frameRestoreAnsi
          }
        : {}),
      ...(reattachProviderSequence ? { providerSequence: reattachProviderSequence } : {}),
      ...(kittyKeyboardFlags !== undefined
        ? { snapshotKittyKeyboardFlags: kittyKeyboardFlags }
        : {}),
      isReattach: true,
      isAlternateScreen: isAltScreen,
      // Why: the snapshot ANSI has no title frame; carry lastTitle beside it so main can seed title records after a relaunch.
      ...(reattachSnapshot.lastTitle ? { lastTitle: reattachSnapshot.lastTitle } : {}),
      // Why: carry the mid-escape tail so the renderer writes it after the reattach reset, else a split escape renders literally (#7329).
      ...(reattachSnapshot.pendingEscapeTailAnsi
        ? { pendingEscapeTailAnsi: reattachSnapshot.pendingEscapeTailAnsi }
        : {})
    }
  }

  private resultForExitBeforeSpawnReply(
    sessionId: string,
    result: CreateOrAttachResult,
    operation: PendingDaemonSpawnOperation
  ): PtySpawnResult | null {
    const matchingExit = (operation.exitsBySessionId.get(sessionId) ?? []).some(
      (exit) =>
        !(exit.incarnationId && operation.ignoredExitIncarnationIds.has(exit.incarnationId)) &&
        (!exit.incarnationId ||
          !result.incarnationId ||
          exit.incarnationId === result.incarnationId)
    )
    if (!matchingExit) {
      return null
    }
    // Why: stream exit can beat the control reply; return proof upward without republishing dead adapter state.
    const exitedResult: PtySpawnResult = {
      id: sessionId,
      exitedBeforeSpawnReply: true,
      ...(result.incarnationId ? { incarnationId: result.incarnationId } : {}),
      ...(result.agentSessionEnsure ? { agentSessionEnsure: result.agentSessionEnsure } : {}),
      ...(!result.isNew ? { isReattach: true } : {})
    }
    return exitedResult
  }

  didExitBeforeSpawnReply(result: PtySpawnResult): boolean {
    return result.exitedBeforeSpawnReply === true
  }

  async attach(id: string): Promise<Pick<PtySpawnResult, 'providerSequence'> | void> {
    await this.ensureConnected()
    if (!this.canDelegateBackgroundToDaemon) {
      this.setPtyBackgrounded(id, false)
    }

    // Why size-first: attach must ride the session's own geometry — a fixed
    // 80×24 here could resize a live agent's TUI — and a null size means the
    // daemon cannot prove the session, so refuse rather than risk a create.
    const size = await this.getAppliedSize(id)
    if (!size) {
      throw new SessionNotFoundError(id)
    }
    const result = await this.client.request<CreateOrAttachResult>('createOrAttach', {
      sessionId: id,
      cols: size.cols,
      rows: size.rows,
      attachOnly: true
    })
    if (result.isNew) {
      // Why: a pre-v31 daemon ignores attachOnly; retire its accidental spawn
      // instead of publishing a fresh shell as an attach.
      await this.client.request('kill', { sessionId: id, immediate: true }).catch((error) => {
        // Why surface, not swallow: a failed retire leaves an untracked orphan shell.
        console.warn('[daemon] attach-only retire of accidental legacy spawn failed', {
          sessionId: id,
          error
        })
      })
      throw new SessionNotFoundError(id)
    }
    this.clearSessionAwaitingDaemonRecovery(id)
    const providerSequence = providerSequenceFromCreateOrAttach(result)
    return providerSequence ? { providerSequence } : undefined
  }

  hasPty(id: string): boolean {
    return this.activeSessionIds.has(id)
  }

  async probePtyLiveness(id: string): Promise<boolean | null> {
    try {
      if (!this.getSizeUnsupported && this.protocolVersion >= GET_SIZE_PROTOCOL_VERSION) {
        try {
          const result = await this.client.request<{ size: { cols: number; rows: number } | null }>(
            'getSize',
            { sessionId: id },
            LIVENESS_PROBE_TIMEOUT_MS
          )
          return result.size !== null
        } catch (error) {
          // Why the capability probe rather than the version alone: `getSize` shipped into an
          // already-released protocol without a bump, so a daemon can report a version that
          // implies support and still reject the request. Ask what it can do, not what its
          // number implies — and remember the answer so later probes skip the dead round trip.
          if (!isUnknownRequestTypeError(error)) {
            throw error
          }
          this.getSizeUnsupported = true
        }
      }
      // Why: a daemon without `getSize` would otherwise answer `null` forever, and one `null`
      // makes the whole owner fan-out unprovable — a dead pane could then never be retired.
      // `listSessions` is the same inventory legacy discovery routes by, and has existed since
      // the first daemon protocol. Requested directly rather than through `listProcesses` so a
      // liveness probe does not publish inventory audit observations as a side effect; both
      // rethrow on failure, so either way a dead socket stays `null` instead of reading absent.
      const { sessions } = await this.client.request<ListSessionsResult>(
        'listSessions',
        undefined,
        LIVENESS_PROBE_TIMEOUT_MS
      )
      return sessions.some((session) => session.sessionId === id && session.isAlive)
    } catch {
      return null
    }
  }

  write(id: string, data: string): boolean {
    const recoverable = this.prepareWrite(id)
    return this.finishWrite(id, this.client.notify('write', { sessionId: id, data }), recoverable)
  }

  async writeWithSettlement(id: string, data: string): Promise<boolean> {
    const recoverable = this.prepareWrite(id)
    return this.finishWrite(
      id,
      await this.client.notifyWithSettlement('write', { sessionId: id, data }),
      recoverable
    )
  }

  private prepareWrite(id: string): boolean {
    this.markSessionDirty(id)
    // Why recoverable and not just active: rejecting a write asks the pane to remount,
    // which only helps if this endpoint can come back. A legacy adapter has no respawn,
    // so its reattach fails and the pane rebuilds empty — losing scrollback the user
    // could still read. Keep the pre-existing silent drop for those.
    const recoverable =
      this.activeSessionIds.has(id) && !this.respawnAdoptionClosed && Boolean(this.respawnFn)
    if (
      recoverable &&
      (this.sessionsAwaitingDaemonRecovery.has(id) || !this.client.isConnected())
    ) {
      this.sessionsAwaitingDaemonRecovery.add(id)
      this.reconnectAfterWriteFailure()
      throw new PtyWriteUnavailableError(`Daemon PTY "${id}" is awaiting recovery`)
    }
    return recoverable
  }

  private finishWrite(id: string, delivered: boolean, recoverable: boolean): boolean {
    if (!delivered && recoverable) {
      this.sessionsAwaitingDaemonRecovery.add(id)
      this.reconnectAfterWriteFailure()
      throw new PtyWriteUnavailableError(`Daemon PTY "${id}" is awaiting recovery`)
    }
    return delivered
  }

  resize(id: string, cols: number, rows: number): void {
    this.markSessionDirty(id)
    this.client.notify('resize', { sessionId: id, cols, rows })
  }

  pauseProducer(id: string): void {
    if (!this.supportsProducerFlowControl) {
      return
    }
    this.pausedProducerSessionIds.add(id)
    this.client.notify('pausePty', { sessionId: id })
  }

  resumeProducer(id: string): void {
    this.producerResumesOwedOnReconnect.delete(id)
    if (!this.supportsProducerFlowControl) {
      return
    }
    this.pausedProducerSessionIds.delete(id)
    this.client.notify('resumePty', { sessionId: id })
  }

  // Why fire-and-forget (like pausePty): just a delivery hint for the daemon's keep-tail stream thinning.
  setPtyBackgrounded(id: string, background: boolean): void {
    if (!this.supportsProducerFlowControl) {
      return
    }
    // Why: preserved daemons without a sequence-safe, faithful serializer cannot heal a thinned stream.
    // Why also gate on 2031 (#9993): backgrounding is what hands transient-fact scan
    // authority to the daemon. A pre-v29 daemon can announce a 2031 subscribe but never
    // retract it, so a TUI exiting while hidden would strand the subscription and the
    // next theme flip would inject CSI 997 into its replacement shell. Declining to
    // background keeps main's scanner — which emits both facts — authoritative.
    const safeBackground = this.canDelegateBackgroundToDaemon && background
    if (safeBackground) {
      this.backgroundedSessionIds.add(id)
    } else {
      this.backgroundedSessionIds.delete(id)
    }
    this.client.notify('setSessionBackground', { sessionId: id, background: safeBackground })
  }

  async shutdown(
    id: string,
    opts: { immediate?: boolean; keepHistory?: boolean; deadlineMs?: number }
  ): Promise<void> {
    if (opts.keepHistory && this.disconnectOnlyPromise) {
      throw new Error('Cannot keep history after daemon disconnect has started')
    }
    const shutdown = this.withHistorySpawnLock(id, () => this.shutdownWithHistoryLock(id, opts))
    if (!opts.keepHistory) {
      await shutdown
      return
    }
    this.keepHistoryShutdowns.add(shutdown)
    try {
      await shutdown
    } finally {
      this.keepHistoryShutdowns.delete(shutdown)
    }
  }

  private async shutdownWithHistoryLock(
    id: string,
    opts: { immediate?: boolean; keepHistory?: boolean; deadlineMs?: number }
  ): Promise<void> {
    // Why: shutdown can be the first lazy-client operation after restart; connect
    // before killing so a healthy daemon session is not orphaned (#7742). Connect,
    // the final-checkpoint wait, and kill all share the caller's one absolute
    // deadline, so neither a wedged handshake nor a stalled history write can burn
    // the whole teardown budget before the kill even starts. Only the waits are
    // bounded — the checkpoint itself stays deadline-free and lossless (STA-4228).
    await this.ensureConnected(opts.deadlineMs)
    // Why: sleep/exact-stop kills the live PTY before the periodic checkpoint may run.
    // Force a final snapshot so wake can restore the pane users left.
    if (opts.keepHistory) {
      const committed = await this.runExclusiveCheckpoint(
        async () => {
          await this.checkpointSessions([id], { final: true, teardown: true })
        },
        { callerDeadlineMs: opts.deadlineMs }
      )
      // Why throw instead of killing anyway: the snapshot the caller asked us to prove is still
      // being written. Killing here would race the wake-time restore source to disk, so report the
      // pty unverified and leave it alive — worktree sleep declines to commit it and retries.
      if (!committed) {
        throw new FinalCheckpointWaitExpiredError(id)
      }
      const wslDistro = this.wslDistrosBySessionId.get(id)
      const detection = await this.historyReader?.detectColdRestoreState(id, { wslDistro })
      const detected = detection?.status === 'restored' ? detection.restoreInfo : null
      const restoreInfo = detected
        ? {
            ...detected,
            cwd:
              normalizeWslColdRestoreCwd({
                recoveredCwd: detected.cwd,
                requestedCwd: this.initialCwds.get(id) ?? resolveSafePtyDefaultCwd(),
                wslDistro
              }) ?? ''
          }
        : null
      const coldRestore = restoreInfo ? this.buildColdRestorePayload(restoreInfo) : null
      if (coldRestore) {
        this.coldRestoreCache.set(id, coldRestore)
        if (this.coldRestoreCache.has(id)) {
          this.sleepRestoreSessionIds.add(id)
        }
        // Why: physical exit must not mark intentional sleep as a clean end; the final checkpoint stays the wake-time recovery authority.
        this.historyManager?.suspendSession(id)
      } else if (
        detection?.status === 'unreadable' ||
        (detection?.status === 'restored' && detection.hasUnreadableRecovery)
      ) {
        this.historyManager?.suspendSession(id)
      }
    }
    await this.client.request(
      'kill',
      { sessionId: id, immediate: opts.immediate ?? false },
      remainingRequestTimeoutMs(opts.deadlineMs)
    )
    this.activeSessionIds.delete(id)
    this.clearSessionAwaitingDaemonRecovery(id)
    this.dirtySessionVersions.delete(id)
    if (!opts.keepHistory) {
      this.coldRestoreCache.delete(id)
      this.sleepRestoreSessionIds.delete(id)
    }
    // Why: the !keepHistory path takes no final checkpoint, so clear sessionsNeedingFullCheckpoint here or it stays stranded (no-op under keepHistory).
    this.sessionsNeedingFullCheckpoint.delete(id)
    this.sessionsNeedingLiveCheckpoint.delete(id)
    this.sessionsNeedingContinuityCheckpoint.delete(id)
    this.overlayDeadlineWarnedSessionIds.delete(id)
    this.periodicDeadlineWarnedSessionIds.delete(id)
    this.nonFinalAdmissionDeniedSessionIds.delete(id)
    this.lastFullCheckpointAt.delete(id)
    this.stopCheckpointTimerIfIdle()
    this.initialCwds.delete(id)
    this.wslDistrosBySessionId.delete(id)
    // Why: only remove history on explicit close; sleep also calls shutdown but wake needs the dir intact for cold restore (opts.keepHistory).
    if (this.historyManager && !opts.keepHistory) {
      await this.historyManager
        .removeSession(id)
        .catch((err) => console.warn('[history] removeSession failed:', id, err))
    }

    // Why: the tombstone rejects reattach to a user-killed session; sleep legitimately reattaches on wake, so skip it under keepHistory.
    if (!opts.keepHistory) {
      this.killedSessionTombstones.delete(id)
      this.killedSessionTombstones.set(id, Date.now())
      if (this.killedSessionTombstones.size > MAX_TOMBSTONES) {
        const oldest = this.killedSessionTombstones.keys().next().value
        if (oldest) {
          this.killedSessionTombstones.delete(oldest)
        }
      }
    }
  }

  ackColdRestore(sessionId: string): void {
    this.coldRestoreCache.delete(sessionId)
    this.sleepRestoreSessionIds.delete(sessionId)
  }

  clearTombstone(sessionId: string): void {
    this.killedSessionTombstones.delete(sessionId)
  }

  private buildColdRestorePayload(restoreInfo: ColdRestoreInfo): ColdRestorePayload | null {
    // Why: alt-screen prefers normal scrollback, else snapshotAnsi alone — not rehydrate, which starts with \x1b[?1049h that POST_REPLAY_MODE_RESET won't undo — so a hibernated TUI's last frame isn't blank on wake.
    const scrollback = restoreInfo.modes.alternateScreen
      ? restoreInfo.scrollbackAnsi || restoreInfo.snapshotAnsi || null
      : restoreInfo.rehydrateSequences + restoreInfo.snapshotAnsi
    if (!scrollback) {
      return null
    }
    return {
      scrollback,
      cwd: restoreInfo.cwd,
      cols: restoreInfo.cols,
      rows: restoreInfo.rows,
      oscLinks: restoreInfo.oscLinks,
      ...(restoreInfo.lastTitle ? { lastTitle: restoreInfo.lastTitle } : {})
    }
  }

  async sendSignal(id: string, signal: string): Promise<void> {
    await this.client.request('signal', { sessionId: id, signal })
  }

  async getCwd(id: string): Promise<string> {
    try {
      const result = await this.client.request<{ cwd: string | null }>('getCwd', {
        sessionId: id
      })
      return result.cwd ?? ''
    } catch {
      return ''
    }
  }

  async getInitialCwd(id: string): Promise<string> {
    return this.initialCwds.get(id) ?? ''
  }

  // Why: resize() is fire-and-forget and can be dropped daemon-side; read the actually-applied size so the renderer can detect drift and re-assert.
  async getAppliedSize(id: string): Promise<{ cols: number; rows: number } | null> {
    try {
      const result = await this.client.request<{ size: { cols: number; rows: number } | null }>(
        'getSize',
        { sessionId: id }
      )
      return result.size ?? null
    } catch {
      return null
    }
  }

  async getBufferSnapshot(
    id: string,
    opts: { scrollbackRows?: number } = {}
  ): Promise<PtyProviderBufferSnapshot | null> {
    if (!this.supportsAuthoritativeBufferSnapshots) {
      return null
    }
    try {
      const scrollbackRows = normalizeDesktopTerminalSnapshotRows(opts.scrollbackRows)
      const result = await this.client.request<GetSnapshotResult>('getSnapshot', {
        sessionId: id,
        ...(scrollbackRows !== undefined ? { scrollbackRows } : {})
      })
      const snapshot = result.snapshot
      // Why: older v19 daemons lack an absolute output sequence, so their snapshot can't reconcile bytes queued on the other socket.
      if (!snapshot || typeof snapshot.outputSequence !== 'number') {
        return null
      }
      const restored =
        this.historyManager &&
        this.historyReader &&
        (scrollbackRows === undefined || scrollbackRows > DAEMON_SESSION_SCROLLBACK_ROWS)
          ? await this.overlayDurableRestoreSnapshot(id, snapshot, scrollbackRows)
          : snapshot
      return this.toProviderBufferSnapshot(restored)
    } catch {
      return null
    }
  }

  private toProviderBufferSnapshot(
    snapshot: NonNullable<GetSnapshotResult['snapshot']>
  ): PtyProviderBufferSnapshot | null {
    if (typeof snapshot.outputSequence !== 'number') {
      return null
    }
    const kittyKeyboardFlags = parseTerminalKittyKeyboardFlags(snapshot.modes.kittyKeyboardFlags)
    return {
      data: snapshot.rehydrateSequences + snapshot.snapshotAnsi,
      frameRestoreAnsi: snapshot.frameRestoreAnsi,
      scrollbackAnsi: snapshot.scrollbackAnsi,
      cols: snapshot.cols,
      rows: snapshot.rows,
      cwd: snapshot.cwd,
      lastTitle: snapshot.lastTitle,
      seq: snapshot.outputSequence,
      source: 'headless',
      oscLinks: snapshot.oscLinks,
      alternateScreen: snapshot.modes.alternateScreen,
      // Why known `0` is carried too: it proves the app negotiated nothing at
      // this boundary, which is a different fact from a source that cannot say.
      ...(kittyKeyboardFlags !== undefined ? { kittyKeyboardFlags } : {}),
      ...(snapshot.pendingEscapeTailAnsi
        ? { pendingEscapeTailAnsi: snapshot.pendingEscapeTailAnsi }
        : {})
    }
  }

  private async overlayDurableRestoreSnapshot(
    sessionId: string,
    liveSnapshot: NonNullable<GetSnapshotResult['snapshot']>,
    scrollbackRows?: number
  ): Promise<NonNullable<GetSnapshotResult['snapshot']>> {
    if (!this.historyManager || !this.historyReader) {
      return liveSnapshot
    }
    // Why turn the caller away instead of queueing: this session already has a
    // compact in flight whose result a third one would only duplicate, and an
    // unbounded queue is how a stalled history filesystem grows without limit.
    if (this.checkpointQueue.isSaturated(sessionId)) {
      return liveSnapshot
    }
    // Why reserve before enqueueing: pane mounts can arrive in one turn, before any compact starts.
    // Count abandoned waits until their writes settle so a relaunch cannot fan out unbounded work.
    if (!this.tryAdmitNonFinalCheckpoint(sessionId)) {
      return liveSnapshot
    }
    // Why per session with a deadline: a reattach is a user click, so it must wait
    // on this session's own compact and nothing else. A blown deadline does not
    // cancel that compact — it keeps running and still commits — so the fallback
    // costs restore depth for this one reattach, never durable history (STA-4173).
    return await this.checkpointQueue.runWithDeadline(
      sessionId,
      async () => {
        try {
          return await this.compactDurableRestoreSnapshot(sessionId, liveSnapshot, scrollbackRows)
        } finally {
          this.releaseNonFinalCheckpointAdmission(sessionId)
          this.overlayDeadlineWarnedSessionIds.delete(sessionId)
        }
      },
      DURABLE_HISTORY_OVERLAY_DEADLINE_MS,
      liveSnapshot,
      {
        onDeadline: () => {
          if (!this.overlayDeadlineWarnedSessionIds.has(sessionId)) {
            this.overlayDeadlineWarnedSessionIds.add(sessionId)
            console.warn('[history] durable snapshot overlay deadline exceeded:', sessionId)
          }
        }
      }
    )
  }

  private tryAdmitNonFinalCheckpoint(sessionId: string): boolean {
    if (this.nonFinalCheckpointAdmissionSessionIds.has(sessionId)) {
      if (!this.nonFinalAdmissionDeniedSessionIds.has(sessionId)) {
        this.nonFinalAdmissionDeniedSessionIds.add(sessionId)
        console.warn('[history] non-final checkpoint already in flight:', sessionId)
      }
      return false
    }
    if (this.nonFinalCheckpointAdmissionSessionIds.size >= MAX_CONCURRENT_CHECKPOINTS) {
      this.reportNonFinalGlobalAdmissionDenial(sessionId)
      return false
    }
    this.nonFinalAdmissionDeniedSessionIds.delete(sessionId)
    this.nonFinalCheckpointAdmissionSessionIds.add(sessionId)
    return true
  }

  private reportNonFinalGlobalAdmissionDenial(sessionId: string): void {
    if (!this.nonFinalGlobalAdmissionWarningActive) {
      this.nonFinalGlobalAdmissionWarningActive = true
      console.warn('[history] non-final checkpoint global admission limit reached:', sessionId)
    }
  }

  private releaseNonFinalCheckpointAdmission(sessionId: string): void {
    if (this.nonFinalCheckpointAdmissionSessionIds.delete(sessionId)) {
      this.nonFinalAdmissionDeniedSessionIds.delete(sessionId)
      this.nonFinalGlobalAdmissionWarningActive = false
    }
  }

  private async compactDurableRestoreSnapshot(
    sessionId: string,
    liveSnapshot: NonNullable<GetSnapshotResult['snapshot']>,
    scrollbackRows?: number
  ): Promise<NonNullable<GetSnapshotResult['snapshot']>> {
    if (!this.historyReader) {
      return liveSnapshot
    }
    try {
      // Why compact before reading: an independent take/append races the 5s tick, can
      // seq-gap the log, and would remount a stale checkpoint over the live window.
      const checkpoint = await this.takeSnapshotAndCheckpoint(sessionId, {
        teardown: false,
        forceLiveSnapshot: this.sessionsNeedingLiveCheckpoint.has(sessionId),
        requireContinuityProof: this.sessionsNeedingContinuityCheckpoint.has(sessionId)
      })
      if (checkpoint.checkpoint === 'committed') {
        this.sessionsNeedingFullCheckpoint.delete(sessionId)
      }
      if (checkpoint.checkpoint !== 'committed' || !checkpoint.snapshot) {
        return checkpoint.snapshot ?? liveSnapshot
      }
      if (scrollbackRows === undefined || scrollbackRows >= DAEMON_RESTORE_SCROLLBACK_ROWS) {
        return checkpoint.snapshot
      }
      const restoreInfo = await this.historyReader.detectColdRestore(sessionId, {
        ignoreCleanEnd: true,
        wslDistro: this.wslDistrosBySessionId.get(sessionId)
      })
      if (!restoreInfo) {
        return liveSnapshot
      }
      return await buildDurableCheckpointSnapshot({
        liveSnapshot: checkpoint.snapshot,
        restoreInfo,
        scrollbackRows
      })
    } catch (error) {
      console.warn('[history] durable snapshot overlay failed:', sessionId, error)
      return liveSnapshot
    }
  }

  async clearBuffer(id: string): Promise<void> {
    await this.client.request('clearScrollback', { sessionId: id })
    this.markSessionDirty(id)
  }

  acknowledgeDataEvent(_id: string, _charCount: number): void {
    // No flow control for daemon-backed terminals
  }

  // Why: daemon-backed PTYs can host long-lived agents while detached; cleanup prompts must not treat them as idle shells.
  private hasChildProcessesFromForeground(foregroundProcess: string | null): boolean {
    return foregroundProcess !== null && !isShellProcess(foregroundProcess)
  }

  async hasChildProcesses(id: string): Promise<boolean> {
    if (this.protocolVersion < GET_FOREGROUND_PROCESS_PROTOCOL_VERSION) {
      return true
    }
    return this.hasChildProcessesFromForeground(await this.getForegroundProcess(id))
  }

  async inspectProcess(id: string): Promise<PtyProcessInspection> {
    if (this.protocolVersion < GET_FOREGROUND_PROCESS_PROTOCOL_VERSION) {
      return { foregroundProcess: null, hasChildProcesses: true, unavailable: true }
    }
    if (this.protocolVersion < COMPLETION_PROCESS_INSPECTION_PROTOCOL_VERSION) {
      // Why: pre-v27 daemons survive an in-place app update; compose the inspection client-side from the
      // one call they do support instead of throwing, or completion detection stays dead until recreate.
      // Requests directly (not via getForegroundProcess) so a dead socket still rejects rather than
      // reading as an idle foreground and dispatching a false completion.
      const { foregroundProcess } = await this.client.request<{
        foregroundProcess: string | null
      }>('getForegroundProcess', { sessionId: id })
      return {
        foregroundProcess,
        hasChildProcesses: this.hasChildProcessesFromForeground(foregroundProcess)
      }
    }
    return this.client.request<{
      foregroundProcess: string | null
      hasChildProcesses: boolean
    }>('inspectProcess', { sessionId: id })
  }

  async getForegroundProcess(id: string): Promise<string | null> {
    if (this.protocolVersion < GET_FOREGROUND_PROCESS_PROTOCOL_VERSION) {
      return null
    }
    try {
      const result = await this.client.request<{ foregroundProcess: string | null }>(
        'getForegroundProcess',
        { sessionId: id }
      )
      return result.foregroundProcess
    } catch {
      return null
    }
  }

  async confirmForegroundProcess(id: string): Promise<string | null> {
    try {
      const result = await this.client.request<{ foregroundProcess: string | null }>(
        'confirmForegroundProcess',
        { sessionId: id }
      )
      return result.foregroundProcess
    } catch {
      return null
    }
  }

  async serialize(ids: string[]): Promise<string> {
    const sessions: Record<string, { initialCwd?: string }> = {}
    for (const id of ids) {
      sessions[id] = { initialCwd: this.initialCwds.get(id) }
    }
    return JSON.stringify(sessions)
  }

  async revive(_state: string): Promise<void> {
    // Sessions already live in the daemon — no revival needed
  }

  /** Called on app launch. Lists daemon sessions, kills orphans whose workspaceId
   *  no longer exists, and caches alive session IDs.
   *
   *  IMPORTANT: a session id embeds the worktree's path at spawn time, so a renamed
   *  worktree keeps its old id. Callers MUST seed `validWorktreeIds` with each live
   *  worktree's `WorktreeMeta.priorWorktreeIds` or those sessions get reaped as false
   *  orphans. No production caller yet; wire the alias in when it gains one. */
  async reconcileOnStartup(validWorktreeIds: Set<string>): Promise<{
    alive: string[]
    killed: string[]
  }> {
    await this.ensureConnected()
    const result = await this.client.request<ListSessionsResult>('listSessions', undefined)

    const alive: string[] = []
    const killed: string[] = []

    for (const session of result.sessions) {
      if (!session.isAlive) {
        continue
      }
      // Why: an unminted session id (worktreeId === null) can't be tied to a live worktree, so it's treated as an orphan.
      const { worktreeId } = parsePtySessionId(session.sessionId)

      if (worktreeId === null || !validWorktreeIds.has(worktreeId)) {
        try {
          await this.client.request('kill', { sessionId: session.sessionId })
        } catch {
          /* already dead */
        }
        killed.push(session.sessionId)
      } else {
        alive.push(session.sessionId)
        // Why: track background sessions in the checkpoint set so disconnectOnly's final checkpoint doesn't leave stale recovery data.
        this.activeSessionIds.add(session.sessionId)
        await this.reconcileLiveSessionHistory(session).catch((err) =>
          console.warn('[history] live-session reconciliation failed:', session.sessionId, err)
        )
      }
    }

    return { alive, killed }
  }

  private async reconcileLiveSessionHistory(session: SessionInfo): Promise<void> {
    const historyManager = this.historyManager
    const historyReader = this.historyReader
    if (!historyManager || !historyReader) {
      return
    }
    await this.withHistorySpawnLock(session.sessionId, async () => {
      if (historyManager.hasWriter(session.sessionId)) {
        return
      }
      const probe = historyReader.probeRestorableHistory(session.sessionId)
      if (probe.status === 'unreadable') {
        return
      }
      if (probe.status === 'none') {
        await historyManager.openSession(session.sessionId, {
          cwd: session.cwd ?? '',
          cols: session.cols,
          rows: session.rows
        })
      } else {
        const recoveryFreeze = await historyManager.freezeForRecovery(session.sessionId)
        try {
          const detection = await historyReader.detectColdRestoreState(session.sessionId, {
            wslDistro: session.wslDistro ?? undefined
          })
          if (
            detection.status === 'unreadable' ||
            (detection.status === 'restored' && detection.hasUnreadableRecovery)
          ) {
            historyManager.suspendSession(session.sessionId, recoveryFreeze)
            return
          }
          historyManager.reopenSession(session.sessionId, recoveryFreeze)
        } finally {
          historyManager.abandonRecoveryFreeze(recoveryFreeze)
        }
      }
      if (historyManager.hasWriter(session.sessionId)) {
        this.sessionsNeedingFullCheckpoint.add(session.sessionId)
        this.sessionsNeedingContinuityCheckpoint.add(session.sessionId)
        this.lastFullCheckpointAt.delete(session.sessionId)
        this.markSessionDirty(session.sessionId)
      }
    })
  }

  async listProcesses(opts?: { deadlineMs?: number }): Promise<PtyProcessInfo[]> {
    // Why: snapshotted before the request so ids spawned mid-flight can never
    // be reconciled away below.
    const preRequestActiveIds = new Set(this.activeSessionIds)
    try {
      // Why: connect + listSessions share the caller's one absolute deadline so a
      // wedged handshake cannot burn the whole teardown budget before the list issues.
      await this.ensureConnected(opts?.deadlineMs)
      const result = await this.client.request<ListSessionsResult>(
        'listSessions',
        undefined,
        remainingRequestTimeoutMs(opts?.deadlineMs)
      )
      const admission = new PtyProcessListAdmission()
      const processes: PtyProcessInfo[] = []
      const aliveSessionIds = new Set<string>()
      for (const session of result.sessions) {
        if (!session.isAlive) {
          continue
        }
        aliveSessionIds.add(session.sessionId)
        const { worktreeId } = parsePtySessionId(session.sessionId)
        processes.push(
          admission.admit({
            id: session.sessionId,
            ...(session.incarnationId ? { incarnationId: session.incarnationId } : {}),
            // Why: OSC 7 may not arrive before cleanup; spawn cwd is authoritative until the daemon reports a live cwd.
            cwd: session.cwd ?? this.initialCwds.get(session.sessionId) ?? '',
            title: 'shell',
            ...(worktreeId ? { worktreeId } : {}),
            ...(session.terminalHandle ? { terminalHandle: session.terminalHandle } : {}),
            ...(session.wslDistro !== undefined ? { wslDistro: session.wslDistro } : {}),
            ...this.validatedAgentSessionOwners(session.agentSessionOwners)
          })
        )
      }
      // Why: hasPty reads activeSessionIds, and an exit missed while the socket
      // was disconnected otherwise survives an authoritative inventory forever —
      // defeating every absence proof built on the cache.
      for (const id of preRequestActiveIds) {
        if (!aliveSessionIds.has(id)) {
          this.activeSessionIds.delete(id)
        }
      }
      this.publishAuditObservation(
        recordAuthenticatedInventory(this.auditContext, this.exactDaemonIncarnation)
      )
      return processes
    } catch (error) {
      const missingAuthenticatedToken = this.isRetiredEndpointTokenMissing()
      const missingNamedPipe = isMissingWindowsNamedPipeError(error)
      this.observeAuditFailure(
        missingAuthenticatedToken
          ? 'token_missing_after_authenticated_disconnect'
          : 'inventory_failed',
        this.exactDaemonIncarnation,
        [
          ...(missingAuthenticatedToken ? (['token_file'] as const) : []),
          ...(missingNamedPipe ? (['windows_named_pipe'] as const) : [])
        ],
        missingNamedPipe ? 'windows_named_pipe_missing' : undefined
      )
      throw error
    }
  }

  private validatedAgentSessionOwners(
    owners: unknown
  ): { agentSessionOwners: AgentSessionOwnerBinding[] } | Record<string, never> {
    if (owners === undefined) {
      return {}
    }
    if (
      !Array.isArray(owners) ||
      owners.length > MAX_CLAIMED_AGENT_PTY_OWNER_ENTRIES ||
      !owners.every((owner) => isAgentSessionOwnerBinding(owner) && owner.phase === 'live')
    ) {
      throw new Error('agent_session_ownership_unknown')
    }
    return owners.length > 0
      ? { agentSessionOwners: owners.map(cloneAgentSessionOwnerBinding) }
      : {}
  }

  // Why: the Manage Sessions panel needs the full SessionInfo (pid, state,
  // createdAt) per session for display; listProcesses drops that detail for
  // the IPtyProvider contract. Keep both in parallel rather than widening
  // the provider surface.
  async listSessions(): Promise<SessionInfo[]> {
    await this.ensureConnected()
    const result = await this.client.request<ListSessionsResult>('listSessions', undefined)
    return result.sessions
      .filter((s) => s.isAlive)
      .map((session) => ({
        ...session,
        ...this.validatedAgentSessionOwners(session.agentSessionOwners)
      }))
  }

  getActiveSessionIds(): string[] {
    return [...this.activeSessionIds]
  }

  // Why: the daemon's kill-all-and-shutdown path suppresses onExit fanout (session.ts:246-252), so synthesize pty:exit
  // for every live session before teardown or renderer panes black-hole writes to a disposed adapter forever.
  fanoutSyntheticExits(code: number): void {
    const ids = [...this.activeSessionIds]
    this.activeSessionIds.clear()
    this.sessionsAwaitingDaemonRecovery.clear()
    this.writeRecoveryAttempted = false
    this.dirtySessionVersions.clear()
    this.lastFullCheckpointAt.clear()
    this.sessionsNeedingFullCheckpoint.clear()
    this.sessionsNeedingLiveCheckpoint.clear()
    this.sessionsNeedingContinuityCheckpoint.clear()
    this.overlayDeadlineWarnedSessionIds.clear()
    this.periodicDeadlineWarnedSessionIds.clear()
    this.nonFinalAdmissionDeniedSessionIds.clear()
    this.pausedProducerSessionIds.clear()
    this.producerResumesOwedOnReconnect.clear()
    this.stopCheckpointTimer()
    for (const id of ids) {
      this.coldRestoreCache.delete(id)
      // Why: don't catch listener throws — matches the natural onExit fanout so synthetic exits keep the same error semantics.
      // oxlint-disable-next-line unicorn/no-useless-spread -- copy-safe: listeners may unsubscribe during iteration
      for (const listener of [...this.exitListeners]) {
        listener({
          id,
          code,
          ...(this.sessionIncarnations.get(id)
            ? { incarnationId: this.sessionIncarnations.get(id) }
            : {})
        })
      }
      this.sessionIncarnations.delete(id)
    }
  }

  async getDefaultShell(): Promise<string> {
    if (process.platform === 'win32') {
      return process.env.COMSPEC || 'powershell.exe'
    }
    return process.env.SHELL || '/bin/zsh'
  }

  async getProfiles(): Promise<{ name: string; path: string }[]> {
    if (process.platform === 'win32') {
      return [
        { name: 'PowerShell', path: 'powershell.exe' },
        { name: 'Command Prompt', path: 'cmd.exe' }
      ]
    }
    const shells = ['/bin/zsh', '/bin/bash', '/bin/sh']
    return shells.filter((s) => existsSync(s)).map((s) => ({ name: basename(s), path: s }))
  }

  onData(
    callback: (payload: {
      id: string
      data: string
      sequenceChars?: number
      transformed?: boolean
      seq?: number
    }) => void
  ): () => void {
    this.dataListeners.push(callback)
    return () => {
      const idx = this.dataListeners.indexOf(callback)
      if (idx !== -1) {
        this.dataListeners.splice(idx, 1)
      }
    }
  }

  onBackgroundStreamEvent(callback: (payload: PtyBackgroundStreamEvent) => void): () => void {
    this.backgroundStreamListeners.push(callback)
    return () => {
      const idx = this.backgroundStreamListeners.indexOf(callback)
      if (idx !== -1) {
        this.backgroundStreamListeners.splice(idx, 1)
      }
    }
  }

  onReplay(_callback: (payload: { id: string; data: string }) => void): () => void {
    return () => {}
  }

  onExit(
    callback: (payload: { id: string; code: number; incarnationId?: PtyIncarnationId }) => void
  ): () => void {
    this.exitListeners.push(callback)
    return () => {
      const idx = this.exitListeners.indexOf(callback)
      if (idx !== -1) {
        this.exitListeners.splice(idx, 1)
      }
    }
  }

  onWriteUnavailable(callback: (payload: { id: string }) => void): () => void {
    this.writeUnavailableListeners.push(callback)
    return () => {
      const idx = this.writeUnavailableListeners.indexOf(callback)
      if (idx !== -1) {
        this.writeUnavailableListeners.splice(idx, 1)
      }
    }
  }

  private emitWriteUnavailable(id: string): void {
    // oxlint-disable-next-line unicorn/no-useless-spread -- copy-safe: listeners may unsubscribe during iteration
    for (const listener of [...this.writeUnavailableListeners]) {
      listener({ id })
    }
  }

  dispose(): void {
    this.respawnAdoptionClosed = true
    this.sessionsAwaitingDaemonRecovery.clear()
    this.writeRecoveryAttempted = false
    this.releasePendingRespawnAdoptionLease()
    this.stopCheckpointTimer()
    this.dirtySessionVersions.clear()
    this.lastFullCheckpointAt.clear()
    this.sessionsNeedingFullCheckpoint.clear()
    this.sessionsNeedingLiveCheckpoint.clear()
    this.sessionsNeedingContinuityCheckpoint.clear()
    this.overlayDeadlineWarnedSessionIds.clear()
    this.periodicDeadlineWarnedSessionIds.clear()
    this.nonFinalAdmissionDeniedSessionIds.clear()
    this.coldRestoreCache.clear()
    this.wslDistrosBySessionId.clear()
    this.pausedProducerSessionIds.clear()
    this.producerResumesOwedOnReconnect.clear()
    this.auditObservationListeners.length = 0
    this.identityChangeListeners.length = 0
    this.removeEventListener?.()
    this.removeEventListener = null
    // Why: final checkpoints are written daemon-side (TerminalHost.dispose); here the adapter only marks sessions
    // cleanly ended so they don't trigger false cold restores.
    if (this.historyManager) {
      void this.historyManager
        .dispose()
        .catch((err) => console.warn('[history] dispose failed:', err))
    }
    this.client.disconnect()
  }

  async establishLifecycleLease(): Promise<void> {
    if (this.protocolVersion < CLEAN_DISCONNECT_PROTOCOL_VERSION) {
      return
    }
    // Why: an authenticated pair cancels the adoption watchdog and lets a never-used adapter retire its empty daemon on quit.
    await this.client.ensureConnected()
    this.recordAuthenticatedIdentity()
  }

  // Why: unlike dispose(), leave history files unclean (no endedAt) so the next launch treats them as crash-recoverable,
  // but still write a final checkpoint so a daemon crash while Orca is closed has recovery data.
  async disconnectOnly(): Promise<void> {
    if (!this.disconnectOnlyPromise) {
      this.respawnAdoptionClosed = true
      this.sessionsAwaitingDaemonRecovery.clear()
      this.writeRecoveryAttempted = false
      this.releasePendingRespawnAdoptionLease()
      this.disconnectOnlyPromise = this.finishDisconnectOnly([...this.keepHistoryShutdowns])
    }
    await this.disconnectOnlyPromise
  }

  private async finishDisconnectOnly(keepHistoryShutdowns: Promise<void>[]): Promise<void> {
    // Why: sleep shutdowns still detect recovery and kill after checkpointing; disconnecting first rejects those admitted operations.
    await Promise.allSettled(keepHistoryShutdowns)
    this.respawnAdoptionClosed = true
    // Why: a final checkpoint covers sessions opened since the last tick (else cold restore finds nothing if the daemon
    // later dies). Await it — fire-and-forget would race client.disconnect() and reject the pending getSnapshot RPCs.
    await this.runExclusiveCheckpoint(() => this.checkpointAllSessions(), {
      rescheduleDirty: false
    })
    this.dirtySessionVersions.clear()
    this.lastFullCheckpointAt.clear()
    this.coldRestoreCache.clear()
    this.wslDistrosBySessionId.clear()
    // Why: the detached daemon keeps these PTYs alive for warm reattach; a leftover pause would stall shells for a failsafe window.
    for (const id of this.pausedProducerSessionIds) {
      this.client.notify('resumePty', { sessionId: id })
    }
    this.pausedProducerSessionIds.clear()
    this.producerResumesOwedOnReconnect.clear()
    this.removeEventListener?.()
    this.removeEventListener = null
    if (this.protocolVersion >= CLEAN_DISCONNECT_PROTOCOL_VERSION) {
      try {
        // Why: only the authenticated daemon can atomically prove it's empty; a shared budget keeps this off quit's critical path.
        const deadlineMs = Date.now() + 250
        if (!this.client.isConnected()) {
          await this.client.ensureConnectedWithin(Math.max(1, deadlineMs - Date.now()))
        }
        await this.client.request('shutdownIfIdle', undefined, Math.max(1, deadlineMs - Date.now()))
      } catch {
        // An unreachable daemon falls back to event-driven retirement once its auth sockets close and it proves itself empty.
      }
    }
    this.client.disconnect()
  }

  private async ensureConnected(deadlineMs?: number): Promise<void> {
    try {
      // Why: destructive teardown bounds the handshake by its deadline so a wedged
      // connect fails fast; undefined keeps the default connect behavior.
      await (deadlineMs !== undefined
        ? this.client.ensureConnectedWithin(Math.max(1, deadlineMs - Date.now()))
        : this.client.ensureConnected())
    } finally {
      // Why: a respawn launcher holds a temporary pair until this adapter's permanent reconnect, preventing both gaps and leaks.
      this.releasePendingRespawnAdoptionLease()
    }
    this.recordAuthenticatedIdentity()
    // Why sampled before setupEventRouting: "no listener yet" identifies a fresh connect — the only time the
    // daemon-side backgrounded set (process state lost with the old daemon) needs a resync.
    const isFreshConnection = this.removeEventListener === null
    this.setupEventRouting()
    this.scheduleCheckpointTimer()
    this.flushOwedProducerResumes()
    if (isFreshConnection) {
      this.resyncBackgroundedSessions()
    }
  }

  private recordAuthenticatedIdentity(): void {
    const current = this.client.getDaemonIdentity()
    if (!current) {
      return
    }
    const previous = this.lastAuthenticatedIdentity
    if (previous && sameEndpointIdentity(previous, current)) {
      return
    }
    this.lastAuthenticatedIdentity = { ...current }
    this.exactDaemonIncarnation = exactDaemonIncarnationForPidRecord(current, this.pidRecord)
    if (!previous) {
      return
    }
    const event = { previous: { ...previous }, current: { ...current } }
    notifyAuditListeners(this.identityChangeListeners, event)
  }

  private async resolveExactDaemonIncarnation(
    exactIncarnation: ExactDaemonIncarnation | null
  ): Promise<ExactDaemonIncarnation | null> {
    if (
      !exactIncarnation ||
      process.platform !== 'linux' ||
      (exactIncarnation.linuxStartTicks && exactIncarnation.bootId)
    ) {
      return exactIncarnation
    }
    const cachedIncarnation = exactDaemonIncarnationForPidRecord(
      exactIncarnation.identity,
      this.pidRecord
    )
    if (cachedIncarnation.linuxStartTicks && cachedIncarnation.bootId) {
      return cachedIncarnation
    }
    const pidRecord = await this.readMatchingPidRecord(exactIncarnation.identity)
    this.pidRecord = pidRecord ?? this.pidRecord
    return pidRecord?.linuxStartTicks && pidRecord.bootId
      ? {
          identity: { ...exactIncarnation.identity },
          linuxStartTicks: pidRecord.linuxStartTicks,
          bootId: pidRecord.bootId
        }
      : exactIncarnation
  }

  private cacheExactDaemonIncarnation(exactIncarnation: ExactDaemonIncarnation | null): void {
    if (
      exactIncarnation &&
      this.lastAuthenticatedIdentity &&
      sameEndpointIdentity(exactIncarnation.identity, this.lastAuthenticatedIdentity)
    ) {
      this.exactDaemonIncarnation = exactIncarnation
    }
  }

  private async readMatchingPidRecord(
    identity: DaemonEndpointIdentity
  ): Promise<ParsedDaemonPid | null> {
    if (!this.pidPath) {
      return null
    }
    try {
      const parsed = parseDaemonPidFile(await readFile(this.pidPath, 'utf8'))
      return parsed?.pid === identity.pid &&
        parsed.startedAtMs === identity.startedAtMs &&
        parsed.launchNonce === identity.launchNonce
        ? parsed
        : null
    } catch {
      return null
    }
  }

  private observeAuditFailure(
    trigger: Exclude<DaemonAuditTrigger, 'inventory_answered'>,
    exactIncarnation = this.exactDaemonIncarnation,
    additionalEvidenceSources: readonly DaemonEvidenceSource[] = [],
    endpointGoneProof?: 'windows_named_pipe_missing'
  ): void {
    void this.resolveExactDaemonIncarnation(exactIncarnation)
      .then((resolvedIncarnation) => {
        this.cacheExactDaemonIncarnation(resolvedIncarnation)
        return classifyDaemonAuditFailure(this.auditContext, trigger, resolvedIncarnation, {
          additionalEvidenceSources,
          endpointGoneProof
        })
      })
      .then((observation) => this.publishAuditObservation(observation))
      .catch(() => {})
  }

  private publishAuditObservation(observation: DaemonAuditObservation): void {
    this.lastAuditObservation = observation
    this.trackAuditEligibility(observation)
    notifyAuditListeners(this.auditObservationListeners, observation)
  }

  private resyncBackgroundedSessions(): void {
    for (const id of this.backgroundedSessionIds) {
      // Harmless no-op for sessions the daemon doesn't know (yet).
      this.client.notify('setSessionBackground', { sessionId: id, background: true })
    }
  }

  private flushOwedProducerResumes(): void {
    if (this.producerResumesOwedOnReconnect.size === 0) {
      return
    }
    for (const id of this.producerResumesOwedOnReconnect) {
      // Why: resuming an unknown session is a harmless no-op; leaving a survivor paused would waste 5s of failsafe latency.
      this.client.notify('resumePty', { sessionId: id })
    }
    this.producerResumesOwedOnReconnect.clear()
  }

  private stopCheckpointTimer(): void {
    if (!this.checkpointTimer) {
      return
    }
    clearTimeout(this.checkpointTimer)
    this.checkpointTimer = null
  }

  private stopCheckpointTimerIfIdle(): void {
    if (this.dirtySessionVersions.size === 0) {
      this.stopCheckpointTimer()
    }
  }

  private scheduleCheckpointTimer(): void {
    if (
      this.checkpointTimer ||
      !this.historyManager ||
      !this.supportsCheckpoints ||
      this.dirtySessionVersions.size === 0
    ) {
      return
    }
    // Why: dirty-gate the timer — a permanent 5s interval woke the main process for idle terminals with nothing to write.
    this.checkpointTimer = setTimeout(() => {
      this.checkpointTimer = null
      // Why: don't overlap checkpoint passes — concurrent tmp-file writes can lose a rename and disable future history writes.
      if (this.checkpointInFlight) {
        this.scheduleCheckpointTimer()
        return
      }
      const checkpoint = this.checkpointDirtySessions()
      this.checkpointInFlight = checkpoint
      void checkpoint
        .finally(() => {
          if (this.checkpointInFlight === checkpoint) {
            this.checkpointInFlight = null
            this.scheduleCheckpointTimer()
          }
        })
        // Why: .finally() re-throws, so a rejected checkpoint would surface as an unhandled rejection here.
        .catch(() => {})
    }, DaemonPtyAdapter.CHECKPOINT_INTERVAL_MS)
  }

  private markSessionDirty(sessionId: string): void {
    if (!this.activeSessionIds.has(sessionId)) {
      return
    }
    this.dirtySessionVersions.set(sessionId, (this.dirtySessionVersions.get(sessionId) ?? 0) + 1)
    this.scheduleCheckpointTimer()
  }

  private async checkpointDirtySessions(): Promise<void> {
    if (!this.historyManager || this.dirtySessionVersions.size === 0) {
      return
    }
    // Why: dirty-version filtering avoids re-serializing every idle session every 5s (CPU/disk on large workspaces)
    // while not dropping writes that arrive mid-checkpoint.
    const versions = new Map(
      [...this.dirtySessionVersions].filter(([sessionId]) => this.activeSessionIds.has(sessionId))
    )
    if (versions.size === 0) {
      this.dirtySessionVersions.clear()
      this.stopCheckpointTimer()
      return
    }
    const completed = await this.checkpointSessions(versions.keys())
    for (const [sessionId, version] of versions) {
      if (completed.has(sessionId) && this.dirtySessionVersions.get(sessionId) === version) {
        this.dirtySessionVersions.delete(sessionId)
      }
    }
    this.stopCheckpointTimerIfIdle()
  }

  /** False only when `callerDeadlineMs` expired first; the checkpoint itself keeps running. */
  private async runExclusiveCheckpoint(
    operation: () => Promise<void>,
    options: { rescheduleDirty?: boolean; callerDeadlineMs?: number } = {}
  ): Promise<boolean> {
    this.stopCheckpointTimer()
    // Why: a promise tail keeps every waiter ordered; awaiting one active operation lets sibling waiters resume together.
    const previous = this.checkpointInFlight ?? Promise.resolve()
    const checkpoint = previous.catch(() => {}).then(operation)
    this.checkpointInFlight = checkpoint
    // Why the release rides the checkpoint instead of the caller's await: a caller that walks away
    // at its deadline must leave this checkpoint as the tail, so the durable write still runs to
    // completion, still commits, and the next waiter still queues behind it (STA-4228).
    const settled = checkpoint.then(
      () => this.releaseExclusiveCheckpoint(checkpoint, options.rescheduleDirty),
      (err: unknown) => {
        this.releaseExclusiveCheckpoint(checkpoint, options.rescheduleDirty)
        throw err
      }
    )
    if (options.callerDeadlineMs === undefined) {
      await settled
      return true
    }
    return await awaitWithinCallerDeadline(settled, options.callerDeadlineMs)
  }

  private releaseExclusiveCheckpoint(
    checkpoint: Promise<void>,
    rescheduleDirty: boolean | undefined
  ): void {
    if (this.checkpointInFlight === checkpoint) {
      this.checkpointInFlight = null
    }
    this.stopCheckpointTimer()
    if (rescheduleDirty !== false) {
      this.scheduleCheckpointTimer()
    }
  }

  // Why final=true not teardown: clean disconnect needs the full daemon-window snapshot as the restore source, but the
  // detached daemon's PTYs keep running for warm reattach, so shell-ready scanner state must stay intact.
  private async checkpointAllSessions(): Promise<void> {
    const completed = await this.checkpointSessions(this.activeSessionIds, { final: true })
    for (const sessionId of completed) {
      this.dirtySessionVersions.delete(sessionId)
    }
  }

  private async checkpointSessions(
    sessionIds: Iterable<string>,
    opts?: { final?: boolean; teardown?: boolean }
  ): Promise<Set<string>> {
    const completed = new Set<string>()
    if (!this.historyManager) {
      return completed
    }
    const ids = Array.from(sessionIds)
    let nextIndex = 0

    const checkpointNext = async (): Promise<void> => {
      for (;;) {
        // No worker in this pass awaits abandoned work, so a full admission set cannot open here.
        if (
          opts?.final !== true &&
          this.nonFinalCheckpointAdmissionSessionIds.size >= MAX_CONCURRENT_CHECKPOINTS
        ) {
          const deferredSessionId = ids[nextIndex]
          if (deferredSessionId !== undefined) {
            this.reportNonFinalGlobalAdmissionDenial(deferredSessionId)
          }
          return
        }
        const index = nextIndex
        nextIndex++
        if (index >= ids.length) {
          return
        }
        const sessionId = ids[index]
        await this.checkpointSession(sessionId, {
          final: opts?.final === true,
          teardown: opts?.teardown === true
        })
          .then((result) => {
            // Why: deferred sessions stay dirty so the checkpoint timer keeps retrying until their full-snapshot cooldown expires.
            if (result === 'done') {
              completed.add(sessionId)
            }
          })
          .catch((err) => console.warn('[history] checkpoint failed:', sessionId, err))
      }
    }
    // Why: snapshot/checkpoint writes are CPU/disk heavy; cap prevents one tick snapshotting every dirty terminal at once.
    const workers = Array.from({ length: Math.min(MAX_CONCURRENT_CHECKPOINTS, ids.length) }, () =>
      checkpointNext()
    )
    await Promise.all(workers)
    return completed
  }

  // Why cooldown starts only after the first full snapshot: a checkpoint-less session must be able to write one immediately.
  private isFullCheckpointCoolingDown(sessionId: string): boolean {
    const last = this.lastFullCheckpointAt.get(sessionId)
    if (last === undefined) {
      return false
    }
    const elapsed = Date.now() - last
    // Why elapsed < 0 counts as expired: a backward wall-clock jump must not extend the deferral window.
    return elapsed >= 0 && elapsed < DaemonPtyAdapter.FULL_CHECKPOINT_COOLDOWN_MS
  }

  private async checkpointSession(
    sessionId: string,
    opts: { final: boolean; teardown: boolean }
  ): Promise<'done' | 'deferred'> {
    // Why final waits without a deadline: sleep/disconnect needs the last snapshot on disk, and
    // deferring there would silently drop what the user left on screen rather than delay it.
    if (opts.final) {
      return await this.checkpointQueue.run(sessionId, () =>
        this.writeSessionCheckpoint(sessionId, opts)
      )
    }
    // Why 'deferred' is safe: the session stays dirty, so the operation that beat us to the queue
    // still commits and the next tick retries this one. Nothing on disk is discarded.
    if (
      this.checkpointQueue.isSaturated(sessionId) ||
      !this.tryAdmitNonFinalCheckpoint(sessionId)
    ) {
      return 'deferred'
    }
    const run = async (): Promise<'done' | 'deferred'> => {
      try {
        return await this.writeSessionCheckpoint(sessionId, opts)
      } finally {
        this.releaseNonFinalCheckpointAdmission(sessionId)
        this.periodicDeadlineWarnedSessionIds.delete(sessionId)
      }
    }
    return await this.checkpointQueue.runWithDeadline(
      sessionId,
      run,
      DaemonPtyAdapter.PERIODIC_CHECKPOINT_DEADLINE_MS,
      'deferred',
      {
        onDeadline: () => {
          if (!this.periodicDeadlineWarnedSessionIds.has(sessionId)) {
            this.periodicDeadlineWarnedSessionIds.add(sessionId)
            console.warn('[history] periodic checkpoint deadline exceeded:', sessionId)
          }
        },
        onAbandonedRejection: (error) => {
          console.warn('[history] checkpoint failed:', sessionId, error)
        }
      }
    )
  }

  // Why 'deferred' exists: a full snapshot inside the cooldown is postponed and the session stays dirty for retry;
  // skipping append meanwhile keeps the on-disk log a consistent (stale) prefix instead of punching a hole.
  private async writeSessionCheckpoint(
    sessionId: string,
    opts: { final: boolean; teardown: boolean }
  ): Promise<'done' | 'deferred'> {
    if (!this.supportsIncrementalCheckpoints) {
      const result = await this.client.request<GetSnapshotResult>('getSnapshot', { sessionId })
      if (result.snapshot && this.historyManager) {
        const checkpoint = await this.historyManager.checkpoint(sessionId, result.snapshot)
        return checkpoint === 'retryable' ? 'deferred' : 'done'
      }
      return 'done'
    }
    if (opts.final || this.sessionsNeedingFullCheckpoint.has(sessionId)) {
      if (!opts.final && this.isFullCheckpointCoolingDown(sessionId)) {
        return 'deferred'
      }
      // Why take-with-snapshot not plain getSnapshot: it clears pending records in the same turn as the serialize,
      // so a warm reattach won't re-append records the checkpoint already contains (double-replay on cold restore).
      const checkpoint = await this.takeSnapshotAndCheckpoint(sessionId, {
        teardown: opts.teardown,
        forceLiveSnapshot: this.sessionsNeedingLiveCheckpoint.has(sessionId),
        requireContinuityProof: this.sessionsNeedingContinuityCheckpoint.has(sessionId)
      })
      if (checkpoint.checkpoint === 'retryable') {
        this.sessionsNeedingFullCheckpoint.add(sessionId)
        return 'deferred'
      }
      this.sessionsNeedingFullCheckpoint.delete(sessionId)
      this.sessionsNeedingLiveCheckpoint.delete(sessionId)
      this.sessionsNeedingContinuityCheckpoint.delete(sessionId)
      return 'done'
    }
    const take = await this.client.request<TakePendingOutputResult | null>('takePendingOutput', {
      sessionId
    })
    if (!take) {
      return 'done'
    }
    if (take.overflowed) {
      // Why: overflow dropped records (log has a hole); only a full snapshot can re-anchor it.
      if (this.isFullCheckpointCoolingDown(sessionId)) {
        this.sessionsNeedingFullCheckpoint.add(sessionId)
        return 'deferred'
      }
      const checkpoint = await this.takeSnapshotAndCheckpoint(sessionId, {
        teardown: false,
        forceLiveSnapshot: true
      })
      if (checkpoint.checkpoint === 'retryable') {
        this.sessionsNeedingFullCheckpoint.add(sessionId)
        return 'deferred'
      }
      return 'done'
    }
    if (take.records.length === 0) {
      return 'done'
    }
    if (!this.historyManager) {
      return 'done'
    }
    const appendResult = await this.historyManager.appendIncrements(
      sessionId,
      take.seq,
      take.records
    )
    if (appendResult === 'needs-checkpoint') {
      // Why dropping take.records is lossless: applied to the emulator before the take, so the snapshot below contains them.
      if (this.isFullCheckpointCoolingDown(sessionId)) {
        this.sessionsNeedingFullCheckpoint.add(sessionId)
        return 'deferred'
      }
      const checkpoint = await this.takeSnapshotAndCheckpoint(sessionId, {
        teardown: false,
        forceLiveSnapshot: true
      })
      if (checkpoint.checkpoint === 'retryable') {
        this.sessionsNeedingFullCheckpoint.add(sessionId)
        return 'deferred'
      }
    }
    return 'done'
  }

  private async takeSnapshotAndCheckpoint(
    sessionId: string,
    opts: {
      teardown: boolean
      forceLiveSnapshot?: boolean
      requireContinuityProof?: boolean
    }
  ): Promise<SnapshotCheckpointResult> {
    const take = await this.client.request<TakePendingOutputResult | null>('takePendingOutput', {
      sessionId,
      includeSnapshot: true,
      teardownSnapshot: opts.teardown
    })
    if (take?.snapshot && this.historyManager) {
      // Why require drainedRecords: an older daemon still empties the pending
      // queue on includeSnapshot but omits the field. Treating absence as []
      // would compact stale disk history and reset the log.
      const snapshot =
        take.drainedRecords === undefined || opts.forceLiveSnapshot === true || take.overflowed
          ? take.snapshot
          : await this.buildDurableHistorySnapshot(
              sessionId,
              take.snapshot,
              [...take.drainedRecords, ...take.records],
              {
                pendingRecordsAreComplete: take.seq === 1,
                ...(opts.requireContinuityProof === true
                  ? { requiredPreviousPendingOutputSeq: take.seq - 1 }
                  : {})
              }
            )
      const checkpoint = await this.historyManager.checkpoint(sessionId, snapshot, {
        pendingOutputSeq: take.seq
      })
      if (checkpoint === 'retryable') {
        // Why take.records is dropped, not appended: the pending output this take drained went into the snapshot that
        // failed to land, so appending the held tail at the next contiguous seq would splice it over that hole and
        // defeat the log's seq-gap detection. A stale prefix beats an undetectable hole.
        this.sessionsNeedingFullCheckpoint.add(sessionId)
        this.sessionsNeedingLiveCheckpoint.add(sessionId)
        this.sessionsNeedingContinuityCheckpoint.delete(sessionId)
        this.markSessionDirty(sessionId)
        return { checkpoint, snapshot: take.snapshot }
      }
      if (checkpoint === 'unavailable') {
        this.sessionsNeedingFullCheckpoint.delete(sessionId)
        this.sessionsNeedingLiveCheckpoint.delete(sessionId)
        this.sessionsNeedingContinuityCheckpoint.delete(sessionId)
        return { checkpoint, snapshot: take.snapshot }
      }
      this.lastFullCheckpointAt.set(sessionId, Date.now())
      if (take.records.length > 0 && snapshot === take.snapshot) {
        // Why: live-window fallback still lacks held parser-state bytes; keep them as a post-checkpoint log tail.
        await this.historyManager.appendIncrements(sessionId, take.seq, take.records)
      }
      this.sessionsNeedingLiveCheckpoint.delete(sessionId)
      this.sessionsNeedingContinuityCheckpoint.delete(sessionId)
      return { checkpoint: 'committed', snapshot }
    }
    this.sessionsNeedingFullCheckpoint.delete(sessionId)
    this.sessionsNeedingLiveCheckpoint.delete(sessionId)
    this.sessionsNeedingContinuityCheckpoint.delete(sessionId)
    return { checkpoint: 'unavailable', snapshot: take?.snapshot ?? null }
  }

  private async buildDurableHistorySnapshot(
    sessionId: string,
    liveSnapshot: NonNullable<TakePendingOutputResult['snapshot']>,
    pendingRecords: TakePendingOutputResult['records'],
    opts: {
      pendingRecordsAreComplete: boolean
      requiredPreviousPendingOutputSeq?: number
    }
  ): Promise<NonNullable<TakePendingOutputResult['snapshot']>> {
    if (!this.historyReader) {
      return liveSnapshot
    }
    try {
      const restoreInfo = await this.historyReader.detectColdRestore(sessionId, {
        ignoreCleanEnd: true,
        wslDistro: this.wslDistrosBySessionId.get(sessionId)
      })
      if (
        (!restoreInfo && !opts.pendingRecordsAreComplete) ||
        (opts.requiredPreviousPendingOutputSeq !== undefined &&
          restoreInfo?.pendingOutputSeq !== opts.requiredPreviousPendingOutputSeq)
      ) {
        console.warn('[history] durable continuity unproven; using live snapshot:', sessionId)
        return liveSnapshot
      }
      return await buildDurableCheckpointSnapshot({
        liveSnapshot,
        restoreInfo,
        pendingRecords
      })
    } catch (error) {
      console.warn('[history] durable history rebuild failed:', sessionId, error)
      return liveSnapshot
    }
  }

  // Why: the token read no longer throws, so audit its absence directly after an authenticated drop.
  private isRetiredEndpointTokenMissing(): boolean {
    return this.client.hasObservedAuthenticatedDisconnect() && !existsSync(this.tokenPath)
  }

  private async withDaemonRetry<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (err) {
      const missingRetiredEndpointToken = this.isRetiredEndpointTokenMissing()
      if (missingRetiredEndpointToken) {
        this.observeAuditFailure(
          'token_missing_after_authenticated_disconnect',
          this.exactDaemonIncarnation,
          ['token_file']
        )
      }
      if (this.respawnAdoptionClosed || !this.respawnFn || !isDaemonGoneError(err)) {
        throw err
      }
      if (!this.respawnPromise) {
        this.respawnPromise = this.doRespawn().finally(() => {
          this.respawnPromise = null
        })
      }
      await this.respawnPromise
      try {
        return await fn()
      } finally {
        // Why: the retried op may reject before any connection attempt (e.g. a tombstone racing respawn).
        this.releasePendingRespawnAdoptionLease()
      }
    }
  }

  private reconnectAfterWriteFailure(): void {
    if (
      this.writeRecoveryPromise ||
      this.writeRecoveryAttempted ||
      this.respawnAdoptionClosed ||
      !this.respawnFn
    ) {
      return
    }
    this.writeRecoveryAttempted = true
    // Why: the dead endpoint took down every session on this daemon. Signal all
    // active panes now — while they are still in activeSessionIds, so the
    // renderer's liveness gate still reads them live — so background panes
    // remount + re-attach alongside the one that was written, instead of being
    // left frozen with silently dropped input until each is typed into.
    this.notifyActiveSessionsWriteUnavailable()
    const recovery = this.withDaemonRetry(() => this.ensureConnected())
      .catch((error) => console.warn('[daemon] Failed to recover after rejected PTY input:', error))
      .finally(() => {
        this.releasePendingRespawnAdoptionLease()
        if (this.writeRecoveryPromise === recovery) {
          this.writeRecoveryPromise = null
        }
      })
    this.writeRecoveryPromise = recovery
  }

  private notifyActiveSessionsWriteUnavailable(): void {
    // Snapshot first: a listener that kills a pane would mutate activeSessionIds
    // mid-iteration and silently skip the sibling this fan-out exists to reach.
    const ids = [...this.activeSessionIds]
    for (const id of ids) {
      this.sessionsAwaitingDaemonRecovery.add(id)
      this.emitWriteUnavailable(id)
    }
  }

  private clearSessionAwaitingDaemonRecovery(sessionId: string): void {
    this.sessionsAwaitingDaemonRecovery.delete(sessionId)
    if (this.sessionsAwaitingDaemonRecovery.size === 0) {
      this.writeRecoveryAttempted = false
    }
  }

  private async withHistorySpawnLock<T>(
    sessionId: string,
    operation: () => Promise<T>
  ): Promise<T> {
    if (!this.historyManager) {
      return await operation()
    }
    const previous = this.historySpawnLocks.get(sessionId) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = previous.then(
      () => current,
      () => current
    )
    this.historySpawnLocks.set(sessionId, tail)
    await previous.catch(() => {})
    try {
      return await operation()
    } finally {
      release()
      if (this.historySpawnLocks.get(sessionId) === tail) {
        this.historySpawnLocks.delete(sessionId)
      }
    }
  }

  private async replaceUnhealthyMacResolverDaemonBeforeNewPty(): Promise<void> {
    if (!this.respawnFn) {
      return
    }

    const health = await getMacDaemonSystemResolverHealth(
      this.socketPath,
      this.tokenPath,
      this.protocolVersion
    )
    if (health !== 'unhealthy') {
      return
    }

    const daemonLiveSessionCount = await this.getDaemonLiveSessionCount()
    const liveSessionCount = Math.max(this.activeSessionIds.size, daemonLiveSessionCount ?? 0)
    if (daemonLiveSessionCount === null || liveSessionCount > 0) {
      console.warn(
        daemonLiveSessionCount === null
          ? '[daemon] macOS system resolver unavailable - preserving daemon because live session state could not be verified'
          : `[daemon] macOS system resolver unavailable - preserving daemon because it owns ${liveSessionCount} live session${liveSessionCount === 1 ? '' : 's'}`
      )
      return
    }

    // Why: replacing the daemon kills its sessions without exit fanout; emit exits first so panes don't write to dead PTYs.
    this.fanoutSyntheticExits(-1)
    if (!this.respawnPromise) {
      this.respawnPromise = this.doRespawn(
        '[daemon] macOS system resolver unavailable - respawning daemon',
        'unhealthy_resolver'
      ).finally(() => {
        this.respawnPromise = null
      })
    }
    await this.respawnPromise
  }

  /** Replace a stale packaged daemon only after its live sessions drain. */
  private async replaceStaleBundleDaemonBeforeNewPty(): Promise<void> {
    if (!this.respawnFn || !this.runtimeDir || !this.packagedAppVersion) {
      return
    }
    if (!this.staleBundleReplacementPromise) {
      this.staleBundleReplacementPromise = this.replaceStaleBundleDaemonOnce(
        this.runtimeDir,
        this.packagedAppVersion
      ).finally(() => {
        this.staleBundleReplacementPromise = null
      })
    }
    await this.staleBundleReplacementPromise
  }

  private async replaceStaleBundleDaemonOnce(
    runtimeDir: string,
    packagedAppVersion: string
  ): Promise<void> {
    const stale = await isDaemonStaleForCurrentBundle(
      runtimeDir,
      this.socketPath,
      this.tokenPath,
      packagedAppVersion,
      this.protocolVersion
    )
    if (!stale) {
      return
    }

    const daemonLiveSessionCount = await this.getDaemonLiveSessionCount()
    const liveSessionCount = Math.max(this.activeSessionIds.size, daemonLiveSessionCount ?? 0)
    if (daemonLiveSessionCount === null || liveSessionCount > 0) {
      console.warn(
        daemonLiveSessionCount === null
          ? '[daemon] Packaged daemon is stale - preserving it because live session state could not be verified'
          : `[daemon] Packaged daemon is stale - preserving it because it owns ${liveSessionCount} live session${liveSessionCount === 1 ? '' : 's'}`
      )
      return
    }

    this.fanoutSyntheticExits(-1)
    if (!this.respawnPromise) {
      this.respawnPromise = this.doRespawn(
        '[daemon] Packaged daemon is stale - respawning from the current app bundle',
        'stale_bundle'
      ).finally(() => {
        this.respawnPromise = null
      })
    }
    await this.respawnPromise
  }

  /** Replace a TCC-severed daemon only after its live sessions drain. */
  private async replaceSeveredMacTccDaemonBeforeNewPty(): Promise<void> {
    // Why no platform gate: getMacDaemonTccAttributionHealth returns 'unknown' off macOS.
    if (!this.respawnFn || !this.runtimeDir) {
      return
    }

    const health = await getMacDaemonTccAttributionHealth(
      this.runtimeDir,
      this.socketPath,
      this.tokenPath,
      this.protocolVersion
    )
    if (health !== 'severed') {
      return
    }

    const daemonLiveSessionCount = await this.getDaemonLiveSessionCount()
    const liveSessionCount = Math.max(this.activeSessionIds.size, daemonLiveSessionCount ?? 0)
    if (daemonLiveSessionCount === null || liveSessionCount > 0) {
      console.warn(
        daemonLiveSessionCount === null
          ? '[daemon] macOS TCC attribution severed - preserving daemon because live session state could not be verified'
          : `[daemon] macOS TCC attribution severed - preserving daemon because it owns ${liveSessionCount} live session${liveSessionCount === 1 ? '' : 's'}; restart from Manage Sessions when ready`
      )
      return
    }

    this.fanoutSyntheticExits(-1)
    if (!this.respawnPromise) {
      this.respawnPromise = this.doRespawn(
        '[daemon] macOS TCC attribution severed - respawning daemon under the current app binary',
        'severed_tcc_attribution'
      ).finally(() => {
        this.respawnPromise = null
      })
    }
    await this.respawnPromise
  }

  private async getDaemonLiveSessionCount(): Promise<number | null> {
    try {
      await this.client.ensureConnected()
      const result = await this.client.request<ListSessionsResult>('listSessions', undefined)
      return result.sessions.filter((session) => session.isAlive).length
    } catch {
      return null
    }
  }

  private emitBackgroundStreamEvent(payload: PtyBackgroundStreamEvent): void {
    // oxlint-disable-next-line unicorn/no-useless-spread -- copy-safe: listeners may unsubscribe during iteration
    for (const listener of [...this.backgroundStreamListeners]) {
      listener(payload)
    }
  }

  private async doRespawn(
    message = '[daemon] Daemon died — respawning',
    reason: DaemonRespawnReason = 'daemon_died'
  ): Promise<void> {
    console.warn(message)
    this.removeEventListener?.()
    this.removeEventListener = null
    this.client.disconnect()
    const releaseAdoptionLease = await this.respawnFn!(reason)
    if (this.respawnAdoptionClosed) {
      // Why: app teardown may win mid-respawn; a late result must not reinstall a lease nobody owns.
      releaseAdoptionLease?.()
      throw new Error('Daemon adapter closed during respawn')
    }
    this.pendingRespawnAdoptionRelease = releaseAdoptionLease ?? null
  }

  private releasePendingRespawnAdoptionLease(): void {
    const release = this.pendingRespawnAdoptionRelease
    this.pendingRespawnAdoptionRelease = null
    release?.()
  }

  private setupEventRouting(): void {
    if (this.removeEventListener) {
      return
    }

    this.removeEventListener = this.client.onEvent((raw) => {
      const event = raw as DaemonEvent
      if (event.type !== 'event') {
        return
      }

      if (event.event === 'data') {
        this.markSessionDirty(event.sessionId)
        // oxlint-disable-next-line unicorn/no-useless-spread -- copy-safe: listeners may unsubscribe during iteration
        for (const listener of [...this.dataListeners]) {
          listener({
            id: event.sessionId,
            data: event.payload.data,
            ...((event.payload.rawLength ?? event.payload.sequenceChars) === undefined
              ? {}
              : { sequenceChars: event.payload.rawLength ?? event.payload.sequenceChars }),
            ...(event.payload.transformed ? { transformed: true } : {}),
            ...(event.payload.seq === undefined ? {} : { seq: event.payload.seq })
          })
        }
      } else if (event.event === 'sessionBackgroundMarker') {
        this.emitBackgroundStreamEvent({
          id: event.sessionId,
          kind: 'backgroundMarker',
          background: event.payload.background,
          ...(event.payload.scanSeedAnsi !== undefined
            ? { scanSeedAnsi: event.payload.scanSeedAnsi }
            : {}),
          ...(event.payload.mode2031PendingSubscribe
            ? { mode2031PendingSubscribe: true as const }
            : {})
        })
      } else if (event.event === 'dataGap') {
        this.emitBackgroundStreamEvent({
          id: event.sessionId,
          kind: 'dataGap',
          droppedChars: event.payload.droppedChars,
          ...(event.payload.sequenceChars === undefined
            ? {}
            : { sequenceChars: event.payload.sequenceChars })
        })
      } else if (event.event === 'transientFact') {
        // Why (#9993): belt-and-braces behind the setPtyBackgrounded gate. A pre-v29
        // daemon is never asked to background, so it should emit no transient facts at
        // all — but one preserved across a reconnect could still have a stale relay
        // tracker. An unretractable subscribe is the harmful direction, so drop it.
        // An unsubscribe is always forwarded: retiring a subscription main registered
        // can only ever help, never strand one.
        if (
          event.payload.kind === '2031-subscribe' &&
          !supportsMode2031UnsubscribeFact(this.protocolVersion)
        ) {
          return
        }
        this.emitBackgroundStreamEvent({
          id: event.sessionId,
          kind: 'transientFact',
          fact: event.payload
        })
      } else if (event.event === 'exit') {
        const pendingOperations = new Set([
          ...(this.pendingSpawnOperationsBySessionId.get(event.sessionId) ?? []),
          ...this.pendingClaimSpawnOperations
        ])
        for (const operation of pendingOperations) {
          if (operation.ignoreNextExit) {
            operation.ignoreNextExit = false
            continue
          }
          const exits = operation.exitsBySessionId.get(event.sessionId) ?? []
          exits.push(
            event.payload.incarnationId ? { incarnationId: event.payload.incarnationId } : {}
          )
          operation.exitsBySessionId.set(event.sessionId, exits)
        }
        const currentIncarnationId = this.sessionIncarnations.get(event.sessionId)
        if (
          event.payload.incarnationId &&
          currentIncarnationId &&
          event.payload.incarnationId !== currentIncarnationId
        ) {
          return
        }
        this.activeSessionIds.delete(event.sessionId)
        this.clearSessionAwaitingDaemonRecovery(event.sessionId)
        this.dirtySessionVersions.delete(event.sessionId)
        // Why: a reused sessionId must not inherit the dead session's owed resume (stray resumePty) or backgrounded/thinned state.
        this.pausedProducerSessionIds.delete(event.sessionId)
        this.producerResumesOwedOnReconnect.delete(event.sessionId)
        this.backgroundedSessionIds.delete(event.sessionId)
        if (!this.sleepRestoreSessionIds.has(event.sessionId)) {
          this.coldRestoreCache.delete(event.sessionId)
        }
        // Why: an exited session can't be checkpointed again; clearing its pending-full flag prevents a permanent leak.
        this.sessionsNeedingFullCheckpoint.delete(event.sessionId)
        this.sessionsNeedingLiveCheckpoint.delete(event.sessionId)
        this.sessionsNeedingContinuityCheckpoint.delete(event.sessionId)
        this.overlayDeadlineWarnedSessionIds.delete(event.sessionId)
        this.periodicDeadlineWarnedSessionIds.delete(event.sessionId)
        this.nonFinalAdmissionDeniedSessionIds.delete(event.sessionId)
        // Why: a reused sessionId (renderer respawns a persisted ptyId) must not inherit the dead session's snapshot cooldown.
        this.lastFullCheckpointAt.delete(event.sessionId)
        this.stopCheckpointTimerIfIdle()
        if (this.historyManager) {
          void this.historyManager
            .closeSession(event.sessionId, event.payload.code)
            .catch((err) => console.warn('[history] closeSession failed:', event.sessionId, err))
        }
        this.initialCwds.delete(event.sessionId)
        this.wslDistrosBySessionId.delete(event.sessionId)
        this.sessionIncarnations.delete(event.sessionId)
        // oxlint-disable-next-line unicorn/no-useless-spread -- copy-safe: listeners may unsubscribe during iteration
        for (const listener of [...this.exitListeners]) {
          listener({
            id: event.sessionId,
            code: event.payload.code,
            ...(event.payload.incarnationId ? { incarnationId: event.payload.incarnationId } : {}),
            ...(event.payload.cause ? { cause: event.payload.cause } : {})
          })
        }
      }
    })
  }

  async closeStartupQueryAuthority(id: string): Promise<number> {
    if (!this.supportsStartupIngress) {
      return 0
    }
    const result = await this.client.request<{ appliedSeq: number }>('closeStartupQueryAuthority', {
      sessionId: id
    })
    return result.appliedSeq
  }
}

function sameEndpointIdentity(
  left: DaemonEndpointIdentity,
  right: DaemonEndpointIdentity
): boolean {
  return (
    left.pid === right.pid &&
    left.startedAtMs === right.startedAtMs &&
    left.launchNonce === right.launchNonce
  )
}

function exactDaemonIncarnationForPidRecord(
  identity: DaemonEndpointIdentity,
  pidRecord: ParsedDaemonPid | null
): ExactDaemonIncarnation {
  return {
    identity: { ...identity },
    ...(process.platform === 'linux' &&
    pidRecord?.pid === identity.pid &&
    pidRecord.startedAtMs === identity.startedAtMs &&
    pidRecord.launchNonce === identity.launchNonce &&
    pidRecord.linuxStartTicks &&
    pidRecord.bootId
      ? {
          linuxStartTicks: pidRecord.linuxStartTicks,
          bootId: pidRecord.bootId
        }
      : {})
  }
}

function readDaemonPidRecord(pidPath: string | null): ParsedDaemonPid | null {
  if (!pidPath) {
    return null
  }
  try {
    return parseDaemonPidFile(readFileSync(pidPath, 'utf8'))
  } catch {
    return null
  }
}

function removeListener<T>(listeners: T[], listener: T): void {
  const index = listeners.indexOf(listener)
  if (index !== -1) {
    listeners.splice(index, 1)
  }
}

function notifyAuditListeners<T>(listeners: readonly ((value: T) => void)[], value: T): void {
  for (const listener of listeners.slice()) {
    try {
      listener(value)
    } catch {
      // Audit observers cannot affect daemon operations.
    }
  }
}

/**
 * Narrow on purpose: only the daemon's own reply for a request type it does not implement.
 * A transient failure must stay unproven rather than be mistaken for a missing capability.
 * The server throws `Unknown request type: <type>`; the client rejects with that text, which
 * `addNodePtyRecoveryHint` only ever prepends to.
 */
function isUnknownRequestTypeError(err: unknown): boolean {
  return err instanceof Error && err.message.includes('Unknown request type')
}

// Why: syscall='connect' distinguishes a dead-socket ENOENT/ECONNREFUSED from token-file ENOENT (no syscall);
// message strings incl. wedged-daemon "Hello response timed out" (#8689) also warrant a respawn.
/** Exported so a test can pin it against the server's refusal wording, which it must match. */
export function isDaemonGoneError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false
  }
  const errno = err as NodeJS.ErrnoException
  if ((errno.code === 'ENOENT' || errno.code === 'ECONNREFUSED') && errno.syscall === 'connect') {
    return true
  }
  const msg = err.message
  return (
    msg === 'Connection lost' ||
    msg === 'Not connected' ||
    msg === 'Hello response timed out' ||
    // Both the daemon's own drain refusal and the client's wedged-daemon signal.
    msg === DAEMON_UNAVAILABLE_RECONNECT_MESSAGE ||
    // Why retry: the daemon refused because the endpoint now resolves elsewhere. Reconnecting
    // reaches whoever owns it; surfacing this to the user would strand the request instead.
    msg === DAEMON_ENDPOINT_LOST_MESSAGE
  )
}

function isMissingWindowsNamedPipeError(err: unknown): boolean {
  if (process.platform !== 'win32' || !(err instanceof Error)) {
    return false
  }
  const errno = err as NodeJS.ErrnoException
  return errno.code === 'ENOENT' && errno.syscall === 'connect'
}
