import type { FileWithMtime } from './session-scanner-types'

/** Retain only the requested newest files, preserving traversal order on ties. */
export class SessionNewestFiles {
  private readonly files: FileWithMtime[] = []

  private readonly limit: number

  constructor(limit: number) {
    this.limit = Math.max(0, Math.trunc(limit) || 0)
  }

  add(file: FileWithMtime): void {
    // The backfill enumerates with no limit; skip the insert search entirely.
    if (!Number.isFinite(this.limit)) {
      this.files.push(file)
      return
    }
    if (this.limit <= 0) {
      return
    }
    const last = this.files.at(-1)
    if (this.files.length >= this.limit && last && file.mtimeMs <= last.mtimeMs) {
      return
    }
    let low = 0
    let high = this.files.length
    while (low < high) {
      const middle = (low + high) >>> 1
      if (this.files[middle].mtimeMs >= file.mtimeMs) {
        low = middle + 1
      } else {
        high = middle
      }
    }
    this.files.splice(low, 0, file)
    if (this.files.length > this.limit) {
      this.files.pop()
    }
  }

  get size(): number {
    return this.files.length
  }

  /** The unbounded path appends in traversal order, so the sort is not redundant. */
  newest(): FileWithMtime[] {
    return [...this.files].sort((a, b) => b.mtimeMs - a.mtimeMs)
  }
}
