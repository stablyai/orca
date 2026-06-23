import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import type { IPtyProvider, PtySpawnOptions, PtySpawnResult } from './types'
import { toAppSshPtyId, toRelaySshPtyId } from './ssh-pty-id'

type DataCallback = (payload: { id: string; data: string }) => void
type ReplayCallback = (payload: { id: string; data: string }) => void
type ExitCallback = (payload: { id: string; code: number }) => void
type RemoteCliBridgeEnv = {
  binDir: string
  relayDir: string
  nodePath: string
  sockPath: string
  pathDelimiter?: ':' | ';'
}

export const SSH_SESSION_EXPIRED_ERROR = 'SSH_SESSION_EXPIRED'

export function isSshPtyNotFoundError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return /PTY ".+" not found/i.test(message)
}

/**
 * Remote PTY provider that proxies all operations through the relay
 * via the JSON-RPC multiplexer. Implements the same IPtyProvider interface
 * as LocalPtyProvider so the dispatch layer can route transparently.
 */
export class SshPtyProvider implements IPtyProvider {
  private mux: SshChannelMultiplexer
  private connectionId: string
  private dataListeners = new Set<DataCallback>()
  private replayListeners = new Set<ReplayCallback>()
  private exitListeners = new Set<ExitCallback>()
  // Why: store the unsubscribe handle so dispose() can detach from the
  // multiplexer. Without this, notification callbacks keep firing after
  // the provider is torn down on disconnect, routing events to stale state.
  private unsubscribeNotifications: (() => void) | null = null

