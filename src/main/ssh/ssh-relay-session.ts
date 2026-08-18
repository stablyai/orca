/* oxlint-disable max-lines */
// Why: single authority for all relay lifecycle state per SSH target (previously scattered across module Maps/Sets with duplicated paths).

import { randomUUID } from 'node:crypto'
import type { BrowserWindow } from 'electron'
import { deployAndLaunchRelay } from './ssh-relay-deploy'
import { execCommand } from './ssh-relay-deploy-helpers'
import { isRelayVersionMismatchError } from './ssh-relay-version-mismatch-error'
import { SshChannelMultiplexer } from './ssh-channel-multiplexer'
import { SshPtyProvider } from '../providers/ssh-pty-provider'
import type { SshPtyAttachResult } from '../providers/ssh-pty-session-reattach'
import type { SshPtyDataCallback, SshPtyExitCallback } from '../providers/ssh-pty-provider-contract'
import type { SshPtyRecoveryActivationLease } from '../providers/ssh-pty-notification-routing'
import { isSshPtyIdentityMismatchError, isSshPtyNotFoundError } from '../providers/ssh-pty-errors'
import { toAppSshPtyId, toRelaySshPtyId } from '../providers/ssh-pty-id'
import { SshFilesystemProvider } from '../providers/ssh-filesystem-provider'
import { isMethodNotFoundError } from './ssh-filesystem-stream-reader'
import { SshGitProvider } from '../providers/ssh-git-provider'
import { agentHookServer } from '../agent-hooks/server'
import { isAgentStatusHooksEnabled } from '../agent-hooks/managed-agent-hook-controls'
import {
  buildManagedHookDetectionCommands,
  detectedManagedHookAgents
} from '../agent-hooks/managed-hook-detection-commands'
import {
  AGENT_HOOK_INSTALL_MANAGED_HOOKS_METHOD,
  AGENT_HOOK_INSTALL_PLUGINS_METHOD,
  AGENT_HOOK_NOTIFICATION_METHOD,
  AGENT_HOOK_REQUEST_REPLAY_METHOD,
  isRemoteAgentHooksEnabled
} from '../../shared/agent-hook-relay'
import { _internals as openCodeInternals } from '../opencode/hook-service'
import { getPiAgentStatusExtensionSource } from '../pi/agent-status-extension-source'
import {
  registerSshPtyProvider,
  unregisterSshPtyProvider,
  getSshPtyProvider,
  getPtyIdsForConnection,
  clearPtyOwnershipForConnection,
  clearProviderPtyState,
  deletePtyOwnership,
  setPtyOwnership,
  restorePtyIncarnation,
  isCurrentPtyExit
} from '../ipc/pty'
import {
  acceptSshPtyOutputData,
  acceptSshPtyOutputExit,
  allocateSshPtyProviderGeneration,
  applySshPtySourceCancellationProof,
  applySshPtySourceRecoveryCancellationProof,
  beginSshPtyOutputGenerationMigration,
  closeSshPtyOutputGeneration,
  getSshPtyAcceptedSourceCheckpoints,
  installSshPtySourceAckPublisher,
  installSshPtySourceCancellationPublisher
} from '../ipc/ssh-pty-output-intake-registry'
import {
  registerSshFilesystemProvider,
  unregisterSshFilesystemProvider,
  getSshFilesystemProvider
} from '../providers/ssh-filesystem-dispatch'
import { registerSshGitProvider, unregisterSshGitProvider } from '../providers/ssh-git-dispatch'
import { notifyRemoteWorkspaceHandlers } from '../ipc/remote-workspace-events'
import { PortScanner } from './ssh-port-scanner'
import { isMainWindowVisible, onMainWindowBecameVisible } from '../window/main-window-visibility'
import type { SshPortForwardManager } from './ssh-port-forward'
import type { SshConnection } from './ssh-connection'
import { joinRemotePath, isWindowsRemoteHost, type RemoteHostPlatform } from './ssh-remote-platform'
import { makeRemoteDirectoryCommand } from './ssh-remote-commands'
import { createRemoteCliInstallPlan } from './ssh-remote-cli-launcher'
import {
  DEFAULT_SSH_RELAY_GRACE_PERIOD_SECONDS,
  type DetectedPort,
  MAX_SSH_RELAY_GRACE_PERIOD_SECONDS,
  MIN_SSH_RELAY_GRACE_PERIOD_SECONDS,
  SSH_RELAY_CONFIGURE_GRACE_TIME_METHOD
} from '../../shared/ssh-types'
import { normalizeRemoteArtifactInput } from '../../shared/artifact-cli-bridge'
import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { DEFAULT_PTY_SOURCE_WINDOW_SU } from '../../shared/pty-source-credit-contract'
import { PTY_CONSUMER_STALE_OWNER_RECOVERY_ERROR } from '../../shared/pty-consumer-session'
import {
  isSshOwnerAdmissionBlocked,
  retrySshOwnerRecoveryWhileBlocked
} from './ssh-owner-recovery-retry'
import {
  isSshOwnerAdmissionBlockedError,
  SshOwnerAdmissionBlockedError
} from './ssh-owner-admission-blocked-error'
import { runRemoteOrcaCli } from './ssh-remote-orca-cli'
import {
  acknowledgeRemoteOrcaCliPostOutput,
  parseRemoteOrcaCliPostOutput
} from './ssh-remote-orchestration-post-output'
import { toSshExecutionHostId, type ExecutionHostId } from '../../shared/execution-host'
import {
  SSH_AI_VAULT_LIST_SESSIONS_METHOD,
  SSH_AI_VAULT_LIST_SESSIONS_TIMEOUT_MS,
  SSH_AI_VAULT_RESOLVE_SESSION_TITLES_METHOD,
  SSH_AI_VAULT_RESOLVE_SESSION_TITLES_TIMEOUT_MS,
  type SshAiVaultRelayListParams,
  type SshAiVaultRelayTitleParams
} from '../../shared/ssh-ai-vault-relay'
import { isTerminalLeafId, makePaneKey } from '../../shared/stable-pane-id'
import { isValidTerminalTabId } from '../../shared/terminal-tab-id'
import {
  openSshPtyConsumerSession,
  type OpenSshPtyConsumerSessionOptions,
  type SshPtyConsumerAdmission,
  type SshPtyConsumerOwnerState,
  type SshPtyConsumerSessionState
} from './ssh-pty-consumer-session'
import type {
  PtySourceRecoveryComplete,
  PtySourceRecoveryPending,
  PtySourceRecoveryRequest
} from '../../shared/pty-source-recovery-contract'
import { SshPtyRecoveryRetentionBudget } from './ssh-pty-recovery-retention-budget'
import { SshPtyRetiredSourceDeliveries } from './ssh-pty-retired-source-deliveries'
import {
  claimSshPtyConsumerRecovery,
  detachSshPtyConsumerRecovery,
  forgetSshPtyConsumerRecovery,
  getSshPtyConsumerRecovery,
  rememberSshPtyConsumerRecovery
} from './ssh-pty-consumer-recovery'
import { classifySshPtyFrameRejection, SshPtyFrameRejectionLog } from './ssh-pty-frame-rejection'
import { SshPtyTargetedReattachQueue } from './ssh-pty-targeted-reattach-queue'

export type RelaySessionState = 'idle' | 'deploying' | 'ready' | 'reconnecting' | 'disposed'

type SshPtyExitPayload = Parameters<SshPtyExitCallback>[0]
type SshPtyDataPayload = Parameters<SshPtyDataCallback>[0]
type SshPtyLease = ReturnType<Store['getSshRemotePtyLeases']>[number]
const SSH_PTY_REATTACH_MAX_CONCURRENCY = 8
const SSH_PTY_REATTACH_ATTEMPT_TIMEOUT_MS = 10_000
const SSH_PTY_REATTACH_RETRY_MIN_DELAY_MS = 50
const SSH_PTY_REATTACH_RETRY_JITTER_MS = 200
const SSH_REJECTED_PTY_RECOVERY_MAX_ATTEMPTS = 2
// Why a second ceiling: the consecutive budget resets whenever a reattach succeeds, so a PTY that
// alternates recovered and rejected frames would otherwise reattach forever — each one costs a
// store read, an attach round trip and a store write.
const SSH_REJECTED_PTY_RECOVERY_MAX_GENERATION_ATTEMPTS = 12
const SSH_REJECTED_PTY_RECOVERY_RETRY_DELAY_MS = 150
const SSH_SOURCE_RECOVERY_CANCELLATION_FAILED = 'ssh_source_recovery_cancellation_failed'

// Why: superseded attempts stop quietly; a dead mux still owned by this attempt must enter recovery.
function verifyRelayAttempt(
  mux: SshChannelMultiplexer,
  isAttemptCurrent: () => boolean,
  phase: string
): boolean {
  if (!isAttemptCurrent()) {
    return false
  }
  if (mux.isDisposed()) {
    throw new Error(`Relay connection lost during ${phase}`)
  }
  return true
}

type PendingPtyReattach = {
  mux: SshChannelMultiplexer
  providerGeneration: number
  retentionKey: string
  exits: SshPtyExitPayload[]
  queuedData: SshPtyDataPayload[]
  recoveryData: SshPtyDataPayload[]
  liveData: SshPtyDataPayload[]
  recovery?: PtySourceRecoveryPending
  recoveryComplete?: PtySourceRecoveryComplete
  nextRecoverySourceSu?: number
  highestRecoverySourceEndSu?: number
  replacementDeliveryToken?: string
  restoreRequired?: string
  recoveryWaiters: Set<() => void>
  livePassthrough: boolean
  activated: boolean
}

type RemoteCliBridgeEnv = {
  remoteHome: string
  binDir: string
  relayDir: string
  nodePath: string
  sockPath: string
  credentialFile?: string
  hostPlatform: RemoteHostPlatform
  pathDelimiter?: ':' | ';'
}

type ExpectedPtyIdentity = { paneKey?: string; tabId?: string }
type TargetedDeliveryRecovery = 'confirm-existing' | 'fresh-activation'

function expectedIdentityForLease(lease: {
  tabId?: string
  leafId?: string
}): ExpectedPtyIdentity | null {
  if (typeof lease.tabId !== 'string' || lease.tabId.length === 0) {
    return null
  }
  const paneKey =
    isValidTerminalTabId(lease.tabId) &&
    typeof lease.leafId === 'string' &&
    isTerminalLeafId(lease.leafId)
      ? makePaneKey(lease.tabId, lease.leafId)
      : undefined
  return {
    ...(paneKey ? { paneKey } : {}),
    tabId: lease.tabId
  }
}

function parseRecoveryComplete(params: Record<string, unknown>): PtySourceRecoveryComplete | null {
  if (
    typeof params.id !== 'string' ||
    typeof params.deliveryToken !== 'string' ||
    params.deliveryToken.length === 0 ||
    typeof params.ptyIncarnation !== 'string' ||
    params.ptyIncarnation.length === 0 ||
    !positiveSafeInteger(params.clientGeneration) ||
    !positiveSafeInteger(params.ownerGeneration) ||
    !nonNegativeSafeInteger(params.checkpointSourceEndSu) ||
    !nonNegativeSafeInteger(params.recoveryEndSu) ||
    Number(params.recoveryEndSu) < Number(params.checkpointSourceEndSu)
  ) {
    return null
  }
  return Object.freeze({
    id: params.id,
    deliveryToken: params.deliveryToken,
    ptyIncarnation: params.ptyIncarnation,
    clientGeneration: Number(params.clientGeneration),
    ownerGeneration: Number(params.ownerGeneration),
    checkpointSourceEndSu: Number(params.checkpointSourceEndSu),
    recoveryEndSu: Number(params.recoveryEndSu)
  })
}

function positiveSafeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) > 0
}

function nonNegativeSafeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0
}

function sourceRecoveryCancellationError(cause: unknown): Error {
  return Object.assign(new Error(SSH_SOURCE_RECOVERY_CANCELLATION_FAILED), {
    code: SSH_SOURCE_RECOVERY_CANCELLATION_FAILED,
    cause
  })
}

function isSourceRecoveryCancellationError(error: unknown): boolean {
  return (error as { code?: unknown })?.code === SSH_SOURCE_RECOVERY_CANCELLATION_FAILED
}

export type SshRelayAiVaultHostInfo = {
  targetId: string
  executionHostId: ExecutionHostId
  remoteHome: string
  hostPlatform: RemoteHostPlatform
}

function normalizeRelayGracePeriodSeconds(graceTimeSeconds: number | undefined): number {
  const raw = graceTimeSeconds ?? DEFAULT_SSH_RELAY_GRACE_PERIOD_SECONDS
  const requested = Number.isFinite(raw) ? Math.floor(raw) : DEFAULT_SSH_RELAY_GRACE_PERIOD_SECONDS
  return requested === 0
    ? 0
    : Math.max(
        MIN_SSH_RELAY_GRACE_PERIOD_SECONDS,
        Math.min(MAX_SSH_RELAY_GRACE_PERIOD_SECONDS, requested)
      )
}

// Why: teardown barriers are independent, so one failing store write must not hide the others —
// settle them all and aggregate, rather than rethrowing only whichever rejected first.
async function settleSshSessionTeardown(
  barriers: (Promise<void> | null | undefined)[]
): Promise<void> {
  const results = await Promise.allSettled(barriers.map((barrier) => barrier ?? Promise.resolve()))
  const errors = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason as unknown] : []
  )
  if (errors.length === 1) {
    throw errors[0]
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, 'SSH relay session teardown failed')
  }
}

// Why: dispose is strictly more destructive than detach, so the mode records which teardown a
// session has already committed to and lets dispose supersede an in-flight detach.
type SshRelaySessionTeardownMode = 'detach' | 'dispose'

