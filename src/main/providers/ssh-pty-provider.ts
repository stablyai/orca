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
import { writeToSshPty, writeToSshPtyWithSettlement } from './ssh-pty-write'

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

  async spawn(opts: PtySpawnOptions): Promise<PtySpawnResult> {
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

  async deleteWorktreeHistory(worktreeId: string): Promise<void> {
    await this.mux.request('pty.deleteWorktreeHistory', { worktreeId })
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

  write(id: string, data: string): boolean {
    return writeToSshPty(this.mux, this.toRelayPtyId(id), data)
  }

  writeWithSettlement(id: string, data: string): Promise<boolean> {
    return writeToSshPtyWithSettlement(this.mux, this.toRelayPtyId(id), data)
  }

  resize(id: string, cols: number, rows: number): void {
    this.mux.notify('pty.resize', { id: this.toRelayPtyId(id), cols, rows })
  }

  async shutdown(id: string, opts: Parameters<IPtyProvider['shutdown']>[1]): Promise<void> {
    await this.mux.request(
      'pty.shutdown',
      {
        id: this.toRelayPtyId(id),
        immediate: opts.immediate ?? false,
        keepHistory: opts.keepHistory ?? false,
        ...(opts.expectedIncarnationId === undefined
          ? {}
          : { expectedIncarnationId: opts.expectedIncarnationId })
      },
      relayTimeoutOptions(opts.deadlineMs)
    )
    this.livePtyIds.delete(id)
  }

  async sendSignal(id: string, signal: string): Promise<void> {
    await this.mux.request('pty.sendSignal', { id: this.toRelayPtyId(id), signal })
  }

  async getCwd(id: string): Promise<string> {
    const result = await this.mux.request('pty.getCwd', { id: this.toRelayPtyId(id) })
    return result as string
  }

  async getInitialCwd(id: string): Promise<string> {
    const result = await this.mux.request('pty.getInitialCwd', { id: this.toRelayPtyId(id) })
    return result as string
  }

  async clearBuffer(id: string): Promise<void> {
    await this.mux.request('pty.clearBuffer', { id: this.toRelayPtyId(id) })
  }

  async closeStartupQueryAuthority(id: string): Promise<number> {
    const result = (await this.mux.request('pty.closeStartupQueryAuthority', {
      id: this.toRelayPtyId(id)
    })) as { appliedSeq?: number }
    return result.appliedSeq ?? 0
  }

  acknowledgeDataEvent(id: string, charCount: number): void {
    this.mux.notify('pty.ackData', { id: this.toRelayPtyId(id), charCount })
  }

  async hasChildProcesses(id: string): Promise<boolean> {
    const result = await this.mux.request('pty.hasChildProcesses', { id: this.toRelayPtyId(id) })
    return result as boolean
  }

  async getForegroundProcess(id: string): Promise<string | null> {
    const result = await this.mux.request('pty.getForegroundProcess', { id: this.toRelayPtyId(id) })
    return result as string | null
  }

  async inspectProcess(id: string): Promise<PtyProcessInspection> {
    return (await this.mux.request('pty.inspectProcess', {
      id: this.toRelayPtyId(id)
    })) as PtyProcessInspection
  }

  async serialize(ids: string[]): Promise<string> {
    const result = await this.mux.request('pty.serialize', {
      ids: ids.map((id) => this.toRelayPtyId(id))
    })
    return result as string
  }

  async revive(state: string): Promise<void> {
    await this.mux.request('pty.revive', { state })
  }

  async listProcesses(opts?: { deadlineMs?: number }): Promise<PtyProcessInfo[]> {
    const result = await this.mux.request(
      'pty.listProcesses',
      undefined,
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

  async getDefaultShell(): Promise<string> {
    const result = await this.mux.request('pty.getDefaultShell')
    return result as string
  }

  async getProfiles(): Promise<{ name: string; path: string }[]> {
    const result = await this.mux.request('pty.getProfiles')
    return result as { name: string; path: string }[]
  }

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
