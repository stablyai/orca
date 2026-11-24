import type { GitBlameResult } from '../../../../shared/git/blame/git-blame-types'

const MAX_ENTRIES = 64
// Head text dominates retained size; bound it like the settled diff cache does.
const MAX_RETAINED_CODE_UNITS = 16 * 1024 * 1024

/** LRU of immutable blame results; Map order is recency order. */
export class GitBlameResultCache {
  private readonly entries = new Map<string, { result: GitBlameResult; size: number }>()
  private retained = 0

  get(key: string): GitBlameResult | undefined {
    const entry = this.entries.get(key)
    if (!entry) {
      return undefined
    }
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.result
  }

  set(key: string, result: GitBlameResult): void {
    const size = result.kind === 'ready' ? result.headText.length + result.ranges.length * 4 : 0
    if (size > MAX_RETAINED_CODE_UNITS) {
      return
    }
    const existing = this.entries.get(key)
    if (existing) {
      this.retained -= existing.size
      this.entries.delete(key)
    }
    this.entries.set(key, { result, size })
    this.retained += size
    for (const [oldestKey, oldest] of this.entries) {
      if (this.entries.size <= MAX_ENTRIES && this.retained <= MAX_RETAINED_CODE_UNITS) {
        break
      }
      this.entries.delete(oldestKey)
      this.retained -= oldest.size
    }
  }
}