  constructor(
    connectionId: string,
    mux: SshChannelMultiplexer,
    private readonly remoteCliBridgeEnv?: RemoteCliBridgeEnv
  ) {
    this.connectionId = connectionId
    this.mux = mux

    // Subscribe to relay notifications for PTY events
    this.unsubscribeNotifications = mux.onNotification((method, params) => {
      switch (method) {
        case 'pty.data':
          for (const cb of this.dataListeners) {
            cb({ id: this.toAppPtyId(params.id as string), data: params.data as string })
          }
          break

        case 'pty.replay':
          for (const cb of this.replayListeners) {
            cb({ id: this.toAppPtyId(params.id as string), data: params.data as string })
          }
          break

        case 'pty.exit':
          for (const cb of this.exitListeners) {
            cb({ id: this.toAppPtyId(params.id as string), code: params.code as number })
          }
          break
      }
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
  }

  getConnectionId(): string {
    return this.connectionId
  }

  private toRelayPtyId(id: string): string {
    return toRelaySshPtyId(this.connectionId, id)
  }

  private toAppPtyId(id: string): string {
    return toAppSshPtyId(this.connectionId, id)
  }

  async spawn(opts: PtySpawnOptions): Promise<PtySpawnResult> {
    // Why: when sessionId is present, the caller is requesting reattach to an
    // existing relay PTY (persisted across app restart). pty.attach replays
    // the buffered output the relay kept alive during the grace window.
    if (opts.sessionId) {
      const relaySessionId = this.toRelayPtyId(opts.sessionId)
      console.warn(
        `[ssh-pty] spawn() called with sessionId=${opts.sessionId}, attempting pty.attach`
      )
      try {
        const attachResult = (await this.mux.request('pty.attach', {
          id: relaySessionId,
          cols: opts.cols,
          rows: opts.rows,
          suppressReplayNotification: true
        })) as { replay?: string }
        console.warn(
          `[ssh-pty] pty.attach succeeded for ${opts.sessionId}, replay=${!!attachResult.replay}`
        )
        return {
          id: this.toAppPtyId(relaySessionId),
          isReattach: true,
          ...(attachResult.replay ? { replay: attachResult.replay } : {})
        }
      } catch (err) {
        // Why: pty.attach fails when the relay grace window has elapsed.
        // Surface the exact condition so the renderer can clear the stale
        // binding before replacing the dead relay PTY in the same pane.
        console.warn(`[ssh-pty] pty.attach FAILED for ${opts.sessionId}:`, err)
        if (isSshPtyNotFoundError(err)) {
          throw new Error(`${SSH_SESSION_EXPIRED_ERROR}: ${relaySessionId}`)
        }
        throw err
      }
    }

    const result = await this.mux.request('pty.spawn', {
      cols: opts.cols,
      rows: opts.rows,
      cwd: opts.cwd,
      env: this.withRemoteCliBridgeEnv(opts.env),
      // Why: the relay's plugin-overlay env augmenter needs to know which
      // Pi-compatible agent is being launched (`pi` vs `omp`) so it mirrors
      // the right `~/.<kind>/agent` source dir on the remote disk. The
      // relay does not execute `command` itself — the user types it into
      // the shell — but receiving it as a hint lets overlay resolution be
      // per-launch instead of always-Pi.
      ...(opts.command ? { command: opts.command } : {}),
      ...(opts.startupCommandDelivery
        ? { startupCommandDelivery: opts.startupCommandDelivery }
        : {})
    })
    return {
      ...(result as PtySpawnResult),
      id: this.toAppPtyId((result as PtySpawnResult).id),
      ...(opts.sessionId ? { sessionExpired: true } : {})
    }
  }

  private withRemoteCliBridgeEnv(
    env: Record<string, string> | undefined
  ): Record<string, string> | undefined {
    if (!this.remoteCliBridgeEnv) {
      return env
    }
    const merged = { ...env }
    const pathDelimiter = this.remoteCliBridgeEnv.pathDelimiter ?? ':'
    const pathKey = merged.PATH !== undefined ? 'PATH' : merged.Path !== undefined ? 'Path' : null
    if (pathKey) {
      const pathValue = merged[pathKey] ?? ''
      merged[pathKey] = pathValue.split(pathDelimiter).includes(this.remoteCliBridgeEnv.binDir)
        ? pathValue
        : pathValue
          ? `${this.remoteCliBridgeEnv.binDir}${pathDelimiter}${pathValue}`
          : this.remoteCliBridgeEnv.binDir
    }
    merged.ORCA_REMOTE_CLI_BIN_DIR = this.remoteCliBridgeEnv.binDir
    merged.ORCA_RELAY_DIR = this.remoteCliBridgeEnv.relayDir
    merged.ORCA_RELAY_NODE_PATH = this.remoteCliBridgeEnv.nodePath
    merged.ORCA_RELAY_SOCKET_PATH = this.remoteCliBridgeEnv.sockPath
    return merged
  }

  async attach(id: string): Promise<void> {
    await this.mux.request('pty.attach', { id: this.toRelayPtyId(id) })
  }

  async attachForReconnect(id: string): Promise<{ replay?: string }> {
    // Why: reconnect owns replay delivery so stale/duplicate attach results can
    // be filtered before they reach the renderer.
    const result = (await this.mux.request('pty.attach', {
      id: this.toRelayPtyId(id),
      suppressReplayNotification: true
    })) as { replay?: string } | undefined
    return result ?? {}
  }

  write(id: string, data: string): void {
    this.mux.notify('pty.data', { id: this.toRelayPtyId(id), data })
  }

  resize(id: string, cols: number, rows: number): void {
    this.mux.notify('pty.resize', { id: this.toRelayPtyId(id), cols, rows })
  }

  async shutdown(id: string, opts: { immediate?: boolean; keepHistory?: boolean }): Promise<void> {
    await this.mux.request('pty.shutdown', {
      id: this.toRelayPtyId(id),
      immediate: opts.immediate ?? false,
      keepHistory: opts.keepHistory ?? false
    })
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

  async listProcesses(): Promise<{ id: string; cwd: string; title: string }[]> {
    const result = await this.mux.request('pty.listProcesses')
    return (result as { id: string; cwd: string; title: string }[]).map((session) => ({
      ...session,
      id: this.toAppPtyId(session.id)
    }))
  }

  async getDefaultShell(): Promise<string> {
    const result = await this.mux.request('pty.getDefaultShell')
    return result as string
  }

  async getProfiles(): Promise<{ name: string; path: string }[]> {
    const result = await this.mux.request('pty.getProfiles')
    return result as { name: string; path: string }[]
  }

  onData(callback: DataCallback): () => void {
    this.dataListeners.add(callback)
    return () => this.dataListeners.delete(callback)
  }

  onReplay(callback: ReplayCallback): () => void {
    this.replayListeners.add(callback)
    return () => this.replayListeners.delete(callback)
  }

  onExit(callback: ExitCallback): () => void {
    this.exitListeners.add(callback)
    return () => this.exitListeners.delete(callback)
  }
}
