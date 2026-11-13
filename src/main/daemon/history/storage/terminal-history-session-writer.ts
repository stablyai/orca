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
import type { PendingOutputRecord } from '../../protocol/daemon-rpc-contract'
import type { TerminalSnapshot } from '../../protocol/terminal-snapshot'
import {
  TERMINAL_HISTORY_CHECKPOINT_MAX_BYTES,
  TERMINAL_HISTORY_META_MAX_BYTES
} from './terminal-history-file-limits'
import { readTerminalHistoryJsonAsync } from './terminal-history-file-reader'
import {
  serializeTerminalCheckpointStrict,
  serializeTerminalCheckpointWithinLimit
} from '../restoration/terminal-checkpoint-serializer'
import {
  PRIVATE_FILE_MODE,
  tightenPathModeAsync
} from '../../endpoint/publication/daemon-private-file-modes'
import {
  tightenTerminalHistorySessionDirMode,
  tightenTerminalHistorySessionDirModeAsync
} from './terminal-history-session-files'

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
    private readonly checkpointMaxBytes = TERMINAL_HISTORY_CHECKPOINT_MAX_BYTES,
    // Checked synchronously before each file mutation: a successor shares these paths.
    private readonly isAdmitted: () => boolean = () => true,
    // A host writer's known log state; its awaited mode repair already ran in openHost.
    hostLog?: { generation: number; bytes: number }
  ) {
    this.checkpointPath = join(dir, 'checkpoint.json')
    this.logPath = join(dir, 'output.log')
    this.logGeneration = hostLog?.generation ?? (fresh ? 0 : null)
    this.logBytes = hostLog?.bytes ?? (fresh ? 0 : null)
    if (!hostLog) {
      // Warm attach must tighten files created with older, umask-derived permissions.
      tightenTerminalHistorySessionDirMode(dir)
    }
  }

  /** The daemon host's writer: modes repaired without blocking, log state supplied by its caller. */
  static async openHost(
    dir: string,
    log: { generation: number; bytes: number },
    isAdmitted: () => boolean
  ): Promise<TerminalHistorySessionWriter> {
    await tightenTerminalHistorySessionDirModeAsync(dir)
    return new TerminalHistorySessionWriter(
      dir,
      false,
      TERMINAL_HISTORY_CHECKPOINT_MAX_BYTES,
      isAdmitted,
      log
    )
  }

  /** Complete frames in the current generation; a failed append or reset leaves this unchanged. */
  get committedLog(): { generation: number; bytes: number } | null {
    return this.logGeneration === null || this.logBytes === null
      ? null
      : { generation: this.logGeneration, bytes: this.logBytes }
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
      this.assertAdmitted()
      await fsPromises.writeFile(this.logPath, encodeLogHeader(this.logGeneration ?? 0), {
        mode: PRIVATE_FILE_MODE
      })
      this.logBytes = LOG_HEADER_BYTES
    }
    this.assertAdmitted()
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
    await this.publishCheckpoint(data, generation)
    return { result: 'committed' }
  }

  /**
   * A host publication: the whole image or nothing, never row-trimmed. An explicit generation
   * supersedes every predecessor generation the caller validated. Host writers open with their
   * log state known, so nothing here resolves it synchronously.
   */
  async checkpointStrict(
    snapshot: TerminalSnapshot,
    opts: { pendingOutputSeq: number; generation?: number }
  ): Promise<
    | { result: 'committed'; data: string; generation: number }
    | { result: 'too-large' }
    | { result: 'retryable'; error: Error }
  > {
    const generation = opts.generation ?? (this.logGeneration ?? 0) + 1
    const cwd = snapshot.cwd ?? (await this.readMetaCwd())
    const data = serializeTerminalCheckpointStrict(
      snapshot,
      {
        cwd,
        generation,
        pendingOutputSeq: opts.pendingOutputSeq,
        checkpointedAt: new Date().toISOString()
      },
      this.checkpointMaxBytes
    )
    if (data === null) {
      return { result: 'too-large' }
    }
    try {
      await this.publishCheckpoint(data, generation)
    } catch (error) {
      return {
        result: 'retryable',
        error: error instanceof Error ? error : new Error(String(error))
      }
    }
    return { result: 'committed', data, generation }
  }

  // Rename publishes the checkpoint; the header reset then starts its generation's log.
  private async publishCheckpoint(data: string, generation: number): Promise<void> {
    const tmpPath = `${this.checkpointPath}.tmp`
    // Create temporary files privately before publishing the checkpoint.
    this.assertAdmitted()
    // Only a temporary file this publication issued is its to remove.
    let issued = true
    try {
      await fsPromises.writeFile(tmpPath, data, { mode: PRIVATE_FILE_MODE })
      // Creation mode does not tighten a temporary file left by an earlier crash.
      this.assertAdmitted()
      await tightenPathModeAsync(tmpPath, PRIVATE_FILE_MODE)
      this.assertAdmitted()
      await fsPromises.rename(tmpPath, this.checkpointPath)
      issued = false
    } catch (error) {
      if (issued) {
        await fsPromises.unlink(tmpPath).catch(() => {})
      }
      throw error
    }
    this.assertAdmitted()
    await fsPromises.writeFile(this.logPath, encodeLogHeader(generation), {
      mode: PRIVATE_FILE_MODE
    })
    this.logGeneration = generation
    this.logBytes = LOG_HEADER_BYTES
    this.assertAdmitted()
    await clearTerminalHistoryRecoveryProtection(this.dir)
  }

  get admitted(): boolean {
    return this.isAdmitted()
  }

  assertAdmitted(): void {
    if (!this.isAdmitted()) {
      throw new Error('terminal_history_admission_closed')
    }
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

  // Bounded and awaited for host publication; an unreadable or foreign file has no folder.
  private async readMetaCwd(): Promise<string | null> {
    try {
      const meta = await readTerminalHistoryJsonAsync<unknown>(
        join(this.dir, 'meta.json'),
        TERMINAL_HISTORY_META_MAX_BYTES
      )
      return typeof meta === 'object' &&
        meta !== null &&
        'cwd' in meta &&
        typeof meta.cwd === 'string'
        ? meta.cwd
        : null
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
