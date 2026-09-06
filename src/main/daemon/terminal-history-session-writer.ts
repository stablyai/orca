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

// Why 5MB: bounds cold-restore replay time and per-session disk; hitting the cap triggers one checkpoint that resets the log.
const LOG_MAX_BYTES = 5 * 1024 * 1024

// Why a head probe: warm reattach only needs the generation number, but
// checkpoint.json can reach TERMINAL_HISTORY_CHECKPOINT_MAX_BYTES; the writer
// emits generation as the first JSON key, so the number is provably in the head.
const GENERATION_HEAD_PROBE_BYTES = 128

export function probeCheckpointGenerationHead(path: string): number | null {
  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
    const head = Buffer.alloc(GENERATION_HEAD_PROBE_BYTES)
    const read = readSync(fd, head, 0, GENERATION_HEAD_PROBE_BYTES, 0)
    // The token boundary after the digits (`,"` next key, or `}` sole key) must
    // close the match, or a truncated/corrupt head could accept a digit prefix
    // of something that is not this file's generation.
    const match = head.toString('utf8', 0, read).match(/^\{"generation":(\d+)(?:"|,|})/)
    return match ? Number(match[1]) : null
  } catch {
    return null
  } finally {
    if (fd !== undefined) {
      closeSync(fd)
    }
  }
}

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

  async checkpoint(
    snapshot: TerminalSnapshot,
    opts?: { pendingOutputSeq?: number }
  ): Promise<{ result: 'committed' } | { result: 'retryable'; error: Error }> {
    // Why: snapshot.cwd is null until OSC-7; preserve meta.json's usable cwd for cold restore.
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
    await fsPromises.writeFile(tmpPath, data)
    await fsPromises.rename(tmpPath, this.checkpointPath)
    await fsPromises.writeFile(this.logPath, encodeLogHeader(generation))
    this.logGeneration = generation
    this.logBytes = LOG_HEADER_BYTES
    clearTerminalHistoryRecoveryProtection(this.dir)
    return { result: 'committed' }
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
    const probed = probeCheckpointGenerationHead(this.checkpointPath)
    if (probed !== null) {
      return probed
    }
    // Legacy checkpoints keep generation late in the JSON; only they pay the full parse.
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
