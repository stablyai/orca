/* oxlint-disable max-lines -- Why: history error-logging .catch() chains add ~10 lines of
safety wiring spread across spawn/event-routing; splitting would scatter tightly coupled
adapter ↔ history lifecycle logic. */
import { basename } from 'path'
import { existsSync } from 'fs'
import { DaemonClient } from './client'
import { HistoryManager } from './history-manager'
import { HistoryReader } from './history-reader'
import { mintPtySessionId } from './pty-session-id'
import { supportsPtyStartupBarrier } from './shell-ready'
import {
  PROTOCOL_VERSION,
  type CreateOrAttachResult,
  type DaemonEvent,
  type GetSnapshotResult,
  type ListSessionsResult
} from './types'
import type { IPtyProvider, PtySpawnOptions, PtySpawnResult } from '../providers/types'

export type DaemonPtyAdapterOptions = {
  socketPath: string
  tokenPath: string
  protocolVersion?: number
  /** Directory for disk-based terminal history. When set, the adapter writes
   *  raw PTY output to disk for cold restore on daemon crash. */
  historyPath?: string
  /** Called when the daemon socket is unreachable (process died). Expected to
   *  fork a fresh daemon so the next connection attempt can succeed. */
  respawn?: () => Promise<void>
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
  private respawnFn: (() => Promise<void>) | null
  // Why: multiple pane mounts can call spawn() concurrently. If the daemon is
  // dead, all calls enter withDaemonRetry's catch block at once. Without a
  // lock, each would fork its own daemon process. This promise coalesces
  // concurrent respawns so only the first caller forks; the rest await it.
  private respawnPromise: Promise<void> | null = null
  private dataListeners: ((payload: { id: string; data: string }) => void)[] = []
  private exitListeners: ((payload: { id: string; code: number }) => void)[] = []
  private removeEventListener: (() => void) | null = null
  private initialCwds = new Map<string, string>()
  // Why: React re-renders and StrictMode double-mounts can call createOrAttach
  // for a session the user just killed. Without tombstones, the daemon would
  // create a fresh session — resurrecting a terminal the user explicitly closed.
  // Uses a Map<id, timestamp> so eviction removes the oldest by insertion order,
  // matching terminal-host.ts tombstone semantics.
  private killedSessionTombstones = new Map<string, number>()
  // Why: React StrictMode double-mounts: mount → cold restore → unmount →
  // mount → ??? The sticky cache returns the same cold restore data on the
  // second mount until the renderer explicitly acknowledges it.
  private coldRestoreCache = new Map<string, { scrollback: string; cwd: string }>()
  private activeSessionIds = new Set<string>()
  private checkpointInterval: ReturnType<typeof setInterval> | null = null
  private checkpointInFlight: Promise<void> | null = null
  // Why: checkpoint-based persistence requires the getSnapshot RPC (v4+).
  // Legacy daemons reject it, causing noisy log spam every 5 seconds.
  private supportsCheckpoints: boolean
  private static CHECKPOINT_INTERVAL_MS = 5_000

  constructor(opts: DaemonPtyAdapterOptions) {
    this.client = new DaemonClient({
      socketPath: opts.socketPath,
      tokenPath: opts.tokenPath,
      protocolVersion: opts.protocolVersion
    })
    this.historyManager = opts.historyPath ? new HistoryManager(opts.historyPath) : null
    this.historyReader = opts.historyPath ? new HistoryReader(opts.historyPath) : null
    this.respawnFn = opts.respawn ?? null
    this.supportsCheckpoints = (opts.protocolVersion ?? PROTOCOL_VERSION) >= 4
  }

  getHistoryManager(): HistoryManager | null {
    return this.historyManager
  }

  async spawn(opts: PtySpawnOptions): Promise<PtySpawnResult> {
    return this.withDaemonRetry(() => this.doSpawn(opts))
  }

  private async doSpawn(opts: PtySpawnOptions): Promise<PtySpawnResult> {
    await this.ensureConnected()

    const sessionId = opts.sessionId ?? mintPtySessionId(opts.worktreeId)

    if (this.killedSessionTombstones.has(sessionId)) {
      throw new TerminalKilledError(sessionId)
    }

    // Why: detect crash-recovery history before spawning a replacement PTY so
    // the revived shell inherits the recovered cwd and dimensions instead of
    // whatever the current renderer happened to request on mount.
    const restoreInfo = this.historyReader?.detectColdRestore(sessionId) ?? null
    const effectiveCwd = restoreInfo?.cwd ?? opts.cwd
    const effectiveCols = restoreInfo?.cols ?? opts.cols
    const effectiveRows = restoreInfo?.rows ?? opts.rows

    const result = await this.client.request<CreateOrAttachResult>('createOrAttach', {
      sessionId,
      cols: effectiveCols,
      rows: effectiveRows,
      cwd: effectiveCwd,
      env: opts.env,
      command: opts.command,
      // Why: without this, the daemon always spawns cmd.exe (COMSPEC) or
      // PowerShell as a fallback — regardless of which shell the renderer
      // asked for in the "+" menu or persisted as the default. Forwarding
      // the override makes the daemon path behave the same as the in-process
      // LocalPtyProvider.
      shellOverride: opts.shellOverride,
      shellReadySupported: opts.command ? supportsPtyStartupBarrier(opts.env ?? {}) : false
    })

    if (effectiveCwd) {
      this.initialCwds.set(sessionId, effectiveCwd)
    }

    // Why: the daemon RPC returns the shell pid of the backing subprocess.
    // Surfacing it through PtySpawnResult lets ipc/pty register with the
    // memory collector without a provider-specific accessor.
    const pid = typeof result.pid === 'number' && result.pid > 0 ? result.pid : null

    // Why: check sticky cache first — StrictMode double-mounts call spawn
    // twice. The second call finds an existing daemon session (isNew=false)
    // but should still return the cached cold restore data.
    const cachedRestore = this.coldRestoreCache.get(sessionId)
    if (cachedRestore) {
      return { id: sessionId, pid, coldRestore: cachedRestore }
    }

    this.activeSessionIds.add(sessionId)

    // Cold restore: daemon created a new session but disk history shows
    // an unclean shutdown → return saved scrollback so the renderer can
    // display the previous terminal content.
    if (result.isNew && restoreInfo) {
      // Why: if the checkpoint was captured while an alternate-screen app
      // (vim, less, htop) was active, snapshotAnsi is the alt buffer content.
      // Replaying that into a fresh shell would show stale TUI content. Use
      // scrollbackAnsi (rows above the viewport only) which excludes the alt
      // buffer. For normal sessions, use the full snapshot with rehydrate
      // sequences to restore terminal modes (colors, cursor position, etc).
      // Why: scrollbackAnsi may be empty if the emulator hadn't accumulated
      // scrollback before the alt-screen app launched. In that case, skip
      // cold restore entirely rather than showing a blank terminal — no
      // content is better than confusing the user with an empty restore.
      const isAltScreen = restoreInfo.modes.alternateScreen
      const scrollback = isAltScreen
        ? restoreInfo.scrollbackAnsi || null
        : restoreInfo.rehydrateSequences + restoreInfo.snapshotAnsi
      // Why: use registerWriter (not openSession) to avoid deleting the
      // existing checkpoint.json. If the revived daemon crashes again before
      // the next 5s tick, the checkpoint is the only recovery data available.
      if (this.historyManager) {
        this.historyManager.registerWriter(sessionId)
      }
      if (scrollback) {
        const coldRestore = { scrollback, cwd: restoreInfo.cwd }
        this.coldRestoreCache.set(sessionId, coldRestore)
        return { id: sessionId, pid, coldRestore }
      }
      return { id: sessionId, pid }
    }

    if (this.historyManager && result.isNew) {
      void this.historyManager
        .openSession(sessionId, {
          cwd: effectiveCwd ?? '',
          cols: effectiveCols,
          rows: effectiveRows
        })
        .catch((err) => console.warn('[history] openSession failed:', sessionId, err))
    } else if (this.historyManager) {
      // Why: on warm reattach after app relaunch, the HistoryManager is a
      // fresh instance with no writers. registerWriter adds the writer
      // without overwriting meta.json or deleting the existing checkpoint
      // (which is the only valid recovery data until the next tick).
      this.historyManager.registerWriter(sessionId)
    }

    const isReattach = !result.isNew
    if (!isReattach || !result.snapshot) {
      return { id: sessionId, pid }
    }

    const isAltScreen = result.snapshot.modes.alternateScreen
    const snapshotPayload = result.snapshot.rehydrateSequences + result.snapshot.snapshotAnsi
    return {
      id: sessionId,
      pid,
      snapshot: snapshotPayload,
      snapshotCols: result.snapshot.cols,
      snapshotRows: result.snapshot.rows,
      isReattach: true,
      isAlternateScreen: isAltScreen
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
    this.activeSessionIds.delete(id)
    this.initialCwds.delete(id)
    // Why: user explicitly closed this terminal — clean up disk history
    // so it doesn't trigger a false cold restore on next launch.
    if (this.historyManager) {
      void this.historyManager
        .removeSession(id)
        .catch((err) => console.warn('[history] removeSession failed:', id, err))
    }

    // Why: delete-then-set ensures the entry moves to the end of Map iteration
    // order, so re-killing a session doesn't leave it as the first eviction target.
    this.killedSessionTombstones.delete(id)
    this.killedSessionTombstones.set(id, Date.now())
    if (this.killedSessionTombstones.size > MAX_TOMBSTONES) {
      const oldest = this.killedSessionTombstones.keys().next().value
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
      if (!session.isAlive) {
        continue
      }
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
        // Why: background sessions discovered here may produce output before
        // the user reattaches their pane. Without adding them to the checkpoint
        // set, disconnectOnly()'s final checkpoint would skip them, leaving
        // stale recovery data if the daemon later crashes.
        this.activeSessionIds.add(session.sessionId)
        this.historyManager?.registerWriter(session.sessionId)
      }
    }

    return { alive, killed }
  }

  async listProcesses(): Promise<{ id: string; cwd: string; title: string }[]> {
    await this.ensureConnected()
    const result = await this.client.request<ListSessionsResult>('listSessions', undefined)
    return result.sessions
      .filter((s) => s.isAlive)
      .map((s) => ({
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
    if (this.checkpointInterval) {
      clearInterval(this.checkpointInterval)
      this.checkpointInterval = null
    }
    this.removeEventListener?.()
    this.removeEventListener = null
    // Why: final checkpoints are written daemon-side in TerminalHost.dispose()
    // which has direct access to sessions. The adapter only marks sessions as
    // cleanly ended here so they don't trigger false cold restores.
    if (this.historyManager) {
      void this.historyManager
        .dispose()
        .catch((err) => console.warn('[history] dispose failed:', err))
    }
    this.client.disconnect()
  }

  // Why: for in-process daemon mode, disconnect without flushing history.
  // dispose() writes endedAt for all sessions, which would prevent cold
  // restore. disconnectOnly() leaves history files in unclean state so
  // the next launch detects them as crash-recoverable.
  // We write a final checkpoint before disconnecting so that if the daemon
  // later crashes while Orca is closed, checkpoint.json has recovery data.
  async disconnectOnly(): Promise<void> {
    if (this.checkpointInterval) {
      clearInterval(this.checkpointInterval)
      this.checkpointInterval = null
    }
    // Why: wait for any in-flight timer pass to finish before starting
    // the final checkpoint. Otherwise both passes race on the shared tmp
    // file, risking ENOENT on rename and disabling future writes.
    if (this.checkpointInFlight) {
      await this.checkpointInFlight
    }
    // Why: without a final checkpoint, sessions opened after the last timer
    // tick have no checkpoint.json on disk. If the detached daemon later
    // dies, detectColdRestore finds nothing to restore from. Must await
    // before disconnecting — fire-and-forget would race with client.disconnect()
    // and the pending getSnapshot RPCs would be rejected.
    await this.checkpointAllSessions()
    this.removeEventListener?.()
    this.removeEventListener = null
    this.client.disconnect()
  }

  private async ensureConnected(): Promise<void> {
    await this.client.ensureConnected()
    this.setupEventRouting()
    this.startCheckpointTimer()
  }

  private startCheckpointTimer(): void {
    if (this.checkpointInterval || !this.historyManager || !this.supportsCheckpoints) {
      return
    }
    this.checkpointInterval = setInterval(() => {
      // Why: if the previous pass is still in-flight (slow RPC or disk),
      // skip this tick. Overlapping passes race on the shared tmp file
      // in checkpoint(), and a lost rename triggers handleWriteError which
      // permanently disables the session's history writes.
      if (this.checkpointInFlight) {
        return
      }
      this.checkpointInFlight = this.checkpointAllSessions().finally(() => {
        this.checkpointInFlight = null
      })
    }, DaemonPtyAdapter.CHECKPOINT_INTERVAL_MS)
  }

  // Why: the adapter runs in the Electron main process and does not have direct
  // access to daemon Session objects. It calls the getSnapshot RPC over the
  // daemon socket per session. Returns a promise that resolves when all
  // checkpoint writes complete (callers that don't need to wait can void it).
  private async checkpointAllSessions(): Promise<void> {
    if (!this.historyManager) {
      return
    }
    const promises: Promise<void>[] = []
    for (const sessionId of this.activeSessionIds) {
      promises.push(
        this.client
          .request<GetSnapshotResult>('getSnapshot', { sessionId })
          .then((result) => {
            if (result.snapshot && this.historyManager) {
              return this.historyManager.checkpoint(sessionId, result.snapshot)
            }
            return undefined
          })
          .catch((err) => console.warn('[history] checkpoint failed:', sessionId, err))
      )
    }
    await Promise.all(promises)
  }

  // Why: when the daemon process dies, operations fail with ENOENT (socket
  // gone), ECONNREFUSED, or "Connection lost" (socket closed mid-request).
  // Rather than leaving all terminals permanently broken until app restart,
  // this wrapper detects daemon-death errors, tears down the stale client
  // state, forks a fresh daemon via respawnFn, reconnects, and retries the
  // operation once. If respawn itself fails, the error propagates normally.
  private async withDaemonRetry<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (err) {
      if (!this.respawnFn || !isDaemonGoneError(err)) {
        throw err
      }
      if (!this.respawnPromise) {
        this.respawnPromise = this.doRespawn().finally(() => {
          this.respawnPromise = null
        })
      }
      await this.respawnPromise
      return await fn()
    }
  }

  private async doRespawn(): Promise<void> {
    console.warn('[daemon] Daemon died — respawning')
    this.removeEventListener?.()
    this.removeEventListener = null
    this.client.disconnect()
    await this.respawnFn!()
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
        // oxlint-disable-next-line unicorn/no-useless-spread -- copy-safe: listeners may unsubscribe during iteration
        for (const listener of [...this.dataListeners]) {
          listener({ id: event.sessionId, data: event.payload.data })
        }
      } else if (event.event === 'exit') {
        this.activeSessionIds.delete(event.sessionId)
        if (this.historyManager) {
          void this.historyManager
            .closeSession(event.sessionId, event.payload.code)
            .catch((err) => console.warn('[history] closeSession failed:', event.sessionId, err))
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

// Why: ENOENT/ECONNREFUSED with syscall 'connect' mean the socket is
// unreachable (daemon died). Checking syscall avoids false positives from
// token-file ENOENT (readFileSync), which has no syscall or syscall='open'.
// "Connection lost" / "Not connected" mean the daemon died while we had an
// active or stale connection. All indicate the daemon is gone and a respawn
// should be attempted.
function isDaemonGoneError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false
  }
  const errno = err as NodeJS.ErrnoException
  if ((errno.code === 'ENOENT' || errno.code === 'ECONNREFUSED') && errno.syscall === 'connect') {
    return true
  }
  const msg = err.message
  return msg === 'Connection lost' || msg === 'Not connected'
}
