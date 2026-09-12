import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import type { IPtyProvider, PtySpawnOptions, PtySpawnResult } from './types'
import type { WriteSettlement } from '../../shared/pty-write-settlement'
import { toAppSshPtyId, toRelaySshPtyId } from './ssh-pty-id'
import { createSshPtyAppliedSizeReader } from './ssh-pty-applied-size'
import type {
  RemoteCliBridgeEnv,
  SshPtyDataCallback,
  SshPtyDeliveryPauseAdapter,
  SshPtyExitCallback,
  SshPtyOwnershipTransferOwner,
  SshPtyOwnershipTransferOutputCallback,
  SshPtyReplayCallback
} from './ssh-pty-provider-contract'
import { SshPtyProviderOutputState } from './ssh-pty-provider-output-state'
import { spawnFreshSshPty } from './ssh-agent-session-create-operation'
import {
  requestSshPtyAttach,
  reattachSshPtySessionForSpawn,
  type PtySourceRecoveryRequest,
  type SshPtyAttachResult
} from './ssh-pty-session-reattach'
import { buildSshPtySpawnRequest } from './ssh-pty-spawn-request'
import { SshPtySpawnExitRaceTracker } from './ssh-pty-spawn-exit-race'
import { SshAgentSessionCapabilities } from './ssh-agent-session-capabilities'
import type { PtyProcessInspection } from './pty-process-inspection'
import type { PtyProviderOperationRetry } from './pty-provider-contract'
import type { PtyOwnershipBridgeCapabilities } from '../../shared/pty-ownership-bridge-contract'
import { createSshPtyProviderRpcOperations } from './ssh-pty-provider-rpc-operations'
import { SshPtyOwnershipTransferClient } from './ssh-pty-ownership-transfer-client'
import { createSshPtyProcessLister } from './ssh-pty-process-list'
import type { SshPtyOwnershipTransferPublishedRoute } from './ssh-pty-ownership-transfer-route-registry'
import { SshPtyOwnershipTransferProviderControls } from './ssh-pty-ownership-transfer-provider-controls'
import { spawnWithTerminalRuntimeRepair, type TerminalRepairHook } from './ssh-pty-spawn-repair'
import type { SshPtyOutgoingControlRelease } from './ssh-pty-outgoing-control-fence'
import { drainSshPtyControls, type SshPtyControlDrain } from './ssh-pty-source-preparation-drain'

/** Remote PTY provider that proxies IPtyProvider operations through the relay. */
export class SshPtyProvider implements IPtyProvider {
  private readonly rpcOperations: ReturnType<typeof createSshPtyProviderRpcOperations>
  private livePtyIds = new Set<string>()
  readonly getAppliedSize: NonNullable<IPtyProvider['getAppliedSize']>
  readonly listProcesses: IPtyProvider['listProcesses']
  private readonly agentSessionCapabilities: SshAgentSessionCapabilities
  private spawnExitRaces = new SshPtySpawnExitRaceTracker()
  private readonly outputState: SshPtyProviderOutputState
  readonly ownershipTransfer: SshPtyOwnershipTransferClient
  private readonly ownershipTransferControls: SshPtyOwnershipTransferProviderControls
  private readonly getOwnershipTransferOwner?: () => SshPtyOwnershipTransferOwner | null
  private recoverFromTerminalUnavailable: TerminalRepairHook<SshPtyProvider> | null = null

  requestHostRpc: NonNullable<IPtyProvider['requestHostRpc']> = (method, params, options) =>
    this.mux.request(method, params as Record<string, unknown>, options)

