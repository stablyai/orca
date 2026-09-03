import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import type { IPtyProvider, PtyProcessInfo, PtySpawnOptions, PtySpawnResult } from './types'
import { toAppSshPtyId, toRelaySshPtyId } from './ssh-pty-id'
import { createSshPtyAppliedSizeReader } from './ssh-pty-applied-size'
import type {
  RemoteCliBridgeEnv,
  SshPtyDataCallback,
  SshPtyDeliveryPauseAdapter,
  SshPtyExitCallback,
  SshPtyReplayCallback
} from './ssh-pty-provider-contract'
import { SshPtyProviderOutputState } from './ssh-pty-provider-output-state'
import { spawnFreshSshPty } from './ssh-agent-session-create-operation'
import { mapSshPtyProcessList } from './ssh-agent-session-process-list'
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
import { spawnWithTerminalRuntimeRepair, type TerminalRepairHook } from './ssh-pty-spawn-repair'
import { createSshPtyProviderRpcOperations } from './ssh-pty-provider-rpc-operations'

// Why: sequential relay teardown calls share one absolute budget; convert to the mux-relative timeout only at dispatch.
function relayTimeoutOptions(deadlineMs: number | undefined): { timeoutMs: number } | undefined {
  return deadlineMs === undefined ? undefined : { timeoutMs: Math.max(1, deadlineMs - Date.now()) }
}

/** Remote PTY provider that proxies IPtyProvider operations through the relay. */
export class SshPtyProvider implements IPtyProvider {
  private mux: SshChannelMultiplexer
  private connectionId: string
  private livePtyIds = new Set<string>()
  readonly getAppliedSize: NonNullable<IPtyProvider['getAppliedSize']>
  private readonly agentSessionCapabilities: SshAgentSessionCapabilities
  private spawnExitRaces = new SshPtySpawnExitRaceTracker()
  private readonly outputState: SshPtyProviderOutputState
  private recoverFromTerminalUnavailable: TerminalRepairHook<SshPtyProvider> | null = null
  private readonly rpcOperations: ReturnType<typeof createSshPtyProviderRpcOperations>

  deleteWorktreeHistory = (worktreeId: string): Promise<void> =>
    this.rpcOperations.deleteWorktreeHistory(worktreeId)
  write = (id: string, data: string): boolean => this.rpcOperations.write(id, data)
  writeWithSettlement = (id: string, data: string): Promise<boolean> =>
    this.rpcOperations.writeWithSettlement(id, data)
  resize = (id: string, cols: number, rows: number): void =>
    this.rpcOperations.resize(id, cols, rows)
  sendSignal = (id: string, signal: string): Promise<void> =>
    this.rpcOperations.sendSignal(id, signal)
  getCwd = (id: string): Promise<string> => this.rpcOperations.getCwd(id)
  getInitialCwd = (id: string): Promise<string> => this.rpcOperations.getInitialCwd(id)
  clearBuffer = (id: string): Promise<void> => this.rpcOperations.clearBuffer(id)
  closeStartupQueryAuthority = (id: string): Promise<number> =>
    this.rpcOperations.closeStartupQueryAuthority(id)
  acknowledgeDataEvent = (id: string, charCount: number): void =>
    this.rpcOperations.acknowledgeDataEvent(id, charCount)
  hasChildProcesses = (id: string): Promise<boolean> => this.rpcOperations.hasChildProcesses(id)
  getForegroundProcess = (id: string): Promise<string | null> =>
    this.rpcOperations.getForegroundProcess(id)
  inspectProcess = (
    id: string,
    options?: { expectedIncarnationId?: string }
  ): Promise<PtyProcessInspection> => this.rpcOperations.inspectProcess(id, options)
  serialize = (ids: string[]): Promise<string> => this.rpcOperations.serialize(ids)
  revive = (state: string): Promise<void> => this.rpcOperations.revive(state)
  getDefaultShell = (): Promise<string> => this.rpcOperations.getDefaultShell()
  getProfiles = (): Promise<{ name: string; path: string }[]> => this.rpcOperations.getProfiles()

  requestHostRpc: NonNullable<IPtyProvider['requestHostRpc']> = (method, params, options) =>
    this.mux.request(method, params as Record<string, unknown>, options)

