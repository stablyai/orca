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

// Why 5MB: bounds cold-restore replay time and per-session disk; hitting the cap triggers one checkpoint that resets the log.
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
  /** Generation of the on-disk log header. Null until lazily resolved on first append after a warm registerWriter. */
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

      // Why: clear stale recovery files (incl. legacy scrollback.bin) so a crash before the first checkpoint can't replay a prior session's content.
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

  // Why: warm reattach has no in-memory writers; re-register without touching meta.json or checkpoint.json (only recovery data until the next tick).
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

  // Why: wake re-spawns a sleep-killed session; re-register without deleting checkpoint.json, clear endedAt so it can cold-restore again.
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
    // Why: leaving the writer active would let the next checkpoint overwrite the only good recovered-scrollback copy.
    this.writers.delete(sessionId)
    this.disabledSessions.delete(sessionId)
  }

  /** Appends one batch to the incremental log; returns 'needs-checkpoint' at capacity, signalling the caller to checkpoint() (which resets the log). */
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
      // Why max(..., header): a fresh log's header (written below) must count toward the projected size or the cap overshoots.
      const projectedBytes = Math.max(writer.logBytes ?? 0, LOG_HEADER_BYTES) + batch.length
      if (projectedBytes > LOG_MAX_BYTES) {
        return 'needs-checkpoint'
      }
      if (writer.logBytes === 0) {
        // Why: header ties this log to its base checkpoint; written lazily so warm reattaches don't clobber an appended log.
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

  // Full checkpoints are rare (clean disconnect, pending-buffer overflow, log cap); the 5s tick appends increments instead.
  async checkpoint(sessionId: string, snapshot: TerminalSnapshot): Promise<void> {
    if (this.disabledSessions.has(sessionId)) {
      return
    }
    const writer = this.writers.get(sessionId)
    if (!writer) {
      return
    }

    try {
      // Why: snapshot.cwd is null until OSC-7; persisting null would clobber meta.json's usable cwd and break cold-restore recovery.
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
      // Why: tmp+rename is atomic (corrupt checkpoint > stale); async so a sync ~MB write can't stall IPC (worse under Windows AV).
      // The adapter's checkpointInFlight guard serializes checkpoints, so concurrent async writes can't collide on the fixed .tmp path.
      const tmpPath = `${writer.checkpointPath}.tmp`
      await fsPromises.writeFile(tmpPath, data)
      await fsPromises.rename(tmpPath, writer.checkpointPath)
      // Why: snapshot subsumes logged records, so reset the log to the new generation; a stale-generation log is ignored on restore.
      await fsPromises.writeFile(writer.logPath, encodeLogHeader(generation))
      writer.logGeneration = generation
      writer.logBytes = LOG_HEADER_BYTES
    } catch (err) {
      this.handleWriteError(sessionId, err)
    }
  }

  // Why: a warm registerWriter may attach to an existing log; read generation/size once so appends continue it, not clobber it.
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
    // Missing/unreadable header: logBytes = 0 makes the next append truncate-rewrite, so a garbage file can't be extended.
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
    // Why: session is dead; without this a transient-error-poisoned id leaks forever (sessionIds never reused).
    this.disabledSessions.delete(sessionId)
    try {
      this.updateMeta(writer.dir, { endedAt: new Date().toISOString(), exitCode })
    } catch (err) {
      // Why: an unwritten endedAt looks like an unclean shutdown → false cold restore next launch.
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
    // Why: mark open sessions cleanly ended so they don't trigger false cold-restores next launch.
    for (const [sessionId, writer] of this.writers) {
      try {
        this.updateMeta(writer.dir, { endedAt: new Date().toISOString(), exitCode: null })
      } catch {
        this.disabledSessions.add(sessionId)
      }
    }
    this.writers.clear()
  }

  // Why: history is best-effort; callers fire-and-forget so a throw would be an unhandled rejection — disable instead.
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