  constructor(
    private readonly connectionId: string,
    private readonly mux: SshChannelMultiplexer,
    private readonly remoteCliBridgeEnv?: RemoteCliBridgeEnv,
    readonly providerGeneration = 1,
    options?: {
      onOwnershipTransferOutput?: SshPtyOwnershipTransferOutputCallback
      getOwnershipTransferOwner?: () => SshPtyOwnershipTransferOwner | null
    }
  ) {
    this.getOwnershipTransferOwner = options?.getOwnershipTransferOwner
    this.rpcOperations = createSshPtyProviderRpcOperations({
      mux,
      toRelayPtyId: (id) => this.toRelayPtyId(id)
    })
    this.agentSessionCapabilities = new SshAgentSessionCapabilities(mux)
    this.ownershipTransfer = new SshPtyOwnershipTransferClient(mux)
    this.ownershipTransferControls = new SshPtyOwnershipTransferProviderControls(
      connectionId,
      mux,
      this.ownershipTransfer,
      providerGeneration,
      this.livePtyIds
    )
    this.getAppliedSize = createSshPtyAppliedSizeReader(mux, connectionId)

    this.outputState = new SshPtyProviderOutputState(providerGeneration, {
      mux,
      toAppPtyId: (id) => this.toAppPtyId(id),
      livePtyIds: this.livePtyIds,
      recordExit: (relayPtyId, incarnationId) => {
        this.spawnExitRaces.recordExit(relayPtyId, incarnationId)
        this.ownershipTransferControls.removeSourceExit(relayPtyId, incarnationId)
      },
      ...(options?.onOwnershipTransferOutput
        ? { onOwnershipTransferOutput: options.onOwnershipTransferOutput }
        : {})
    })
    this.listProcesses = createSshPtyProcessLister({
      mux,
      connectionId,
      livePtyIds: this.livePtyIds,
      outputState: this.outputState
    })
  }

  dispose(): void {
    this.ownershipTransferControls.dispose()
    this.outputState.dispose()
    this.livePtyIds.clear()
  }

  getConnectionId = (): string => this.connectionId

  isOutgoingSourceControlReleased = (id: string, expectedIdentity?: unknown): boolean =>
    this.ownershipTransferControls.isSourceControlReleased(id, expectedIdentity)

  /** Caller owns durable migration authority; does not drain already-admitted operations. */
  releaseOutgoingSourceControl = (value: SshPtyOutgoingControlRelease): void =>
    this.ownershipTransferControls.releaseSource(value, this.getOwnershipTransferSourceIdentity)

  canProvideAuthoritativeBufferSnapshot = (_id: string): boolean => false

  getOwnershipTransferSourceIdentity = (id: string) =>
    this.outputState.resolveOwnershipTransferSourceAuthority(
      this.toRelayPtyId(id),
      this.getOwnershipTransferOwner?.() ?? null
    )

  drainOutgoingSourceControls = (value: SshPtyControlDrain): Promise<void> =>
    drainSshPtyControls(this, this.mux, value)

  fenceOutgoingCatalogCreation = (signal: AbortSignal): Promise<void> =>
    this.mux.drainPtyCatalogCreation(signal)

  installPublishedOwnershipTransferRoute = (route: SshPtyOwnershipTransferPublishedRoute): void => {
    this.ownershipTransferControls.install(route)
  }

  private toRelayPtyId = (id: string): string => toRelaySshPtyId(this.connectionId, id)

  private toAppPtyId = (id: string): string => toAppSshPtyId(this.connectionId, id)

  /** Installed by SshRelaySession, which owns the connection, the repair lock and the reconnect. */
  setTerminalUnavailableRecovery(recover: TerminalRepairHook<SshPtyProvider>): void {
    this.recoverFromTerminalUnavailable = recover
  }

  hasLivePtys = (): boolean => this.livePtyIds.size > 0

  async spawn(opts: PtySpawnOptions): Promise<PtySpawnResult> {
    return await spawnWithTerminalRuntimeRepair<SshPtyProvider, PtySpawnResult>({
      attempt: () => this.spawnWithoutTerminalRuntimeRepair(opts),
      recover: this.recoverFromTerminalUnavailable,
      retry: (provider) => provider.spawnWithoutTerminalRuntimeRepair(opts)
    })
  }