export class SshRelaySession {
  private _state: RelaySessionState = 'idle'
  private mux: SshChannelMultiplexer | null = null
  private abortController: AbortController | null = null
  private muxDisposeCleanup: (() => void) | null = null
  // Why: hold the notification-handler disposer so teardownProviders can release it on reconnect/shutdown (symmetric with muxDisposeCleanup).
  private muxNotificationCleanup: (() => void) | null = null
  // Why: onStateChange never fires when the relay channel closes but SSH stays up; this callback lets ssh.ts drive relay-level reconnect.
  private _onRelayLost: ((targetId: string) => void) | null = null
  // Why: a version mismatch or a blocked owner admission is terminal, so it needs a separate callback
  // from _onRelayLost (which expects a recoverable transport drop).
  private _onTerminalRelayError: ((targetId: string, err: Error) => void) | null = null
  private _onReady: ((targetId: string) => void) | null = null
  private portScanner: PortScanner | null = null
  private currentConnection: SshConnection | null = null
  private hostPlatform: RemoteHostPlatform | null = null
  private remoteCliBridgeEnv: RemoteCliBridgeEnv | null = null
  private aiVaultListMethodSupported: boolean | null = null
  private aiVaultTitleMethodSupported: boolean | null = null
  private pendingPtyReattaches = new Map<string, PendingPtyReattach>()
  private readonly ptyRecoveryRetention = new SshPtyRecoveryRetentionBudget()
  private activePtyProviderGeneration: number | null = null
  private sourceAckPublisherCleanup: (() => void) | null = null
  private sourceCancellationPublisherCleanup: (() => void) | null = null
  private teardownMode: SshRelaySessionTeardownMode | null = null
  private teardownCompletion: Promise<void> | null = null
  // Why: detach's in-memory half is one-shot but its lease write is retryable, so they are tracked
  // apart — a rejected write can be re-issued without re-running provider teardown.
  private detachedInMemory = false
  private detachFlushRejected = false
  private ptyRecoveryNotificationCleanups: (() => void)[] = []
  private readonly sourceIdentityByRelayPtyId = new Map<
    string,
    Readonly<{
      deliveryToken: string
      clientGeneration: number
      ownerGeneration: number
      ptyIncarnation: string
      nextSourceSu?: number
    }>
  >()
  private readonly retiredSourceDeliveries = new SshPtyRetiredSourceDeliveries()
  private readonly rejectedPtyRecoveryAttempts = new Map<
    string,
    {
      providerGeneration: number
      attempts: number
      generationAttempts: number
      reported: boolean
    }
  >()
  private readonly rejectedPtyRecoveryRetries = new Set<ReturnType<typeof setTimeout>>()
  private readonly rejectedPtyReattaches = new SshPtyTargetedReattachQueue(
    SSH_PTY_REATTACH_MAX_CONCURRENCY
  )
  private readonly ptyFrameRejectionLog = new SshPtyFrameRejectionLog()
  private readonly ptyConsumerClientInstanceId: string
  private ptyConsumerSessionState: SshPtyConsumerSessionState | null = null
  private activeCompatibilityAttachmentIds = new Set<string>()

  constructor(
    readonly targetId: string,
    private getMainWindow: () => BrowserWindow | null,
    private store: Store,
    private portForwardManager: SshPortForwardManager,
    private runtime?: OrcaRuntimeService,
    private onDetectedPortsChanged?: (
      targetId: string,
      ports: DetectedPort[],
      platform: string
    ) => void
  ) {
    this.ptyConsumerClientInstanceId = claimSshPtyConsumerRecovery(targetId, store).clientInstanceId
  }

  refreshEnvironment(
    getMainWindow: () => BrowserWindow | null,
    store: Store,
    portForwardManager: SshPortForwardManager,
    runtime?: OrcaRuntimeService,
    onDetectedPortsChanged?: (targetId: string, ports: DetectedPort[], platform: string) => void
  ): void {
    this.getMainWindow = getMainWindow
    this.store = store
    this.portForwardManager = portForwardManager
    this.runtime = runtime
    this.onDetectedPortsChanged = onDetectedPortsChanged
  }

  setOnRelayLost(cb: (targetId: string) => void): void {
    this._onRelayLost = cb
  }

  setOnTerminalRelayError(cb: (targetId: string, err: Error) => void): void {
    this._onTerminalRelayError = cb
  }

  setOnReady(cb: (targetId: string) => void): void {
    this._onReady = cb
  }

  getState(): RelaySessionState {
    return this._state
  }

  // Why: dispose() can mutate _state across await points, so defeat TS's control-flow narrowing that would otherwise reject the 'disposed' check.
  private isDisposed(): boolean {
    return (this._state as RelaySessionState) === 'disposed'
  }

  private requireReadyConnection(): SshConnection {
    if (!this.currentConnection) {
      throw new Error('SSH connection is not active')
    }
    return this.currentConnection
  }

  getMux(): SshChannelMultiplexer | null {
    return this.mux
  }

  getHostPlatform(): RemoteHostPlatform | null {
    return this.remoteCliBridgeEnv?.hostPlatform ?? this.hostPlatform
  }

  getAiVaultHostInfo(): SshRelayAiVaultHostInfo | null {
    const env = this.remoteCliBridgeEnv
    if (!env) {
      return null
    }
    return {
      targetId: this.targetId,
      executionHostId: toSshExecutionHostId(this.targetId),
      remoteHome: env.remoteHome,
      hostPlatform: env.hostPlatform
    }
  }

  async requestAiVaultSessionList(
    params: SshAiVaultRelayListParams,
    options: { signal?: AbortSignal; timeoutMs?: number } = {}
  ): Promise<unknown> {
    if (this.aiVaultListMethodSupported === false) {
      return null
    }
    const mux = this.mux
    if (!mux || mux.isDisposed() || this._state !== 'ready') {
      throw new Error('SSH relay is not ready')
    }
    try {
      const result = await mux.request(SSH_AI_VAULT_LIST_SESSIONS_METHOD, params, {
        signal: options.signal,
        timeoutMs: options.timeoutMs ?? SSH_AI_VAULT_LIST_SESSIONS_TIMEOUT_MS
      })
      this.aiVaultListMethodSupported = true
      return result
    } catch (error) {
      if (isMethodNotFoundError(error)) {
        this.aiVaultListMethodSupported = false
        return null
      }
      throw error
    }
  }

  async requestAiVaultSessionTitles(
    params: SshAiVaultRelayTitleParams,
    options: { signal?: AbortSignal; timeoutMs?: number } = {}
  ): Promise<unknown> {
    if (this.aiVaultTitleMethodSupported === false) {
      return null
    }
    const mux = this.mux
    if (!mux || mux.isDisposed() || this._state !== 'ready') {
      throw new Error('SSH relay is not ready')
    }
    try {
      const result = await mux.request(SSH_AI_VAULT_RESOLVE_SESSION_TITLES_METHOD, params, {
        signal: options.signal,
        timeoutMs: options.timeoutMs ?? SSH_AI_VAULT_RESOLVE_SESSION_TITLES_TIMEOUT_MS
      })
      this.aiVaultTitleMethodSupported = true
      return result
    } catch (error) {
      if (isMethodNotFoundError(error)) {
        this.aiVaultTitleMethodSupported = false
        return null
      }
      throw error
    }
  }

  getPortScanner(): PortScanner | null {
    return this.portScanner
  }

  prepareForHostSleep(): void {
    const mux = this.mux
    if (!mux || mux.isDisposed() || this.isDisposed()) {
      return
    }
    mux.notify(SSH_RELAY_CONFIGURE_GRACE_TIME_METHOD, { graceTimeSeconds: 0 })
  }

  // Why: single entry point for relay setup (initial connect + app-restart reconnect) so no path forgets a registration step.
  async establish(conn: SshConnection, graceTimeSeconds?: number): Promise<void> {
    if (this._state !== 'idle') {
      throw new Error(`Cannot establish relay session in state: ${this._state}`)
    }
    this._state = 'deploying'
    this.aiVaultListMethodSupported = null
    this.aiVaultTitleMethodSupported = null
    this.currentConnection = conn

    try {
      const {
        transport,
        serverBuildId,
        remoteHome,
        remoteRelayDir,
        nodePath,
        sockPath,
        credentialFile,
        hostPlatform
      } = await deployAndLaunchRelay(conn, undefined, graceTimeSeconds, this.targetId)
      this.hostPlatform = hostPlatform ?? null
      this.remoteCliBridgeEnv =
        remoteHome && remoteRelayDir && nodePath && sockPath && hostPlatform
          ? {
              remoteHome,
              binDir: joinRemotePath(hostPlatform, remoteHome, '.orca-relay', 'bin'),
              relayDir: remoteRelayDir,
              nodePath,
              sockPath,
              ...(credentialFile ? { credentialFile } : {}),
              hostPlatform,
              pathDelimiter: hostPlatform.pathDelimiter
            }
          : null

      // Why: dispose() can fire during the await above; if it did, creating a mux/providers now would leak with no owner to dispose them.
      if (this.isDisposed()) {
        const orphanMux = new SshChannelMultiplexer(transport)
        orphanMux.dispose()
        throw new Error('Session disposed during establish')
      }

      const mux = new SshChannelMultiplexer(transport)
      this.mux = mux
      const isAttemptCurrent = (): boolean => this.mux === mux && !this.isDisposed()
      const shouldContinue = (): boolean => isAttemptCurrent() && !mux.isDisposed()

      const ptyConsumerSessionState = await this.openPtyConsumerSession(
        mux,
        serverBuildId,
        shouldContinue
      )
      if (!verifyRelayAttempt(mux, isAttemptCurrent, 'consumer session setup')) {
        if (!mux.isDisposed()) {
          mux.dispose()
        }
        throw new Error('Session disposed during establish')
      }
      this.ptyConsumerSessionState = ptyConsumerSessionState
      await this.rememberPtyConsumerRecovery(serverBuildId)
      if (!verifyRelayAttempt(mux, isAttemptCurrent, 'consumer recovery persistence')) {
        if (!mux.isDisposed()) {
          mux.dispose()
        }
        throw new Error('Session disposed during establish')
      }

      await mux.request('session.resolveHome', { path: '~' })
      if (!verifyRelayAttempt(mux, isAttemptCurrent, 'home resolution')) {
        if (!mux.isDisposed()) {
          mux.dispose()
        }
        throw new Error('Session disposed during establish')
      }
      const connectionIncarnation = randomUUID()

      const registered = await this.registerProviders(mux, shouldContinue, connectionIncarnation)
      if (!registered) {
        if (!verifyRelayAttempt(mux, isAttemptCurrent, 'provider registration')) {
          if (!mux.isDisposed()) {
            mux.dispose()
          }
          throw new Error('Session disposed during establish')
        }
        throw new Error('Relay provider registration stopped unexpectedly')
      }

      if (!verifyRelayAttempt(mux, isAttemptCurrent, 'provider registration')) {
        if (!mux.isDisposed()) {
          mux.dispose()
        }
        throw new Error('Session disposed during establish')
      }

      // Why: explicit disconnect keeps PTY ownership, so a later manual connect must reattach those remote PTYs.
      await this.reattachKnownPtys(mux, shouldContinue)

      if (!verifyRelayAttempt(mux, isAttemptCurrent, 'PTY reattach')) {
        throw new Error('Session disposed during establish')
      }

      this.configureRelayGraceTime(mux, graceTimeSeconds)
      verifyRelayAttempt(mux, isAttemptCurrent, 'establish')
      this.watchMuxForRelayLoss(mux)
      verifyRelayAttempt(mux, isAttemptCurrent, 'establish')
      this._state = 'ready'
      this.startPortScanning()
      this._onReady?.(this.targetId)
    } catch (err) {
      // Why: registerProviders can throw with a live mux and partial registration — tear everything down so a retry starts clean.
      if (!this.isDisposed()) {
        this.teardownProviders(
          'connection_lost',
          isSourceRecoveryCancellationError(err)
            ? SSH_SOURCE_RECOVERY_CANCELLATION_FAILED
            : 'connection_lost'
        )
        this._state = 'idle'
      }
      // Why: terminal on first connect — a deployed binary against a still-running legacy daemon, or a
      // claim another connection holds. Notify the callback but still rethrow.
      if (isRelayVersionMismatchError(err) || isSshOwnerAdmissionBlockedError(err)) {
        console.warn(
          `[ssh-relay-session] Terminal relay error on initial connect for ${this.targetId}: ${err.message}`
        )
        this._onTerminalRelayError?.(this.targetId, err)
      }
      throw err
    }
  }

