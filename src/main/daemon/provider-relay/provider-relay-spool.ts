import { open, unlink, type FileHandle } from 'node:fs/promises'
import type { ProviderRelayRecord } from '../protocol/daemon-provider-relay-protocol'
import { SpoolFileIndex } from './provider-relay-spool-file-index'
import { SpoolMemory, type HeldRecord } from './provider-relay-spool-memory'
import { replayMemoryTail, replaySpoolFileRecords } from './provider-relay-spool-replay'

export const RELAY_SPOOL_MEMORY_CAP_BYTES = 1024 * 1024
export const RELAY_SPOOL_FILE_CAP_BYTES = 16 * 1024 * 1024
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
  /** Unacked output reached half the memory cap: a client acking in batches should ack now. */
  onAckWanted?: (throughSeq: number) => void
  memoryCapBytes?: number
  fileCapBytes?: number
}

type SpoolMode = 'attached' | 'replaying' | 'detached'

type SpoolWrite = { chunk: string; records: HeldRecord[] }

/**
 * Seq-numbered stdout lines awaiting the client's ack. Attached, they live in memory; detached,
 * they are appended to a private file. Acks trim; the file goes once everything in it is acked.
 */
export class ProviderRelaySpool {
  private nextSeqValue = 1
  private acked = 0
  /** Records a lost spool file held; never sendable, so they don't hold the relay open. */
  private lostThrough = 0
  private readonly memory: SpoolMemory
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
  private ackAsked = false
  private ackAskedSeq = 0
  /** The highest seq the client said it received; acked may stay below it while lines are kept. */
  private clientAcked = 0
  /** The client's last ack named a floor to keep (an open streamed item), so lines go to the file too. */
  private keeping = false
  private disposed = false
  private readonly memoryCap: number
  private readonly fileCap: number

  constructor(private readonly options: SpoolOptions) {
    this.memoryCap = options.memoryCapBytes ?? RELAY_SPOOL_MEMORY_CAP_BYTES
    this.memory = new SpoolMemory(this.memoryCap)
    this.fileCap = options.fileCapBytes ?? RELAY_SPOOL_FILE_CAP_BYTES
  }

  get nextSeq(): number {
    return this.nextSeqValue
  }

  get ackedSeq(): number {
    return this.acked
  }

  get drained(): boolean {
    return Math.max(this.acked, this.lostThrough) >= this.nextSeqValue - 1
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
    } else if (this.keepingLive) {
      // Kept as when detached, so a later attach replays it; the client still gets it live.
      this.writeToFile(record)
      this.options.deliver(record)
    } else {
      this.memory.push(record)
      if (this.mode === 'attached') {
        this.options.deliver(record)
      }
    }
    this.updatePressure()
    return record
  }

  /**
   * The client received through `seq`. With `keepFrom`, lines from it on stay for a later attach to
   * replay: memory is freed through `seq`, and the kept lines move to the spool file.
   */
  ack(seq: number, keepFrom?: number): void {
    if (!Number.isSafeInteger(seq)) {
      return
    }
    const through = Math.min(seq, this.nextSeqValue - 1)
    this.clientAcked = Math.max(this.clientAcked, through)
    this.keeping =
      keepFrom !== undefined &&
      Number.isSafeInteger(keepFrom) &&
      keepFrom <= through &&
      !this.fileFailed
    this.releaseThrough(this.keeping ? (keepFrom as number) - 1 : through)
    if (this.keepingLive) {
      this.spillMemory()
    }
    // An answer to the last ask that leaves half the cap held asks again, so the client never stalls.
    this.ackAsked = this.ackAsked && this.clientAcked < this.ackAskedSeq
    this.updatePressure()
  }

  /** Attached and keeping: new and still-held lines go to the file as well as to the client. */
  private get keepingLive(): boolean {
    return this.keeping && this.mode === 'attached' && !this.fileFailed
  }

  /** Memory records the client hasn't released move to the file in seq order, as on detach. */
  private spillMemory(): void {
    for (const record of this.memory.takeAll()) {
      if (this.fileFailed) {
        this.memory.push(record)
      } else {
        this.writeToFile(record)
      }
    }
  }

  /** Frees everything through `seq` from memory and the file; never moves backwards. */
  private releaseThrough(seq: number): void {
    if (seq <= this.acked) {
      return
    }
    this.acked = seq
    this.memory.releaseThrough(seq)
    this.fileIndex.ackThrough(this.acked)
    if (this.fileIndex.lastSeq > 0 && this.acked >= this.fileIndex.lastSeq) {
      this.removeFile()
    }
  }

  /** Replays records after `fromSeq` through `deliver`, then streams live; returns the last replayed seq. */
  async attach(fromSeq: number): Promise<number> {
    const generation = ++this.attachGeneration
    this.mode = 'replaying'
    // A new client has confirmed nothing yet, so kept lines can't be released past the floor for it.
    this.clientAcked = this.acked
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
            index: this.fileIndex,
            current,
            deliver: this.options.deliver,
            drained: this.options.drained
          })
        : { outcome: 'done', highest: after }
    if (file.outcome === 'lost' && current()) {
      // Retrying would fail the same way, so the loss is named; lost records are never claimed as sent.
      this.lostThrough = Math.max(this.lostThrough, fileLast)
      this.removeFile()
      this.options.onFileLost?.()
    } else if (file.outcome !== 'done' || !current()) {
      return this.nextSeqValue - 1
    }
    after = file.highest
    const tail = await replayMemoryTail({
      memory: () => this.memory.records,
      head: this.memory.head,
      after,
      current,
      deliver: this.options.deliver,
      drained: this.options.drained,
      // Switched in the same step as the final check, so no append can land between them.
      caughtUp: () => {
        this.mode = 'attached'
        // Lines held during the replay join the file first, so it stays in seq order.
        if (this.keepingLive) {
          this.spillMemory()
        }
        this.updatePressure()
      }
    })
    return tail === null ? this.nextSeqValue - 1 : Math.min(tail, this.nextSeqValue - 1)
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
      this.spillMemory()
    }
    this.updatePressure()
    return this.io
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.memory.takeAll()
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
    const fileHeld = this.fileIndex.unackedBytes + this.memory.bytes
    if (this.keeping && fileHeld >= this.fileCap && this.clientAcked > this.acked) {
      // A kept item longer than the file cap can't be kept whole; holding it would stall the agent.
      this.releaseThrough(this.clientAcked)
    }
    const [held, cap] =
      this.mode === 'detached' || this.keepingLive
        ? [this.fileIndex.unackedBytes + this.memory.bytes, this.fileCap]
        : [this.memory.bytes, this.memoryCap]
    const paused = !this.disposed && (this.paused ? held >= cap / 2 : held >= cap)
    // Asked once per crossing and again once answered if still crossed, so a client can ack rarely.
    // Only while streaming live: during a replay the client has nothing new to ack yet. While
    // keeping, lines are on disk, so the ask comes near the file cap rather than the memory cap.
    const ackWanted = this.mode === 'attached' && held >= cap / 2
    if (ackWanted && !this.ackAsked) {
      this.ackAskedSeq = this.nextSeqValue - 1
      this.options.onAckWanted?.(this.ackAskedSeq)
    }
    this.ackAsked = ackWanted
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
    this.memory.merge(write.records.filter((record) => record.seq > this.acked))
    this.updatePressure()
  }

  /** Also runs with no record indexed: a first append that failed may still have created the file. */
  private removeFile(): void {
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
