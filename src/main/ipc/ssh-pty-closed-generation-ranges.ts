type ClosedGenerationRange = {
  start: number
  end: number
}

export class SshPtyClosedGenerationRanges {
  private readonly ranges: ClosedGenerationRange[] = []

  add(generation: number): void {
    const index = this.firstRangeReachableFrom(generation)
    const current = this.ranges[index]
    if (!current || generation + 1 < current.start) {
      this.ranges.splice(index, 0, { start: generation, end: generation })
      return
    }
    current.start = Math.min(current.start, generation)
    current.end = Math.max(current.end, generation)
    const next = this.ranges[index + 1]
    if (next && current.end + 1 >= next.start) {
      current.end = Math.max(current.end, next.end)
      this.ranges.splice(index + 1, 1)
    }
  }

  has(generation: number): boolean {
    const range = this.ranges[this.firstRangeReachableFrom(generation)]
    return range !== undefined && generation >= range.start && generation <= range.end
  }

  // Why binary search rather than a scan: ranges only collapse to one while every allocated
  // generation is eventually closed. A generation that is allocated and never closed leaves a
  // permanent gap, and `has` is on the per-output-chunk admission path, so a linear scan turns
  // fragmentation into a hot-path cost (measured ~1800x a plain Set at 20k ranges) and makes `add`
  // quadratic. Log-time keeps the degraded shape no worse than the Set this replaced.
  private firstRangeReachableFrom(generation: number): number {
    let low = 0
    let high = this.ranges.length
    while (low < high) {
      const mid = (low + high) >> 1
      if (this.ranges[mid]!.end + 1 < generation) {
        low = mid + 1
      } else {
        high = mid
      }
    }
    return low
  }

  get size(): number {
    return this.ranges.length
  }

  get activeGaps(): number {
    const highWater = this.ranges.at(-1)?.end ?? 0
    let closedGenerations = 0
    for (const range of this.ranges) {
      closedGenerations += range.end - range.start + 1
    }
    // Why: provider generations allocate from 1, so unclosed IDs below high-water remain active.
    return highWater - closedGenerations
  }
}