  // Why: network-blip reconnect; AbortController-guarded so overlapping attempts from fast flaps cancel the stale one.
  async reconnect(conn: SshConnection, graceTimeSeconds?: number): Promise<void> {
    // Why: reconnect only from 'ready'/'reconnecting' — from 'deploying' it would tear down a mux establish() is still using; 'idle' has no session yet.
    if (this._state !== 'ready' && this._state !== 'reconnecting') {
      return
    }

    this.releaseRelayLossWatcher()
    // Cancel any in-flight reconnect
    this.abortController?.abort()
    const abortController = new AbortController()
    this.abortController = abortController

    this._state = 'reconnecting'
    this.aiVaultListMethodSupported = null
    this.aiVaultTitleMethodSupported = null
    this.currentConnection = conn

    // Why: stop scanning before teardownProviders so the poll timer can't fire against a disposed multiplexer.
    this.stopPortScanning()
    await this.portForwardManager.removeAllForwards(this.targetId)
    this.broadcastEmptyLists()
    this.teardownProviders('connection_lost')

    try {
      const {
        transport,
        serverBuildId,
        remoteHome,
        remoteRelayDir,
        nodePath,
        sockPath,
        credentialFile,
        hostPlatform
      } = await deployAndLaunchRelay(conn, undefined, graceTimeSeconds, this.targetId)
      this.hostPlatform = hostPlatform ?? null
      this.remoteCliBridgeEnv =
        remoteHome && remoteRelayDir && nodePath && sockPath && hostPlatform
          ? {
              remoteHome,
              binDir: joinRemotePath(hostPlatform, remoteHome, '.orca-relay', 'bin'),
              relayDir: remoteRelayDir,
              nodePath,
              sockPath,
              ...(credentialFile ? { credentialFile } : {}),
              hostPlatform,
              pathDelimiter: hostPlatform.pathDelimiter
            }
          : null

      if (abortController.signal.aborted || this.isDisposed()) {
        // Why: relay is already running remotely — a throwaway mux we immediately dispose sends a clean shutdown so it doesn't linger until grace expires.
        const orphanMux = new SshChannelMultiplexer(transport)
        orphanMux.dispose()
        return
      }

      const mux = new SshChannelMultiplexer(transport)
      this.mux = mux

      const isAttemptCurrent = (): boolean =>
        this.mux === mux &&
        this.abortController === abortController &&
        !abortController.signal.aborted &&
        !this.isDisposed()
      const shouldContinue = (): boolean => isAttemptCurrent() && !mux.isDisposed()

      const ptyConsumerSessionState = await this.openPtyConsumerSession(
        mux,
        serverBuildId,
        shouldContinue
      )
      if (!verifyRelayAttempt(mux, isAttemptCurrent, 'consumer session setup')) {
        if (!mux.isDisposed()) {
          mux.dispose()
        }
        return
      }
      this.ptyConsumerSessionState = ptyConsumerSessionState
      await this.rememberPtyConsumerRecovery(serverBuildId)
      if (!verifyRelayAttempt(mux, isAttemptCurrent, 'consumer recovery persistence')) {
        if (!mux.isDisposed()) {
          mux.dispose()
        }
        return
      }

      await mux.request('session.resolveHome', { path: '~' })
      if (!verifyRelayAttempt(mux, isAttemptCurrent, 'home resolution')) {
        if (!mux.isDisposed()) {
          mux.dispose()
        }
        return
      }
      const connectionIncarnation = randomUUID()

      const registered = await this.registerProviders(mux, shouldContinue, connectionIncarnation)
      if (!registered) {
        if (!verifyRelayAttempt(mux, isAttemptCurrent, 'provider registration')) {
          if (this.mux === mux) {
            this.teardownProviders('shutdown')
          } else if (!mux.isDisposed()) {
            mux.dispose()
          }
          return
        }
        throw new Error('Relay provider registration stopped unexpectedly')
      }

      // Why: dispose() during registration/attach already cleaned up, but this.mux was reassigned above — clean up the new mux so it doesn't leak.
      if (!verifyRelayAttempt(mux, isAttemptCurrent, 'provider registration')) {
        if (this.mux === mux) {
          this.teardownProviders('shutdown')
        } else if (!mux.isDisposed()) {
          mux.dispose()
        }
        return
      }

      await this.reattachKnownPtys(mux, shouldContinue)

      if (!verifyRelayAttempt(mux, isAttemptCurrent, 'PTY reattach')) {
        return
      }

      this.configureRelayGraceTime(mux, graceTimeSeconds)
      verifyRelayAttempt(mux, isAttemptCurrent, 'reconnect')
      this.watchMuxForRelayLoss(mux)
      verifyRelayAttempt(mux, isAttemptCurrent, 'reconnect')
      this._state = 'ready'
      this.startPortScanning()
      this._onReady?.(this.targetId)
    } catch (err) {
      // Why: tear down a partially-registered mux so its keepalive/timeout timers don't keep running on a half-initialized session.
      if (this.abortController === abortController && !this.isDisposed()) {
        this.teardownProviders(
          'connection_lost',
          isSourceRecoveryCancellationError(err)
            ? SSH_SOURCE_RECOVERY_CANCELLATION_FAILED
            : 'connection_lost'
        )
      }
      // Why terminal: neither a version mismatch nor a blocked owner claim is reconcilable by backoff
      // retry, so fire the typed callback and drop out of 'reconnecting'.
      if (isRelayVersionMismatchError(err) || isSshOwnerAdmissionBlockedError(err)) {
        console.warn(
          `[ssh-relay-session] Terminal relay error for ${this.targetId}: ${err.message}`
        )
        if (this.abortController === abortController && !this.isDisposed()) {
          this._state = 'idle'
        }
        this._onTerminalRelayError?.(this.targetId, err)
        return
      }
      // Why: stay in 'reconnecting' (not 'ready') since the provider stack is torn down; the SSH manager will fire another onStateChange to retry.
      console.warn(
        `[ssh-relay-session] Failed to re-establish relay for ${this.targetId}: ${err instanceof Error ? err.message : String(err)}`
      )
      if (this.abortController === abortController && !this.isDisposed()) {
        // Why: treat non-not-found attach failures as relay loss so ssh.ts's bounded backoff retries instead of stranding the session in 'reconnecting'.
        this._onRelayLost?.(this.targetId)
      }
    } finally {
      if (this.abortController === abortController) {
        this.abortController = null
      }
    }
  }

  /** Fire-and-forget disposal; prefer {@link disposeAndPersist} when the caller can await durability. */
  dispose(): void {
    void this.disposeAndPersist().catch((error) => {
      console.warn(
        `[ssh-relay-session] Failed to persist disposal for ${this.targetId}: ${error instanceof Error ? error.message : String(error)}`
      )
    })
  }

  /**
   * Destructive teardown: forgets the consumer recovery record and terminates the leases.
   * Repeat calls share one completion, and a dispose requested after a detach supersedes it —
   * the destructive half re-runs so detach-then-dispose still forgets recovery and terminates
   * leases. (The reverse, detach after dispose, is a no-op.)
   */
  disposeAndPersist(): Promise<void> {
    if (this.teardownMode === 'dispose') {
      return this.teardownCompletion ?? Promise.resolve()
    }
    const pendingDetach = this.teardownCompletion
    this.teardownMode = 'dispose'
    try {
      this.teardownCompletion = this.runDisposal(pendingDetach)
    } catch (error) {
      // Why: a synchronous failure in the in-memory half must ride the completion promise, or a later
      // disposeAndPersist reports success on a null completion and detachAndPersist re-runs runDetach.
      this.teardownCompletion = Promise.reject(error)
    }
    return this.teardownCompletion
  }

  private runDisposal(pendingDetach: Promise<void> | null): Promise<void> {
    // Why: the whole in-memory half runs before any await so a concurrent connect can never observe
    // a half-torn session; only the durability barriers below are deferred onto the returned promise.
    this.releaseRelayLossWatcher()
    this.abortController?.abort()
    this.stopPortScanning()
    this.broadcastEmptyLists()
    this.teardownProviders('shutdown')
    this.currentConnection = null
    this._state = 'disposed'
    const recoveryRemoval = forgetSshPtyConsumerRecovery(
      this.targetId,
      this.ptyConsumerClientInstanceId,
      this.store
    )
    const leaseTermination = this.store.markSshRemotePtyLeasesAsync(this.targetId, 'terminated')
    return settleSshSessionTeardown([
      // Why: a superseded detach keeps its own rejection for its own caller; swallow it here so a
      // failed detach write cannot fail the disposal that replaced it.
      pendingDetach?.catch(() => undefined),
      // Why: nothing rebinds after dispose, but direct callers (no IPC-side teardown) still need
      // this session's local listeners released.
      this.portForwardManager.removeAllForwards(this.targetId),
      recoveryRemoval,
      leaseTermination
    ])
  }

  /** Fire-and-forget detach; prefer {@link detachAndPersist} when the caller can await durability. */
  detach(): void {
    void this.detachAndPersist().catch((error) => {
      console.warn(
        `[ssh-relay-session] Failed to persist detach for ${this.targetId}: ${error instanceof Error ? error.message : String(error)}`
      )
    })
  }

  /**
   * Non-destructive teardown: keeps PTY ownership so a later connect reclaims this consumer
   * identity. Once dispose has been requested this is a no-op — see {@link disposeAndPersist}.
   */
  async detachAndPersist(): Promise<void> {
    // Why: a rejected lease write must not latch forever — re-issue just the write so the caller can
    // retry. Never under 'dispose': that supersedes detach for good and re-issuing would resurrect
    // the 'detached' state the disposal already replaced with 'terminated'.
    if (!this.teardownCompletion || (this.teardownMode === 'detach' && this.detachFlushRejected)) {
      this.teardownCompletion = this.runDetach()
    }
    this.teardownMode ??= 'detach'
    let completion = this.teardownCompletion
    while (completion) {
      try {
        await completion
      } catch (error) {
        if (completion === this.teardownCompletion) {
          throw error
        }
      }
      if (completion === this.teardownCompletion) {
        return
      }
      completion = this.teardownCompletion
    }
  }

  // Why a separate transition from detachAndPersist: on the committed quit path every in-memory
  // change has to land before the final store flush snapshots, and that flush — not a per-session
  // durable write — is what persists it. Idempotent, and it schedules no persistence of its own, so
  // nothing the async drain finishes later can write recovery state after the snapshot.
  //
  // 'detached' says this app let go of the lease, not that the remote shell died. The remote PTYs are
  // left running for the next attach, exactly as an ordinary detach leaves them.
  beginShutdownDetach(): void {
    if (this.detachedInMemory || this._state === 'disposed') {
      return
    }
    detachSshPtyConsumerRecovery(this.targetId, this.ptyConsumerClientInstanceId)
    this.releaseRelayLossWatcher()
    this.abortController?.abort()
    this.stopPortScanning()
    this.broadcastEmptyLists()
    this.teardownProviders('connection_lost')
    this.currentConnection = null
    this._state = 'disposed'
    this.detachedInMemory = true
    this.store.markSshRemotePtyLeasesForShutdown(this.targetId, 'detached')
  }

  private runDetach(): Promise<void> {
    if (!this.detachedInMemory) {
      if (this._state === 'disposed') {
        return Promise.resolve()
      }
      // Why first: same synchronous-half-first rule as runDisposal, and this is the highest-value
      // step — a fast reconnect must reclaim this identity instead of minting one, even if a
      // teardown call below throws unexpectedly.
      detachSshPtyConsumerRecovery(this.targetId, this.ptyConsumerClientInstanceId)
      this.releaseRelayLossWatcher()
      this.abortController?.abort()
      this.stopPortScanning()
      this.broadcastEmptyLists()
      // Why: disconnect keeps PTY ownership so a later manual connect can reattach.
      this.teardownProviders('connection_lost')
      this.currentConnection = null
      this._state = 'disposed'
      this.detachedInMemory = true
    }
    this.detachFlushRejected = false
    return settleSshSessionTeardown([
      this.store.markSshRemotePtyLeasesAsync(this.targetId, 'detached')
    ]).catch((error: unknown) => {
      this.detachFlushRejected = true
      throw error
    })
  }

  // ── Private ───────────────────────────────────────────────────────

  // Why: teardown itself can kill the mux — an aborted request emits rpc.cancel, and a saturated
  // control lane turns that admission failure into mux.dispose('connection_lost'). Every teardown
  // path must release the watcher before its first mux write, or our own shutdown re-enters
  // recovery as a spurious relay loss. teardownProviders is not early enough: stopPortScanning
  // runs ahead of it and is what emits that frame. Call this ahead of abortController.abort()
  // too — that signal reaches no mux request today, but plumbing it into one would otherwise
  // reopen the same hole silently.
  private releaseRelayLossWatcher(): void {
    this.muxDisposeCleanup?.()
    this.muxDisposeCleanup = null
  }

  // Why: onStateChange only fires on SSH-level reconnects, so watch for relay-channel loss while SSH stays up and fire onRelayLost.
  private watchMuxForRelayLoss(mux: SshChannelMultiplexer): void {
    this.releaseRelayLossWatcher()
    this.muxDisposeCleanup = mux.onDispose((reason) => {
      if (reason === 'connection_lost' && this.mux === mux && !this.isDisposed()) {
        console.warn(
          `[ssh-relay-session] Relay channel lost for ${this.targetId}, triggering reconnect`
        )
        this._onRelayLost?.(this.targetId)
      }
    })
  }

