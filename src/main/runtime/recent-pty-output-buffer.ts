export const RECENT_PTY_OUTPUT_LIMIT = 64 * 1024

const RETAINED_CONTENT_CHUNK_LIMIT = 1024
const DROPPED_CONTENT_CHUNK_LIMIT = 1024
const INITIAL_BOUNDARY_CAPACITY = 16

class RetainedChunkLengthQueue {
  private values = new Uint32Array(INITIAL_BOUNDARY_CAPACITY)
  private head = 0
  private count = 0

  get length(): number {
    return this.count
  }

  get capacity(): number {
    return this.values.length
  }

  push(value: number): void {
    if (this.count === this.values.length) {
      const grown = new Uint32Array(this.values.length * 2)
      for (let index = 0; index < this.count; index += 1) {
        grown[index] = this.at(index)
      }
      this.values = grown
      this.head = 0
    }
    this.values[(this.head + this.count) % this.values.length] = value
    this.count += 1
  }

  shift(): number {
    if (this.count === 0) {
      return 0
    }
    const value = this.values[this.head]!
    this.head = (this.head + 1) % this.values.length
    this.count -= 1
    if (this.count === 0) {
      this.head = 0
    }
    return value
  }

  at(index: number): number {
    return this.values[(this.head + index) % this.values.length]!
  }

  reset(): void {
    this.values = new Uint32Array(INITIAL_BOUNDARY_CAPACITY)
    this.head = 0
    this.count = 0
  }
}

/** Bounded raw PTY tail that temporarily preserves source chunk boundaries for path backfill. */
export class RecentPtyOutputBuffer {
  private chunks: string[] = []
  private contentHeadIndex = 0
  private contentHeadOffset = 0
  private totalLen = 0
  private headOffset = 0
  private headChunkIsPartial = false
  private preserveChunkBoundaries: boolean
  private readonly originalChunkLengths = new RetainedChunkLengthQueue()

  constructor(options?: { preserveChunkBoundaries?: boolean }) {
    this.preserveChunkBoundaries = options?.preserveChunkBoundaries ?? true
  }

  append(data: string): void {
    if (data.length === 0) {
      return
    }
    if (data.length >= RECENT_PTY_OUTPUT_LIMIT) {
      this.replaceContent(data.slice(-RECENT_PTY_OUTPUT_LIMIT))
      this.totalLen = RECENT_PTY_OUTPUT_LIMIT
      this.headOffset = 0
      this.headChunkIsPartial = data.length > RECENT_PTY_OUTPUT_LIMIT
      this.originalChunkLengths.reset()
      if (this.preserveChunkBoundaries) {
        this.originalChunkLengths.push(RECENT_PTY_OUTPUT_LIMIT)
      }
      return
    }

    this.appendContent(data)
    this.totalLen += data.length
    if (this.preserveChunkBoundaries) {
      this.trimPreservingBoundaries()
      this.originalChunkLengths.push(data.length)
    } else {
      this.trimContentToWindow()
    }
  }

  read(): string {
    const stored = this.storedContent()
    const value = this.headOffset > 0 ? stored.slice(this.headOffset) : stored
    if (!this.preserveChunkBoundaries) {
      this.replaceContent(value)
    }
    return value
  }

  /** Original PTY chunks retained for the one-time path-candidate backfill. */
  retainedChunks(): { chunks: string[]; headChunkIsPartial: boolean } {
    const chunks: string[] = []
    const state = this.forEachRetainedChunk((chunk) => chunks.push(chunk))
    return { chunks, headChunkIsPartial: state.headChunkIsPartial }
  }

  /** Streams boundaries so activation does not allocate one string object per tiny write. */
  forEachRetainedChunk(
    visit: (chunk: string, index: number, headChunkIsPartial: boolean) => void
  ): {
    headChunkIsPartial: boolean
  } {
    if (!this.preserveChunkBoundaries) {
      const value = this.read()
      if (value) {
        visit(value, 0, false)
      }
      return { headChunkIsPartial: false }
    }
    const stored = this.storedContent()
    let offset = 0
    for (let index = 0; index < this.originalChunkLengths.length; index += 1) {
      const length = this.originalChunkLengths.at(index)
      visit(stored.slice(offset, offset + length), index, this.headChunkIsPartial)
      offset += length
    }
    return { headChunkIsPartial: this.headChunkIsPartial }
  }

  /** Ends the boundary obligation and returns to compact steady-state storage. */
  compact(): void {
    const value = this.read()
    this.preserveChunkBoundaries = false
    this.replaceContent(value)
    this.headOffset = 0
    this.headChunkIsPartial = false
    this.originalChunkLengths.reset()
  }

  private appendContent(data: string): void {
    this.chunks.push(data)
    if (this.chunks.length - this.contentHeadIndex > RETAINED_CONTENT_CHUNK_LIMIT) {
      this.replaceContent(this.storedContent())
    }
  }

  private trimPreservingBoundaries(): void {
    while (this.totalLen > RECENT_PTY_OUTPUT_LIMIT) {
      const originalHeadLength = this.originalChunkLengths.at(0)
      const headRemaining = originalHeadLength - this.headOffset
      const excess = this.totalLen - RECENT_PTY_OUTPUT_LIMIT
      if (headRemaining <= excess) {
        this.totalLen -= headRemaining
        this.headOffset = 0
        this.headChunkIsPartial = false
        this.originalChunkLengths.shift()
        this.dropContentPrefix(originalHeadLength)
      } else {
        this.headOffset += excess
        this.totalLen -= excess
      }
    }
  }

  private trimContentToWindow(): void {
    const excess = this.totalLen - RECENT_PTY_OUTPUT_LIMIT
    if (excess <= 0) {
      return
    }
    this.dropContentPrefix(excess)
    this.totalLen -= excess
  }

  private dropContentPrefix(length: number): void {
    let remaining = length
    while (remaining > 0) {
      const chunk = this.chunks[this.contentHeadIndex] ?? ''
      const available = chunk.length - this.contentHeadOffset
      if (available <= remaining) {
        this.chunks[this.contentHeadIndex] = ''
        this.contentHeadIndex += 1
        this.contentHeadOffset = 0
        remaining -= available
      } else {
        this.contentHeadOffset += remaining
        remaining = 0
      }
    }
    if (this.contentHeadIndex >= DROPPED_CONTENT_CHUNK_LIMIT) {
      this.chunks = this.chunks.slice(this.contentHeadIndex)
      this.contentHeadIndex = 0
    }
  }

  private storedContent(): string {
    const retained = this.chunks.slice(this.contentHeadIndex)
    if (retained.length === 0) {
      return ''
    }
    if (this.contentHeadOffset > 0) {
      retained[0] = retained[0]!.slice(this.contentHeadOffset)
    }
    return retained.length === 1 ? retained[0]! : retained.join('')
  }

  private replaceContent(value: string): void {
    this.chunks = value ? [value] : []
    this.contentHeadIndex = 0
    this.contentHeadOffset = 0
  }
}
