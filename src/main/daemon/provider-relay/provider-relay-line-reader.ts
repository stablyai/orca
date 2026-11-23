import { appendFile, readFile, truncate, unlink } from 'node:fs/promises'

const NEWLINE = 0x0a
/** Past this, an unfinished line moves to disk; real JSONL lines stay far below it. */
export const RELAY_LINE_SPILL_BYTES = 4 * 1024 * 1024
/** A rebuilt line this large costs that much daemon memory at once, so it is logged. */
const LARGE_LINE_WARN_BYTES = 64 * 1024 * 1024

type LineReaderOptions = {
  /** Private scratch file for one unfinished line; removed once the line completes. */
  spillPath: string
  onLine: (line: string) => void
  /** True while disk work is in flight; the owner stops reading stdout meanwhile. */
  onBusy: (busy: boolean) => void
  spillBytes?: number
  onLargeLine?: (bytes: number) => void
  /** The spilled start of a line could not be read back, so the whole line was dropped. */
  onLineLost?: (bytes: number) => void
}

const SPILL_READ_ATTEMPTS = 3

/**
 * Splits agent stdout into lines. A line that grows past the spill size goes to a scratch file and
 * is stitched back whole on its newline, so memory stays bounded without pausing (which would
 * deadlock a long line) or ending the agent. A failing disk keeps the line in memory instead.
 */
export class ProviderRelayLineReader {
  private partial: Buffer[] = []
  private partialBytes = 0
  private spilled = false
  private spillBroken = false
  private queue: (Buffer | null)[] = []
  private draining = false
  private drainDone: Promise<void> = Promise.resolve()
  /** Bytes known to be whole in the spill file; a torn append past this is ignored. */
  private spilledBytes = 0
  private disposed = false
  private ended: (() => void) | null = null
  private readonly spillBytes: number

  constructor(private readonly options: LineReaderOptions) {
    this.spillBytes = options.spillBytes ?? RELAY_LINE_SPILL_BYTES
  }

  push(chunk: Buffer): void {
    if (this.disposed) {
      return
    }
    if (this.spilled || this.draining) {
      this.queue.push(chunk)
      void this.drain()
      return
    }
    this.split(chunk)
  }

  /** Resolves once the last line, spilled or not, has been delivered. */
  end(): Promise<void> {
    if (!this.spilled && !this.draining) {
      this.flushMemory()
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      this.ended = resolve
      this.queue.push(null)
      void this.drain()
    })
  }

  private split(chunk: Buffer): void {
    let start = 0
    let newline = chunk.indexOf(NEWLINE, start)
    while (newline !== -1) {
      const tail = chunk.subarray(start, newline)
      const line =
        this.partial.length === 0
          ? tail.toString('utf8')
          : Buffer.concat([...this.partial, tail]).toString('utf8')
      this.partial = []
      this.partialBytes = 0
      this.options.onLine(line)
      start = newline + 1
      newline = chunk.indexOf(NEWLINE, start)
    }
    if (start < chunk.length) {
      this.partial.push(chunk.subarray(start))
      this.partialBytes += chunk.length - start
    }
    if (!this.spillBroken && this.partialBytes >= this.spillBytes) {
      this.spilled = true
      void this.drain()
    }
  }

  private flushMemory(): void {
    if (this.partial.length > 0) {
      const line = Buffer.concat(this.partial).toString('utf8')
      this.partial = []
      this.partialBytes = 0
      this.options.onLine(line)
    }
  }

  /** Stops reading and spilling, and waits for disk work in flight, so the caller can delete the file. */
  async dispose(): Promise<void> {
    this.disposed = true
    this.queue = []
    await this.drainDone
  }

  private drain(): Promise<void> {
    if (!this.draining) {
      this.drainDone = this.runDrain()
    }
    return this.drainDone
  }

  private async runDrain(): Promise<void> {
    this.draining = true
    this.options.onBusy(true)
    try {
      await this.spillMemory()
      while (this.queue.length > 0 && !this.disposed) {
        const chunk = this.queue.shift() ?? null
        if (chunk === null) {
          await this.finishLine(null)
          this.ended?.()
          continue
        }
        if (!this.spilled) {
          this.split(chunk)
          await this.spillMemory()
          continue
        }
        const newline = chunk.indexOf(NEWLINE)
        if (newline === -1) {
          await this.spillChunk(chunk)
          continue
        }
        await this.finishLine(chunk.subarray(0, newline))
        this.split(chunk.subarray(newline + 1))
        await this.spillMemory()
      }
    } finally {
      this.draining = false
      this.options.onBusy(false)
    }
  }

  private async spillMemory(): Promise<void> {
    if (!this.spilled || this.partial.length === 0) {
      return
    }
    const held = Buffer.concat(this.partial)
    this.partial = []
    this.partialBytes = 0
    await this.spillChunk(held)
  }

  private async spillChunk(chunk: Buffer): Promise<void> {
    if (this.disposed) {
      return
    }
    if (this.spillBroken) {
      this.partial.push(chunk)
      this.partialBytes += chunk.length
      return
    }
    try {
      await appendFile(this.options.spillPath, chunk, { mode: 0o600 })
      this.spilledBytes += chunk.length
    } catch {
      // Disk trouble: the rest of this line stays in memory rather than being lost; a torn tail is cut.
      this.spillBroken = true
      await truncate(this.options.spillPath, this.spilledBytes).catch(() => {})
      this.partial.push(chunk)
      this.partialBytes += chunk.length
    }
  }

  /** Delivers the spilled line plus its in-memory tail; null tail means stdout ended mid-line. */
  private async finishLine(tail: Buffer | null): Promise<void> {
    if (!this.spilled) {
      if (tail) {
        this.split(Buffer.concat([tail, Buffer.from('\n')]))
      } else {
        this.flushMemory()
      }
      return
    }
    const head = await this.readSpill()
    await unlink(this.options.spillPath).catch(() => {})
    const spilledBytes = this.spilledBytes
    this.spilledBytes = 0
    if (head === null) {
      // A line missing its start would be corrupt; dropping it is reported instead.
      this.options.onLineLost?.(spilledBytes + this.partialBytes + (tail?.length ?? 0))
      this.partial = []
      this.partialBytes = 0
      this.spilled = false
      this.spillBroken = false
      return
    }
    const parts = [head.subarray(0, spilledBytes), ...this.partial, ...(tail ? [tail] : [])]
    this.partial = []
    this.partialBytes = 0
    this.spilled = false
    this.spillBroken = false
    const whole = Buffer.concat(parts)
    if (whole.length > LARGE_LINE_WARN_BYTES) {
      this.options.onLargeLine?.(whole.length)
    }
    this.options.onLine(whole.toString('utf8'))
  }

  private async readSpill(): Promise<Buffer | null> {
    for (let attempt = 0; attempt < SPILL_READ_ATTEMPTS; attempt++) {
      try {
        return await readFile(this.options.spillPath)
      } catch {}
    }
    return null
  }
}
