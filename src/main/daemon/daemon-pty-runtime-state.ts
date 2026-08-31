import { DaemonClient } from './client'
import { createDaemonAuditEligibilityTracker } from './daemon-audit-eligibility-event'
import type {
  DaemonAuditContext,
  DaemonAuditObservation,
  DaemonAuditTrigger
} from './daemon-audit-classifier'
import { CheckpointSessionQueue } from './daemon-checkpoint-session-queue'
import {
  GIT_CREDENTIAL_GUARD_HOST_PROTOCOL_VERSION,
  SNAPSHOT_SERIALIZER_FIDELITY_DAEMON_PROTOCOL_VERSION,
  WORKER_AUTHORITY_ISOLATION_DAEMON_PROTOCOL_VERSION
} from './daemon-protocol-version'
import type { DaemonEndpointIdentity } from './daemon-hello-protocol'
import type { DaemonEvidenceSource, ExactDaemonIncarnation } from './daemon-incarnation-evidence'
import { readDaemonPidRecord } from './daemon-endpoint-incarnation'
import { removeDaemonListener } from './daemon-listener-registry'
import type { ParsedDaemonPid } from './daemon-pid-file-parse'
import {
  AGENT_SESSION_CLAIM_DAEMON_PROTOCOL_VERSION,
  AGENT_SESSION_CREATE_OPERATION_DAEMON_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  supportsMode2031UnsubscribeFact,
  supportsPtyStartupIngress,
  type TakePendingOutputResult
} from './types'
import { ColdRestorePayloadCache } from './cold-restore-payload-cache'
import {
  HistoryManager,
  type HistoryCheckpointResult,
  type HistoryRecoveryFreeze
} from './history-manager'
import { HistoryReader } from './history-reader'
import type { PtyBackgroundStreamEvent } from '../providers/types'
import type { PtyIncarnationId } from '../../shared/pty-incarnation'
import type { TerminalExitCause } from '../../shared/terminal-exit-cause'
import type { TuiAgent } from '../../shared/tui-agent'

export type PendingDaemonSpawnOperation = {
  exitsBySessionId: Map<string, { incarnationId?: string }[]>
  ignoredExitIncarnationIds: Set<string>
  ignoreNextExit: boolean
}

export type HistoryRecoveryContext = {
  freeze: HistoryRecoveryFreeze | null
  unreadableSessionId: string | null
  identityChanged: boolean
}

export type SnapshotCheckpointResult = {
  checkpoint: HistoryCheckpointResult
  snapshot: NonNullable<TakePendingOutputResult['snapshot']> | null
}

