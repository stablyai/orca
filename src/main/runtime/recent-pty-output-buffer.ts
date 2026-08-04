export const RECENT_PTY_OUTPUT_LIMIT = 64 * 1024

// Compact the backing array once this many fully-dropped head slots accumulate,
// so the array itself stays bounded under long chunk floods.
const DROPPED_HEAD_COMPACT_THRESHOLD = 1024

/**
 * Bounded deque of raw PTY output chunks retaining exactly the last
 * RECENT_PTY_OUTPUT_LIMIT UTF-16 code units.
 *
 * Why: eagerly rebuilding a rolling 64KB string per PTY chunk flattened a
 * ~128KB rope on every write; keep chunks and defer the join to rare readers.
 */
export class RecentPtyOutputBuffer {
  private chunks: string[] = []
  private headIndex = 0
  // Code units already trimmed off the front of the head chunk. Deferred so
  // repeated small trims never allocate a substring per append, and so the
  // head chunk's original text stays available for candidate backfill.
  private headOffset = 0
  private totalLen = 0
  // True when the stored head chunk is not the full original PTY chunk (a
  // single over-limit append is stored pre-sliced), so backfill replay knows
  // the original line context of its leading text is gone.
  private headChunkIsPartial = false
  // Original chunk boundaries are owed only to the one-time path-candidate
  // backfill; compact() ends that obligation and lets read() collapse.
  private preserveChunkBoundaries: boolean
  // Why configurable: the relay retains a different window than the main process.
  private readonly limit: number

  constructor(options?: { preserveChunkBoundaries?: boolean; limit?: number }) {
    this.preserveChunkBoundaries = options?.preserveChunkBoundaries ?? true
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
      this.chunks = [data.slice(-this.limit)]
      this.headIndex = 0
      this.headOffset = 0
      this.totalLen = this.limit
      this.headChunkIsPartial = data.length > this.limit
      return
    }
    this.chunks.push(data)
    this.totalLen += data.length
    while (this.totalLen > this.limit) {
      const headRemaining = this.chunks[this.headIndex].length - this.headOffset
      const excess = this.totalLen - this.limit
      if (headRemaining <= excess) {
        // Release the dropped chunk's reference; the slot is reclaimed on compaction.
        this.chunks[this.headIndex] = ''
        this.headIndex += 1
        this.headOffset = 0
        this.headChunkIsPartial = false
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
    if (this.preserveChunkBoundaries) {
      // Join without mutating: boundaries and the original head chunk are
      // still owed to retainedChunks(); reads are rare before compact().
      if (this.chunks.length - this.headIndex > 1) {
        const retained = this.chunks.slice(this.headIndex)
        if (this.headOffset > 0) {
          retained[0] = retained[0].slice(this.headOffset)
        }
        return retained.join('')
      }
      const head = this.chunks[this.headIndex] ?? ''
      return this.headOffset > 0 ? head.slice(this.headOffset) : head
    }
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
      // Single retained chunk: apply the deferred head trim once, here.
      this.chunks[this.headIndex] = this.chunks[this.headIndex].slice(this.headOffset)
      this.headOffset = 0
    }
    return this.chunks[this.headIndex] ?? ''
  }

  /**
   * Retained chunks with original PTY boundaries. The head chunk is its full
   * original text (any window-trimmed prefix included) unless
   * headChunkIsPartial. Why: path-candidate backfill must replay the eager
   * per-chunk extraction exactly — trimming or joining chunks changes the
   * candidate set. Only meaningful before compact().
   */
  retainedChunks(): { chunks: string[]; headChunkIsPartial: boolean } {
    return {
      chunks: this.chunks.slice(this.headIndex),
      headChunkIsPartial: this.headChunkIsPartial
    }
  }

  /**
   * Ends the chunk-boundary obligation after the one-time backfill and
   * collapses immediately, so the append/read hot path returns to the
   * compact single-chunk steady state.
   */
  compact(): void {
    this.preserveChunkBoundaries = false
    this.read()
  }
}
