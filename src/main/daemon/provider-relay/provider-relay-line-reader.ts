import { readFile, truncate, unlink, writeFile } from 'node:fs/promises'
import { waitAtMost } from './provider-relay-bounded-wait'

const NEWLINE = 0x0a
/** Past this, an unfinished line moves to disk; real JSONL lines stay far below it. */
export const RELAY_LINE_SPILL_BYTES = 4 * 1024 * 1024
/** A rebuilt line this large costs that much daemon memory at once, so it is logged. */
const LARGE_LINE_WARN_BYTES = 64 * 1024 * 1024
/** With the disk failing, a line held in memory past this is dropped, so a full disk can't exhaust the daemon. */
const MEMORY_LINE_LIMIT_BYTES = 256 * 1024 * 1024

type LineReaderOptions = {
  /** Private scratch file for one unfinished line; removed once the line completes. */
  spillPath: string
  onLine: (line: string) => void
  /** True while disk work is in flight; the owner stops reading stdout meanwhile. */
  onBusy: (busy: boolean) => void
  spillBytes?: number
  onLargeLine?: (bytes: number) => void
  /** With the disk failing, a line held in memory passed its cap and was dropped. */
  onLineLost?: (bytes: number) => void
  /**
   * A line could not be read back, decoded or recorded. Skipping it would leave the chat waiting
   * on a message that never comes, so the reader stops and the owner ends the agent.
   */
  onFailed: (reason: ProviderRelayLineFailure) => void
}

export type ProviderRelayLineFailure = 'line-unreadable' | 'line-undeliverable'

const SPILL_READ_ATTEMPTS = 3
/** A stray spill file left by a disk that never answers is swept by a later daemon. */
const DISPOSE_WAIT_MS = 2000

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
  /** An oversized line was dropped; its remaining bytes are skipped up to its newline. */
  private discarding = false
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
    if (this.disposed) {
      return Promise.resolve()
    }
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
    if (this.discarding) {
      const newline = chunk.indexOf(NEWLINE)
      if (newline === -1) {
        return
      }
      this.discarding = false
      start = newline + 1
    }
    let newline = chunk.indexOf(NEWLINE, start)
    while (newline !== -1) {
      const tail = chunk.subarray(start, newline)
      const line = this.partial.length === 0 ? tail : Buffer.concat([...this.partial, tail])
      this.partial = []
      this.partialBytes = 0
      this.deliver(line)
      start = newline + 1
      newline = chunk.indexOf(NEWLINE, start)
    }
    if (start < chunk.length) {
      this.hold(chunk.subarray(start))
    }
    if (!this.spillBroken && this.partialBytes >= this.spillBytes) {
      this.spilled = true
      void this.drain()
    }
  }

  private flushMemory(): void {
    if (this.partial.length > 0) {
      const line = Buffer.concat(this.partial)
      this.partial = []
      this.partialBytes = 0
      this.deliver(line)
    }
  }

  private hold(chunk: Buffer): void {
    this.partial.push(chunk)
    this.partialBytes += chunk.length
    if (this.spillBroken && this.partialBytes > MEMORY_LINE_LIMIT_BYTES) {
      this.options.onLineLost?.(this.spilledBytes + this.partialBytes)
      this.partial = []
      this.partialBytes = 0
      this.spilledBytes = 0
      this.spilled = false
      this.spillBroken = false
      this.discarding = true
    }
  }

  private deliver(line: Buffer): void {
    if (this.disposed) {
      return
    }
    try {
      this.options.onLine(line.toString('utf8'))
    } catch {
      this.fail('line-undeliverable')
    }
  }

  /** Stops for good: nothing after a missing line may be delivered, or the chat would read out of order. */
  private fail(reason: ProviderRelayLineFailure): void {
    if (this.disposed) {
      return
    }
    this.disposed = true
    this.queue = []
    this.partial = []
    this.partialBytes = 0
    this.options.onFailed(reason)
    this.ended?.()
  }

  /** Stops reading and spilling, and waits for disk work in flight, so the caller can delete the file. */
  async dispose(): Promise<void> {
    this.disposed = true
    this.queue = []
    await waitAtMost(this.drainDone, DISPOSE_WAIT_MS)
    this.ended?.()
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
    } catch {
      // Unexpected trouble must still settle stdout's end, or the relay would never finish.
      this.fail('line-undeliverable')
    } finally {
      this.draining = false
      this.options.onBusy(false)
    }
  }

  private async spillMemory(): Promise<void> {
    // With the disk failing, held bytes stay where they are rather than being re-joined per chunk.
    if (!this.spilled || this.spillBroken || this.partial.length === 0) {
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
      this.hold(chunk)
      if (this.discarding) {
        await unlink(this.options.spillPath).catch(() => {})
      }
      return
    }
    try {
      // A line's first piece replaces the file, so a leftover from a failed unlink never prefixes it.
      await writeFile(this.options.spillPath, chunk, {
        mode: 0o600,
        flag: this.spilledBytes === 0 ? 'w' : 'a'
      })
      this.spilledBytes += chunk.length
      if (this.disposed) {
        // The owner's cleanup may have run before this write created the file.
        await unlink(this.options.spillPath).catch(() => {})
      }
    } catch {
      // Disk trouble: the rest of this line stays in memory rather than being lost; a torn tail is cut.
      this.spillBroken = true
      await truncate(this.options.spillPath, this.spilledBytes).catch(() => {})
      this.hold(chunk)
    }
    if (this.discarding) {
      // The dropped line's spilled start is useless now; the next line's first write replaces any rest.
      await unlink(this.options.spillPath).catch(() => {})
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
    const tailBytes = tail?.length ?? 0
    const overCap = this.spillBroken && this.partialBytes + tailBytes > MEMORY_LINE_LIMIT_BYTES
    // Nothing whole reached the file (the first append failed): the line is entirely in memory.
    const head = this.spilledBytes === 0 || overCap ? Buffer.alloc(0) : await this.readSpill()
    await unlink(this.options.spillPath).catch(() => {})
    const spilledBytes = this.spilledBytes
    this.spilledBytes = 0
    const heldBytes = spilledBytes + this.partialBytes + tailBytes
    const held = this.partial
    this.partial = []
    this.partialBytes = 0
    this.spilled = false
    this.spillBroken = false
    if (overCap) {
      this.options.onLineLost?.(heldBytes)
      return
    }
    // A missing or cut-short file would yield a line without its start, which would be corrupt.
    if (head === null || head.length < spilledBytes) {
      this.fail('line-unreadable')
      return
    }
    let whole: Buffer
    try {
      whole = Buffer.concat([head.subarray(0, spilledBytes), ...held, ...(tail ? [tail] : [])])
    } catch {
      this.fail('line-undeliverable')
      return
    }
    if (whole.length > LARGE_LINE_WARN_BYTES) {
      this.options.onLargeLine?.(whole.length)
    }
    this.deliver(whole)
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
