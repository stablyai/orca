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
import type { PendingOutputRecord, TerminalSnapshot } from './types'
import { TERMINAL_HISTORY_CHECKPOINT_MAX_BYTES } from './terminal-history-file-limits'
import { serializeTerminalCheckpointWithinLimit } from './terminal-checkpoint-serializer'
import { PRIVATE_FILE_MODE, tightenPathMode } from './daemon-private-file-modes'
import { tightenTerminalHistorySessionDirMode } from './terminal-history-session-files'

// Bound replay work and disk use; a full log requests a checkpoint before accepting more output.
const LOG_MAX_BYTES = 5 * 1024 * 1024

export class TerminalHistorySessionWriter {
  readonly checkpointPath: string
  readonly logPath: string
  private logGeneration: number | null
  private logBytes: number | null

  constructor(
    readonly dir: string,
    fresh: boolean,
    private readonly checkpointMaxBytes = TERMINAL_HISTORY_CHECKPOINT_MAX_BYTES
  ) {
    this.checkpointPath = join(dir, 'checkpoint.json')
    this.logPath = join(dir, 'output.log')
    this.logGeneration = fresh ? 0 : null
    this.logBytes = fresh ? 0 : null
    // Warm attach must tighten files created with older, umask-derived permissions.
    tightenTerminalHistorySessionDirMode(dir)
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
      await fsPromises.writeFile(this.logPath, encodeLogHeader(this.logGeneration ?? 0), {
        mode: PRIVATE_FILE_MODE
      })
      this.logBytes = LOG_HEADER_BYTES
    }
    await fsPromises.appendFile(this.logPath, batch, { mode: PRIVATE_FILE_MODE })
    this.logBytes = (this.logBytes ?? LOG_HEADER_BYTES) + batch.length
    return 'ok'
  }

  async checkpoint(
    snapshot: TerminalSnapshot,
    opts?: { pendingOutputSeq?: number }
  ): Promise<{ result: 'committed' } | { result: 'retryable'; error: Error }> {
    // Preserve metadata cwd until the shell sends OSC 7.
    const effectiveCwd = snapshot.cwd ?? this.readMeta()?.cwd ?? null
    this.resolveLogState()
    const generation = (this.logGeneration ?? 0) + 1
    let data: string
    try {
      data = await serializeTerminalCheckpointWithinLimit(
        snapshot,
        {
          cwd: effectiveCwd,
          generation,
          ...(opts?.pendingOutputSeq !== undefined
            ? { pendingOutputSeq: opts.pendingOutputSeq }
            : {}),
          checkpointedAt: new Date().toISOString()
        },
        this.checkpointMaxBytes
      )
    } catch (error) {
      return {
        result: 'retryable',
        error: error instanceof Error ? error : new Error(String(error))
      }
    }
    const tmpPath = `${this.checkpointPath}.tmp`
    // Create temporary files privately before publishing the checkpoint.
    await fsPromises.writeFile(tmpPath, data, { mode: PRIVATE_FILE_MODE })
    // Creation mode does not tighten a temporary file left by an earlier crash.
    tightenPathMode(tmpPath, PRIVATE_FILE_MODE)
    await fsPromises.rename(tmpPath, this.checkpointPath)
    await fsPromises.writeFile(this.logPath, encodeLogHeader(generation), {
      mode: PRIVATE_FILE_MODE
    })
    this.logGeneration = generation
    this.logBytes = LOG_HEADER_BYTES
    clearTerminalHistoryRecoveryProtection(this.dir)
    return { result: 'committed' }
  }

  // Warm writers must extend the existing generation without clobbering its log.
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
      // An unreadable log falls back to a fresh header using the checkpoint generation.
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