  private async spawnWithoutTerminalRuntimeRepair(opts: PtySpawnOptions): Promise<PtySpawnResult> {
    if (opts.agentSessionEnsure && opts.sessionId) {
      throw new Error('agent_session_claim_unavailable')
    }
    if (opts.agentSessionEnsure) {
      const supportsClaims = await this.supportsAgentSessionClaims({ signal: opts.signal })
      if (opts.signal?.aborted) {
        throw new Error('client_disconnected')
      }
      if (!supportsClaims) {
        throw new Error('agent_session_claim_unavailable')
      }
    }
    if (opts.sessionId) {
      return await reattachSshPtySessionForSpawn({
        mux: this.mux,
        connectionId: this.connectionId,
        sessionId: opts.sessionId,
        options: opts,
        exitRaceTracker: this.spawnExitRaces,
        installSourceActivation: (relayPtyId, activation) =>
          this.outputState.installReceivingActivation(relayPtyId, activation),
        rememberPtyIncarnation: (relayPtyId, incarnationId) =>
          this.outputState.rememberPtyIncarnation(relayPtyId, incarnationId),
        acceptLivePty: (relayPtyId) => this.livePtyIds.add(relayPtyId)
      })
    }

    const supportsCreateOperation = opts.agentSessionCreateOperationId
      ? await this.supportsAgentSessionCreateOperations({ signal: opts.signal })
      : false
    if (opts.signal?.aborted) {
      throw new Error('client_disconnected')
    }
    if (opts.agentSessionCreateOperationId && !supportsCreateOperation) {
      // Why: host routing owns legacy selection; a changed relay must not downgrade after dispatch.
      throw new Error('execution_owner_unavailable')
    }
    return await spawnFreshSshPty({
      mux: this.mux,
      options: opts,
      params: buildSshPtySpawnRequest({
        options: opts,
        remoteCliBridgeEnv: this.remoteCliBridgeEnv,
        supportsCreateOperation
      }),
      exitRaceTracker: this.spawnExitRaces,
      installSourceActivation: (id, activation) =>
        this.outputState.installReceivingActivation(id, activation),
      rememberPtyIncarnation: (id, incarnation) =>
        this.outputState.rememberPtyIncarnation(id, incarnation),
      acceptLivePty: (id) => this.livePtyIds.add(id),
      toAppPtyId: this.toAppPtyId
    })
  }

  async supportsAgentSessionClaims(options: { signal?: AbortSignal } = {}): Promise<boolean> {
    return await this.agentSessionCapabilities.supportsClaims(options)
  }

  providesAgentSessionOwnerListings(_ptyId: string): boolean {
    return this.agentSessionCapabilities.providesOwnerListings()
  }

  async supportsAgentSessionCreateOperations(
    options: { signal?: AbortSignal } = {}
  ): Promise<boolean> {
    return await this.agentSessionCapabilities.supportsCreateOperations(options)
  }

  getOwnershipBridgeCapabilities = (
    options: { signal?: AbortSignal } = {}
  ): Promise<PtyOwnershipBridgeCapabilities | null> =>
    this.rpcOperations.getOwnershipBridgeCapabilities(options)

  async supportsForegroundProcessEvidence(
    options: { signal?: AbortSignal } = {}
  ): Promise<boolean> {
    return await this.agentSessionCapabilities.supportsForegroundProcessEvidence(options)
  }

  async attach(id: string): Promise<void> {
    const relayPtyId = this.toRelayPtyId(id)
    await requestSshPtyAttach({
      mux: this.mux,
      relayPtyId,
      params: { id: relayPtyId },
      commitSourceActivation: true,
      installSourceActivation: (ptyId, activation) =>
        this.outputState.installReceivingActivation(ptyId, activation),
      rememberPtyIncarnation: (ptyId, incarnationId) =>
        this.outputState.rememberPtyIncarnation(ptyId, incarnationId)
    })
  }

  async attachForReconnect(
    id: string,
    expected?: { paneKey?: string; tabId?: string },
    sourceRecovery?: PtySourceRecoveryRequest
  ): Promise<SshPtyAttachResult> {
    // Reconnect filters replay before renderer delivery; expected identity rejects ID collisions.
    const params = {
      id: this.toRelayPtyId(id),
      suppressReplayNotification: true,
      ...(sourceRecovery ? { sourceRecovery } : {}),
      ...(expected?.paneKey ? { expectedPaneKey: expected.paneKey } : {}),
      ...(expected?.tabId ? { expectedTabId: expected.tabId } : {})
    }
    const relayPtyId = this.toRelayPtyId(id)
    return await requestSshPtyAttach({
      mux: this.mux,
      relayPtyId,
      params,
      timeoutMs: 10_000,
      installSourceActivation: (ptyId, activation) =>
        this.outputState.installReceivingActivation(ptyId, activation),
      rememberPtyIncarnation: (ptyId, incarnationId) =>
        this.outputState.rememberPtyIncarnation(ptyId, incarnationId)
    })
  }

