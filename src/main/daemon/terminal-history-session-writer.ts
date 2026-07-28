import {
  closeSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  promises as fsPromises
} from 'node:fs'
import { join } from 'node:path'
import {
  decodeLogHeader,
  encodeLogBatch,
  encodeLogHeader,
  LOG_HEADER_BYTES
} from './terminal-history-log'
import type { SessionMeta } from './terminal-history-metadata'
import { clearTerminalHistoryRecoveryProtection } from './terminal-history-recovery-quarantine'
import type { PendingOutputRecord, TerminalCheckpointFile, TerminalSnapshot } from './types'

// Why 5MB: bounds cold-restore replay time and per-session disk; hitting the cap triggers one checkpoint that resets the log.
const LOG_MAX_BYTES = 5 * 1024 * 1024

export class TerminalHistorySessionWriter {
  readonly checkpointPath: string
  readonly logPath: string
  private logGeneration: number | null
  private logBytes: number | null

  constructor(
    readonly dir: string,
    fresh: boolean
  ) {
    this.checkpointPath = join(dir, 'checkpoint.json')
    this.logPath = join(dir, 'output.log')
    this.logGeneration = fresh ? 0 : null
    this.logBytes = fresh ? 0 : null
  }

  async appendIncrements(
    seq: number,
    records: PendingOutputRecord[]
  ): Promise<'ok' | 'needs-checkpoint'> {
    this.resolveLogState()
    const batch = encodeLogBatch(seq, records)
    const projectedBytes = Math.max(this.logBytes ?? 0, LOG_HEADER_BYTES) + batch.length
    if (projectedBytes > LOG_MAX_BYTES) {
      return 'needs-checkpoint'
    }
    if (this.logBytes === 0) {
      await fsPromises.writeFile(this.logPath, encodeLogHeader(this.logGeneration ?? 0))
      this.logBytes = LOG_HEADER_BYTES
    }
    await fsPromises.appendFile(this.logPath, batch)
    this.logBytes = (this.logBytes ?? LOG_HEADER_BYTES) + batch.length
    return 'ok'
  }

  async checkpoint(snapshot: TerminalSnapshot): Promise<void> {
    // Why: snapshot.cwd is null until OSC-7; preserve meta.json's usable cwd for cold restore.
    const effectiveCwd = snapshot.cwd ?? this.readMeta()?.cwd ?? null
    this.resolveLogState()
    const generation = (this.logGeneration ?? 0) + 1
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
    const tmpPath = `${this.checkpointPath}.tmp`
    await fsPromises.writeFile(tmpPath, JSON.stringify(checkpointFile))
    await fsPromises.rename(tmpPath, this.checkpointPath)
    await fsPromises.writeFile(this.logPath, encodeLogHeader(generation))
    this.logGeneration = generation
    this.logBytes = LOG_HEADER_BYTES
    clearTerminalHistoryRecoveryProtection(this.dir)
  }

  // Why: a warm writer must append to the existing generation without clobbering its log.
  private resolveLogState(): void {
    if (this.logBytes !== null && this.logGeneration !== null) {
      return
    }
    let headerGeneration: number | null = null
    let size = 0
    try {
      const fd = openSync(this.logPath, 'r')
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
      this.logGeneration = headerGeneration
      this.logBytes = size
      return
    }
    this.logBytes = 0
    this.logGeneration = this.readCheckpointGeneration() ?? 0
  }

  private readCheckpointGeneration(): number | null {
    try {
      const checkpoint = JSON.parse(readFileSync(this.checkpointPath, 'utf-8'))
      return typeof checkpoint.generation === 'number' ? checkpoint.generation : null
    } catch {
      return null
    }
  }

  private readMeta(): SessionMeta | null {
    try {
      return JSON.parse(readFileSync(join(this.dir, 'meta.json'), 'utf-8'))
    } catch {
      return null
    }
  }
}
