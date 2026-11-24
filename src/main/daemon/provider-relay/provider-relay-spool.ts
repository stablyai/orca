import type { ProviderRelayRecord } from '../protocol/daemon-provider-relay-protocol'
import { SpoolFile } from './provider-relay-spool-file'
import { SpoolMemory, type HeldRecord } from './provider-relay-spool-memory'
import { replayMemoryTail, replaySpoolFileRecords } from './provider-relay-spool-replay'

export const RELAY_SPOOL_MEMORY_CAP_BYTES = 1024 * 1024
export const RELAY_SPOOL_FILE_CAP_BYTES = 16 * 1024 * 1024
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
  /** A release left nothing held, which can happen without an ack (a kept span let go at the cap). */
  onDrained?: () => void
  memoryCapBytes?: number
  fileCapBytes?: number
}

type SpoolMode = 'attached' | 'replaying' | 'detached'

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
  private readonly file: SpoolFile
  private mode: SpoolMode = 'detached'
  private attachGeneration = 0
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
    this.file = new SpoolFile(options.path, {
      acked: () => this.acked,
      restore: (records) => {
        this.memory.merge(records)
        this.updatePressure()
      },
      pendingChanged: () => this.updatePressure()
    })
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
    if (this.mode === 'detached' && !this.file.failed) {
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
    // A late, older ack says nothing new and must not undo a later keep.
    if (through < this.clientAcked) {
      return
    }
    this.clientAcked = through
    const floor = keepFrom !== undefined && Number.isSafeInteger(keepFrom) ? keepFrom : null
    this.keeping = floor !== null
    // A floor past `seq` keeps nothing the client has; with a broken file, kept lines stay in memory.
    this.releaseThrough(floor === null ? through : Math.min(floor, through + 1) - 1)
    if (this.keepingLive) {
      this.spillMemory()
    }
    this.file.compactIfWasteful(this.fileCap)
    // An answer to the last ask that leaves half the cap held asks again, so the client never stalls.
    this.ackAsked = this.ackAsked && this.clientAcked < this.ackAskedSeq
    this.updatePressure()
  }

  /** Attached and keeping: new and still-held lines go to the file as well as to the client. */
  private get keepingLive(): boolean {
    return this.keeping && this.mode === 'attached' && !this.file.failed
  }

  /** Memory records the client hasn't released move to the file in seq order, as on detach. */
  private spillMemory(): void {
    for (const record of this.memory.takeAll()) {
      if (this.file.failed) {
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
    if (this.drained) {
      this.options.onDrained?.()
    }
    this.file.index.ackThrough(this.acked)
    if (this.file.index.lastSeq > 0 && this.acked >= this.file.index.lastSeq) {
      this.file.remove()
    }
  }

  /** Replays records after `fromSeq` through `deliver`, then streams live; returns the last replayed seq. */
  async attach(fromSeq: number): Promise<number> {
    const generation = ++this.attachGeneration
    this.mode = 'replaying'
    // A new client has confirmed nothing yet, so kept lines can't be released past the floor for it,
    // and it hasn't been asked to ack anything.
    this.clientAcked = this.acked
    this.ackAsked = false
    this.ackAskedSeq = 0
    this.updatePressure()
    const current = (): boolean =>
      generation === this.attachGeneration && this.mode === 'replaying' && !this.disposed
    // Writes are waited for only when the file holds records this replay reads.
    if (this.file.index.lastSeq > Math.max(fromSeq, this.acked)) {
      await this.file.writtenOrRemoved()
      // A superseded attach reads nothing, so a stalled write can't make each one reread the file.
      if (!current()) {
        return this.nextSeqValue - 1
      }
    }
    let after = Math.max(fromSeq, this.acked)
    // The highest seq the file should hold whole; a write that failed partway was taken out of it.
    const fileLast = this.file.index.lastSeq
    const file: Awaited<ReturnType<typeof replaySpoolFileRecords>> =
      fileLast > after
        ? await replaySpoolFileRecords({
            path: this.options.path,
            after,
            index: this.file.index,
            current,
            deliver: this.options.deliver,
            drained: this.options.drained
          })
        : { outcome: 'done', highest: after }
    if (file.outcome === 'lost' && current()) {
      // Retrying would fail the same way, so the loss is named; lost records are never claimed as sent.
      this.lostThrough = Math.max(this.lostThrough, fileLast)
      this.file.remove()
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
    this.clientAcked = this.acked
    // An earlier attach still replaying is superseded too, or it would keep sending to the new client.
    if (this.mode !== 'detached') {
      this.mode = 'replaying'
      this.attachGeneration++
    }
  }

  detach(): Promise<void> {
    if (this.mode === 'detached') {
      return this.file.io
    }
    this.mode = 'detached'
    this.attachGeneration++
    if (!this.file.failed) {
      this.spillMemory()
    }
    this.updatePressure()
    return this.file.io
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.memory.takeAll()
    await this.file.dispose()
  }

  /** An ended, detached relay writes nothing more; its fd closes and the file waits for a reader. */
  closeHandle(): void {
    this.file.closeWhenIdle(() => this.mode === 'detached')
  }

  /** Pause at the cap, resume below half of it, so acks near the cap don't flap the agent's stdout. */
  private updatePressure(): void {
    // A kept span is released through the live client's own acks only when it alone holds the
    // agent paused (or would pause it): queued writes drain by themselves, and lines the client hasn't
    // acked can't be released. Only this client's acks count, so a takeover never loses lines.
    if (
      this.keeping &&
      this.mode === 'attached' &&
      this.clientAcked > this.acked &&
      this.holdsPause(this.pressure(0)) &&
      !this.holdsPause(this.pressure(this.clientAcked))
    ) {
      this.releaseThrough(this.clientAcked)
    }
    const [held, cap] = this.pressure(0)
    const paused = !this.disposed && this.holdsPause([held, cap])
    // Asked once per crossing and again once answered if still crossed, so a client can ack rarely.
    // Only while streaming live: during a replay the client has nothing new to ack yet. While
    // keeping, lines are on disk, so the ask comes near the file cap rather than the memory cap.
    // An ask with nothing new since the last one is skipped, and asked again once output arrives.
    const ackWanted = this.mode === 'attached' && held >= cap / 2
    if (!ackWanted) {
      this.ackAsked = false
    } else if (!this.ackAsked && this.nextSeqValue - 1 > this.ackAskedSeq) {
      this.ackAsked = true
      this.ackAskedSeq = this.nextSeqValue - 1
      this.options.onAckWanted?.(this.ackAskedSeq)
    }
    if (paused !== this.paused) {
      this.paused = paused
      this.options.onPressureChanged(paused)
    }
  }

  private holdsPause([held, cap]: [number, number]): boolean {
    return this.paused ? held >= cap / 2 : held >= cap
  }

  /**
   * What holds memory or disk, against its cap, as if everything through `releasedThrough` were
   * released (0 for as it is). Writes not yet started count: they hold memory an ack can't free.
   */
  private pressure(releasedThrough: number): [held: number, cap: number] {
    const queued = this.file.pendingBytes
    const memory = this.memory.bytes - this.memory.bytesThrough(releasedThrough)
    if (this.mode !== 'detached' && !this.keepingLive) {
      // Live, a queue here is left from keeping; a replay flushes the detached queue before it starts.
      return [memory + (this.mode === 'attached' ? queued : 0), this.memoryCap]
    }
    const unacked = this.file.index.unackedBytes - this.file.index.bytesThrough(releasedThrough)
    return [Math.max(unacked, queued) + memory, this.fileCap]
  }

  private writeToFile(record: HeldRecord): void {
    // Too large to escape: it and every later record stay in memory, so seq order holds.
    if (!this.file.write(record)) {
      this.memory.push(record)
    }
  }
}
