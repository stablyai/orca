import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import type { IPtyProvider, PtyProcessInfo, PtySpawnOptions, PtySpawnResult } from './types'
import { toAppSshPtyId, toRelaySshPtyId } from './ssh-pty-id'
import { createSshPtyAppliedSizeReader } from './ssh-pty-applied-size'
import type {
  RemoteCliBridgeEnv,
  SshPtyDataCallback,
  SshPtyExitCallback,
  SshPtyReplayCallback
} from './ssh-pty-provider-contract'
import { subscribeSshPtyNotifications } from './ssh-pty-notification-routing'
import { validateClaimedSshSpawn } from './ssh-agent-session-claim-validation'
import {
  assertSshAgentSessionCreateResult,
  requestSshAgentSessionCreate
} from './ssh-agent-session-create-operation'
import { mapSshPtyProcessList } from './ssh-agent-session-process-list'
import {
  parseSshPtyAttachResult,
  reattachSshPtySessionWithExitFence,
  type SshPtyAttachResult
} from './ssh-pty-session-reattach'
import { buildSshPtySpawnRequest } from './ssh-pty-spawn-request'
import { SshPtySpawnExitRaceTracker } from './ssh-pty-spawn-exit-race'
import { SshAgentSessionCapabilities } from './ssh-agent-session-capabilities'

// Why: sequential relay teardown calls share one absolute budget; convert to the mux-relative timeout only at dispatch.
function relayTimeoutOptions(deadlineMs: number | undefined): { timeoutMs: number } | undefined {
  return deadlineMs === undefined ? undefined : { timeoutMs: Math.max(1, deadlineMs - Date.now()) }
}

/** Remote PTY provider that proxies IPtyProvider operations through the relay. */
export class SshPtyProvider implements IPtyProvider {
  private mux: SshChannelMultiplexer
  private connectionId: string
  private dataListeners = new Set<SshPtyDataCallback>()
  private replayListeners = new Set<SshPtyReplayCallback>()
  private exitListeners = new Set<SshPtyExitCallback>()
  private livePtyIds = new Set<string>()
  // Why: stale notification callbacks must not outlive a disconnected provider.
  private unsubscribeNotifications: (() => void) | null = null
  readonly getAppliedSize: NonNullable<IPtyProvider['getAppliedSize']>
  private readonly agentSessionCapabilities: SshAgentSessionCapabilities
  private spawnExitRaces = new SshPtySpawnExitRaceTracker()

  constructor(
    connectionId: string,
    mux: SshChannelMultiplexer,
    private readonly remoteCliBridgeEnv?: RemoteCliBridgeEnv
  ) {
    this.connectionId = connectionId
    this.mux = mux
    this.agentSessionCapabilities = new SshAgentSessionCapabilities(mux)
    this.getAppliedSize = createSshPtyAppliedSizeReader(mux, connectionId)

    this.unsubscribeNotifications = subscribeSshPtyNotifications({
      mux,
      toAppPtyId: (id) => this.toAppPtyId(id),
      dataListeners: this.dataListeners,
      replayListeners: this.replayListeners,
      exitListeners: this.exitListeners,
      livePtyIds: this.livePtyIds,
      recordExit: (relayPtyId, incarnationId) =>
        this.spawnExitRaces.recordExit(relayPtyId, incarnationId)
    })
  }

  dispose(): void {
    if (this.unsubscribeNotifications) {
      this.unsubscribeNotifications()
      this.unsubscribeNotifications = null
    }
    this.dataListeners.clear()
    this.replayListeners.clear()
    this.exitListeners.clear()
    this.livePtyIds.clear()
  }

  getConnectionId = (): string => this.connectionId

  private toRelayPtyId(id: string): string {
    return toRelaySshPtyId(this.connectionId, id)
  }

