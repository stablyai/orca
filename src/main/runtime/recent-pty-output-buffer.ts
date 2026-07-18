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
  // Code units already trimmed off the front of the head chunk. Deferred to
  // read() so repeated small trims never allocate a substring per append.
  private headOffset = 0
  private totalLen = 0

  append(data: string): void {
    if (data.length >= RECENT_PTY_OUTPUT_LIMIT) {
      this.chunks = [data.slice(-RECENT_PTY_OUTPUT_LIMIT)]
      this.headIndex = 0
      this.headOffset = 0
      this.totalLen = RECENT_PTY_OUTPUT_LIMIT
      return
    }
    if (data.length === 0) {
      return
    }
    this.chunks.push(data)
    this.totalLen += data.length
    while (this.totalLen > RECENT_PTY_OUTPUT_LIMIT) {
      const headRemaining = this.chunks[this.headIndex].length - this.headOffset
      const excess = this.totalLen - RECENT_PTY_OUTPUT_LIMIT
      if (headRemaining <= excess) {
        // Release the dropped chunk's reference; the slot is reclaimed on compaction.
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
      // Single retained chunk: apply the deferred head trim once, here.
      this.chunks[this.headIndex] = this.chunks[this.headIndex].slice(this.headOffset)
      this.headOffset = 0
    }
    return this.chunks[this.headIndex] ?? ''
  }
}
