import { open, unlink, type FileHandle } from 'node:fs/promises'
import type { ProviderRelayRecord } from '../protocol/daemon-provider-relay-protocol'
import { SpoolFileIndex } from './provider-relay-spool-file-index'
import { replaySpoolFileRecords } from './provider-relay-spool-replay'

export const RELAY_SPOOL_MEMORY_CAP_BYTES = 1024 * 1024
export const RELAY_SPOOL_FILE_CAP_BYTES = 16 * 1024 * 1024
/** Acked records are skipped by index and compacted in bulk, so per-line acks stay O(1). */
const MEMORY_COMPACT_MIN = 1024
/** Coalesced appends stop growing here, so joining records can never pass the engine's string limit. */
const MAX_COALESCED_WRITE_CHARS = 8 * 1024 * 1024
/** Each record costs at least this much, so a flood of blank lines still reaches the cap. */
const RECORD_OVERHEAD_BYTES = 64

type SpoolOptions = {
  path: string
  /** Called with each record while a client is attached, in seq order. */
  deliver: (record: ProviderRelayRecord) => void
  /** True asks the owner to stop reading the agent's stdout; the agent is never ended for size. */
  onPressureChanged: (paused: boolean) => void
  /** Resolves once the client's stream can take more, so a replay never floods its socket. */
  drained?: () => Promise<void>
  /** The detached file could not be read back; its records are gone and the owner ends the agent. */
  onFileLost?: () => void
  memoryCapBytes?: number
  fileCapBytes?: number
}

type SpoolMode = 'attached' | 'replaying' | 'detached'

/** `bytes` is what the record is charged in memory: its UTF-8 size plus a fixed overhead. */
type HeldRecord = ProviderRelayRecord & { bytes: number }

type SpoolWrite = { chunk: string; records: HeldRecord[] }

/**
 * Seq-numbered stdout lines awaiting the client's ack. Attached, they live in memory; detached,
 * they are appended to a private file. Acks trim; the file goes once everything in it is acked.
 */
export class ProviderRelaySpool {
  private nextSeqValue = 1
  private acked = 0
  private memory: HeldRecord[] = []
  private memoryHead = 0
  private ackedHeldBytes = 0
  private memoryBytes = 0
  private mode: SpoolMode = 'detached'
  private file: FileHandle | null = null
  private readonly fileIndex = new SpoolFileIndex()
  /** The not-yet-started write, so appends coalesce without reordering around a removal. */
  private queuedWrite: SpoolWrite | null = null
  /** A failed write keeps every later record in memory, so a full or broken disk loses nothing. */
  private fileFailed = false
  private attachGeneration = 0
  /** Bumped when the file is removed, so batches queued before that never write into a new one. */
  private fileEpoch = 0
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

