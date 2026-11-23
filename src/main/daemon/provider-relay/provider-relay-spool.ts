import { createReadStream } from 'node:fs'
import { open, unlink, type FileHandle } from 'node:fs/promises'
import type { ProviderRelayRecord } from '../protocol/daemon-provider-relay-protocol'

export const RELAY_SPOOL_MEMORY_CAP_BYTES = 1024 * 1024
export const RELAY_SPOOL_FILE_CAP_BYTES = 16 * 1024 * 1024
const DETACHED_FSYNC_INTERVAL_MS = 1_000
const REPLAY_READ_CHUNK_BYTES = 64 * 1024
/** Acked records are skipped by index and compacted in bulk, so per-line acks stay O(1). */
const MEMORY_COMPACT_MIN = 1024

type SpoolOptions = {
  path: string
  /** Called with each record while a client is attached, in seq order. */
  deliver: (record: ProviderRelayRecord) => void
  /** True asks the owner to stop reading the agent's stdout; the agent is never ended for size. */
  onPressureChanged: (paused: boolean) => void
  /** Resolves once the client's stream can take more, so a replay never floods its socket. */
  drained?: () => Promise<void>
  memoryCapBytes?: number
  fileCapBytes?: number
}

type SpoolMode = 'attached' | 'replaying' | 'detached'

function isSpoolRecord(value: unknown): value is ProviderRelayRecord {
  return (
    typeof value === 'object' &&
    value !== null &&
    'seq' in value &&
    Number.isSafeInteger(value.seq) &&
    'line' in value &&
    typeof value.line === 'string'
  )
}

/**
 * Seq-numbered stdout lines awaiting the client's ack. Attached, they live in memory; detached,
 * they are appended to a private file. Acks trim; the file goes once everything in it is acked.
 */
export class ProviderRelaySpool {
  private nextSeqValue = 1
  private acked = 0
  private memory: ProviderRelayRecord[] = []
  private memoryHead = 0
  private ackedHeldBytes = 0
  private memoryBytes = 0
  private mode: SpoolMode = 'detached'
  private file: FileHandle | null = null
  private fileBytes = 0
  private fileLastSeq = 0
  /** The not-yet-started write, so appends coalesce without reordering around a removal. */
  private queuedWrite: { chunk: string } | null = null
  private attachGeneration = 0
  private io: Promise<void> = Promise.resolve()
  private fsyncTimer: ReturnType<typeof setTimeout> | null = null
  private paused = false
  private disposed = false
  private readonly memoryCap: number
  private readonly fileCap: number

  constructor(private readonly options: SpoolOptions) {
    this.memoryCap = options.memoryCapBytes ?? RELAY_SPOOL_MEMORY_CAP_BYTES
    this.fileCap = options.fileCapBytes ?? RELAY_SPOOL_FILE_CAP_BYTES
  }

  get nextSeq(): number {
    return this.nextSeqValue
  }

  get ackedSeq(): number {
    return this.acked
  }

  get drained(): boolean {
    return this.acked >= this.nextSeqValue - 1
  }

  /** Replay is done and new records go straight to the client. */
  get streaming(): boolean {
    return this.mode === 'attached'
  }

  append(line: string): ProviderRelayRecord {
    const record = { seq: this.nextSeqValue++, line }
    if (this.mode === 'detached') {
      this.writeToFile(record)
    } else {
      this.memory.push(record)
      this.memoryBytes += line.length
      if (this.mode === 'attached') {
        this.options.deliver(record)
      }
    }
    this.updatePressure()
    return record
  }

  ack(seq: number): void {
    if (!Number.isSafeInteger(seq) || seq <= this.acked) {
      return
    }
    this.acked = Math.min(seq, this.nextSeqValue - 1)
    while (this.memoryHead < this.memory.length && this.memory[this.memoryHead].seq <= this.acked) {
      const { length } = this.memory[this.memoryHead].line
      this.memoryBytes -= length
      this.ackedHeldBytes += length
      this.memoryHead++
    }
    // Acked lines are released by count or by size, so a few huge lines cannot outlive their ack.
    if (
      this.memoryHead === this.memory.length ||
      this.ackedHeldBytes >= this.memoryCap / 2 ||
      (this.memoryHead >= MEMORY_COMPACT_MIN && this.memoryHead * 2 >= this.memory.length)
    ) {
      this.ackedHeldBytes = 0
      this.memory = this.memory.slice(this.memoryHead)
      this.memoryHead = 0
    }
    if (this.fileLastSeq > 0 && this.acked >= this.fileLastSeq) {
      this.removeFile()
    }
    this.updatePressure()
  }

  /** Replays records after `fromSeq` through `deliver`, then streams live; returns the last replayed seq. */
  async attach(fromSeq: number): Promise<number> {
    const generation = ++this.attachGeneration
    this.mode = 'replaying'
    this.stopFsyncTimer()
    this.updatePressure()
    const current = (): boolean =>
      generation === this.attachGeneration && this.mode === 'replaying' && !this.disposed
    await this.io
    const after = Math.max(fromSeq, this.acked)
    if (this.fileLastSeq > 0 && !(await this.replayFile(after, current))) {
      return this.nextSeqValue - 1
    }
    if (!current()) {
      return this.nextSeqValue - 1
    }
    for (let index = this.memoryHead; index < this.memory.length; index++) {
      if (this.memory[index].seq > after) {
        this.options.deliver(this.memory[index])
      }
    }
    this.mode = 'attached'
    this.updatePressure()
    return this.nextSeqValue - 1
  }

