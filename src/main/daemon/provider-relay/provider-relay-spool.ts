import { open, unlink, type FileHandle } from 'node:fs/promises'
import type { ProviderRelayRecord } from '../protocol/daemon-provider-relay-protocol'
import { replaySpoolFile } from './provider-relay-spool-replay'

export const RELAY_SPOOL_MEMORY_CAP_BYTES = 1024 * 1024
export const RELAY_SPOOL_FILE_CAP_BYTES = 16 * 1024 * 1024
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

type SpoolWrite = { chunk: string; records: ProviderRelayRecord[]; bytes: number[] }

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
  /** Packed [seq, bytes] per file record, so back-pressure counts only what is still unacked. */
  private fileIndex: number[] = []
  private fileIndexHead = 0
  private fileUnackedBytes = 0
  private fileLastSeq = 0
  /** The not-yet-started write, so appends coalesce without reordering around a removal. */
  private queuedWrite: SpoolWrite | null = null
  /** A failed write keeps every later record in memory, so a full or broken disk loses nothing. */
  private fileFailed = false
  private attachGeneration = 0
  private io: Promise<void> = Promise.resolve()
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
    if (this.mode === 'detached' && !this.fileFailed) {
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
    while (
      this.fileIndexHead < this.fileIndex.length &&
      this.fileIndex[this.fileIndexHead] <= this.acked
    ) {
      this.fileUnackedBytes -= this.fileIndex[this.fileIndexHead + 1]
      this.fileIndexHead += 2
    }
    if (
      this.fileIndexHead >= 2 * MEMORY_COMPACT_MIN &&
      this.fileIndexHead * 2 >= this.fileIndex.length
    ) {
      this.fileIndex = this.fileIndex.slice(this.fileIndexHead)
      this.fileIndexHead = 0
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
    this.updatePressure()
    const current = (): boolean =>
      generation === this.attachGeneration && this.mode === 'replaying' && !this.disposed
    await this.io
    let after = Math.max(fromSeq, this.acked)
    // A write that failed partway left whole records in the file and copies in memory; send each once.
    let fileHighest = after
    if (
      this.fileLastSeq > 0 &&
      !(await replaySpoolFile({
        path: this.options.path,
        after,
        current,
        deliver: (record) => {
          fileHighest = Math.max(fileHighest, record.seq)
          this.options.deliver(record)
        },
        drained: this.options.drained
      }))
    ) {
      return this.nextSeqValue - 1
    }
    if (!current()) {
      return this.nextSeqValue - 1
    }
    after = fileHighest
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
    if (!this.fileFailed) {
      const held = this.memory.slice(this.memoryHead)
      this.memory = []
      this.memoryHead = 0
      this.ackedHeldBytes = 0
      this.memoryBytes = 0
      for (const record of held) {
        if (this.fileFailed) {
          this.memory.push(record)
          this.memoryBytes += record.line.length
        } else {
          this.writeToFile(record)
        }
      }
    }
    this.updatePressure()
    return this.io
  }

  async dispose(): Promise<void> {
    this.disposed = true
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
      this.mode === 'detached'
        ? [this.fileUnackedBytes + this.memoryBytes, this.fileCap]
        : [this.memoryBytes, this.memoryCap]
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
    let encoded: string
    try {
      encoded = `${JSON.stringify(record)}\n`
    } catch {
      // Too large to escape: it and every later record stay in memory, so seq order holds.
      this.fileFailed = true
      this.memory.push(record)
      this.memoryBytes += record.line.length
      return
    }
    const bytes = Buffer.byteLength(encoded)
    this.fileUnackedBytes += bytes
    this.fileIndex.push(record.seq, bytes)
    this.fileLastSeq = record.seq
    const queued = this.queuedWrite
    if (queued) {
      queued.chunk += encoded
      queued.records.push(record)
      queued.bytes.push(bytes)
    } else {
      const write: SpoolWrite = { chunk: encoded, records: [record], bytes: [bytes] }
      this.queuedWrite = write
      this.io = this.io
        .then(async () => {
          if (this.queuedWrite === write) {
            this.queuedWrite = null
          }
          if (write.chunk.length === 0 || this.fileFailed) {
            this.keepInMemory(write)
            return
          }
          try {
            this.file ??= await open(this.options.path, 'a', 0o600)
            // appendFile keeps writing until every byte lands; a bare write may stop short.
            await this.file.appendFile(write.chunk)
          } catch {
            this.fileFailed = true
            this.keepInMemory(write)
          }
        })
        .catch(() => {})
    }
  }

  /** Records a failed write didn't land go back to memory in seq order, still unacked. */
  private keepInMemory(write: SpoolWrite): void {
    if (write.chunk.length === 0 || this.disposed) {
      return
    }
    const failed = new Set<number>()
    write.records.forEach((record, index) => {
      failed.add(record.seq)
      this.fileUnackedBytes -= write.bytes[index]
      if (record.seq > this.acked) {
        this.memoryBytes += record.line.length
      }
    })
    const index: number[] = []
    for (let at = this.fileIndexHead; at < this.fileIndex.length; at += 2) {
      if (!failed.has(this.fileIndex[at])) {
        index.push(this.fileIndex[at], this.fileIndex[at + 1])
      }
    }
    this.fileIndex = index
    this.fileIndexHead = 0
    const unacked = write.records.filter((record) => record.seq > this.acked)
    this.memory = [...unacked, ...this.memory.slice(this.memoryHead)].sort(
      (left, right) => left.seq - right.seq
    )
    this.memoryHead = 0
    this.updatePressure()
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
    this.fileUnackedBytes = 0
    this.fileIndex = []
    this.fileIndexHead = 0
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