  // Why: shared by establish() and reconnect() so both use the exact same registration sequence.
  private async registerProviders(
    mux: SshChannelMultiplexer,
    shouldContinue: (() => boolean) | undefined,
    connectionIncarnation: string
  ): Promise<boolean> {
    await this.registerRelayRoots(mux)
    if (shouldContinue && !shouldContinue()) {
      return false
    }

    await this.installPluginsOnRelay(mux)
    if (shouldContinue && !shouldContinue()) {
      return false
    }

    try {
      await this.installRemoteOrcaCliLauncher()
    } catch (error) {
      // Why: on MaxSessions=1 remotes the relay holds the only slot, so this raw-connection install can fail — don't fail the whole connection.
      console.warn(
        `[ssh-relay-session] remote orca CLI launcher install failed for ${this.targetId}: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }
    if (shouldContinue && !shouldContinue()) {
      return false
    }

    this.wireUpRemoteOrcaCli(mux, connectionIncarnation)

    const providerGeneration = allocateSshPtyProviderGeneration()
    const ptyProvider = new SshPtyProvider(
      this.targetId,
      mux,
      this.remoteCliBridgeEnv ?? undefined,
      providerGeneration
    )
    const consumerOwnerState = this.activePtyConsumerOwner()
    if (consumerOwnerState) {
      ptyProvider.setPtyDeliveryPauseAdapter?.(({ id, providerGeneration: generation, paused }) => {
        if (
          generation !== providerGeneration ||
          this.activePtyProviderGeneration !== providerGeneration ||
          this.mux !== mux
        ) {
          return
        }
        const sourceIdentity = this.sourceIdentityByRelayPtyId.get(id)
        if (consumerOwnerState.outputFlowControl && !sourceIdentity) {
          return
        }
        mux.notify('pty.setDeliveryPaused', {
          id,
          paused,
          clientGeneration: consumerOwnerState.clientGeneration,
          ownerGeneration: consumerOwnerState.ownerGeneration,
          ...(sourceIdentity ? { deliveryToken: sourceIdentity.deliveryToken } : {})
        })
      })
    }
    this.sourceAckPublisherCleanup?.()
    this.sourceAckPublisherCleanup = null
    this.sourceCancellationPublisherCleanup?.()
    this.sourceCancellationPublisherCleanup = null
    if (consumerOwnerState?.outputFlowControl) {
      this.sourceAckPublisherCleanup = installSshPtySourceAckPublisher(
        providerGeneration,
        (batch, onSettled) =>
          mux.notifyWithSettlement(
            'pty.ackData',
            batch as unknown as Record<string, unknown>,
            onSettled
          )
      )
      this.sourceCancellationPublisherCleanup = installSshPtySourceCancellationPublisher(
        providerGeneration,
        async (request) => {
          const result = (await mux.request('pty.cancelDelivery', {
            ...request,
            id: toRelaySshPtyId(this.targetId, request.id)
          })) as Record<string, unknown>
          if (
            result.canceled !== true ||
            !Number.isSafeInteger(result.sentEndSu) ||
            !Number.isSafeInteger(result.creditedEndSu)
          ) {
            throw new Error('ssh_source_cancellation_proof_invalid')
          }
          return {
            sentEndSu: result.sentEndSu as number,
            creditedEndSu: result.creditedEndSu as number
          }
        }
      )
    }
    this.activePtyProviderGeneration = providerGeneration
    registerSshPtyProvider(this.targetId, ptyProvider)
    this.installPtyRecoveryNotifications(mux)

    const connection = this.requireReadyConnection()
    const createSftp =
      connection.usesSystemSshTransport?.() === true
        ? undefined
        : (options?: { signal?: AbortSignal }) => this.requireReadyConnection().sftp(options)
    // Why: getHostPlatform() falls back to this.hostPlatform when bridge env is incomplete, so path rules still match the host.
    const hostPlatform = this.getHostPlatform() ?? undefined
    const fsProvider = new SshFilesystemProvider(
      this.targetId,
      mux,
      createSftp,
      {
        downloadFile: (sourcePath, destinationPath) =>
          this.requireReadyConnection().downloadFile(sourcePath, destinationPath, {
            hostPlatform
          }),
        openFileUploadSession: () =>
          this.requireReadyConnection().openFileUploadSession({
            hostPlatform
          }),
        writeBuffer: (remotePath, contents, options) =>
          this.requireReadyConnection().writeBuffer(remotePath, contents, {
            hostPlatform,
            append: options.append,
            exclusive: options.exclusive
          })
      },
      hostPlatform
    )
    registerSshFilesystemProvider(this.targetId, fsProvider)

    const gitProvider = new SshGitProvider(
      this.targetId,
      mux,
      this.remoteCliBridgeEnv?.hostPlatform ?? null
    )
    registerSshGitProvider(this.targetId, gitProvider)

    this.wireUpPtyEvents(ptyProvider, mux, providerGeneration)
    this.wireUpAgentHookEvents(mux)
    this.wireUpRemoteWorkspaceEvents(mux)
    void this.installManagedHooksOnRemote(mux, shouldContinue)
    return true
  }

  private activePtyConsumerOwner(): SshPtyConsumerOwnerState | null {
    const state = this.ptyConsumerSessionState
    return state && state.mode !== 'legacy-fallback' ? state : null
  }

  private recoverablePtyConsumerOwner(
    serverBuildId: string | undefined
  ): SshPtyConsumerOwnerState | null {
    const active = this.activePtyConsumerOwner()
    if (active) {
      return active
    }
    const recovery = getSshPtyConsumerRecovery(this.targetId)
    return serverBuildId && recovery?.serverBuildId === serverBuildId
      ? (recovery?.owner ?? null)
      : null
  }

  private async openPtyConsumerSession(
    mux: SshChannelMultiplexer,
    serverBuildId: string | undefined,
    ownsAttempt: () => boolean
  ): Promise<SshPtyConsumerSessionState> {
    const previousOwner = this.recoverablePtyConsumerOwner(serverBuildId)
    const options: OpenSshPtyConsumerSessionOptions = {
      clientInstanceId: this.ptyConsumerClientInstanceId,
      expectedServerBuildId: serverBuildId,
      allowSameBuildLegacyFallback: true,
      outputFlowControl: { requestedWindowSu: DEFAULT_PTY_SOURCE_WINDOW_SU }
    }
    let admission: SshPtyConsumerAdmission
    try {
      admission = await this.admitPtyConsumerOwner(mux, previousOwner, options, ownsAttempt)
    } catch (error) {
      if (
        !previousOwner ||
        (error as { code?: unknown }).code !== PTY_CONSUMER_STALE_OWNER_RECOVERY_ERROR
      ) {
        throw error
      }
      this.voidPtyConsumerCheckpoints(previousOwner, ownsAttempt)
      if (!ownsAttempt()) {
        throw new Error('Session disposed during owner recovery')
      }
      admission = await openSshPtyConsumerSession(mux, options)
    }
    if (previousOwner && !admission.resumed) {
      this.voidPtyConsumerCheckpoints(previousOwner, ownsAttempt)
    }
    return admission.state
  }

  private async admitPtyConsumerOwner(
    mux: SshChannelMultiplexer,
    previousOwner: SshPtyConsumerOwnerState | null,
    options: OpenSshPtyConsumerSessionOptions,
    ownsAttempt: () => boolean
  ): Promise<SshPtyConsumerAdmission> {
    try {
      return await retrySshOwnerRecoveryWhileBlocked(
        () =>
          openSshPtyConsumerSession(mux, {
            ...options,
            ...(previousOwner
              ? {
                  resume: {
                    ownerGeneration: previousOwner.ownerGeneration,
                    ownerLease: previousOwner.ownerLease
                  }
                }
              : {})
          }),
        {
          isCurrent: () => ownsAttempt() && !mux.isDisposed(),
          onClosed: (listener) => mux.onDispose(listener)
        }
      )
    } catch (error) {
      // Why converted here: past this point the failure travels the same path as a dropped transport,
      // where backoff would keep redeploying a relay that is working fine and refusing on purpose.
      if (isSshOwnerAdmissionBlocked(error)) {
        throw new SshOwnerAdmissionBlockedError(this.targetId, { cause: error })
      }
      throw error
    }
  }

  // Why the recovery row and clientInstanceId survive: the relay minted a fresh claim, which voids the
  // checkpoints taken under the old one but says nothing about our identity for this target. The caller
  // durably records the new lease before ready, so removal here would only lose the identity.
  private voidPtyConsumerCheckpoints(
    previousOwner: SshPtyConsumerOwnerState,
    ownsAttempt: () => boolean
  ): void {
    const recovery = getSshPtyConsumerRecovery(this.targetId)
    // Why identity-guarded: the record is target-scoped and its clientInstanceId is shared by every
    // session for that target, so only a record still describing the owner this attempt tried to
    // resume is ours to void — otherwise a loser wipes the winner's checkpoints.
    if (
      !recovery ||
      !ownsAttempt() ||
      (recovery.owner &&
        (recovery.owner.ownerGeneration !== previousOwner.ownerGeneration ||
          recovery.owner.ownerLease !== previousOwner.ownerLease))
    ) {
      return
    }
    delete recovery.owner
    recovery.checkpointsByAppPtyId.clear()
    for (const [ptyId, migration] of recovery.modelMigrationsByAppPtyId) {
      recovery.modelMigrationsByAppPtyId.set(
        ptyId,
        migration.then(() =>
          Object.freeze({
            status: 'checkpoint-unavailable' as const,
            reason: 'completion-failed' as const
          })
        )
      )
    }
  }

  private async rememberPtyConsumerRecovery(serverBuildId: string | undefined): Promise<void> {
    const owner = this.activePtyConsumerOwner()
    if (!owner || !serverBuildId) {
      return
    }
    await rememberSshPtyConsumerRecovery({
      targetId: this.targetId,
      clientInstanceId: this.ptyConsumerClientInstanceId,
      serverBuildId,
      owner,
      store: this.store
    })
  }

  private configureRelayGraceTime(
    mux: SshChannelMultiplexer,
    graceTimeSeconds: number | undefined
  ): void {
    mux.notify(SSH_RELAY_CONFIGURE_GRACE_TIME_METHOD, {
      graceTimeSeconds: normalizeRelayGracePeriodSeconds(graceTimeSeconds)
    })
  }

  private async installManagedHooksOnRemote(
    mux: SshChannelMultiplexer,
    shouldContinue?: () => boolean
  ): Promise<void> {
    if (
      !isRemoteAgentHooksEnabled() ||
      !this.areAgentStatusHooksEnabled() ||
      (shouldContinue && !shouldContinue())
    ) {
      return
    }
    if (
      this.remoteCliBridgeEnv?.hostPlatform &&
      isWindowsRemoteHost(this.remoteCliBridgeEnv.hostPlatform)
    ) {
      // Why: managed hook installers emit POSIX-only scripts/paths; Windows remotes rely on relay-injected env + plugin overlays instead.
      return
    }

    try {
      const store = this.store as { getSettings?: Store['getSettings'] }
      const detected = (await mux.request('preflight.detectAgents', {
        commands: buildManagedHookDetectionCommands(store.getSettings?.() ?? null, 'linux')
      })) as { agents?: unknown }
      const agents = detectedManagedHookAgents(detected?.agents)
      if (agents.length === 0 || (shouldContinue && !shouldContinue())) {
        return
      }
      const hostKeyFingerprint = this.requireReadyConnection().getHostKeyFingerprint?.()
      const params = {
        ...(hostKeyFingerprint ? { hostKeyFingerprint } : {}),
        agents
      }
      const result = (await mux.request(AGENT_HOOK_INSTALL_MANAGED_HOOKS_METHOD, params)) as {
        errors?: unknown
      }
      if (typeof result.errors === 'number' && result.errors > 0) {
        console.warn(
          `[ssh-relay-session] ${result.errors} remote managed hook installers failed for ${this.targetId}`
        )
      }
    } catch (error) {
      // Why: teardown routinely cancels this best-effort request; only warn for
      // installer failures that survive the connection lifecycle.
      const code = (error as { code?: unknown })?.code
      if (
        code === -32601 ||
        code === 'CONNECTION_LOST' ||
        code === 'DISPOSED' ||
        mux.isDisposed()
      ) {
        return
      }
      console.warn(
        `[ssh-relay-session] relay managed hook install failed for ${this.targetId}: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }
  }

  private async installRemoteOrcaCliLauncher(): Promise<void> {
    if (!this.remoteCliBridgeEnv) {
      return
    }
    const { binDir, hostPlatform } = this.remoteCliBridgeEnv
    const plan = createRemoteCliInstallPlan(this.remoteCliBridgeEnv)
    const conn = this.requireReadyConnection()
    await execCommand(conn, makeRemoteDirectoryCommand(hostPlatform, binDir), {
      wrapCommand: !isWindowsRemoteHost(hostPlatform)
    })
    if (typeof conn.writeFile === 'function') {
      for (const file of plan.files) {
        await conn.writeFile(file.path, file.contents, { hostPlatform })
      }
    } else {
      const sftp = await conn.sftp()
      try {
        for (const file of plan.files) {
          await new Promise<void>((resolve, reject) => {
            const ws = sftp.createWriteStream(file.path)
            sftp.once('error', reject)
            ws.once('close', resolve)
            ws.once('error', reject)
            ws.end(file.contents)
          })
        }
      } finally {
        sftp.end()
      }
    }
    for (const command of plan.postWriteCommands) {
      await execCommand(conn, command, { wrapCommand: !isWindowsRemoteHost(hostPlatform) })
    }
  }

  private wireUpRemoteOrcaCli(mux: SshChannelMultiplexer, connectionIncarnation: string): void {
    mux.onRequest('orca.cli', async (params) => {
      if (!this.runtime) {
        throw new Error('Orca runtime is unavailable')
      }
      const argv = Array.isArray(params.argv)
        ? params.argv.filter((item): item is string => typeof item === 'string')
        : []
      const cwd = typeof params.cwd === 'string' && params.cwd.length > 0 ? params.cwd : '/'
      const rawEnv = params.env
      const env =
        rawEnv && typeof rawEnv === 'object' && !Array.isArray(rawEnv)
          ? Object.fromEntries(
              Object.entries(rawEnv).filter(
                (entry): entry is [string, string] =>
                  typeof entry[0] === 'string' && typeof entry[1] === 'string'
              )
            )
          : {}
      const stdin = typeof params.stdin === 'string' ? params.stdin : undefined
      const artifactInput = normalizeRemoteArtifactInput(params.artifactInput)
      const runtimeAuthority = this.runtime.registerOrchestrationCompatibilitySshAttachment(
        this.targetId,
        connectionIncarnation
      )
      this.activeCompatibilityAttachmentIds.add(runtimeAuthority.attachmentId)
      try {
        return await runRemoteOrcaCli(this.runtime, {
          argv,
          cwd,
          env,
          ...(stdin !== undefined ? { stdin } : {}),
          ...(artifactInput ? { artifactInput } : {}),
          runtimeAuthority
        })
      } finally {
        this.activeCompatibilityAttachmentIds.delete(runtimeAuthority.attachmentId)
        this.runtime.releaseOrchestrationCompatibilitySshAttachment(runtimeAuthority.attachmentId)
      }
    })
    mux.onRequest('orca.cli.postOutput', async (params) => {
      if (!this.runtime) {
        throw new Error('Orca runtime is unavailable')
      }
      const rawEnv = params.env
      const env =
        rawEnv && typeof rawEnv === 'object' && !Array.isArray(rawEnv)
          ? Object.fromEntries(
              Object.entries(rawEnv).filter(
                (entry): entry is [string, string] =>
                  typeof entry[0] === 'string' && typeof entry[1] === 'string'
              )
            )
          : {}
      const runtimeAuthority = this.runtime.registerOrchestrationCompatibilitySshAttachment(
        this.targetId,
        connectionIncarnation
      )
      this.activeCompatibilityAttachmentIds.add(runtimeAuthority.attachmentId)
      try {
        await acknowledgeRemoteOrcaCliPostOutput(this.runtime, {
          postOutput: parseRemoteOrcaCliPostOutput(params.postOutput),
          env,
          runtimeAuthority
        })
        return { acknowledged: true }
      } finally {
        this.activeCompatibilityAttachmentIds.delete(runtimeAuthority.attachmentId)
        this.runtime.releaseOrchestrationCompatibilitySshAttachment(runtimeAuthority.attachmentId)
      }
    })
  }

  // Why: ship plugin/extension source from Orca so agent-event changes don't force a relay redeploy — the relay is versioned independently. Best-effort: failure only costs agent status on this host.
  private async installPluginsOnRelay(mux: SshChannelMultiplexer): Promise<void> {
    if (!isRemoteAgentHooksEnabled() || !this.areAgentStatusHooksEnabled()) {
      return
    }
    try {
      await mux.request(AGENT_HOOK_INSTALL_PLUGINS_METHOD, {
        opencodePluginSource: openCodeInternals.getOpenCodePluginSource(),
        piExtensionSource: getPiAgentStatusExtensionSource('pi'),
        ompExtensionSource: getPiAgentStatusExtensionSource('omp'),
        primeAgentExtensionSource: getPiAgentStatusExtensionSource('prime-agent')
      })
    } catch (err) {
      // Why: -32601 = older relay without the handler; CONNECTION_LOST/DISPOSED = routine mid-flight teardown — swallow both.
      const code = (err as { code?: unknown })?.code
      if (code === -32601 || code === 'CONNECTION_LOST' || code === 'DISPOSED') {
        return
      }
      if (mux.isDisposed()) {
        return
      }
      console.warn(
        `[ssh-relay-session] agent_hook.installPlugins failed for ${this.targetId}: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
    }
  }

  private areAgentStatusHooksEnabled(): boolean {
    const store = this.store as { getSettings?: Store['getSettings'] }
    return isAgentStatusHooksEnabled(store.getSettings?.())
  }

  private wireUpRemoteWorkspaceEvents(mux: SshChannelMultiplexer): void {
    mux.onNotification((method, params) => {
      notifyRemoteWorkspaceHandlers(this.targetId, method, params)
    })
  }

  // Why: relay sends connectionId:null, so stamp this.targetId here so the renderer can drop events from torn-down connections.
  private wireUpAgentHookEvents(mux: SshChannelMultiplexer): void {
    if (!isRemoteAgentHooksEnabled()) {
      return
    }
    // Why: capture the disposer so teardownProviders can release this handler and re-wiring can't double-register it.
    this.muxNotificationCleanup?.()
    this.muxNotificationCleanup = mux.onNotification((method, params) => {
      if (method !== AGENT_HOOK_NOTIFICATION_METHOD) {
        return
      }
      const envelope = params as {
        paneKey?: unknown
        launchToken?: unknown
        tabId?: unknown
        worktreeId?: unknown
        env?: unknown
        version?: unknown
        hasExplicitPrompt?: unknown
        promptInteractionKey?: unknown
        hookEventName?: unknown
        source?: unknown
        providerPromptId?: unknown
        compactTrigger?: unknown
        toolUseId?: unknown
        toolAgentId?: unknown
        teammateName?: unknown
        toolAgentType?: unknown
        isReplay?: unknown
        providerSession?: unknown
        providerSessionOnly?: unknown
        shedFields?: unknown
        claudeRunningNonAgentTask?: unknown
        payload?: unknown
      }
      if (typeof envelope.paneKey !== 'string') {
        return
      }
      // Why: forward the agent CLI's env/version verbatim (not the relay's) so warn-once protocol-mismatch diagnostics fire for remote events too.
      agentHookServer.ingestRemote(
        {
          paneKey: envelope.paneKey,
          launchToken: typeof envelope.launchToken === 'string' ? envelope.launchToken : undefined,
          tabId: typeof envelope.tabId === 'string' ? envelope.tabId : undefined,
          worktreeId: typeof envelope.worktreeId === 'string' ? envelope.worktreeId : undefined,
          env: typeof envelope.env === 'string' ? envelope.env : undefined,
          version: typeof envelope.version === 'string' ? envelope.version : undefined,
          hasExplicitPrompt: envelope.hasExplicitPrompt === true ? true : undefined,
          promptInteractionKey:
            typeof envelope.promptInteractionKey === 'string'
              ? envelope.promptInteractionKey
              : undefined,
          hookEventName:
            typeof envelope.hookEventName === 'string' ? envelope.hookEventName : undefined,
          source: envelope.source,
          providerPromptId: envelope.providerPromptId,
          compactTrigger: envelope.compactTrigger,
          toolUseId: typeof envelope.toolUseId === 'string' ? envelope.toolUseId : undefined,
          toolAgentId: typeof envelope.toolAgentId === 'string' ? envelope.toolAgentId : undefined,
          teammateName:
            typeof envelope.teammateName === 'string' ? envelope.teammateName : undefined,
          toolAgentType:
            typeof envelope.toolAgentType === 'string' ? envelope.toolAgentType : undefined,
          isReplay: envelope.isReplay === true ? true : undefined,
          providerSession: envelope.providerSession,
          providerSessionOnly: envelope.providerSessionOnly === true ? true : undefined,
          // Why: names the fields the relay dropped to fit the frame; ingestRemote restores them.
          shedFields: envelope.shedFields,
          claudeRunningNonAgentTask:
            typeof envelope.claudeRunningNonAgentTask === 'boolean'
              ? envelope.claudeRunningNonAgentTask
              : undefined,
          payload: envelope.payload
        },
        this.targetId
      )
    })

    // Why: request replay of cached paneKeys only after the handler is wired, so replayed events can't arrive before we subscribe. Best-effort.
    void mux.request(AGENT_HOOK_REQUEST_REPLAY_METHOD).catch((err) => {
      const code = (err as { code?: unknown })?.code
      if (code === -32601 || code === 'CONNECTION_LOST' || code === 'DISPOSED') {
        return
      }
      if (mux.isDisposed()) {
        return
      }
      // Why: suppress the warn when a normal teardown rejects the in-flight request, so reconnect cycles aren't noisy.
      if (mux.isDisposed()) {
        return
      }
      console.warn(
        `[ssh-relay-session] agent_hook.requestReplay failed for ${this.targetId}: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
    })
  }

  private teardownProviders(
    reason: 'shutdown' | 'connection_lost',
    outputGenerationReason: string = reason
  ): void {
    this.releaseRelayLossWatcher()
    this.muxNotificationCleanup?.()
    this.muxNotificationCleanup = null
    for (const cleanup of this.ptyRecoveryNotificationCleanups) {
      cleanup()
    }
    this.ptyRecoveryNotificationCleanups = []
    if (this.activePtyProviderGeneration !== null) {
      const providerGeneration = this.activePtyProviderGeneration
      if (reason === 'connection_lost' && this.activePtyConsumerOwner()?.outputFlowControl) {
        this.beginPtyModelMigration(providerGeneration, outputGenerationReason)
      } else {
        closeSshPtyOutputGeneration(providerGeneration, outputGenerationReason)
      }
      this.activePtyProviderGeneration = null
    }
    this.sourceAckPublisherCleanup?.()
    this.sourceAckPublisherCleanup = null
    this.sourceCancellationPublisherCleanup?.()
    this.sourceCancellationPublisherCleanup = null
    if (this.mux && !this.mux.isDisposed()) {
      this.mux.dispose(reason)
    }
    this.mux = null
    for (const attachmentId of this.activeCompatibilityAttachmentIds) {
      this.runtime?.releaseOrchestrationCompatibilitySshAttachment(attachmentId)
    }
    this.activeCompatibilityAttachmentIds.clear()

    if (reason === 'shutdown') {
      clearPtyOwnershipForConnection(this.targetId)
    } else {
      // Why: handlers detached above, so no late event can re-stamp status between this clear and reconnect replay.
      agentHookServer.clearStatusEntriesForConnection(this.targetId)
    }

    const ptyProvider = getSshPtyProvider(this.targetId)
    if (ptyProvider && 'dispose' in ptyProvider) {
      ;(ptyProvider as { dispose: () => void }).dispose()
    }
    const fsProvider = getSshFilesystemProvider(this.targetId)
    if (fsProvider && 'dispose' in fsProvider) {
      ;(fsProvider as { dispose: () => void }).dispose()
    }

    unregisterSshPtyProvider(this.targetId)
    unregisterSshFilesystemProvider(this.targetId)
    unregisterSshGitProvider(this.targetId)
    this.sourceIdentityByRelayPtyId.clear()
    this.retiredSourceDeliveries.clear()
    this.rejectedPtyRecoveryAttempts.clear()
    for (const timer of this.rejectedPtyRecoveryRetries) {
      clearTimeout(timer)
    }
    this.rejectedPtyRecoveryRetries.clear()
    this.rejectedPtyReattaches.clear()
    this.ptyFrameRejectionLog.clear()
    for (const pending of this.pendingPtyReattaches.values()) {
      for (const resolve of pending.recoveryWaiters) {
        resolve()
      }
    }
    this.pendingPtyReattaches.clear()
    this.ptyRecoveryRetention.clear()
  }

  // Why: back-compat for old relays that gate FS ops on registered roots; removable post-cutover (docs/relay-fs-allowlist-removal.md).
  private async registerRelayRoots(mux: SshChannelMultiplexer): Promise<void> {
    const remoteRepos = this.store.getRepos().filter((r) => r.connectionId === this.targetId)

    for (const repo of remoteRepos) {
      mux.notify('session.registerRoot', { rootPath: repo.path })
    }

    // Why: git.listWorktrees requires the repo root to be registered first.
    await Promise.all(
      remoteRepos.map(async (repo) => {
        try {
          const worktrees = (await mux.request('git.listWorktrees', {
            repoPath: repo.path
          })) as { path: string }[]
          for (const wt of worktrees) {
            if (wt.path !== repo.path) {
              mux.notify('session.registerRoot', { rootPath: wt.path })
            }
          }
        } catch {
          // git worktree list may fail for folder-mode repos — not fatal
        }
      })
    )
  }

  // Why: shared by establish()/reconnect() so both paths reset renderer lists the same way.
  private broadcastEmptyLists(): void {
    const win = this.getMainWindow()
    if (!win || win.isDestroyed()) {
      return
    }
    win.webContents.send('ssh:port-forwards-changed', {
      targetId: this.targetId,
      forwards: []
    })
    win.webContents.send('ssh:detected-ports-changed', {
      targetId: this.targetId,
      ports: []
    })
  }

  private startPortScanning(): void {
    if (!this.mux || this.isDisposed()) {
      return
    }
    // Why: each scan walks /proc/*/fd remotely, so skip ticks while the window is hidden and rescan when it returns.
    const scanner = new PortScanner({
      isWindowVisible: () => isMainWindowVisible(this.getMainWindow()),
      onWindowBecameVisible: onMainWindowBecameVisible
    })
    this.portScanner = scanner
    // Why: guard against a late ports.detect callback from a pre-reconnect scanner publishing stale results into the new session.
    scanner.startScanning(this.targetId, this.mux, (targetId, ports, platform) => {
      if (this.portScanner !== scanner) {
        return
      }
      this.onDetectedPortsChanged?.(targetId, ports, platform)
    })
  }

  private stopPortScanning(): void {
    if (this.portScanner) {
      this.portScanner.stopScanning(this.targetId)
      this.portScanner = null
    }
  }

  private wireUpPtyEvents(
    ptyProvider: SshPtyProvider,
    mux: SshChannelMultiplexer,
    providerGeneration: number
  ): void {
    ptyProvider.onData((payload) => {
      if (
        this.mux !== mux ||
        this.activePtyProviderGeneration !== providerGeneration ||
        payload.providerGeneration !== providerGeneration
      ) {
        return
      }
      const pending = this.pendingPtyReattaches.get(payload.id)
      if (pending && this.activePtyConsumerOwner()?.outputFlowControl) {
        if (pending.livePassthrough) {
          void this.acceptPtyData(payload).catch(() => {})
          return
        }
        this.quarantineReattachData(pending, payload)
        return
      }
      void this.acceptPtyData(payload).catch(() => {})
    })
    ptyProvider.onRejectedData?.((payload) => {
      if (
        this.mux !== mux ||
        this.activePtyProviderGeneration !== providerGeneration ||
        payload.providerGeneration !== providerGeneration
      ) {
        return
      }
      const pending = this.pendingPtyReattaches.get(payload.id)
      if (pending) {
        pending.restoreRequired = payload.sourceMalformed
          ? 'recoverySourceMalformed'
          : 'recoverySourceUnadmitted'
        this.wakeRecovery(pending)
        return
      }
      void this.acceptPtyData(payload).catch(() => {})
    })
    ptyProvider.onReplay((payload) => {
      if (this.mux !== mux || this.activePtyProviderGeneration !== providerGeneration) {
        return
      }
      const win = this.getMainWindow()
      if (win && !win.isDestroyed()) {
        win.webContents.send('pty:replay', payload)
      }
    })
    ptyProvider.onExit((payload) => {
      if (
        this.mux !== mux ||
        this.activePtyProviderGeneration !== providerGeneration ||
        payload.providerGeneration !== providerGeneration
      ) {
        return
      }
      const pendingReattach = this.pendingPtyReattaches.get(payload.id)
      if (pendingReattach && !pendingReattach.activated) {
        // Why: attach response and exit can share one transport batch, before incarnation restoration runs.
        pendingReattach.exits.push(payload)
        this.wakeRecovery(pendingReattach)
        return
      }
      if (!isCurrentPtyExit(payload)) {
        return
      }
      void this.acceptPtyExit(payload).catch(() => {})
    })
  }

  private acceptPtyData(payload: SshPtyDataPayload): Promise<unknown> {
    const consumerOwner = this.activePtyConsumerOwner()
    const offeredSource = payload.source
    if (
      offeredSource &&
      this.retiredSourceDeliveries.has(payload.providerGeneration, offeredSource)
    ) {
      return Promise.resolve()
    }
    const rejection = classifySshPtyFrameRejection(payload, consumerOwner)
    if (rejection) {
      if (offeredSource) {
        this.retiredSourceDeliveries.retire(payload.providerGeneration, offeredSource)
      }
      this.ptyFrameRejectionLog.record(payload, consumerOwner, rejection)
      if (rejection.action === 'retire-and-reattach-delivery') {
        this.recoverRejectedPtyDelivery(payload, offeredSource)
      }
      return Promise.resolve()
    }
    const source = consumerOwner?.outputFlowControl ? offeredSource : undefined
    if (source && consumerOwner) {
      const current = this.sourceIdentityByRelayPtyId.get(source.relayPtyId)
      if (
        source.sourceEndSu <= source.sourceStartSu ||
        (current &&
          (current.deliveryToken !== source.deliveryToken ||
            current.clientGeneration !== source.clientGeneration ||
            current.ownerGeneration !== source.ownerGeneration ||
            current.ptyIncarnation !== payload.ptyIncarnation ||
            (current.nextSourceSu !== undefined && current.nextSourceSu !== source.sourceStartSu)))
      ) {
        const rejection = {
          reason: 'source-range-invalid',
          action: 'retire-and-reattach-delivery'
        } as const
        this.retiredSourceDeliveries.retire(payload.providerGeneration, source)
        this.ptyFrameRejectionLog.record(payload, consumerOwner, rejection)
        this.recoverRejectedPtyDelivery(payload, source)
        return Promise.resolve()
      }
      this.sourceIdentityByRelayPtyId.set(source.relayPtyId, {
        deliveryToken: source.deliveryToken,
        clientGeneration: source.clientGeneration,
        ownerGeneration: source.ownerGeneration,
        ptyIncarnation: payload.ptyIncarnation,
        nextSourceSu: source.sourceEndSu
      })
    }
    const rawLength = payload.sequenceChars ?? payload.data.length
    return acceptSshPtyOutputData({
      id: payload.id,
      data: payload.data,
      providerGeneration: payload.providerGeneration,
      ptyIncarnation: payload.ptyIncarnation,
      rawLength,
      transformed: payload.transformed === true,
      ...(typeof payload.seq === 'number' ? { sequence: payload.seq } : {}),
      ...(source ? { source } : {})
    })
  }

  private recoverRejectedPtyDelivery(
    payload: SshPtyDataPayload,
    source: SshPtyDataPayload['source']
  ): void {
    const mux = this.mux
    const providerGeneration = this.activePtyProviderGeneration
    let relayPtyId: string
    try {
      relayPtyId = source?.relayPtyId ?? toRelaySshPtyId(this.targetId, payload.id)
    } catch {
      return
    }
    const appPtyId = toAppSshPtyId(this.targetId, relayPtyId)
    if (
      payload.id !== appPtyId ||
      !mux ||
      mux.isDisposed() ||
      providerGeneration !== payload.providerGeneration ||
      this.pendingPtyReattaches.has(appPtyId) ||
      this.rejectedPtyReattaches.has(appPtyId)
    ) {
      return
    }
    if (payload.rejectedSourceRecovery === 'reconnect-channel') {
      console.warn(
        `[ssh-relay-session] PTY ${relayPtyId} delivery identity could not be retired safely for ${this.targetId}; dropping the relay channel to reconnect`
      )
      mux.dispose('connection_lost')
      return
    }
    const previous = this.rejectedPtyRecoveryAttempts.get(appPtyId)
    const attempt =
      previous?.providerGeneration === providerGeneration
        ? previous
        : { providerGeneration, attempts: 0, generationAttempts: 0, reported: false }
    if (
      attempt.attempts >= SSH_REJECTED_PTY_RECOVERY_MAX_ATTEMPTS ||
      attempt.generationAttempts >= SSH_REJECTED_PTY_RECOVERY_MAX_GENERATION_ATTEMPTS
    ) {
      if (!attempt.reported) {
        attempt.reported = true
        console.warn(
          `[ssh-relay-session] PTY ${relayPtyId} delivery recovery exhausted for ${this.targetId}; dropping the relay channel to reconnect`
        )
        // Why a channel drop and not a terminal relay error: a terminal error clears the reconnect
        // backoff, rotates provider authority (aborting every in-flight fs and git request on the
        // target) and parks the target in a manual-recovery state — over one PTY's delivery. Losing
        // the channel is the recoverable escalation, and it is what this path did before targeted
        // recovery existed.
        mux.dispose('connection_lost')
      }
      return
    }
    attempt.attempts++
    attempt.generationAttempts++
    this.rejectedPtyRecoveryAttempts.set(appPtyId, attempt)
    void this.rejectedPtyReattaches
      .run(appPtyId, () =>
        this.reattachRejectedPty(
          relayPtyId,
          mux,
          providerGeneration,
          payload.rejectedSourceRecovery === 'fresh-activation'
            ? 'fresh-activation'
            : 'confirm-existing'
        )
      )
      .then(
        (recovered) => {
          if (recovered) {
            // Why only a completed reattach clears this: an accepted frame proves nothing about the
            // delivery that was rejected, and resetting on one lets a flapping PTY reattach forever.
            attempt.attempts = 0
            return
          }
          this.retryRejectedPtyDelivery(payload, source, appPtyId)
        },
        (error: unknown) => {
          console.warn(`[ssh-relay-session] PTY ${relayPtyId} targeted delivery recovery failed`, {
            providerGeneration,
            error: error instanceof Error ? error.message : String(error)
          })
          this.retryRejectedPtyDelivery(payload, source, appPtyId)
        }
      )
  }

  // Why liveness is checked before retrying: reattachKnownPty resolves without claiming the lease
  // when the PTY exited mid-attach, which is indistinguishable from a failed reattach at the call
  // site. Retrying that race twice would drop the relay channel over an ordinary PTY exit.
  private retryRejectedPtyDelivery(
    payload: SshPtyDataPayload,
    source: SshPtyDataPayload['source'],
    appPtyId: string
  ): void {
    const ptyProvider = getSshPtyProvider(this.targetId) as SshPtyProvider | undefined
    if (!ptyProvider || typeof ptyProvider.hasPty !== 'function' || !ptyProvider.hasPty(appPtyId)) {
      this.rejectedPtyRecoveryAttempts.delete(appPtyId)
      return
    }
    const timer = setTimeout(() => {
      this.rejectedPtyRecoveryRetries.delete(timer)
      this.recoverRejectedPtyDelivery(payload, source)
    }, SSH_REJECTED_PTY_RECOVERY_RETRY_DELAY_MS)
    timer.unref?.()
    this.rejectedPtyRecoveryRetries.add(timer)
  }

  private async reattachRejectedPty(
    relayPtyId: string,
    mux: SshChannelMultiplexer,
    providerGeneration: number,
    targetedDeliveryRecovery: TargetedDeliveryRecovery
  ): Promise<boolean> {
    const shouldContinue = () =>
      this.mux === mux &&
      !mux.isDisposed() &&
      this.activePtyProviderGeneration === providerGeneration
    const ptyProvider = getSshPtyProvider(this.targetId) as SshPtyProvider | undefined
    // Why re-checked here: this can have waited for a queue slot, and a superseded generation must
    // not pay for a lease read or an attach round trip.
    if (!ptyProvider || !shouldContinue()) {
      return false
    }
    const activeLease = this.store
      .getSshRemotePtyLeases(this.targetId)
      .find(
        (lease) =>
          lease.ptyId === relayPtyId && lease.state !== 'terminated' && lease.state !== 'expired'
      )
    const activeLeaseByPtyId = activeLease
      ? new Map<string, SshPtyLease>([[relayPtyId, activeLease]])
      : new Map<string, SshPtyLease>()
    const expectedIdentity = activeLease ? expectedIdentityForLease(activeLease) : undefined
    const attachedLeaseIds = new Set<string>()
    await this.reattachKnownPty({
      ptyProvider,
      ptyId: relayPtyId,
      activeLeaseByPtyId,
      expectedIdentityByPtyId: expectedIdentity
        ? new Map([[relayPtyId, expectedIdentity]])
        : new Map(),
      attachedLeaseIds,
      mux,
      providerGeneration,
      shouldContinue,
      targetedDeliveryRecovery
    })
    if (attachedLeaseIds.size > 0 && shouldContinue()) {
      await this.store.markSshRemotePtyLeasesAttachedAsync(
        this.targetId,
        Array.from(attachedLeaseIds)
      )
    }
    return attachedLeaseIds.has(relayPtyId)
  }

  private quarantineReattachData(pending: PendingPtyReattach, payload: SshPtyDataPayload): void {
    this.observePrivateRecoveryFrame(pending, payload)
    if (pending.restoreRequired) {
      return
    }
    const sourceSu = payload.source
      ? payload.source.sourceEndSu - payload.source.sourceStartSu
      : (payload.sequenceChars ?? payload.data.length)
    if (!this.ptyRecoveryRetention.tryRetain(pending.retentionKey, payload.data, sourceSu)) {
      pending.restoreRequired = 'recoveryQuarantineCapacityExceeded'
      this.wakeRecovery(pending)
      return
    }
    this.routeQuarantinedReattachData(pending, payload)
  }

  private routeQuarantinedReattachData(
    pending: PendingPtyReattach,
    payload: SshPtyDataPayload
  ): void {
    this.observePrivateRecoveryFrame(pending, payload)
    if (!pending.recovery) {
      pending.queuedData.push(payload)
      return
    }
    if (
      pending.recoveryComplete &&
      pending.nextRecoverySourceSu === pending.recovery.recoveryEndSu
    ) {
      pending.liveData.push(payload)
      return
    }
    this.admitRecoveryData(pending, payload)
  }

  private observePrivateRecoveryFrame(
    pending: PendingPtyReattach,
    payload: SshPtyDataPayload
  ): void {
    const recovery = pending.recovery
    if (
      recovery &&
      payload.source?.deliveryToken === recovery.deliveryToken &&
      payload.source.clientGeneration === recovery.clientGeneration &&
      payload.source.ownerGeneration === recovery.ownerGeneration &&
      payload.ptyIncarnation === recovery.ptyIncarnation
    ) {
      pending.highestRecoverySourceEndSu = Math.max(
        pending.highestRecoverySourceEndSu ?? recovery.checkpointSourceEndSu,
        payload.source.sourceEndSu
      )
    }
  }

  private admitRecoveryData(pending: PendingPtyReattach, payload: SshPtyDataPayload): void {
    if (pending.restoreRequired) {
      return
    }
    const recovery = pending.recovery
    const nextSourceSu = pending.nextRecoverySourceSu
    if (
      !recovery ||
      !payload.source ||
      nextSourceSu === undefined ||
      payload.source.deliveryToken !== recovery.deliveryToken ||
      payload.source.clientGeneration !== recovery.clientGeneration ||
      payload.source.ownerGeneration !== recovery.ownerGeneration ||
      payload.source.sourceStartSu !== nextSourceSu ||
      payload.source.sourceEndSu <= payload.source.sourceStartSu ||
      payload.source.sourceEndSu > recovery.recoveryEndSu ||
      payload.ptyIncarnation !== recovery.ptyIncarnation
    ) {
      pending.restoreRequired = 'recoveryFrameIdentityMismatch'
      this.wakeRecovery(pending)
      return
    }
    pending.nextRecoverySourceSu = payload.source.sourceEndSu
    pending.recoveryData.push(payload)
  }

  private installPtyRecoveryNotifications(mux: SshChannelMultiplexer): void {
    for (const cleanup of this.ptyRecoveryNotificationCleanups) {
      cleanup()
    }
    this.ptyRecoveryNotificationCleanups = [
      mux.onNotificationByMethod('pty.recoveryComplete', (params) => {
        if (this.mux !== mux) {
          return
        }
        const id = typeof params.id === 'string' ? toAppSshPtyId(this.targetId, params.id) : ''
        const pending = this.pendingPtyReattaches.get(id)
        if (!pending || pending.mux !== mux) {
          return
        }
        const complete = parseRecoveryComplete(params)
        if (!complete) {
          pending.restoreRequired = 'invalidRecoveryComplete'
        } else {
          pending.recoveryComplete = complete
        }
        this.wakeRecovery(pending)
      }),
      mux.onNotificationByMethod('pty.restoreRequired', (params) => {
        if (this.mux !== mux) {
          return
        }
        const id = typeof params.id === 'string' ? toAppSshPtyId(this.targetId, params.id) : ''
        const pending = this.pendingPtyReattaches.get(id)
        if (!pending || pending.mux !== mux) {
          return
        }
        pending.restoreRequired =
          typeof params.reason === 'string' ? params.reason : 'relayRestoreRequired'
        this.wakeRecovery(pending)
      }),
      mux.onNotificationByMethod('pty.deliveryCanceled', (params) => {
        if (this.mux !== mux) {
          return
        }
        const id = typeof params.id === 'string' ? params.id : ''
        const identity = this.sourceIdentityByRelayPtyId.get(id)
        if (
          !identity ||
          params.deliveryToken !== identity.deliveryToken ||
          params.clientGeneration !== identity.clientGeneration ||
          params.ownerGeneration !== identity.ownerGeneration ||
          params.ptyIncarnation !== identity.ptyIncarnation
        ) {
          return
        }
        const replacementDeliveryToken =
          typeof params.replacementDeliveryToken === 'string' ? params.replacementDeliveryToken : ''
        const pending = this.pendingPtyReattaches.get(toAppSshPtyId(this.targetId, id))
        if (pending?.mux === mux) {
          if (
            replacementDeliveryToken.length === 0 ||
            replacementDeliveryToken === identity.deliveryToken
          ) {
            pending.restoreRequired =
              typeof params.reason === 'string'
                ? `relayDeliveryCanceled:${params.reason}`
                : 'relayDeliveryCanceled'
            this.wakeRecovery(pending)
            return
          }
          if (
            pending.replacementDeliveryToken &&
            pending.replacementDeliveryToken !== replacementDeliveryToken
          ) {
            pending.restoreRequired = 'recoveryReplacementTokenMismatch'
            this.wakeRecovery(pending)
            return
          }
          pending.replacementDeliveryToken = replacementDeliveryToken
          return
        }
        const generation = this.activePtyProviderGeneration
        if (
          generation !== null &&
          Number.isSafeInteger(params.sentEndSu) &&
          Number.isSafeInteger(params.creditedEndSu)
        ) {
          try {
            applySshPtySourceCancellationProof(
              {
                id: toAppSshPtyId(this.targetId, id),
                code: -1,
                providerGeneration: generation,
                ptyIncarnation: identity.ptyIncarnation
              },
              {
                sentEndSu: params.sentEndSu as number,
                creditedEndSu: params.creditedEndSu as number
              }
            )
            this.retiredSourceDeliveries.retire(generation, {
              relayPtyId: id,
              ...identity
            })
            this.sourceIdentityByRelayPtyId.delete(id)
          } catch {
            /* Invalid proof retains the active token identity. */
          }
        }
      })
    ]
  }

  private wakeRecovery(pending: PendingPtyReattach): void {
    for (const resolve of pending.recoveryWaiters) {
      resolve()
    }
    pending.recoveryWaiters.clear()
  }

  private async acceptPtyExit(payload: SshPtyExitPayload): Promise<void> {
    await acceptSshPtyOutputExit({
      id: payload.id,
      code: payload.code,
      providerGeneration: payload.providerGeneration,
      ptyIncarnation: payload.ptyIncarnation
    })
    if (isCurrentPtyExit(payload)) {
      this.retireExitedPty(payload, true)
    }
  }

  private retireExitedPty(payload: SshPtyExitPayload, deliveryHandled = false): void {
    const relayPtyId = toRelaySshPtyId(this.targetId, payload.id)
    this.retiredSourceDeliveries.activate(relayPtyId)
    clearProviderPtyState(payload.id)
    deletePtyOwnership(payload.id)
    this.rejectedPtyRecoveryAttempts.delete(payload.id)
    getSshPtyConsumerRecovery(this.targetId)?.checkpointsByAppPtyId.delete(payload.id)
    getSshPtyConsumerRecovery(this.targetId)?.checkpointsByAppPtyId.delete(
      toRelaySshPtyId(this.targetId, payload.id)
    )
    this.store.markSshRemotePtyLease(this.targetId, relayPtyId, 'terminated')
    if (deliveryHandled) {
      return
    }
    this.runtime?.onPtyExit(payload.id, payload.code, payload.incarnationId)
    const win = this.getMainWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send('pty:exit', payload)
    }
  }