  write(id: string, data: string, retry?: PtyProviderOperationRetry): boolean {
    return this.ownershipTransferControls.write(id, data, retry)
  }

  writeWithSettlement(
    id: string,
    data: string,
    retry?: PtyProviderOperationRetry
  ): Promise<WriteSettlement> {
    return this.ownershipTransferControls.writeWithSettlement(id, data, retry)
  }

  retireWriteOperation(id: string, operationId: string): Promise<boolean> {
    return this.ownershipTransferControls.retireWriteOperation(id, operationId)
  }

  resize(id: string, cols: number, rows: number, retry?: PtyProviderOperationRetry): void {
    this.ownershipTransferControls.resize(id, cols, rows, retry)
  }

  shutdown(id: string, opts: Parameters<IPtyProvider['shutdown']>[1]): Promise<void> {
    return this.ownershipTransferControls.shutdown(id, opts)
  }

  sendSignal(id: string, signal: string, retry?: PtyProviderOperationRetry): Promise<void> {
    return this.ownershipTransferControls.sendSignal(id, signal, retry)
  }

  getCwd = (id: string): Promise<string> => this.rpcOperations.getCwd(id)

  deleteWorktreeHistory = (worktreeId: string): Promise<void> =>
    this.rpcOperations.deleteWorktreeHistory(worktreeId)

  getInitialCwd = (id: string): Promise<string> => this.rpcOperations.getInitialCwd(id)

  clearBuffer(id: string, retry?: PtyProviderOperationRetry): Promise<void> {
    return this.ownershipTransferControls.clearBuffer(id, retry)
  }

  closeStartupQueryAuthority = (id: string): Promise<number> =>
    this.rpcOperations.closeStartupQueryAuthority(id)

  acknowledgeDataEvent = (id: string, charCount: number): void =>
    this.rpcOperations.acknowledgeDataEvent(id, charCount)

  hasChildProcesses = (id: string): Promise<boolean> => this.rpcOperations.hasChildProcesses(id)

  getForegroundProcess = (id: string): Promise<string | null> =>
    this.rpcOperations.getForegroundProcess(id)

  inspectProcess = (
    id: string,
    options?: { expectedIncarnationId?: string; scanChildProcesses?: boolean }
  ): Promise<PtyProcessInspection> => this.rpcOperations.inspectProcess(id, options)

  serialize = (ids: string[]): Promise<string> => this.rpcOperations.serialize(ids)

  revive = (state: string): Promise<void> => this.rpcOperations.revive(state)

  hasPty = (id: string): boolean => this.livePtyIds.has(id)

  getDefaultShell = (): Promise<string> => this.rpcOperations.getDefaultShell()

  getProfiles = (): Promise<{ name: string; path: string }[]> => this.rpcOperations.getProfiles()

  onData = (callback: SshPtyDataCallback): (() => void) => this.outputState.onData(callback)
  onRejectedData = (callback: SshPtyDataCallback): (() => void) =>
    this.outputState.onRejectedData(callback)
  onReplay = (callback: SshPtyReplayCallback): (() => void) => this.outputState.onReplay(callback)
  onExit = (callback: SshPtyExitCallback): (() => void) => this.outputState.onExit(callback)

  setPtyDeliveryPauseAdapter = (adapter: SshPtyDeliveryPauseAdapter | null): void =>
    this.outputState.setDeliveryPauseAdapter(adapter)

  hasPtyDeliveryPauseAdapter = (): boolean => this.outputState.hasDeliveryPauseAdapter()

  pauseProducer = (id: string): void => this.outputState.pause(this.toRelayPtyId(id))

  resumeProducer = (id: string): void => this.outputState.resume(this.toRelayPtyId(id))

  closeOutputIntake(reason: string): void {
    this.mux.dispose('connection_lost')
    console.error('[ssh-pty-provider] closed after bounded output intake failure', { reason })
  }
}
