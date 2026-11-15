// Diagnostics append off the event loop so a stalled disk delays log lines, never the process.

import { appendFileSync } from 'node:fs'
import { open, rename, stat } from 'node:fs/promises'
import { withTimeout } from '../../shared/promise-timeout-fallback'

const PRIVATE_FILE_MODE = 0o600
export const DEFAULT_MAX_QUEUED_CHARS = 1024 * 1024

export type BoundedLogFileWriterOptions = {
  readonly filePath: string
  readonly maxBytes: number
  /** Includes the active file; one disables rotation. */
  readonly maxFiles: number
  readonly batchWindowMs: number
  /** Measured in UTF-16 units so admission never scans line bytes. */
  readonly maxQueuedChars?: number
  /** Written where entries were dropped. */
  readonly formatDroppedLine: (droppedEntries: number) => string
}

export type BoundedLogFileWriter = {
  /** Never blocks; when the queue is full, drops and counts its oldest lines. */
  write(line: string): void
  /** Resolves once every line accepted before the call has been written or dropped. */
  flush(): Promise<void>
  /** Appends the queue synchronously, for crash boundaries; may land before an in-flight batch. */
  flushSync(): void
  /** Stops accepting lines and flushes synchronously, for exit paths. */
  close(): void
  /** Stops admission and drains asynchronously; deadline expiry drops pending lines, never sync-flushes. */
  closeAsync(timeoutMs: number): Promise<void>
}

// A number marks where that many entries were dropped.
type QueueItem = string | number