  private forwardReattachReplay(appPtyId: string, data: string): void {
    if (!data) {
      return
    }
    const win = this.getMainWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send('pty:replay', { id: appPtyId, data })
    }
  }

  private async reattachKnownPtys(
    mux: SshChannelMultiplexer,
    shouldContinue: () => boolean
  ): Promise<void> {
    const activeLeases = this.store
      .getSshRemotePtyLeases(this.targetId)
      .filter((lease) => lease.state !== 'terminated' && lease.state !== 'expired')
    const activeLeaseByPtyId = new Map(activeLeases.map((lease) => [lease.ptyId, lease]))
    const leasedPtyIds = activeLeases.map((lease) => lease.ptyId)
    // Why: pass pane identity so the relay can reject cross-generation id collisions; tabId falls back for pre-leafId leases.
    const expectedIdentityByPtyId = new Map(
      activeLeases
        .map((lease): [string, ExpectedPtyIdentity] | null => {
          const expected = expectedIdentityForLease(lease)
          return expected ? [lease.ptyId, expected] : null
        })
        .filter((entry): entry is [string, ExpectedPtyIdentity] => entry !== null)
    )
    const attachedLeaseIds = new Set<string>()
    // Why: after app restart ptyOwnership is empty, but durable SSH leases still describe grace-window survivors.
    const ptyIds = Array.from(
      new Set([
        ...getPtyIdsForConnection(this.targetId).map((ptyId) =>
          toRelaySshPtyId(this.targetId, ptyId)
        ),
        ...leasedPtyIds
      ])
    )
    const ptyProvider = getSshPtyProvider(this.targetId) as SshPtyProvider | undefined
    const providerGeneration = this.activePtyProviderGeneration
    if (!ptyProvider || providerGeneration === null || this.mux !== mux) {
      return
    }
    let nextPtyIndex = 0
    const worker = async (): Promise<void> => {
      while (shouldContinue()) {
        const ptyId = ptyIds[nextPtyIndex++]
        if (ptyId === undefined) {
          return
        }
        try {
          await this.reattachKnownPty({
            ptyProvider,
            ptyId,
            activeLeaseByPtyId,
            expectedIdentityByPtyId,
            attachedLeaseIds,
            mux,
            providerGeneration,
            shouldContinue
          })
        } catch (error) {
          if (isSourceRecoveryCancellationError(error)) {
            throw error
          }
          console.warn(
            `[ssh-relay-session] PTY ${ptyId} reattach processing failed for ${this.targetId}: ${
              error instanceof Error ? error.message : String(error)
            }`
          )
        }
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(SSH_PTY_REATTACH_MAX_CONCURRENCY, ptyIds.length) }, worker)
    )
    if (attachedLeaseIds.size > 0 && shouldContinue()) {
      await this.store.markSshRemotePtyLeasesAttachedAsync(
        this.targetId,
        Array.from(attachedLeaseIds)
      )
    }
  }

  private async reattachKnownPty(args: {
    ptyProvider: SshPtyProvider
    ptyId: string
    activeLeaseByPtyId: Map<string, SshPtyLease>
    expectedIdentityByPtyId: Map<string, ExpectedPtyIdentity>
    attachedLeaseIds: Set<string>
    mux: SshChannelMultiplexer
    providerGeneration: number
    shouldContinue: () => boolean
    targetedDeliveryRecovery?: TargetedDeliveryRecovery
  }): Promise<void> {
    const {
      ptyProvider,
      ptyId,
      activeLeaseByPtyId,
      expectedIdentityByPtyId,
      attachedLeaseIds,
      mux,
      providerGeneration,
      shouldContinue,
      targetedDeliveryRecovery
    } = args
    const appPtyId = toAppSshPtyId(this.targetId, ptyId)
    const pendingReattach: PendingPtyReattach = {
      mux,
      providerGeneration,
      retentionKey: `${providerGeneration}\0${appPtyId}\0${randomUUID()}`,
      exits: [],
      queuedData: [],
      recoveryData: [],
      liveData: [],
      recoveryWaiters: new Set(),
      livePassthrough: false,
      activated: false
    }
    this.pendingPtyReattaches.set(appPtyId, pendingReattach)
    let sourceActivationLease: SshPtyAttachResult['sourceActivationLease']
    let recoveryActivationLease: SshPtyRecoveryActivationLease | undefined
    try {
      const recoveryRequest =
        targetedDeliveryRecovery === 'fresh-activation'
          ? undefined
          : await this.sourceRecoveryRequest(appPtyId)
      const attachResult = await this.attachPtyWithRetry(
        ptyProvider,
        ptyId,
        expectedIdentityByPtyId.get(ptyId),
        recoveryRequest,
        shouldContinue
      )
      sourceActivationLease = attachResult.sourceActivationLease
      if (!shouldContinue()) {
        return
      }
      const exitDuringAttach = pendingReattach.exits.find(
        (exit) =>
          !exit.incarnationId ||
          !attachResult.incarnationId ||
          exit.incarnationId === attachResult.incarnationId
      )
      if (exitDuringAttach && !recoveryRequest) {
        if (attachResult.incarnationId) {
          restorePtyIncarnation(appPtyId, attachResult.incarnationId)
          this.runtime?.acceptPtyIncarnationForExit(appPtyId, attachResult.incarnationId)
        }
        await this.acceptPtyExit(exitDuringAttach)
        return
      }
      const existingDeliveryConfirmed =
        targetedDeliveryRecovery === 'confirm-existing' &&
        recoveryRequest?.status === 'checkpoint' &&
        !attachResult.sourceRecovery &&
        Boolean(
          attachResult.sourceActivation &&
          this.sameSourceDelivery(attachResult.sourceActivation, recoveryRequest)
        )
      if (targetedDeliveryRecovery) {
        const owner = this.activePtyConsumerOwner()
        const activation = attachResult.sourceActivation
        if (
          !owner?.outputFlowControl ||
          !activation ||
          activation.clientGeneration !== owner.clientGeneration ||
          activation.ownerGeneration !== owner.ownerGeneration
        ) {
          return
        }
      }
      if (recoveryRequest && !existingDeliveryConfirmed) {
        const recovered = await this.finishSourceRecovery(
          ptyId,
          appPtyId,
          attachResult,
          recoveryRequest,
          pendingReattach,
          shouldContinue,
          () => {
            const lease = sourceActivationLease
            if (!lease) {
              return
            }
            recoveryActivationLease = lease.transferToRecovery((payload) =>
              this.quarantineReattachData(pendingReattach, payload)
            )
            sourceActivationLease = undefined
          }
        )
        if (!recovered) {
          const recoveryExit = this.findExactPendingExit(
            pendingReattach,
            attachResult.incarnationId
          )
          if (
            recoveryExit &&
            shouldContinue() &&
            this.ownsPtyRecoveryAttempt(appPtyId, pendingReattach)
          ) {
            if (recoveryActivationLease) {
              recoveryActivationLease.retire()
              recoveryActivationLease = undefined
            } else if (sourceActivationLease) {
              const canceled = await sourceActivationLease.rollback()
              sourceActivationLease = undefined
              if (!canceled) {
                throw sourceRecoveryCancellationError(
                  new Error('ssh_source_activation_cancellation_unproven')
                )
              }
            }
            this.preparePtyIncarnationForExit(appPtyId, attachResult.incarnationId)
            await this.acceptPtyExit(recoveryExit)
          }
          return
        }
        const recoveryExit = this.findExactPendingExit(pendingReattach, attachResult.incarnationId)
        if (recoveryExit) {
          this.preparePtyIncarnationForExit(appPtyId, attachResult.incarnationId)
          pendingReattach.activated = true
          recoveryActivationLease?.commit()
          recoveryActivationLease = undefined
          await this.acceptPtyExit(recoveryExit)
          return
        }
      }
      if (!shouldContinue() || !this.ownsPtyRecoveryAttempt(appPtyId, pendingReattach)) {
        return
      }
      setPtyOwnership(appPtyId, this.targetId)
      if (attachResult.incarnationId) {
        restorePtyIncarnation(appPtyId, attachResult.incarnationId)
        this.restoreReattachedPtyRuntime(
          appPtyId,
          attachResult.incarnationId,
          activeLeaseByPtyId.get(ptyId)
        )
      }
      attachedLeaseIds.add(ptyId)
      pendingReattach.activated = true
      recoveryActivationLease?.commit()
      recoveryActivationLease = undefined
      if (targetedDeliveryRecovery) {
        if (targetedDeliveryRecovery === 'fresh-activation') {
          this.retiredSourceDeliveries.activate(ptyId)
          this.sourceIdentityByRelayPtyId.delete(ptyId)
          getSshPtyConsumerRecovery(this.targetId)?.checkpointsByAppPtyId.delete(appPtyId)
          getSshPtyConsumerRecovery(this.targetId)?.checkpointsByAppPtyId.delete(ptyId)
        }
        while (pendingReattach.queuedData.length > 0) {
          await this.acceptPtyData(pendingReattach.queuedData.shift()!)
        }
        pendingReattach.livePassthrough = true
      }
      const exitAfterActivation = pendingReattach.exits.find(
        (exit) =>
          !exit.incarnationId ||
          !attachResult.incarnationId ||
          exit.incarnationId === attachResult.incarnationId
      )
      if (exitAfterActivation) {
        await this.acceptPtyExit(exitAfterActivation)
        return
      }
      if (!recoveryRequest && !targetedDeliveryRecovery) {
        this.forwardReattachReplay(appPtyId, attachResult.replay ?? '')
      }
      sourceActivationLease?.commit()
      sourceActivationLease = undefined
    } catch (error) {
      if (isSourceRecoveryCancellationError(error)) {
        throw error
      }
      if (!shouldContinue()) {
        return
      }
      this.handlePtyReattachFailure(ptyId, appPtyId, pendingReattach, error)
    } finally {
      recoveryActivationLease?.retire()
      sourceActivationLease?.rollback()
      if (this.pendingPtyReattaches.get(appPtyId) === pendingReattach) {
        this.pendingPtyReattaches.delete(appPtyId)
      }
      this.ptyRecoveryRetention.release(pendingReattach.retentionKey)
    }
  }

  private findExactPendingExit(
    pending: PendingPtyReattach,
    ptyIncarnation: string | undefined
  ): SshPtyExitPayload | undefined {
    if (!ptyIncarnation) {
      return undefined
    }
    return pending.exits.find(
      (exit) =>
        exit.providerGeneration === pending.providerGeneration &&
        exit.ptyIncarnation === ptyIncarnation
    )
  }

  private preparePtyIncarnationForExit(appPtyId: string, ptyIncarnation: string | undefined): void {
    if (!ptyIncarnation) {
      return
    }
    restorePtyIncarnation(appPtyId, ptyIncarnation)
    this.runtime?.acceptPtyIncarnationForExit(appPtyId, ptyIncarnation)
  }

  private restoreReattachedPtyRuntime(
    appPtyId: string,
    incarnationId: string,
    lease: SshPtyLease | undefined
  ): void {
    if (lease?.worktreeId && lease.tabId && lease.leafId) {
      this.runtime?.registerPty(appPtyId, lease.worktreeId, this.targetId, {
        tabId: lease.tabId,
        leafId: lease.leafId,
        incarnationId
      })
      try {
        this.store.persistPtyBinding({
          worktreeId: lease.worktreeId,
          tabId: lease.tabId,
          leafId: lease.leafId,
          ptyId: appPtyId,
          incarnationId
        })
      } catch (error) {
        console.error('[ssh-relay-session] Failed to persist reconnect incarnation:', error)
      }
      return
    }
    this.runtime?.onPtySpawned(appPtyId, incarnationId, { awaitsRegistration: false })
  }

  private async attachPtyWithRetry(
    ptyProvider: SshPtyProvider,
    ptyId: string,
    expectedIdentity: ExpectedPtyIdentity | undefined,
    recoveryRequest: PtySourceRecoveryRequest | undefined,
    shouldContinue: () => boolean
  ): Promise<SshPtyAttachResult> {
    let lastError: unknown
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!shouldContinue()) {
        throw lastError ?? new Error('PTY reattach attempt is no longer current')
      }
      try {
        return await this.attachPtyWithDeadline(
          ptyProvider,
          ptyId,
          expectedIdentity,
          recoveryRequest
        )
      } catch (error) {
        lastError = error
        if (!shouldContinue() || isSshPtyNotFoundError(error) || attempt === 1) {
          throw error
        }
        await this.waitForPtyReattachRetry()
      }
    }
    throw lastError
  }

  private async attachPtyWithDeadline(
    ptyProvider: SshPtyProvider,
    ptyId: string,
    expectedIdentity: ExpectedPtyIdentity | undefined,
    recoveryRequest: PtySourceRecoveryRequest | undefined
  ): Promise<SshPtyAttachResult> {
    let timer: ReturnType<typeof setTimeout> | undefined
    let timedOut = false
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true
        reject(
          new Error(`PTY reattach attempt timed out after ${SSH_PTY_REATTACH_ATTEMPT_TIMEOUT_MS}ms`)
        )
      }, SSH_PTY_REATTACH_ATTEMPT_TIMEOUT_MS)
      timer.unref?.()
    })
    try {
      const attach = expectedIdentity
        ? recoveryRequest
          ? ptyProvider.attachForReconnect(ptyId, expectedIdentity, recoveryRequest)
          : ptyProvider.attachForReconnect(ptyId, expectedIdentity)
        : recoveryRequest
          ? ptyProvider.attachForReconnect(ptyId, undefined, recoveryRequest)
          : ptyProvider.attachForReconnect(ptyId)
      const guardedAttach = attach.then((result) => {
        if (timedOut) {
          result.sourceActivationLease?.rollback()
        }
        return result
      })
      return (await Promise.race([guardedAttach, timeout])) ?? {}
    } finally {
      if (timer) {
        clearTimeout(timer)
      }
    }
  }

  private async waitForPtyReattachRetry(): Promise<void> {
    const delayMs =
      SSH_PTY_REATTACH_RETRY_MIN_DELAY_MS +
      Math.floor(Math.random() * (SSH_PTY_REATTACH_RETRY_JITTER_MS + 1))
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, delayMs)
      timer.unref?.()
    })
  }

  private handlePtyReattachFailure(
    ptyId: string,
    appPtyId: string,
    pending: PendingPtyReattach,
    error: unknown
  ): void {
    if (!isSshPtyNotFoundError(error)) {
      pending.restoreRequired = 'reattachAttemptsExhausted'
      this.wakeRecovery(pending)
      console.warn(
        `[ssh-relay-session] Leaving PTY ${ptyId} detached for ${this.targetId} after bounded reattach attempts failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
      return
    }
    if (isSshPtyIdentityMismatchError(error)) {
      console.warn(
        `[ssh-relay-session] Ignoring stale PTY ${ptyId} for ${this.targetId} after relay identity mismatch: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
      return
    }
    console.warn(
      `[ssh-relay-session] Dropping stale PTY ${ptyId} for ${this.targetId} after relay reattach failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
    clearProviderPtyState(appPtyId)
    deletePtyOwnership(appPtyId)
    this.store.markSshRemotePtyLease(this.targetId, ptyId, 'expired')
    const win = this.getMainWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send('pty:exit', { id: appPtyId, code: -1 })
    }
  }

  private async sourceRecoveryRequest(
    appPtyId: string
  ): Promise<PtySourceRecoveryRequest | undefined> {
    if (!this.activePtyConsumerOwner()?.outputFlowControl) {
      return undefined
    }
    const recovery = getSshPtyConsumerRecovery(this.targetId)
    const migration = recovery?.modelMigrationsByAppPtyId.get(appPtyId)
    if (migration) {
      const outcome = await migration
      if (recovery?.modelMigrationsByAppPtyId.get(appPtyId) === migration) {
        recovery.modelMigrationsByAppPtyId.delete(appPtyId)
      }
      if (outcome.status !== 'settled') {
        return Object.freeze({ status: 'checkpointUnavailable' })
      }
    }
    const checkpoints = recovery?.checkpointsByAppPtyId
    const relayPtyId = toRelaySshPtyId(this.targetId, appPtyId)
    // Why: every checkpoint writer records app-id keys now, so the relay-id
    // lookup (and its paired delete below) is a legacy guard only.
    const checkpoint = checkpoints?.get(appPtyId) ?? checkpoints?.get(relayPtyId)
    if (!checkpoint) {
      return Object.freeze({ status: 'checkpointUnavailable' })
    }
    return Object.freeze({
      status: 'checkpoint',
      clientGeneration: checkpoint.clientGeneration,
      ownerGeneration: checkpoint.ownerGeneration,
      ptyIncarnation: checkpoint.ptyIncarnation,
      deliveryToken: checkpoint.deliveryToken,
      acceptedSourceEndSu: checkpoint.acceptedSourceEndSu
    })
  }

  private beginPtyModelMigration(providerGeneration: number, closeReason: string): void {
    const recovery = getSshPtyConsumerRecovery(this.targetId)
    if (!recovery) {
      closeSshPtyOutputGeneration(providerGeneration, closeReason)
      return
    }
    for (const checkpoint of getSshPtyAcceptedSourceCheckpoints(providerGeneration)) {
      recovery.checkpointsByAppPtyId.set(checkpoint.id, checkpoint)
    }
    const migration = beginSshPtyOutputGenerationMigration(providerGeneration)
    for (const [ptyId, result] of migration.byPty) {
      const previous = recovery.modelMigrationsByAppPtyId.get(ptyId)
      const fence = previous ? previous.then(() => result) : result
      recovery.modelMigrationsByAppPtyId.set(ptyId, fence)
      void fence.then((outcome) => {
        const current = getSshPtyConsumerRecovery(this.targetId)
        if (current?.modelMigrationsByAppPtyId.get(ptyId) !== fence) {
          return
        }
        if (outcome.status === 'settled') {
          current.checkpointsByAppPtyId.set(ptyId, outcome.checkpoint)
        } else {
          current.checkpointsByAppPtyId.delete(ptyId)
          current.checkpointsByAppPtyId.delete(toRelaySshPtyId(this.targetId, ptyId))
        }
        current.modelMigrationsByAppPtyId.delete(ptyId)
      })
    }
    void migration.completion.then(() => {
      closeSshPtyOutputGeneration(providerGeneration, closeReason)
    })
  }

  private async finishSourceRecovery(
    relayPtyId: string,
    appPtyId: string,
    attachResult: SshPtyAttachResult,
    request: PtySourceRecoveryRequest,
    pending: PendingPtyReattach,
    shouldContinue: () => boolean,
    activateRecoveryQuarantine: () => void
  ): Promise<boolean> {
    const recovery = attachResult.sourceRecovery
    const pendingRecovery = recovery?.status === 'pending' ? recovery : undefined
    const owner = this.activePtyConsumerOwner()
    if (
      !owner?.outputFlowControl ||
      !pendingRecovery ||
      request.status !== 'checkpoint' ||
      pendingRecovery.clientGeneration !== owner.clientGeneration ||
      pendingRecovery.ownerGeneration !== owner.ownerGeneration ||
      pendingRecovery.ptyIncarnation !== attachResult.incarnationId ||
      pendingRecovery.ptyIncarnation !== request.ptyIncarnation ||
      pendingRecovery.checkpointSourceEndSu !== request.acceptedSourceEndSu ||
      (pending.replacementDeliveryToken !== undefined &&
        pending.replacementDeliveryToken !== pendingRecovery.deliveryToken)
    ) {
      if (!shouldContinue() || !this.ownsPtyRecoveryAttempt(appPtyId, pending)) {
        return false
      }
      await this.abandonPtySourceRecovery(relayPtyId, appPtyId, pending)
      return false
    }
    const acceptedRecovery = pendingRecovery
    pending.recovery = acceptedRecovery
    pending.nextRecoverySourceSu = acceptedRecovery.checkpointSourceEndSu
    this.retiredSourceDeliveries.activate(relayPtyId)
    this.sourceIdentityByRelayPtyId.set(relayPtyId, {
      deliveryToken: acceptedRecovery.deliveryToken,
      clientGeneration: acceptedRecovery.clientGeneration,
      ownerGeneration: acceptedRecovery.ownerGeneration,
      ptyIncarnation: acceptedRecovery.ptyIncarnation,
      nextSourceSu: acceptedRecovery.checkpointSourceEndSu
    })
    activateRecoveryQuarantine()
    for (const payload of pending.queuedData.splice(0)) {
      this.routeQuarantinedReattachData(pending, payload)
    }
    await this.waitForRecoveryFence(pending, shouldContinue)
    const exactExit = this.findExactPendingExit(pending, acceptedRecovery.ptyIncarnation)
    const complete = pending.recoveryComplete ?? (exactExit ? acceptedRecovery : undefined)
    if (
      !shouldContinue() ||
      pending.restoreRequired ||
      !complete ||
      complete.deliveryToken !== acceptedRecovery.deliveryToken ||
      complete.clientGeneration !== acceptedRecovery.clientGeneration ||
      complete.ownerGeneration !== acceptedRecovery.ownerGeneration ||
      complete.ptyIncarnation !== acceptedRecovery.ptyIncarnation ||
      complete.checkpointSourceEndSu !== acceptedRecovery.checkpointSourceEndSu ||
      complete.recoveryEndSu !== acceptedRecovery.recoveryEndSu ||
      pending.nextRecoverySourceSu !== acceptedRecovery.recoveryEndSu
    ) {
      if (!shouldContinue() || !this.ownsPtyRecoveryAttempt(appPtyId, pending)) {
        return false
      }
      await this.abandonPtySourceRecovery(relayPtyId, appPtyId, pending)
      return false
    }
    let nextLiveSourceSu = acceptedRecovery.recoveryEndSu
    for (const payload of pending.liveData) {
      if (
        !payload.source ||
        payload.source.deliveryToken !== acceptedRecovery.deliveryToken ||
        payload.source.clientGeneration !== acceptedRecovery.clientGeneration ||
        payload.source.ownerGeneration !== acceptedRecovery.ownerGeneration ||
        payload.source.sourceStartSu !== nextLiveSourceSu ||
        payload.source.sourceEndSu <= payload.source.sourceStartSu ||
        payload.ptyIncarnation !== acceptedRecovery.ptyIncarnation
      ) {
        if (!shouldContinue() || !this.ownsPtyRecoveryAttempt(appPtyId, pending)) {
          return false
        }
        await this.abandonPtySourceRecovery(relayPtyId, appPtyId, pending)
        return false
      }
      nextLiveSourceSu = payload.source.sourceEndSu
    }
    try {
      for (const payload of pending.recoveryData) {
        await this.acceptPtyData(payload)
      }
      for (const payload of pending.liveData) {
        await this.acceptPtyData(payload)
      }
      pending.livePassthrough = true
    } catch {
      if (!shouldContinue() || !this.ownsPtyRecoveryAttempt(appPtyId, pending)) {
        return false
      }
      await this.abandonPtySourceRecovery(relayPtyId, appPtyId, pending)
      return false
    }
    if (!shouldContinue() || !this.ownsPtyRecoveryAttempt(appPtyId, pending)) {
      return false
    }
    const acceptedSourceEndSu = pending.liveData.reduce(
      (endSu, payload) => Math.max(endSu, payload.source?.sourceEndSu ?? endSu),
      acceptedRecovery.recoveryEndSu
    )
    // Why: checkpoints are app-id keyed; a relay-id entry here would be shadowed
    // by a staler app-id entry on the next sourceRecoveryRequest lookup.
    getSshPtyConsumerRecovery(this.targetId)?.checkpointsByAppPtyId.set(
      appPtyId,
      Object.freeze({
        id: appPtyId,
        providerGeneration: this.activePtyProviderGeneration!,
        clientGeneration: acceptedRecovery.clientGeneration,
        ownerGeneration: acceptedRecovery.ownerGeneration,
        ptyIncarnation: acceptedRecovery.ptyIncarnation,
        deliveryToken: acceptedRecovery.deliveryToken,
        acceptedSourceEndSu
      })
    )
    return true
  }

  private async waitForRecoveryFence(
    pending: PendingPtyReattach,
    shouldContinue: () => boolean
  ): Promise<void> {
    const deadline = Date.now() + SSH_PTY_REATTACH_ATTEMPT_TIMEOUT_MS
    while (
      shouldContinue() &&
      !pending.recoveryComplete &&
      !pending.restoreRequired &&
      !this.findExactPendingExit(pending, pending.recovery?.ptyIncarnation) &&
      Date.now() < deadline
    ) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(
          () => {
            pending.recoveryWaiters.delete(settle)
            resolve()
          },
          Math.max(1, deadline - Date.now())
        )
        timer.unref?.()
        const settle = (): void => {
          clearTimeout(timer)
          resolve()
        }
        pending.recoveryWaiters.add(settle)
      })
    }
    if (
      !pending.recoveryComplete &&
      !pending.restoreRequired &&
      !this.findExactPendingExit(pending, pending.recovery?.ptyIncarnation)
    ) {
      pending.restoreRequired = 'recoveryFenceTimeout'
    }
  }

  private async abandonPtySourceRecovery(
    relayPtyId: string,
    appPtyId: string,
    pending: PendingPtyReattach
  ): Promise<void> {
    if (!this.ownsPtyRecoveryAttempt(appPtyId, pending)) {
      return
    }
    const recovery = pending.recovery
    const { mux, providerGeneration } = pending
    if (recovery && !mux.isDisposed()) {
      const cancellationRequest = {
        id: relayPtyId,
        clientGeneration: recovery.clientGeneration,
        ownerGeneration: recovery.ownerGeneration,
        deliveryToken: recovery.deliveryToken
      }
      this.retiredSourceDeliveries.retire(providerGeneration, {
        relayPtyId,
        deliveryToken: recovery.deliveryToken,
        clientGeneration: recovery.clientGeneration,
        ownerGeneration: recovery.ownerGeneration
      })
      try {
        const result = (await mux.request('pty.cancelDelivery', cancellationRequest)) as Record<
          string,
          unknown
        >
        const highestPrivateSourceEndSu = pending.liveData.reduce(
          (endSu, payload) => Math.max(endSu, payload.source?.sourceEndSu ?? endSu),
          Math.max(
            pending.nextRecoverySourceSu ?? recovery.checkpointSourceEndSu,
            pending.highestRecoverySourceEndSu ?? recovery.checkpointSourceEndSu
          )
        )
        if (
          result.canceled !== true ||
          !Number.isSafeInteger(result.sentEndSu) ||
          (result.sentEndSu as number) < highestPrivateSourceEndSu ||
          !Number.isSafeInteger(result.creditedEndSu) ||
          result.creditedEndSu !== recovery.checkpointSourceEndSu ||
          (result.creditedEndSu as number) > (result.sentEndSu as number)
        ) {
          throw new Error('ssh_source_cancellation_proof_invalid')
        }
        if (!this.ownsPtyRecoveryAttempt(appPtyId, pending)) {
          return
        }
        const identity = this.sourceIdentityByRelayPtyId.get(relayPtyId)
        if (identity && !this.sameSourceDelivery(identity, recovery)) {
          return
        }
        if (identity) {
          const applied = applySshPtySourceRecoveryCancellationProof(
            {
              id: appPtyId,
              code: -1,
              providerGeneration,
              ptyIncarnation: recovery.ptyIncarnation
            },
            {
              sentEndSu: result.sentEndSu as number,
              creditedEndSu: result.creditedEndSu as number
            }
          )
          if (!applied) {
            throw new Error('ssh_source_cancellation_proof_rejected')
          }
        }
      } catch (error) {
        if (!this.ownsPtyRecoveryAttempt(appPtyId, pending)) {
          return
        }
        console.warn(
          `[ssh-relay-session] Failed to cancel replacement delivery for ${relayPtyId}: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
        throw sourceRecoveryCancellationError(error)
      }
    }
    if (!this.ownsPtyRecoveryAttempt(appPtyId, pending)) {
      return
    }
    const identity = this.sourceIdentityByRelayPtyId.get(relayPtyId)
    if (!identity || !recovery || this.sameSourceDelivery(identity, recovery)) {
      this.sourceIdentityByRelayPtyId.delete(relayPtyId)
    }
    getSshPtyConsumerRecovery(this.targetId)?.checkpointsByAppPtyId.delete(appPtyId)
    getSshPtyConsumerRecovery(this.targetId)?.checkpointsByAppPtyId.delete(relayPtyId)
    this.store.markSshRemotePtyLease(this.targetId, relayPtyId, 'detached')
  }

  private ownsPtyRecoveryAttempt(appPtyId: string, pending: PendingPtyReattach): boolean {
    return (
      this.pendingPtyReattaches.get(appPtyId) === pending &&
      this.mux === pending.mux &&
      this.activePtyProviderGeneration === pending.providerGeneration &&
      !pending.mux.isDisposed()
    )
  }

  private sameSourceDelivery(
    left: Readonly<{
      deliveryToken: string
      clientGeneration: number
      ownerGeneration: number
      ptyIncarnation: string
    }>,
    right: Readonly<{
      deliveryToken: string
      clientGeneration: number
      ownerGeneration: number
      ptyIncarnation: string
    }>
  ): boolean {
    return (
      left.deliveryToken === right.deliveryToken &&
      left.clientGeneration === right.clientGeneration &&
      left.ownerGeneration === right.ownerGeneration &&
      left.ptyIncarnation === right.ptyIncarnation
    )
  }
}