export type DaemonPtyAdapterOptions = {
  socketPath: string
  tokenPath: string
  pidPath?: string
  profileScope?: string
  protocolVersion?: number
  historyPath?: string
  runtimeDir?: string
  packagedAppVersion?: string | null
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

export abstract class DaemonPtyRuntimeState {
  readonly protocolVersion: number
  protected socketPath: string
  protected tokenPath: string
  protected pidPath: string | null
  protected pidRecord: ParsedDaemonPid | null
  protected client: DaemonClient
  protected auditContext: DaemonAuditContext
  protected lastAuthenticatedIdentity: DaemonEndpointIdentity | null = null
  protected exactDaemonIncarnation: ExactDaemonIncarnation | null = null
  protected lastAuditObservation: DaemonAuditObservation | null = null
  protected readonly trackAuditEligibility = createDaemonAuditEligibilityTracker()
  protected auditObservationListeners: ((observation: DaemonAuditObservation) => void)[] = []
  protected identityChangeListeners: ((event: DaemonIdentityChangeEvent) => void)[] = []
  protected historyManager: HistoryManager | null
  protected historyReader: HistoryReader | null
  protected respawnFn: DaemonPtyAdapterOptions['respawn'] | null
  protected runtimeDir: string | null
  protected packagedAppVersion: string | null
  protected pendingRespawnAdoptionRelease: (() => void) | null = null
  protected respawnAdoptionClosed = false
  protected respawnPromise: Promise<void> | null = null
  protected staleBundleReplacementPromise: Promise<void> | null = null
  protected writeRecoveryPromise: Promise<void> | null = null
  protected writeRecoveryAttempted = false
  protected dataListeners: ((payload: {
    id: string
    data: string
    sequenceChars?: number
    transformed?: boolean
    seq?: number
  }) => void)[] = []
  protected exitListeners: ((payload: {
    id: string
    code: number
    incarnationId?: PtyIncarnationId
    cause?: TerminalExitCause
  }) => void)[] = []
  protected backgroundStreamListeners: ((payload: PtyBackgroundStreamEvent) => void)[] = []
  protected writeUnavailableListeners: ((payload: { id: string }) => void)[] = []
  protected removeEventListener: (() => void) | null = null
  protected initialCwds = new Map<string, string>()
  protected wslDistrosBySessionId = new Map<string, string>()
  protected killedSessionTombstones = new Map<string, number>()
  protected sleepRestoreSessionIds = new Set<string>()
  protected coldRestoreCache = new ColdRestorePayloadCache(undefined, (sessionId) => {
    this.sleepRestoreSessionIds.delete(sessionId)
  })
  protected activeSessionIds = new Set<string>()
  protected getSizeUnsupported = false
  protected sessionsAwaitingDaemonRecovery = new Set<string>()
  protected sessionIncarnations = new Map<string, string>()
  protected pendingSpawnOperationsBySessionId = new Map<string, Set<PendingDaemonSpawnOperation>>()
  protected pendingClaimSpawnOperations = new Set<PendingDaemonSpawnOperation>()
  protected historySpawnLocks = new Map<string, Promise<void>>()
  protected dirtySessionVersions = new Map<string, number>()
  protected sessionsNeedingFullCheckpoint = new Set<string>()
  protected sessionsNeedingLiveCheckpoint = new Set<string>()
  protected sessionsNeedingContinuityCheckpoint = new Set<string>()
  protected checkpointTimer: ReturnType<typeof setTimeout> | null = null
  protected checkpointInFlight: Promise<void> | null = null
  protected checkpointQueue = new CheckpointSessionQueue()
  protected nonFinalCheckpointAdmissionSessionIds = new Set<string>()
  protected nonFinalAdmissionDeniedSessionIds = new Set<string>()
  protected nonFinalGlobalAdmissionWarningActive = false
  protected overlayDeadlineWarnedSessionIds = new Set<string>()
  protected periodicDeadlineWarnedSessionIds = new Set<string>()
  protected keepHistoryShutdowns = new Set<Promise<void>>()
  protected disconnectOnlyPromise: Promise<void> | null = null
  protected supportsCheckpoints: boolean
  protected supportsIncrementalCheckpoints: boolean
  protected supportsProducerFlowControl: boolean
  protected supportsAuthoritativeBufferSnapshots: boolean
  protected supportsStartupIngress: boolean
  protected pausedProducerSessionIds = new Set<string>()
  protected backgroundedSessionIds = new Set<string>()
  protected producerResumesOwedOnReconnect = new Set<string>()
  protected static CHECKPOINT_INTERVAL_MS = 5_000
  protected static PERIODIC_CHECKPOINT_DEADLINE_MS = 15_000
  protected static MAX_CONCURRENT_CHECKPOINTS = 4
  protected static FULL_CHECKPOINT_COOLDOWN_MS = 45_000
  protected lastFullCheckpointAt = new Map<string, number>()

  protected abstract observeAuditFailure(
    trigger: Exclude<DaemonAuditTrigger, 'inventory_answered'>,
    exactIncarnation?: ExactDaemonIncarnation | null,
    additionalEvidenceSources?: readonly DaemonEvidenceSource[],
    endpointGoneProof?: 'windows_named_pipe_missing'
  ): void

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

  supportsGitCredentialGuardHost(): boolean {
    return this.protocolVersion >= GIT_CREDENTIAL_GUARD_HOST_PROTOCOL_VERSION
  }

  supportsWorkerAuthorityIsolation(agent: TuiAgent): boolean {
    return (
      agent === 'codex' &&
      process.platform === 'darwin' &&
      this.protocolVersion >= WORKER_AUTHORITY_ISOLATION_DAEMON_PROTOCOL_VERSION
    )
  }

  canProvideAuthoritativeBufferSnapshot(_id: string): boolean {
    return this.supportsAuthoritativeBufferSnapshots
  }

  protected get canDelegateBackgroundToDaemon(): boolean {
    return (
      this.supportsAuthoritativeBufferSnapshots &&
      supportsMode2031UnsubscribeFact(this.protocolVersion)
    )
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
    return () => removeDaemonListener(this.identityChangeListeners, listener)
  }

  onAuditEligibilityObservation(
    listener: (observation: DaemonAuditObservation) => void
  ): () => void {
    this.auditObservationListeners.push(listener)
    return () => removeDaemonListener(this.auditObservationListeners, listener)
  }

  supportsAgentSessionClaims(): boolean {
    return this.protocolVersion >= AGENT_SESSION_CLAIM_DAEMON_PROTOCOL_VERSION
  }

  providesAgentSessionOwnerListings(_ptyId: string): boolean {
    return this.supportsAgentSessionClaims()
  }

  supportsAgentSessionCreateOperations(): boolean {
    return this.protocolVersion >= AGENT_SESSION_CREATE_OPERATION_DAEMON_PROTOCOL_VERSION
  }
}