export function createBoundedLogFileWriter(
  opts: BoundedLogFileWriterOptions
): BoundedLogFileWriter {
  const { filePath, maxBytes, maxFiles, batchWindowMs, formatDroppedLine } = opts
  const maxQueuedChars = opts.maxQueuedChars ?? DEFAULT_MAX_QUEUED_CHARS

  const queue: QueueItem[] = []
  // Every queued item has a sequence index; queue[0] holds headIndex.
  let headIndex = 0
  // Memory stays under the cap plus one in-flight batch.
  let queuedChars = 0
  // Entries lost to failed writes or oversized lines; the marker goes where the next line lands.
  let droppedEntries = 0
  let inFlight: { start: number; done: Promise<void> } | null = null
  let timer: NodeJS.Timeout | null = null
  let closed = false
  let abandoned = false
  let closing: Promise<void> | null = null

  function nextIndex(): number {
    return headIndex + queue.length
  }

  /** Lines settle in order: an in-flight batch is always older than anything still queued. */
  function oldestUnsettled(): number {
    return inFlight?.start ?? (queue.length > 0 ? headIndex : Number.POSITIVE_INFINITY)
  }

  function queueDroppedMarker(): void {
    if (droppedEntries > 0) {
      queue.push(droppedEntries)
      droppedEntries = 0
    }
  }

  function render(items: readonly QueueItem[]): string {
    return items.map((item) => (typeof item === 'number' ? formatDroppedLine(item) : item)).join('')
  }

  function countDropped(items: readonly QueueItem[]): void {
    for (const item of items) {
      droppedEntries += typeof item === 'number' ? item : 1
    }
  }

  function dequeueAll(): QueueItem[] {
    headIndex += queue.length
    queuedChars = 0
    return queue.splice(0)
  }

  /** Drops the oldest queued entries so the newest, such as a fatal line, always fit. */
  function evictOldestFor(chars: number): void {
    let evicted = 0
    while (queue.length > 0 && queuedChars + chars > maxQueuedChars) {
      const item = queue[0]
      evicted += typeof item === 'number' ? item : 1
      queuedChars -= typeof item === 'number' ? 0 : item.length
      queue.shift()
      headIndex++
    }
    if (evicted > 0) {
      // The marker takes the last evicted entry's place and index.
      headIndex--
      queue.unshift(evicted)
    }
  }

  async function fileSize(): Promise<number> {
    return stat(filePath).then(
      (stats) => stats.size,
      (error: unknown) => {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
          return 0
        }
        throw error
      }
    )
  }

  async function rotate(): Promise<void> {
    // Oldest generation first, so each rename lands on a freed name.
    for (let i = maxFiles - 1; i >= 1; i--) {
      if (abandoned) {
        throw new Error('Writer abandoned')
      }
      const from = i === 1 ? filePath : `${filePath}.${i - 1}`
      await rename(from, `${filePath}.${i}`).catch(() => undefined)
    }
  }

  // Appends the batch in as few writes as the OS allows, normally one, so a concurrent sync
  // append lands between batches rather than inside a record.
  async function append(text: string): Promise<void> {
    if (abandoned) {
      throw new Error('Writer abandoned')
    }
    const handle = await open(filePath, 'a', PRIVATE_FILE_MODE)
    try {
      const data = Buffer.from(text, 'utf8')
      let offset = 0
      while (offset < data.length) {
        if (abandoned) {
          throw new Error('Writer abandoned')
        }
        const { bytesWritten } = await handle.write(data, offset)
        if (bytesWritten <= 0) {
          throw new Error('Write made no progress')
        }
        offset += bytesWritten
      }
    } finally {
      await handle.close()
    }
  }

  // The only code that rotates; batches run one at a time, so renames never race.
  async function writeBatch(items: readonly QueueItem[]): Promise<void> {
    let written = true
    try {
      const text = render(items)
      const bytes = Buffer.byteLength(text, 'utf8')
      if (bytes > maxBytes) {
        throw new Error('Batch exceeds file budget')
      }
      const size = await fileSize()
      if (maxFiles > 1 && size > 0 && size + bytes > maxBytes) {
        await rotate()
      }
      // A failed rename must not turn a bounded log into an unbounded append.
      if (size + bytes > maxBytes && (await fileSize()) + bytes > maxBytes) {
        throw new Error('File budget unavailable')
      }
      if (text) {
        await append(text)
      }
    } catch {
      written = false
    }
    // Settle in the same synchronous block that observes the write finishing.
    inFlight = null
    if (!written) {
      countDropped(items)
    } else if (!closed) {
      // Retrying a marker against a failing disk would spin; wait for the next accepted line.
      queueDroppedMarker()
    }
    if (queue.length > 0) {
      scheduleDrain()
    }
  }

  function startDrain(): Promise<void> {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (inFlight) {
      return inFlight.done
    }
    // An empty batch still runs the size check, for appends made by flushSync.
    const start = headIndex
    const items = dequeueAll()
    inFlight = { start, done: Promise.resolve().then(() => writeBatch(items)) }
    return inFlight.done
  }

  function scheduleDrain(): void {
    if (timer || inFlight || closed) {
      return
    }
    timer = setTimeout(() => void startDrain(), batchWindowMs)
    timer.unref?.()
  }

  // Leaves the drain timer running: the next drain sizes this append and rotates if needed.
  function flushSync(): void {
    queueDroppedMarker()
    if (queue.length === 0) {
      return
    }
    const items = dequeueAll()
    // An O_APPEND write never overwrites an in-flight batch; it may only land before it.
    try {
      appendFileSync(filePath, render(items), { mode: PRIVATE_FILE_MODE })
    } catch {
      countDropped(items)
    }
  }

  async function flush(): Promise<void> {
    if (abandoned) {
      return
    }
    queueDroppedMarker()
    const target = nextIndex()
    while (oldestUnsettled() < target) {
      await startDrain()
    }
  }

  function stopAdmission(): void {
    closed = true
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }

  return {
    write(line: string): void {
      if (closed) {
        return
      }
      // A line the queue could never hold is counted where it would have gone.
      if (line.length > maxQueuedChars) {
        droppedEntries++
        return
      }
      queueDroppedMarker()
      evictOldestFor(line.length)
      queue.push(line)
      queuedChars += line.length
      scheduleDrain()
    },
    flush,
    flushSync,
    close(): void {
      if (closed) {
        return
      }
      stopAdmission()
      flushSync()
    },
    closeAsync(timeoutMs): Promise<void> {
      if (closing) {
        return closing
      }
      if (closed) {
        return Promise.resolve()
      }
      stopAdmission()
      closing = withTimeout(flush(), timeoutMs, undefined).finally(() => {
        abandoned = true
        dequeueAll()
        droppedEntries = 0
      })
      return closing
    }
  }
}
