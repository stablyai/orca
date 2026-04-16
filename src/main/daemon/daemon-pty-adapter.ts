import { basename } from 'path'
import { existsSync } from 'fs'
import { randomUUID } from 'crypto'
import { DaemonClient } from './client'
import { HistoryManager } from './history-manager'
import { HistoryReader } from './history-reader'
import type { CreateOrAttachResult, DaemonEvent, ListSessionsResult } from './types'
import type { IPtyProvider, PtySpawnOptions, PtySpawnResult } from '../providers/types'

export type DaemonPtyAdapterOptions = {
  socketPath: string
  tokenPath: string
  /** Directory for disk-based terminal history. When set, the adapter writes
   *  raw PTY output to disk for cold restore on daemon crash. */
  historyPath?: string
}

const MAX_TOMBSTONES = 1000

export class TerminalKilledError extends Error {
  constructor(sessionId: string) {
    super(`Session "${sessionId}" was explicitly killed`)
    this.name = 'TerminalKilledError'
  }
}

export class DaemonPtyAdapter implements IPtyProvider {
  private client: DaemonClient
  private historyManager: HistoryManager | null
  private historyReader: HistoryReader | null
  private dataListeners: ((payload: { id: string; data: string }) => void)[] = []
  private exitListeners: ((payload: { id: string; code: number }) => void)[] = []
  private removeEventListener: (() => void) | null = null
  private initialCwds = new Map<string, string>()
  // Why: React re-renders and StrictMode double-mounts can call createOrAttach
  // for a session the user just killed. Without tombstones, the daemon would
  // create a fresh session — resurrecting a terminal the user explicitly closed.
  private killedSessionTombstones = new Set<string>()
  // Why: React StrictMode double-mounts: mount → cold restore → unmount →
  // mount → ??? The sticky cache returns the same cold restore data on the
  // second mount until the renderer explicitly acknowledges it.
  private coldRestoreCache = new Map<string, { scrollback: string; cwd: string }>()

  constructor(opts: DaemonPtyAdapterOptions) {
    this.client = new DaemonClient({
      socketPath: opts.socketPath,
      tokenPath: opts.tokenPath
    })
    this.historyManager = opts.historyPath ? new HistoryManager(opts.historyPath) : null
    this.historyReader = opts.historyPath ? new HistoryReader(opts.historyPath) : null
  }

  getHistoryManager(): HistoryManager | null {
    return this.historyManager
  }

  async spawn(opts: PtySpawnOptions): Promise<PtySpawnResult> {
    await this.ensureConnected()

    const sessionId =
      opts.sessionId ??
      (opts.worktreeId ? `${opts.worktreeId}@@${randomUUID().slice(0, 8)}` : randomUUID())

    if (this.killedSessionTombstones.has(sessionId)) {
      throw new TerminalKilledError(sessionId)
    }

    const result = await this.client.request<CreateOrAttachResult>('createOrAttach', {
      sessionId,
      cols: opts.cols,
      rows: opts.rows,
      cwd: opts.cwd,
      env: opts.env,
      command: opts.command
    })

    if (opts.cwd) {
      this.initialCwds.set(sessionId, opts.cwd)
    }

    // Why: check sticky cache first — StrictMode double-mounts call spawn
    // twice. The second call finds an existing daemon session (isNew=false)
    // but should still return the cached cold restore data.
    const cachedRestore = this.coldRestoreCache.get(sessionId)
    if (cachedRestore) {
      return { id: sessionId, coldRestore: cachedRestore }
    }

    // Cold restore: daemon created a new session but disk history shows
    // an unclean shutdown → return saved scrollback so the renderer can
    // display the previous terminal content. Must run BEFORE openSession
    // which would overwrite the saved history files.
    if (result.isNew && this.historyReader) {
      const restoreInfo = this.historyReader.detectColdRestore(sessionId)
      if (restoreInfo) {
        const coldRestore = { scrollback: restoreInfo.scrollback, cwd: restoreInfo.cwd }
        this.coldRestoreCache.set(sessionId, coldRestore)
        // Why: open a fresh history session AFTER reading cold restore data.
        // Without this, post-restore data events are silently dropped and a
        // second daemon crash would have no history to restore from.
        if (this.historyManager) {
          // Why: seed the new history with the restored scrollback so the data
          // survives on disk. Without this, scrollback.bin is truncated to empty
          // and a second crash before new data arrives would restore nothing.
          void this.historyManager.openSession(sessionId, {
            cwd: opts.cwd ?? '',
            cols: opts.cols,
            rows: opts.rows,
            initialScrollback: restoreInfo.scrollback
          })
        }
        return { id: sessionId, coldRestore }
      }
    }

    if (this.historyManager && result.isNew) {
      void this.historyManager.openSession(sessionId, {
        cwd: opts.cwd ?? '',
        cols: opts.cols,
        rows: opts.rows,
        initialScrollback: result.snapshot?.snapshotAnsi
      })
    }

    const isReattach = !result.isNew
    if (!isReattach || !result.snapshot) {
      return { id: sessionId }
    }

    // Why: alternate-screen TUI apps (vim, claude, htop) repaint themselves
    // when they receive SIGWINCH from the pre-snapshot resize. Writing the
    // ANSI snapshot into xterm.js would create garbled overlapping content
    // because the TUI immediately redraws over it. For these apps, only
    // restore terminal modes (bracketed paste, mouse tracking, etc.) and
    // let the resize trigger a clean full repaint.
    const snapshotAnsi = result.snapshot.modes.alternateScreen ? '' : result.snapshot.snapshotAnsi

    return {
      id: sessionId,
      snapshot: result.snapshot.rehydrateSequences + snapshotAnsi,
      snapshotCols: result.snapshot.cols,
      snapshotRows: result.snapshot.rows,
      isReattach: true
    }
  }

