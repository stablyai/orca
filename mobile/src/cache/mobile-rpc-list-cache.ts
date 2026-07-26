import { stringifyMobileOutboundJson } from '../transport/mobile-outbound-json'

export type MobileRpcListCacheEvidence = {
  entryCount: number
  retainedBytes: number
  keysOldestFirst: string[]
}

type CacheEntry = {
  values: unknown[]
  at: number
  retainedBytes: number
}

export class MobileRpcListCache {
  private readonly entries = new Map<string, CacheEntry>()
  private retainedBytes = 0

  constructor(
    private readonly maxAgeMs: number,
    private readonly maxEntries: number,
    private readonly maxItemsPerEntry: number,
    private readonly maxRetainedBytes: number
  ) {
    if (
      !Number.isFinite(maxAgeMs) ||
      maxAgeMs < 0 ||
      !Number.isInteger(maxEntries) ||
      maxEntries < 1 ||
      !Number.isInteger(maxItemsPerEntry) ||
      maxItemsPerEntry < 1 ||
      !Number.isSafeInteger(maxRetainedBytes) ||
      maxRetainedBytes < 1
    ) {
      throw new Error('Mobile RPC list cache limits must be positive')
    }
  }

  set(key: string, values: unknown[], now = Date.now()): boolean {
    this.delete(key)
    if (values.length > this.maxItemsPerEntry) {
      return false
    }
    let serialized: string
    try {
      serialized = stringifyMobileOutboundJson({ key, values }, this.maxRetainedBytes)
    } catch {
      return false
    }
    const retainedBytes = utf8ByteLength(serialized)
    if (retainedBytes > this.maxRetainedBytes) {
      return false
    }
    this.entries.set(key, { values, at: now, retainedBytes })
    this.retainedBytes += retainedBytes
    this.evictOverflow()
    return this.entries.has(key)
  }

  get(key: string, now = Date.now()): unknown[] | null {
    const entry = this.entries.get(key)
    if (!entry) {
      return null
    }
    if (now - entry.at > this.maxAgeMs) {
      this.delete(key)
      return null
    }
    return entry.values
  }

  clear(): void {
    this.entries.clear()
    this.retainedBytes = 0
  }

  evidence(): MobileRpcListCacheEvidence {
    return {
      entryCount: this.entries.size,
      retainedBytes: this.retainedBytes,
      keysOldestFirst: [...this.entries.keys()]
    }
  }

  private delete(key: string): void {
    const entry = this.entries.get(key)
    if (!entry) {
      return
    }
    this.retainedBytes -= entry.retainedBytes
    this.entries.delete(key)
  }

  private evictOverflow(): void {
    while (this.entries.size > this.maxEntries || this.retainedBytes > this.maxRetainedBytes) {
      const oldestKey = this.entries.keys().next().value
      if (typeof oldestKey !== 'string') {
        return
      }
      this.delete(oldestKey)
    }
  }
}

function utf8ByteLength(value: string): number {
  let bytes = 0
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x7f) {
      bytes += 1
    } else if (code <= 0x7ff) {
      bytes += 2
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4
        index += 1
      } else {
        bytes += 3
      }
    } else {
      bytes += 3
    }
  }
  return bytes
}
