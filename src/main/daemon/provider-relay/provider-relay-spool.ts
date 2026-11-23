import { open, readFile, unlink, type FileHandle } from 'node:fs/promises'
import type { ProviderRelayRecord } from '../protocol/daemon-provider-relay-protocol'

export const RELAY_SPOOL_MEMORY_CAP_BYTES = 1024 * 1024
export const RELAY_SPOOL_FILE_CAP_BYTES = 16 * 1024 * 1024
const DETACHED_FSYNC_INTERVAL_MS = 1_000

type SpoolOptions = {
  path: string
  /** Called with each record while a client is attached, in seq order. */
  deliver: (record: ProviderRelayRecord) => void
  /** True asks the owner to stop reading the agent's stdout; the agent is never ended for size. */
  onPressureChanged: (paused: boolean) => void
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
    let drop = 0
    while (drop < this.memory.length && this.memory[drop].seq <= this.acked) {
      this.memoryBytes -= this.memory[drop].line.length
      drop++
    }
    if (drop > 0) {
      this.memory = this.memory.slice(drop)
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
    await this.io
    const fileRecords = this.fileLastSeq > 0 ? await this.readFileRecords() : []
    if (generation !== this.attachGeneration || this.mode !== 'replaying' || this.disposed) {
      return this.nextSeqValue - 1
    }
    const after = Math.max(fromSeq, this.acked)
    for (const record of fileRecords) {
      if (record.seq > after) {
        this.options.deliver(record)
      }
    }
    for (const record of this.memory) {
      if (record.seq > after) {
        this.options.deliver(record)
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
    for (const record of this.memory) {
      this.writeToFile(record)
    }
    this.memory = []
    this.memoryBytes = 0
    this.updatePressure()
    this.io = this.io.then(() => this.file?.sync()).catch(() => {})
    return this.io
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.stopFsyncTimer()
    this.memory = []
    this.memoryBytes = 0
    this.removeFile()
    await this.io
  }

  private updatePressure(): void {
    const paused =
      !this.disposed &&
      (this.mode === 'detached'
        ? this.fileBytes >= this.fileCap
        : this.memoryBytes >= this.memoryCap)
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

  private async readFileRecords(): Promise<ProviderRelayRecord[]> {
    let text: string
    try {
      text = await readFile(this.options.path, 'utf8')
    } catch {
      return []
    }
    const records: ProviderRelayRecord[] = []
    for (const line of text.split('\n')) {
      if (line.length === 0) {
        continue
      }
      try {
        const record: unknown = JSON.parse(line)
        if (isSpoolRecord(record)) {
          records.push(record)
        }
      } catch {}
    }
    return records
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
