import { join } from 'path'
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  renameSync,
  unlinkSync
} from 'fs'
import { getHistorySessionDirName } from './history-paths'
import type { TerminalSnapshot } from './types'

export type SessionMeta = {
  cwd: string
  cols: number
  rows: number
  startedAt: string
  endedAt: string | null
  exitCode: number | null
}

export type OpenSessionOptions = {
  cwd: string
  cols: number
  rows: number
}

type SessionWriter = {
  dir: string
  checkpointPath: string
}

export type HistoryManagerOptions = {
  onWriteError?: (sessionId: string, error: Error) => void
}

export class HistoryManager {
  private basePath: string
  private writers = new Map<string, SessionWriter>()
  private disabledSessions = new Set<string>()
  private onWriteError?: (sessionId: string, error: Error) => void

  constructor(basePath: string, opts?: HistoryManagerOptions) {
    this.basePath = basePath
    this.onWriteError = opts?.onWriteError
  }

  async openSession(sessionId: string, opts: OpenSessionOptions): Promise<void> {
    try {
      this.disabledSessions.delete(sessionId)
      const dir = join(this.basePath, getHistorySessionDirName(sessionId))
      mkdirSync(dir, { recursive: true })

      const meta: SessionMeta = {
        cwd: opts.cwd,
        cols: opts.cols,
        rows: opts.rows,
        startedAt: new Date().toISOString(),
        endedAt: null,
        exitCode: null
      }
      writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta, null, 2))

      // Why: if a session ID is reused after a previous clean exit, stale
      // recovery files may still be on disk. Without removing them, a crash
      // before the first 5s checkpoint tick would cause detectColdRestore to
      // replay stale terminal content from the previous session. Both
      // checkpoint.json and scrollback.bin (legacy) must be cleaned up
      // because the reader falls back to scrollback.bin when no checkpoint
      // exists.
      const checkpointPath = join(dir, 'checkpoint.json')
      for (const staleFile of [checkpointPath, join(dir, 'scrollback.bin')]) {
        try {
          unlinkSync(staleFile)
        } catch {
          // ENOENT is expected for new sessions
        }
      }

      this.writers.set(sessionId, {
        dir,
        checkpointPath
      })
    } catch (err) {
      this.handleWriteError(sessionId, err)
    }
  }

  // Why: on warm reattach after app relaunch, the HistoryManager is a fresh
  // instance with no in-memory writers. This registers the writer so
  // checkpoint() calls work, without overwriting meta.json or deleting the
  // existing checkpoint.json (which is the only valid recovery data until
  // the next checkpoint tick writes a fresh one).
  registerWriter(sessionId: string): void {
    if (this.writers.has(sessionId)) {
      return
    }
    const dir = join(this.basePath, getHistorySessionDirName(sessionId))
    this.writers.set(sessionId, {
      dir,
      checkpointPath: join(dir, 'checkpoint.json')
    })
  }

  // Why: replaces the old appendData (which wrote every PTY chunk to disk).
  // Checkpoints happen every ~5 seconds from a timer, not on every data event,
  // so disk I/O drops from O(PTY throughput) to O(1 write per interval).
  async checkpoint(sessionId: string, snapshot: TerminalSnapshot): Promise<void> {
    if (this.disabledSessions.has(sessionId)) {
      return
    }
    const writer = this.writers.get(sessionId)
    if (!writer) {
      return
    }

    try {
      // Why: shells that haven't emitted OSC-7 have snapshot.cwd = null.
      // Persisting null would overwrite the usable cwd from meta.json,
      // breaking cold restore cwd recovery. Fall back to the meta cwd
      // so the revived shell inherits the original working directory.
      let effectiveCwd = snapshot.cwd
      if (effectiveCwd === null) {
        const meta = this.readMetaFromDir(writer.dir)
        effectiveCwd = meta?.cwd ?? null
      }

      const data = JSON.stringify({
        snapshotAnsi: snapshot.snapshotAnsi,
        scrollbackAnsi: snapshot.scrollbackAnsi,
        rehydrateSequences: snapshot.rehydrateSequences,
        cwd: effectiveCwd,
        cols: snapshot.cols,
        rows: snapshot.rows,
        modes: snapshot.modes,
        scrollbackLines: snapshot.scrollbackLines,
        checkpointedAt: new Date().toISOString()
      })
      // Why: atomic write via tmp+rename prevents half-written checkpoints
      // on crash. Reading a corrupt checkpoint is worse than reading a
      // slightly stale one.
      const tmpPath = `${writer.checkpointPath}.tmp`
      writeFileSync(tmpPath, data)
      renameSync(tmpPath, writer.checkpointPath)
    } catch (err) {
      this.handleWriteError(sessionId, err)
    }
  }

  async closeSession(sessionId: string, exitCode: number): Promise<void> {
    const writer = this.writers.get(sessionId)
    if (!writer) {
      return
    }

    this.writers.delete(sessionId)
    try {
      this.updateMeta(writer.dir, { endedAt: new Date().toISOString(), exitCode })
    } catch (err) {
      // Why: if endedAt can't be written, the session looks like an unclean
      // shutdown and triggers a false cold restore on next launch. Disable
      // further writes and report, but don't crash the app.
      this.handleWriteError(sessionId, err)
    }
  }

  async removeSession(sessionId: string): Promise<void> {
    this.writers.delete(sessionId)
    this.disabledSessions.delete(sessionId)
    rmSync(join(this.basePath, getHistorySessionDirName(sessionId)), {
      recursive: true,
      force: true
    })
  }

  hasHistory(sessionId: string): boolean {
    return existsSync(join(this.basePath, getHistorySessionDirName(sessionId), 'meta.json'))
  }

  readMeta(sessionId: string): SessionMeta | null {
    const metaPath = join(this.basePath, getHistorySessionDirName(sessionId), 'meta.json')
    if (!existsSync(metaPath)) {
      return null
    }
    try {
      return JSON.parse(readFileSync(metaPath, 'utf-8'))
    } catch {
      return null
    }
  }

  async dispose(): Promise<void> {
    // Why: mark all open sessions as cleanly ended so they don't trigger
    // false cold-restores on next launch.
    for (const [sessionId, writer] of this.writers) {
      try {
        this.updateMeta(writer.dir, { endedAt: new Date().toISOString(), exitCode: null })
      } catch {
        this.disabledSessions.add(sessionId)
      }
    }
    this.writers.clear()
  }

  // Why: history is best-effort — any error should disable the session
  // rather than crash the app. Callers use fire-and-forget `void` promises,
  // so a re-thrown error would become an unhandled rejection.
  private handleWriteError(sessionId: string, err: unknown): void {
    this.disabledSessions.add(sessionId)
    this.onWriteError?.(sessionId, err as Error)
  }

  private readMetaFromDir(dir: string): SessionMeta | null {
    const metaPath = join(dir, 'meta.json')
    try {
      return JSON.parse(readFileSync(metaPath, 'utf-8'))
    } catch {
      return null
    }
  }

  private updateMeta(dir: string, updates: Partial<SessionMeta>): void {
    const metaPath = join(dir, 'meta.json')
    let meta: SessionMeta
    try {
      meta = JSON.parse(readFileSync(metaPath, 'utf-8'))
    } catch {
      return
    }
    Object.assign(meta, updates)
    writeFileSync(metaPath, JSON.stringify(meta, null, 2))
  }
}