  constructor(
    connectionId: string,
    mux: SshChannelMultiplexer,
    private readonly remoteCliBridgeEnv?: RemoteCliBridgeEnv,
    readonly providerGeneration = 1
  ) {
    this.connectionId = connectionId
    this.mux = mux
    this.rpcOperations = createSshPtyProviderRpcOperations({
      mux,
      toRelayPtyId: (id) => this.toRelayPtyId(id)
    })
    this.agentSessionCapabilities = new SshAgentSessionCapabilities(mux)
    this.getAppliedSize = createSshPtyAppliedSizeReader(mux, connectionId)

    this.outputState = new SshPtyProviderOutputState(providerGeneration, {
      mux,
      toAppPtyId: (id) => this.toAppPtyId(id),
      livePtyIds: this.livePtyIds,
      recordExit: (relayPtyId, incarnationId) => {
        this.spawnExitRaces.recordExit(relayPtyId, incarnationId)
      }
    })
  }

  dispose(): void {
    this.outputState.dispose()
    this.livePtyIds.clear()
  }

  getConnectionId = (): string => this.connectionId

  canProvideAuthoritativeBufferSnapshot = (_id: string): boolean => false

  private toRelayPtyId = (id: string): string => toRelaySshPtyId(this.connectionId, id)

  private toAppPtyId = (id: string): string => toAppSshPtyId(this.connectionId, id)

  /** Installed by SshRelaySession, which owns the connection, the repair lock and the reconnect. */
  setTerminalUnavailableRecovery(recover: TerminalRepairHook<SshPtyProvider>): void {
    this.recoverFromTerminalUnavailable = recover
  }

  hasLivePtys(): boolean {
    return this.livePtyIds.size > 0
  }

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
    // Why: reconnect owns replay delivery so stale/duplicate attach results can
    // be filtered before they reach the renderer. The expected identity lets the
    // relay reject a cross-generation id collision instead of reattaching this
    // lease to a different pane's freshly spawned PTY.
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

  async shutdown(id: string, opts: Parameters<IPtyProvider['shutdown']>[1]): Promise<void> {
    // Both fences are omitted rather than sent undefined: a host that predates either must see no
    // key at all, and the owner fence in particular must never reach it as a falsy claim.
    const { expectedIncarnationId, expectedOwnerClientInstanceId } = opts
    await this.mux.request(
      'pty.shutdown',
      {
        id: this.toRelayPtyId(id),
        immediate: opts.immediate ?? false,
        keepHistory: opts.keepHistory ?? false,
        ...(expectedIncarnationId === undefined ? {} : { expectedIncarnationId }),
        ...(expectedOwnerClientInstanceId === undefined ? {} : { expectedOwnerClientInstanceId })
      },
      relayTimeoutOptions(opts.deadlineMs)
    )
    this.livePtyIds.delete(id)
  }

  async listProcesses(opts?: {
    deadlineMs?: number
    includeForegroundProcessEvidence?: boolean
  }): Promise<PtyProcessInfo[]> {
    const result = await this.mux.request(
      'pty.listProcesses',
      opts?.includeForegroundProcessEvidence === undefined
        ? undefined
        : { includeForegroundProcessEvidence: opts.includeForegroundProcessEvidence },
      relayTimeoutOptions(opts?.deadlineMs)
    )
    const processes = mapSshPtyProcessList(result as PtyProcessInfo[], (id) => this.toAppPtyId(id))
    for (const process of processes) {
      this.livePtyIds.add(process.id)
      const relayPtyId = this.toRelayPtyId(process.id)
      this.outputState.rememberPtyIncarnation(relayPtyId, process.incarnationId)
    }
    return processes
  }

  hasPty = (id: string): boolean => this.livePtyIds.has(id)

  onData = (callback: SshPtyDataCallback): (() => void) => this.outputState.onData(callback)
  onRejectedData = (callback: SshPtyDataCallback): (() => void) =>
    this.outputState.onRejectedData(callback)
  onReplay = (callback: SshPtyReplayCallback): (() => void) => this.outputState.onReplay(callback)
  onExit = (callback: SshPtyExitCallback): (() => void) => this.outputState.onExit(callback)

  setPtyDeliveryPauseAdapter(adapter: SshPtyDeliveryPauseAdapter | null): void {
    this.outputState.setDeliveryPauseAdapter(adapter)
  }

  hasPtyDeliveryPauseAdapter(): boolean {
    return this.outputState.hasDeliveryPauseAdapter()
  }

  pauseProducer(id: string): void {
    this.outputState.pause(this.toRelayPtyId(id))
  }

  resumeProducer(id: string): void {
    this.outputState.resume(this.toRelayPtyId(id))
  }

  closeOutputIntake(reason: string): void {
    this.mux.dispose('connection_lost')
    console.error('[ssh-pty-provider] closed after bounded output intake failure', { reason })
  }
}