  /** `utf8Bytes` is the line's size as read; it defaults to its length for callers that don't know it. */
  append(line: string, utf8Bytes = line.length): ProviderRelayRecord {
    const record: HeldRecord = {
      seq: this.nextSeqValue++,
      line,
      bytes: utf8Bytes + RECORD_OVERHEAD_BYTES
    }
    if (this.mode === 'detached' && !this.fileFailed) {
      this.writeToFile(record)
    } else {
      this.memory.push(record)
      this.memoryBytes += record.bytes
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
      const { bytes } = this.memory[this.memoryHead]
      this.memoryBytes -= bytes
      this.ackedHeldBytes += bytes
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
    this.fileIndex.ackThrough(this.acked)
    if (this.fileIndex.lastSeq > 0 && this.acked >= this.fileIndex.lastSeq) {
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
    // The highest seq the file should hold whole; a write that failed partway was taken out of it.
    const fileLast = this.fileIndex.lastSeq
    const file: Awaited<ReturnType<typeof replaySpoolFileRecords>> =
      fileLast > 0
        ? await replaySpoolFileRecords({
            path: this.options.path,
            after,
            fileLast,
            current,
            deliver: this.options.deliver,
            drained: this.options.drained
          })
        : { outcome: 'done', highest: after }
    if (file.outcome === 'lost' && current()) {
      // Retrying would fail the same way and keep the agent paused; the loss is named instead,
      // and the lost records count as acked so nobody waits on output that can never arrive.
      this.acked = Math.max(this.acked, fileLast)
      this.removeFile()
      this.options.onFileLost?.()
    } else if (file.outcome !== 'done' || !current()) {
      return this.nextSeqValue - 1
    }
    after = file.highest
    // The memory tail waits for the client's socket too; an ack may compact memory meanwhile.
    let memory = this.memory
    let index = this.memoryHead
    while (true) {
      if (memory !== this.memory) {
        memory = this.memory
        const at = memory.findIndex((record) => record.seq > after)
        index = at === -1 ? memory.length : at
      }
      if (index >= memory.length) {
        break
      }
      const record = memory[index++]
      if (record.seq <= after) {
        continue
      }
      this.options.deliver(record)
      after = record.seq
      await this.options.drained?.()
      if (!current()) {
        return this.nextSeqValue - 1
      }
    }
    this.mode = 'attached'
    this.updatePressure()
    return this.nextSeqValue - 1
  }

  /** A takeover holds live records back until its own replay, so none reaches the new client twice. */
  suspend(): void {
    // An earlier attach still replaying is superseded too, or it would keep sending to the new client.
    if (this.mode !== 'detached') {
      this.mode = 'replaying'
      this.attachGeneration++
    }
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
          this.memoryBytes += record.bytes
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
        ? [this.fileIndex.unackedBytes + this.memoryBytes, this.fileCap]
        : [this.memoryBytes, this.memoryCap]
    const paused = !this.disposed && (this.paused ? held >= cap / 2 : held >= cap)
    if (paused !== this.paused) {
      this.paused = paused
      this.options.onPressureChanged(paused)
    }
  }

  private writeToFile(record: HeldRecord): void {
    if (this.disposed) {
      return
    }
    let encoded: string
    try {
      encoded = `${JSON.stringify({ seq: record.seq, line: record.line })}\n`
    } catch {
      // Too large to escape: it and every later record stay in memory, so seq order holds.
      this.fileFailed = true
      this.memory.push(record)
      this.memoryBytes += record.bytes
      return
    }
    const bytes = Buffer.byteLength(encoded)
    this.fileIndex.add(record.seq, bytes)
    const queued = this.queuedWrite
    if (queued && queued.chunk.length + encoded.length <= MAX_COALESCED_WRITE_CHARS) {
      queued.chunk += encoded
      queued.records.push(record)
    } else {
      const write: SpoolWrite = { chunk: encoded, records: [record] }
      const epoch = this.fileEpoch
      this.queuedWrite = write
      this.io = this.io
        .then(async () => {
          if (this.queuedWrite === write) {
            this.queuedWrite = null
          }
          if (epoch !== this.fileEpoch) {
            return
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
            // An ack may have retired the whole file while this write was in flight.
            if (epoch === this.fileEpoch) {
              this.keepInMemory(write)
            }
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
    const failed = new Set(write.records.map((record) => record.seq))
    this.fileIndex.drop(failed)
    const unacked = write.records.filter((record) => record.seq > this.acked)
    for (const record of unacked) {
      this.memoryBytes += record.bytes
    }
    this.memory = [...unacked, ...this.memory.slice(this.memoryHead)].sort(
      (left, right) => left.seq - right.seq
    )
    this.memoryHead = 0
    this.updatePressure()
  }

  private removeFile(): void {
    if (this.fileIndex.lastSeq === 0 && !this.file) {
      return
    }
    // A queued write holds only acked records, so it is dropped rather than written.
    if (this.queuedWrite) {
      this.queuedWrite.chunk = ''
      this.queuedWrite = null
    }
    this.fileEpoch++
    this.fileIndex.clear()
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
