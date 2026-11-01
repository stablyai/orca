import { ownRetainedString } from '../../shared/own-retained-string'

export const RECENT_PTY_OUTPUT_LIMIT = 64 * 1024

// Compact dropped array slots so long chunk floods cannot grow the backing array without bound.
const DROPPED_HEAD_COMPACT_THRESHOLD = 1024

/** Retain the configured UTF-16 tail as chunks; defer joins to avoid flattening a large rolling string on every PTY write. */
export class RecentPtyOutputBuffer {
  private chunks: string[] = []
  private headIndex = 0
  // Defer head trimming to avoid per-append substrings.
  private headOffset = 0
  private totalLen = 0
  // Relay and main retain different output windows.
  private readonly limit: number

  constructor(options?: { limit?: number }) {
    this.limit = options?.limit ?? RECENT_PTY_OUTPUT_LIMIT
    if (!Number.isSafeInteger(this.limit) || this.limit <= 0) {
      throw new Error(`RecentPtyOutputBuffer limit must be a positive integer, got ${this.limit}`)
    }
  }

  append(data: string): void {
    if (data.length === 0) {
      return
    }
    if (data.length >= this.limit) {
      this.chunks = [data.length > this.limit ? ownRetainedString(data.slice(-this.limit)) : data]
      this.headIndex = 0
      this.headOffset = 0
      this.totalLen = this.limit
      return
    }
    this.chunks.push(data)
    this.totalLen += data.length
    while (this.totalLen > this.limit) {
      const headRemaining = this.chunks[this.headIndex].length - this.headOffset
      const excess = this.totalLen - this.limit
      if (headRemaining <= excess) {
        this.chunks[this.headIndex] = ''
        this.headIndex += 1
        this.headOffset = 0
        this.totalLen -= headRemaining
      } else {
        this.headOffset += excess
        this.totalLen -= excess
      }
    }
    if (this.headIndex >= DROPPED_HEAD_COMPACT_THRESHOLD) {
      this.chunks = this.chunks.slice(this.headIndex)
      this.headIndex = 0
    }
  }

  read(): string {
    if (this.chunks.length - this.headIndex > 1) {
      // Collapse to the joined tail so repeated reads stay O(1).
      const retained = this.chunks.slice(this.headIndex)
      if (this.headOffset > 0) {
        retained[0] = retained[0].slice(this.headOffset)
        this.headOffset = 0
      }
      this.chunks = [retained.join('')]
      this.headIndex = 0
    } else if (this.headOffset > 0) {
      this.chunks[this.headIndex] = this.chunks[this.headIndex].slice(this.headOffset)
      this.headOffset = 0
    }
    return this.chunks[this.headIndex] ?? ''
  }
}
