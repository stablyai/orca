// Committed send boundaries in ascending order. Cleanup advances a monotone cursor rather than
// iterating a Set, because repeated Set iteration rescans V8 delete tombstones and stays quadratic
// across an ACK drain even when the loop breaks at the first live element.
export class PtySourceSentBoundaries {
  private entries: number[]
  private liveStart = 0

  constructor(checkpointBoundary: number) {
    this.entries = [checkpointBoundary]
  }

  // has binary-searches and dropBelow scans forward, so a non-ascending insert corrupts both.
  add(boundary: number): void {
    const highest = this.entries.at(-1)
    if (highest !== undefined && boundary <= highest) {
      throw new Error('PTY source sent boundary does not ascend')
    }
    this.entries.push(boundary)
  }

  has(boundary: number): boolean {
    let low = this.liveStart
    let high = this.entries.length - 1
    while (low <= high) {
      const middle = (low + high) >>> 1
      const value = this.entries[middle]!
      if (value === boundary) {
        return true
      }
      if (value < boundary) {
        low = middle + 1
      } else {
        high = middle - 1
      }
    }
    return false
  }

  dropBelow(boundary: number): void {
    while (this.liveStart < this.entries.length && this.entries[this.liveStart]! < boundary) {
      this.liveStart += 1
    }
    // Compact only once the dropped prefix outgrows the live tail so the copy cost stays amortized.
    if (this.liveStart > 0 && this.liveStart * 2 >= this.entries.length) {
      this.entries = this.entries.slice(this.liveStart)
      this.liveStart = 0
    }
  }

  *[Symbol.iterator](): IterableIterator<number> {
    for (let index = this.liveStart; index < this.entries.length; index += 1) {
      yield this.entries[index]!
    }
  }
}