  async attach(id: string): Promise<void> {
    await this.ensureConnected()

    await this.client.request<CreateOrAttachResult>('createOrAttach', {
      sessionId: id,
      cols: 80,
      rows: 24
    })
  }

  write(id: string, data: string): void {
    this.client.notify('write', { sessionId: id, data })
  }

  resize(id: string, cols: number, rows: number): void {
    this.client.notify('resize', { sessionId: id, cols, rows })
  }

  async shutdown(id: string, _immediate: boolean): Promise<void> {
    await this.client.request('kill', { sessionId: id })
    this.initialCwds.delete(id)
    // Why: user explicitly closed this terminal — clean up disk history
    // so it doesn't trigger a false cold restore on next launch.
    if (this.historyManager) {
      void this.historyManager.removeSession(id)
    }

    this.killedSessionTombstones.add(id)
    if (this.killedSessionTombstones.size > MAX_TOMBSTONES) {
      // Evict the oldest entry (Set iteration order is insertion order)
      const oldest = this.killedSessionTombstones.values().next().value
      if (oldest) {
        this.killedSessionTombstones.delete(oldest)
      }
    }
  }

  ackColdRestore(sessionId: string): void {
    this.coldRestoreCache.delete(sessionId)
  }

  clearTombstone(sessionId: string): void {
    this.killedSessionTombstones.delete(sessionId)
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

  async clearBuffer(id: string): Promise<void> {
    await this.client.request('clearScrollback', { sessionId: id })
  }

  acknowledgeDataEvent(_id: string, _charCount: number): void {
    // No flow control for daemon-backed terminals
  }

  async hasChildProcesses(_id: string): Promise<boolean> {
    return false
  }

  async getForegroundProcess(_id: string): Promise<string | null> {
    return null
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

  /** Called on app launch. Lists daemon sessions, kills orphans whose
   *  workspaceId no longer exists, and caches alive session IDs. */
  async reconcileOnStartup(validWorktreeIds: Set<string>): Promise<{
    alive: string[]
    killed: string[]
  }> {
    await this.ensureConnected()
    const result = await this.client.request<ListSessionsResult>('listSessions', undefined)

    const alive: string[] = []
    const killed: string[] = []

    for (const session of result.sessions) {
      // Why: session IDs use the format `${worktreeId}@@${shortUuid}`. The @@
      // separator is unambiguous — worktreeIds contain hyphens and colons but
      // never @@.
      const separatorIdx = session.sessionId.lastIndexOf('@@')
      const worktreeId =
        separatorIdx !== -1 ? session.sessionId.slice(0, separatorIdx) : session.sessionId

      if (!validWorktreeIds.has(worktreeId)) {
        try {
          await this.client.request('kill', { sessionId: session.sessionId })
        } catch {
          /* already dead */
        }
        killed.push(session.sessionId)
      } else {
        alive.push(session.sessionId)
      }
    }

    return { alive, killed }
  }

  async listProcesses(): Promise<{ id: string; cwd: string; title: string }[]> {
    await this.ensureConnected()
    const result = await this.client.request<ListSessionsResult>('listSessions', undefined)
    return result.sessions.map((s) => ({
      id: s.sessionId,
      cwd: s.cwd ?? '',
      title: 'shell'
    }))
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

  onData(callback: (payload: { id: string; data: string }) => void): () => void {
    this.dataListeners.push(callback)
    return () => {
      const idx = this.dataListeners.indexOf(callback)
      if (idx !== -1) {
        this.dataListeners.splice(idx, 1)
      }
    }
  }

  onReplay(_callback: (payload: { id: string; data: string }) => void): () => void {
    return () => {}
  }

  onExit(callback: (payload: { id: string; code: number }) => void): () => void {
    this.exitListeners.push(callback)
    return () => {
      const idx = this.exitListeners.indexOf(callback)
      if (idx !== -1) {
        this.exitListeners.splice(idx, 1)
      }
    }
  }

  dispose(): void {
    this.removeEventListener?.()
    this.removeEventListener = null
    if (this.historyManager) {
      void this.historyManager.dispose()
    }
    this.client.disconnect()
  }

  // Why: for in-process daemon mode, disconnect without flushing history.
  // dispose() writes endedAt for all sessions, which would prevent cold
  // restore. disconnectOnly() leaves history files in unclean state so
  // the next launch detects them as crash-recoverable.
  disconnectOnly(): void {
    this.removeEventListener?.()
    this.removeEventListener = null
    this.client.disconnect()
  }

  private async ensureConnected(): Promise<void> {
    await this.client.ensureConnected()
    this.setupEventRouting()
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
        if (this.historyManager) {
          void this.historyManager.appendData(event.sessionId, event.payload.data)
        }
        // oxlint-disable-next-line unicorn/no-useless-spread -- copy-safe: listeners may unsubscribe during iteration
        for (const listener of [...this.dataListeners]) {
          listener({ id: event.sessionId, data: event.payload.data })
        }
      } else if (event.event === 'exit') {
        if (this.historyManager) {
          void this.historyManager.closeSession(event.sessionId, event.payload.code)
        }
        this.initialCwds.delete(event.sessionId)
        // oxlint-disable-next-line unicorn/no-useless-spread -- copy-safe: listeners may unsubscribe during iteration
        for (const listener of [...this.exitListeners]) {
          listener({ id: event.sessionId, code: event.payload.code })
        }
      }
    })
  }
}