  private toAppPtyId(id: string): string {
    return toAppSshPtyId(this.connectionId, id)
  }

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
      const result = await reattachSshPtySessionWithExitFence({
        mux: this.mux,
        connectionId: this.connectionId,
        sessionId: opts.sessionId,
        options: opts,
        exitRaceTracker: this.spawnExitRaces
      })
      this.livePtyIds.add(result.id)
      return result
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
    const operation = this.spawnExitRaces.begin()
    try {
      const result = await requestSshAgentSessionCreate({
        mux: this.mux,
        operationId: opts.agentSessionCreateOperationId,
        signal: opts.signal,
        params: buildSshPtySpawnRequest({
          options: opts,
          remoteCliBridgeEnv: this.remoteCliBridgeEnv,
          supportsCreateOperation
        })
      })
      if (opts.agentSessionCreateOperationId) {
        assertSshAgentSessionCreateResult(result)
      }
      const spawnResult = result as PtySpawnResult
      if (this.spawnExitRaces.didMatchingExitArrive(operation, spawnResult)) {
        // Why: relay notification can share the response batch; no controller registration may follow.
        throw Object.assign(new Error('agent_session_exited_during_start'), {
          agentSessionOperationOutcome: 'unknown' as const
        })
      }
      const claimed = spawnResult.agentSessionEnsure
      if (opts.agentSessionEnsure) {
        const validation = validateClaimedSshSpawn(spawnResult, opts.agentSessionEnsure)
        if (!validation.valid) {
          if (validation.cleanup === 'created' && typeof spawnResult.id === 'string') {
            try {
              // Why: immediate relay shutdown resolves only after physical exit;
              // a best-effort graceful request cannot prove the duplicate is gone.
              await this.mux.request('pty.shutdown', { id: spawnResult.id, immediate: true })
            } catch {
              throw new Error('execution_owner_unavailable')
            }
          }
          throw new Error(validation.error)
        }
      }
      const id = this.toAppPtyId(spawnResult.id)
      this.livePtyIds.add(id)
      return {
        ...spawnResult,
        id,
        ...(claimed
          ? {
              agentSessionEnsure: {
                ...claimed,
                owner: {
                  ...claimed.owner,
                  ptyId: this.toAppPtyId(claimed.owner.ptyId)
                }
              }
            }
          : {}),
        ...(opts.sessionId ? { sessionExpired: true } : {})
      }
    } finally {
      this.spawnExitRaces.finish(operation)
    }
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
    await this.mux.request('pty.attach', { id: this.toRelayPtyId(id) })
  }

  async attachForReconnect(
    id: string,
    expected?: { paneKey?: string; tabId?: string }
  ): Promise<SshPtyAttachResult> {
    // Why: reconnect owns replay delivery so stale/duplicate attach results can
    // be filtered before they reach the renderer. The expected identity lets the
    // relay reject a cross-generation id collision instead of reattaching this
    // lease to a different pane's freshly spawned PTY.
    return parseSshPtyAttachResult(
      await this.mux.request('pty.attach', {
        id: this.toRelayPtyId(id),
        suppressReplayNotification: true,
        ...(expected?.paneKey ? { expectedPaneKey: expected.paneKey } : {}),
        ...(expected?.tabId ? { expectedTabId: expected.tabId } : {})
      })
    )
  }

  write(id: string, data: string): void {
    this.mux.notify('pty.data', { id: this.toRelayPtyId(id), data })
  }

  resize(id: string, cols: number, rows: number): void {
    this.mux.notify('pty.resize', { id: this.toRelayPtyId(id), cols, rows })
  }

  async shutdown(
    id: string,
    opts: { immediate?: boolean; keepHistory?: boolean; deadlineMs?: number }
  ): Promise<void> {
    await this.mux.request(
      'pty.shutdown',
      {
        id: this.toRelayPtyId(id),
        immediate: opts.immediate ?? false,
        keepHistory: opts.keepHistory ?? false
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
    }
    return processes
  }

  hasPty(id: string): boolean {
    return this.livePtyIds.has(id)
  }

  async getDefaultShell(): Promise<string> {
    const result = await this.mux.request('pty.getDefaultShell')
    return result as string
  }

  async getProfiles(): Promise<{ name: string; path: string }[]> {
    const result = await this.mux.request('pty.getProfiles')
    return result as { name: string; path: string }[]
  }

  onData(callback: SshPtyDataCallback): () => void {
    this.dataListeners.add(callback)
    return () => this.dataListeners.delete(callback)
  }

  onReplay(callback: SshPtyReplayCallback): () => void {
    this.replayListeners.add(callback)
    return () => this.replayListeners.delete(callback)
  }

  onExit(callback: SshPtyExitCallback): () => void {
    this.exitListeners.add(callback)
    return () => this.exitListeners.delete(callback)
  }
}