  detach(): Promise<void> {
    if (this.mode === 'detached') {
      return this.io
    }
    this.mode = 'detached'
    this.attachGeneration++
    for (let index = this.memoryHead; index < this.memory.length; index++) {
      this.writeToFile(this.memory[index])
    }
    this.memory = []
    this.memoryHead = 0
    this.ackedHeldBytes = 0
    this.memoryBytes = 0
    this.updatePressure()
    this.io = this.io.then(() => this.file?.sync()).catch(() => {})
    return this.io
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.stopFsyncTimer()
    this.memory = []
    this.memoryHead = 0
    this.ackedHeldBytes = 0
    this.memoryBytes = 0
    this.removeFile()
    await this.io
  }

  /** An ended, detached relay writes nothing more; its fd closes and the file waits for a reader. */
  closeHandle(): void {
    this.io = this.io
      .then(async () => {
        if (this.mode === 'detached' && !this.queuedWrite) {
          const file = this.file
          this.file = null
          await file?.close()
        }
      })
      .catch(() => {})
  }

  /** Pause at the cap, resume below half of it, so acks near the cap don't flap the agent's stdout. */
  private updatePressure(): void {
    const [held, cap] =
      this.mode === 'detached' ? [this.fileBytes, this.fileCap] : [this.memoryBytes, this.memoryCap]
    const paused = !this.disposed && (this.paused ? held >= cap / 2 : held >= cap)
    if (paused !== this.paused) {
      this.paused = paused
      this.options.onPressureChanged(paused)
    }
  }

  private writeToFile(record: ProviderRelayRecord): void {
    if (this.disposed) {
      return
    }
    const encoded = `${JSON.stringify(record)}\n`
    this.fileBytes += Buffer.byteLength(encoded)
    this.fileLastSeq = record.seq
    if (this.queuedWrite) {
      this.queuedWrite.chunk += encoded
    } else {
      const write = { chunk: encoded }
      this.queuedWrite = write
      this.io = this.io
        .then(async () => {
          if (this.queuedWrite === write) {
            this.queuedWrite = null
          }
          if (write.chunk.length === 0) {
            return
          }
          this.file ??= await open(this.options.path, 'a', 0o600)
          await this.file.write(write.chunk)
        })
        .catch(() => {})
    }
    if (this.mode === 'detached' && !this.fsyncTimer) {
      this.fsyncTimer = setTimeout(() => {
        this.fsyncTimer = null
        this.io = this.io.then(() => this.file?.sync()).catch(() => {})
      }, DETACHED_FSYNC_INTERVAL_MS)
      this.fsyncTimer.unref?.()
    }
  }

  private stopFsyncTimer(): void {
    if (this.fsyncTimer) {
      clearTimeout(this.fsyncTimer)
      this.fsyncTimer = null
    }
  }

  /** Streams the file in chunks, yielding to the client's drain; false when the attach went stale. */
  private async replayFile(after: number, current: () => boolean): Promise<boolean> {
    // utf8 decoding keeps a character split across chunks whole.
    const stream = createReadStream(this.options.path, {
      encoding: 'utf8',
      highWaterMark: REPLAY_READ_CHUNK_BYTES
    })
    // A record longer than a chunk collects its parts and is joined once, not re-scanned per chunk.
    let parts: string[] = []
    let partial = ''
    try {
      for await (const chunk of stream) {
        if (!chunk.includes('\n')) {
          parts.push(chunk)
          continue
        }
        const lines = (partial + parts.join('') + chunk).split('\n')
        parts = []
        partial = lines.pop() ?? ''
        for (const line of lines) {
          this.replayLine(line, after)
        }
        await this.options.drained?.()
        if (!current()) {
          return false
        }
      }
      this.replayLine(partial + parts.join(''), after)
      return true
    } catch {
      return current()
    } finally {
      stream.destroy()
    }
  }

  private replayLine(line: string, after: number): void {
    if (line.length === 0) {
      return
    }
    try {
      const record: unknown = JSON.parse(line)
      if (isSpoolRecord(record) && record.seq > after) {
        this.options.deliver(record)
      }
    } catch {}
  }

  private removeFile(): void {
    if (this.fileLastSeq === 0 && !this.file) {
      return
    }
    // A queued write holds only acked records, so it is dropped rather than written.
    if (this.queuedWrite) {
      this.queuedWrite.chunk = ''
      this.queuedWrite = null
    }
    this.fileBytes = 0
    this.fileLastSeq = 0
    this.io = this.io
      .then(async () => {
        const file = this.file
        this.file = null
        await file?.close()
        await unlink(this.options.path).catch(() => {})
      })
      .catch(() => {})
  }
}
