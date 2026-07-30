type ClosedGenerationRange = {
  start: number
  end: number
}

export class SshPtyClosedGenerationRanges {
  private readonly ranges: ClosedGenerationRange[] = []

  add(generation: number): void {
    let index = 0
    while (index < this.ranges.length && this.ranges[index]!.end + 1 < generation) {
      index++
    }
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
    for (const range of this.ranges) {
      if (generation < range.start) {
        return false
      }
      if (generation <= range.end) {
        return true
      }
    }
    return false
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
