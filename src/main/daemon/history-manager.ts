import { join } from 'node:path'
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  unlinkSync,
  openSync,
  closeSync,
  readSync,
  fstatSync,
  promises as fsPromises
} from 'node:fs'
import { getHistorySessionDirName } from './history-paths'
import {
  decodeLogHeader,
  encodeLogBatch,
  encodeLogHeader,
  LOG_HEADER_BYTES
} from './terminal-history-log'
import type { PendingOutputRecord, TerminalCheckpointFile, TerminalSnapshot } from './types'

// Why 5MB: bounds both cold-restore replay time and disk usage per session.
// Reaching the cap triggers one full snapshot checkpoint (which subsumes and
// resets the log) — one O(buffer) serialize per ~5MB of output instead of one
// per 5-second tick.
const LOG_MAX_BYTES = 5 * 1024 * 1024

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
  logPath: string
  /** Generation of the on-disk log header. Null until lazily resolved on the
   *  first append after a warm registerWriter (the file may predate us). */
  logGeneration: number | null
  /** Current log file size. Null until lazily resolved alongside generation. */
  logBytes: number | null
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
      const logPath = join(dir, 'output.log')
      for (const staleFile of [checkpointPath, join(dir, 'scrollback.bin'), logPath]) {
        try {
          unlinkSync(staleFile)
        } catch {
          // ENOENT is expected for new sessions
        }
      }

      this.writers.set(sessionId, {
        dir,
        checkpointPath,
        logPath,
        logGeneration: 0,
        logBytes: 0
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
      checkpointPath: join(dir, 'checkpoint.json'),
      logPath: join(dir, 'output.log'),
      logGeneration: null,
      logBytes: null
    })
  }

  // Why: wake after sleep re-spawns a session whose history was closed by the
  // sleep-time kill. Re-register the writer without deleting checkpoint.json
  // (still the only recovery data until the next tick) and clear endedAt so
  // the next sleep can cold-restore this session again.
  reopenSession(sessionId: string): void {
    this.disabledSessions.delete(sessionId)
    this.registerWriter(sessionId)
    const writer = this.writers.get(sessionId)
    if (!writer) {
      return
    }
    try {
      this.updateMeta(writer.dir, { endedAt: null, exitCode: null })
    } catch (err) {
      this.handleWriteError(sessionId, err)
    }
  }

  suspendSession(sessionId: string): void {
    // Why: if a fresh daemon cannot accept recovered scrollback, leaving its
    // writer active would let the next checkpoint overwrite the only good copy.
    this.writers.delete(sessionId)
    this.disabledSessions.delete(sessionId)
  }

  /** Appends one take batch to the incremental log. Returns 'needs-checkpoint'
   *  when the log is at capacity — the caller must take a full snapshot, which
   *  subsumes the un-appended records (they were already applied to the live
   *  emulator) and resets the log via checkpoint(). */
  async appendIncrements(
    sessionId: string,
    seq: number,
    records: PendingOutputRecord[]
  ): Promise<'ok' | 'needs-checkpoint'> {
    if (this.disabledSessions.has(sessionId) || records.length === 0) {
      return 'ok'
    }
    const writer = this.writers.get(sessionId)
    if (!writer) {
      return 'ok'
    }
    try {
      this.resolveLogState(writer)
      const batch = encodeLogBatch(seq, records)
      // Why max(..., header): a fresh log gets its header written below, so
      // the projected size must include it or the cap can be overshot.
      const projectedBytes = Math.max(writer.logBytes ?? 0, LOG_HEADER_BYTES) + batch.length
      if (projectedBytes > LOG_MAX_BYTES) {
        return 'needs-checkpoint'
      }
      if (writer.logBytes === 0) {
        // Why: header carries the generation that ties this log to its base
        // checkpoint; written lazily so warm reattaches never clobber a log
        // that already has appended batches.
        await fsPromises.writeFile(writer.logPath, encodeLogHeader(writer.logGeneration ?? 0))
        writer.logBytes = LOG_HEADER_BYTES
      }
      await fsPromises.appendFile(writer.logPath, batch)
      writer.logBytes = (writer.logBytes ?? LOG_HEADER_BYTES) + batch.length
      return 'ok'
    } catch (err) {
      this.handleWriteError(sessionId, err)
      return 'ok'
    }
  }

  // Why: replaces the old appendData (which wrote every PTY chunk to disk).
  // Full checkpoints are now rare (clean disconnect, pending-buffer overflow,
  // log cap); the 5s tick appends increments via appendIncrements instead.
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

      this.resolveLogState(writer)
      const generation = (writer.logGeneration ?? 0) + 1
      const checkpointFile: TerminalCheckpointFile = {
        snapshotAnsi: snapshot.snapshotAnsi,
        scrollbackAnsi: snapshot.scrollbackAnsi,
        oscLinks: snapshot.oscLinks,
        rehydrateSequences: snapshot.rehydrateSequences,
        cwd: effectiveCwd,
        cols: snapshot.cols,
        rows: snapshot.rows,
        modes: snapshot.modes,
        scrollbackLines: snapshot.scrollbackLines,
        generation,
        checkpointedAt: new Date().toISOString()
      }
      const data = JSON.stringify(checkpointFile)
      // Why: atomic write via tmp+rename prevents half-written checkpoints
      // on crash. Reading a corrupt checkpoint is worse than reading a
      // slightly stale one. Async IO — a sync ~MB write (worse under
      // antivirus scanning on Windows) would stall input/IPC for its
      // duration. Overlap is prevented by the adapter's checkpointInFlight
      // guard, which awaits this promise before the next tick.
      const tmpPath = `${writer.checkpointPath}.tmp`
      await fsPromises.writeFile(tmpPath, data)
      await fsPromises.rename(tmpPath, writer.checkpointPath)
      // Why: the snapshot subsumes every logged record, so the log resets to
      // the new generation. Crash between rename and this reset is safe: the
      // stale log's generation no longer matches the checkpoint's, so the
      // restore reader ignores it.
      await fsPromises.writeFile(writer.logPath, encodeLogHeader(generation))
      writer.logGeneration = generation
      writer.logBytes = LOG_HEADER_BYTES
    } catch (err) {
      this.handleWriteError(sessionId, err)
    }
  }

  // Why: a warm registerWriter may attach to a session dir that already has a
  // log (app relaunch while the daemon kept running). Generation and size are
  // read from disk once so appends continue the existing stream instead of
  // clobbering it.
  private resolveLogState(writer: SessionWriter): void {
    if (writer.logBytes !== null && writer.logGeneration !== null) {
      return
    }
    let headerGeneration: number | null = null
    let size = 0
    try {
      const fd = openSync(writer.logPath, 'r')
      try {
        size = fstatSync(fd).size
        const header = Buffer.alloc(LOG_HEADER_BYTES)
        if (readSync(fd, header, 0, LOG_HEADER_BYTES, 0) === LOG_HEADER_BYTES) {
          headerGeneration = decodeLogHeader(header)
        }
      } finally {
        closeSync(fd)
      }
    } catch {
      // Missing log file — fresh state below.
    }
    if (headerGeneration !== null) {
      writer.logGeneration = headerGeneration
      writer.logBytes = size
      return
    }
    // Missing or unreadable header: logBytes = 0 makes the next append rewrite
    // the file from scratch (writeFile truncates), so a garbage file cannot be
    // extended.
    writer.logBytes = 0
    writer.logGeneration = this.readCheckpointGeneration(writer) ?? 0
  }

  private readCheckpointGeneration(writer: SessionWriter): number | null {
    try {
      const checkpoint = JSON.parse(readFileSync(writer.checkpointPath, 'utf-8'))
      return typeof checkpoint.generation === 'number' ? checkpoint.generation : null
    } catch {
      return null
    }
  }

  async closeSession(sessionId: string, exitCode: number): Promise<void> {
    const writer = this.writers.get(sessionId)
    if (!writer) {
      return
    }

    this.writers.delete(sessionId)
    // Why: the session is dead, so its disabled flag is dead state. Without this
    // a session poisoned by a transient mid-life write error leaks its id in
    // disabledSessions forever (sessionIds are fresh per PTY, never reused).
    this.disabledSessions.delete(sessionId)
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

  isSessionDisabled(sessionId: string): boolean {
    return this.disabledSessions.has(sessionId)
  }

  disabledSessionCount(): number {
    return this.disabledSessions.size
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
