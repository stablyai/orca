import { measureUtf8ByteLength } from '../../shared/utf8-byte-limits'

export const REPOSITORY_REF_CACHE_MAX_ENTRIES = 512
export const REPOSITORY_REF_CACHE_KEY_MAX_BYTES = 4 * 1024
export const REPOSITORY_REF_CACHE_VALUE_MAX_BYTES = 16 * 1024

export type RepositoryRefCacheLookup<T> = { found: true; value: T | null } | { found: false }

export function buildRepositoryRefCacheKey(parts: readonly string[]): string | null {
  let remainingBytes = REPOSITORY_REF_CACHE_KEY_MAX_BYTES - Math.max(0, parts.length - 1)
  if (remainingBytes < 0) {
    return null
  }
  for (const part of parts) {
    const measured = measureUtf8ByteLength(part, { stopAfterBytes: remainingBytes })
    if (measured.exceededLimit) {
      return null
    }
    remainingBytes -= measured.byteLength
  }
  return parts.join('\0')
}

export class RepositoryRefCache<T> {
  private readonly entries = new Map<string, T | null>()

  clear(): void {
    this.entries.clear()
  }

  get size(): number {
    return this.entries.size
  }

  get(cacheKey: string | null): RepositoryRefCacheLookup<T> {
    if (cacheKey === null || !this.entries.has(cacheKey)) {
      return { found: false }
    }
    const value = this.entries.get(cacheKey) ?? null
    this.entries.delete(cacheKey)
    this.entries.set(cacheKey, value)
    return { found: true, value }
  }

  remember(cacheKey: string | null, value: T | null, retainedStrings: readonly string[]): void {
    if (cacheKey === null || !fitsValueBudget(retainedStrings)) {
      return
    }
    this.entries.delete(cacheKey)
    this.entries.set(cacheKey, value)
    while (this.entries.size > REPOSITORY_REF_CACHE_MAX_ENTRIES) {
      const oldestKey = this.entries.keys().next().value
      if (oldestKey === undefined) {
        return
      }
      this.entries.delete(oldestKey)
    }
  }
}

function fitsValueBudget(values: readonly string[]): boolean {
  let remainingBytes = REPOSITORY_REF_CACHE_VALUE_MAX_BYTES
  for (const value of values) {
    const measured = measureUtf8ByteLength(value, { stopAfterBytes: remainingBytes })
    if (measured.exceededLimit) {
      return false
    }
    remainingBytes -= measured.byteLength
  }
  return true
}
