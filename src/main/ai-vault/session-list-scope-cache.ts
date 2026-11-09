import { BoundedMap } from '../../shared/bounded-map'
import { MAX_TIMER_DELAY_MS } from '../../shared/timer-delay'
import type { AiVaultListResult } from '../../shared/ai-vault/contracts/ai-vault-types'
import type { AiVaultSessionDepth } from '../../shared/ai-vault/scanning/ai-vault-session-depth'

type CachedSessionList = {
  key: string
  depth: AiVaultSessionDepth
  result: AiVaultListResult
  expiresAt: number
  revision?: number
}

const MAX_SCOPE_CACHE_BYTES = 32 * 1024 * 1024
type StoredSessionList = CachedSessionList & { revision: number }

export class SessionListScopeCache {
  // Preserve the existing one-result cache even when an unlimited scan exceeds the archive budget.
  private latest: StoredSessionList | null = null
  private revision = 0
  private expiryTimer: ReturnType<typeof setTimeout> | null = null
  private readonly previous = new BoundedMap<string, StoredSessionList>({
    maxEntries: 7,
    maxBytes: MAX_SCOPE_CACHE_BYTES,
    sizeOf: (entry) => estimateEntryBytes(entry)
  })

  get(key: string, now: number): StoredSessionList | undefined {
    this.prune(now)
    return this.latest?.key === key ? this.latest : this.previous.get(key)
  }

  set(entry: CachedSessionList): void {
    this.prune(Date.now())
    const old = this.latest
    this.previous.delete(entry.key)
    if (old && old.key !== entry.key) {
      this.previous.set(old.key, old)
    }
    this.latest = { ...entry, revision: entry.revision ?? ++this.revision }
    this.scheduleExpiry()
  }

  discardBefore(revision: number): void {
    if (this.latest && this.latest.revision < revision) {
      this.latest = null
    }
    for (const [key, entry] of this.previous.entries()) {
      if (entry.revision < revision) {
        this.previous.delete(key)
      }
    }
    this.scheduleExpiry()
  }

  clear(): void {
    if (this.expiryTimer !== null) {
      clearTimeout(this.expiryTimer)
      this.expiryTimer = null
    }
    this.latest = null
    this.previous.clear()
  }

  private scheduleExpiry(): void {
    if (this.expiryTimer !== null) {
      clearTimeout(this.expiryTimer)
      this.expiryTimer = null
    }
    let earliest = this.latest?.expiresAt ?? Infinity
    for (const entry of this.previous.values()) {
      earliest = Math.min(earliest, entry.expiresAt)
    }
    if (earliest === Infinity) {
      return
    }
    this.expiryTimer = setTimeout(
      () => {
        this.expiryTimer = null
        this.prune(Date.now())
        this.scheduleExpiry()
      },
      Math.min(MAX_TIMER_DELAY_MS, Math.max(0, earliest - Date.now()))
    )
    this.expiryTimer.unref?.()
  }

  private prune(now: number): void {
    if (this.latest && this.latest.expiresAt <= now) {
      this.latest = null
    }
    for (const [key, entry] of this.previous.entries()) {
      if (entry.expiresAt <= now) {
        this.previous.delete(key)
      }
    }
  }
}

// Charge UTF-16 strings and object overhead without allocating a serialized copy of every preview.
function estimateEntryBytes(entry: CachedSessionList): number {
  let bytes = 0
  const visit = (value: unknown): void => {
    if (bytes > MAX_SCOPE_CACHE_BYTES) {
      return
    }
    if (typeof value === 'string') {
      bytes += 32 + value.length * 2
    } else if (value && typeof value === 'object') {
      bytes += 64
      for (const item of Array.isArray(value) ? value : Object.values(value)) {
        bytes += 16
        visit(item)
        if (bytes > MAX_SCOPE_CACHE_BYTES) {
          break
        }
      }
    } else {
      bytes += 8
    }
  }
  visit(entry)
  return bytes
}
