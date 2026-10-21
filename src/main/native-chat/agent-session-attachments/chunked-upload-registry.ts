import { randomUUID } from 'node:crypto'

type RegistryEntry<T> = {
  value: T
  expiresAt: number
  ttlTimer: ReturnType<typeof setTimeout>
}

export type ChunkedUploadRegistryOptions<T> = {
  maxConcurrent: number
  /** Idle lifetime: every touch restarts it. */
  ttlMs: number
  tooManyMessage: string
  notFoundMessage: string
  /** Runs when an upload expires unfinished; never for an explicit delete. */
  onExpire?: (value: T) => void
}

/**
 * In-flight chunked uploads held between start and commit: bounded in number, each forgotten after
 * an idle TTL so a client that disappears mid-upload cannot pin the slot.
 */
export class ChunkedUploadRegistry<T> {
  private readonly entries = new Map<string, RegistryEntry<T>>()

  constructor(private readonly options: ChunkedUploadRegistryOptions<T>) {}

  get size(): number {
    return this.entries.size
  }

  /** `build` receives the new id, for state that is named after it. */
  create(build: (uploadId: string) => T): string {
    this.pruneExpired()
    if (this.entries.size >= this.options.maxConcurrent) {
      throw new Error(this.options.tooManyMessage)
    }
    const uploadId = randomUUID()
    this.entries.set(uploadId, {
      value: build(uploadId),
      expiresAt: Date.now() + this.options.ttlMs,
      ttlTimer: this.scheduleExpiry(uploadId)
    })
    return uploadId
  }

  require(uploadId: string): T {
    this.pruneExpired()
    const entry = this.entries.get(uploadId)
    if (!entry) {
      throw new Error(this.options.notFoundMessage)
    }
    return entry.value
  }

  peek(uploadId: string): T | undefined {
    this.pruneExpired()
    return this.entries.get(uploadId)?.value
  }

  has(uploadId: string): boolean {
    return this.entries.has(uploadId)
  }

  touch(uploadId: string): void {
    const entry = this.entries.get(uploadId)
    if (!entry) {
      return
    }
    clearTimeout(entry.ttlTimer)
    entry.expiresAt = Date.now() + this.options.ttlMs
    entry.ttlTimer = this.scheduleExpiry(uploadId)
  }

  delete(uploadId: string): T | undefined {
    const entry = this.entries.get(uploadId)
    if (!entry) {
      return undefined
    }
    clearTimeout(entry.ttlTimer)
    this.entries.delete(uploadId)
    return entry.value
  }

  clear(): void {
    for (const uploadId of this.entries.keys()) {
      this.delete(uploadId)
    }
  }

  private expire(uploadId: string): void {
    const value = this.delete(uploadId)
    if (value !== undefined) {
      this.options.onExpire?.(value)
    }
  }

  private pruneExpired(now = Date.now()): void {
    for (const [uploadId, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.expire(uploadId)
      }
    }
  }

  private scheduleExpiry(uploadId: string): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => this.expire(uploadId), this.options.ttlMs)
    if (typeof timer === 'object' && 'unref' in timer) {
      timer.unref()
    }
    return timer
  }
}

/** The next chunk must start where the last one ended and stay within the declared size. */
export function nextChunkedUploadLength(
  upload: { expectedLength: number; receivedLength: number },
  offset: number,
  chunkLength: number,
  messages: { outOfOrder: string; exceeded: string }
): number {
  if (offset !== upload.receivedLength) {
    throw new Error(messages.outOfOrder)
  }
  const nextLength = upload.receivedLength + chunkLength
  if (nextLength > upload.expectedLength) {
    throw new Error(messages.exceeded)
  }
  return nextLength
}
