import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import type { IPtyProvider, PtySpawnOptions, PtySpawnResult } from './types'

type DataCallback = (payload: { id: string; data: string }) => void
type ReplayCallback = (payload: { id: string; data: string }) => void
type ExitCallback = (payload: { id: string; code: number }) => void

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

  constructor(connectionId: string, mux: SshChannelMultiplexer) {
    this.connectionId = connectionId
    this.mux = mux

    // Subscribe to relay notifications for PTY events
    this.unsubscribeNotifications = mux.onNotification((method, params) => {
      switch (method) {
        case 'pty.data':
          for (const cb of this.dataListeners) {
            cb({ id: params.id as string, data: params.data as string })
          }
          break

        case 'pty.replay':
          for (const cb of this.replayListeners) {
            cb({ id: params.id as string, data: params.data as string })
          }
          break

        case 'pty.exit':
          for (const cb of this.exitListeners) {
            cb({ id: params.id as string, code: params.code as number })
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

  async spawn(opts: PtySpawnOptions): Promise<PtySpawnResult> {
    // Why: when sessionId is present, the caller is requesting reattach to an
    // existing relay PTY (persisted across app restart). pty.attach replays
    // the buffered output the relay kept alive during the grace window.
    if (opts.sessionId) {
      console.warn(
        `[ssh-pty] spawn() called with sessionId=${opts.sessionId}, attempting pty.attach`
      )
      try {
        const attachResult = (await this.mux.request('pty.attach', {
          id: opts.sessionId,
          cols: opts.cols,
          rows: opts.rows,
          suppressReplayNotification: true
        })) as { replay?: string }
        console.warn(
          `[ssh-pty] pty.attach succeeded for ${opts.sessionId}, replay=${!!attachResult.replay}`
        )
        return {
          id: opts.sessionId,
          isReattach: true,
          ...(attachResult.replay ? { replay: attachResult.replay } : {})
        }
      } catch (err) {
        // Why: pty.attach fails when the relay grace window has elapsed. Fall
        // through to pty.spawn so the user gets a fresh shell; sessionExpired
        // lets the renderer show a brief "Session expired" message.
        console.warn(
          `[ssh-pty] pty.attach FAILED for ${opts.sessionId}, falling back to fresh spawn:`,
          err
        )
      }
    }

    const result = await this.mux.request('pty.spawn', {
      cols: opts.cols,
      rows: opts.rows,
      cwd: opts.cwd,
      env: opts.env
    })
    return {
      ...(result as PtySpawnResult),
      ...(opts.sessionId ? { sessionExpired: true } : {})
    }
  }

  async attach(id: string): Promise<void> {
    await this.mux.request('pty.attach', { id })
  }

  write(id: string, data: string): void {
    this.mux.notify('pty.data', { id, data })
  }

  resize(id: string, cols: number, rows: number): void {
    this.mux.notify('pty.resize', { id, cols, rows })
  }

  async shutdown(id: string, immediate: boolean): Promise<void> {
    await this.mux.request('pty.shutdown', { id, immediate })
  }

  async sendSignal(id: string, signal: string): Promise<void> {
    await this.mux.request('pty.sendSignal', { id, signal })
  }

  async getCwd(id: string): Promise<string> {
    const result = await this.mux.request('pty.getCwd', { id })
    return result as string
  }

  async getInitialCwd(id: string): Promise<string> {
    const result = await this.mux.request('pty.getInitialCwd', { id })
    return result as string
  }

  async clearBuffer(id: string): Promise<void> {
    await this.mux.request('pty.clearBuffer', { id })
  }

  acknowledgeDataEvent(id: string, charCount: number): void {
    this.mux.notify('pty.ackData', { id, charCount })
  }

  async hasChildProcesses(id: string): Promise<boolean> {
    const result = await this.mux.request('pty.hasChildProcesses', { id })
    return result as boolean
  }

  async getForegroundProcess(id: string): Promise<string | null> {
    const result = await this.mux.request('pty.getForegroundProcess', { id })
    return result as string | null
  }

  async serialize(ids: string[]): Promise<string> {
    const result = await this.mux.request('pty.serialize', { ids })
    return result as string
  }

  async revive(state: string): Promise<void> {
    await this.mux.request('pty.revive', { state })
  }

  async listProcesses(): Promise<{ id: string; cwd: string; title: string }[]> {
    const result = await this.mux.request('pty.listProcesses')
    return result as { id: string; cwd: string; title: string }[]
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
