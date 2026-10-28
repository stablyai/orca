// Provider failures affect only their owner/provider cache entry, never Orca storage health.

import type { ExternalAutomationManager } from '../../shared/automations-types'
import { isExternalAutomationProbeCancelled } from './external-automation-probe-scheduler'

export type ExternalAutomationManagerCacheKey = {
  ownerKey: string
  provider: string
}

export type ExternalAutomationManagerCacheEntry = {
  /** Null when no manager is configured or the probe failed; inspect error. */
  manager: ExternalAutomationManager | null
  error: string | null
  updatedAt: number
}

const DEFAULT_CACHE_TTL_MS = 30_000
const MAX_CACHED_ERROR_LENGTH = 300
export const MAX_EXTERNAL_AUTOMATION_MANAGER_CACHE_ENTRIES = 512

/** Keep bounded error messages, without retaining arbitrary provider payloads. */
export function describeExternalManagerFailure(error: unknown): string {
  const message = error instanceof Error ? error.message.trim() : ''
  if (!message) {
    return 'External automation manager could not be read.'
  }
  return message.length > MAX_CACHED_ERROR_LENGTH
    ? `${message.slice(0, MAX_CACHED_ERROR_LENGTH)}…`
    : message
}

export function externalAutomationManagerCacheKey(key: ExternalAutomationManagerCacheKey): string {
  // ownerKey already escapes separators.
  return `${key.ownerKey}|${key.provider}`
}

export class ExternalAutomationManagerCache {
  private readonly entries = new Map<string, ExternalAutomationManagerCacheEntry>()
  private readonly ttlMs: number
  private readonly now: () => number

  constructor(options?: { ttlMs?: number; now?: () => number }) {
    this.ttlMs = Math.max(0, options?.ttlMs ?? DEFAULT_CACHE_TTL_MS)
    this.now = options?.now ?? Date.now
  }

  get size(): number {
    return this.entries.size
  }

  read(key: ExternalAutomationManagerCacheKey): ExternalAutomationManagerCacheEntry | null {
    this.pruneExpired()
    const entry = this.entries.get(externalAutomationManagerCacheKey(key))
    if (!entry) {
      return null
    }
    return this.now() - entry.updatedAt <= this.ttlMs ? entry : null
  }

  write(
    key: ExternalAutomationManagerCacheKey,
    manager: ExternalAutomationManager | null
  ): ExternalAutomationManagerCacheEntry {
    return this.store(key, { manager, error: null, updatedAt: this.now() })
  }

  writeFailure(
    key: ExternalAutomationManagerCacheKey,
    error: unknown
  ): ExternalAutomationManagerCacheEntry {
    return this.store(key, {
      manager: null,
      error: describeExternalManagerFailure(error),
      updatedAt: this.now()
    })
  }

  invalidate(key: ExternalAutomationManagerCacheKey): void {
    this.entries.delete(externalAutomationManagerCacheKey(key))
  }

  invalidateOwner(ownerKey: string): void {
    for (const key of this.entries.keys()) {
      if (key.startsWith(`${ownerKey}|`)) {
        this.entries.delete(key)
      }
    }
  }

  clear(): void {
    this.entries.clear()
  }

  /** Cancellation propagates without replacing the previous cache entry. */
  async resolve(
    key: ExternalAutomationManagerCacheKey,
    load: () => Promise<ExternalAutomationManager | null>,
    options?: { refresh?: boolean }
  ): Promise<ExternalAutomationManagerCacheEntry> {
    if (!options?.refresh) {
      const cached = this.read(key)
      if (cached) {
        return cached
      }
    }
    try {
      return this.write(key, await load())
    } catch (error) {
      if (isExternalAutomationProbeCancelled(error)) {
        throw error
      }
      return this.writeFailure(key, error)
    }
  }

  private store(
    key: ExternalAutomationManagerCacheKey,
    entry: ExternalAutomationManagerCacheEntry
  ): ExternalAutomationManagerCacheEntry {
    this.pruneExpired()
    const cacheKey = externalAutomationManagerCacheKey(key)
    this.entries.delete(cacheKey)
    this.entries.set(cacheKey, entry)
    while (this.entries.size > MAX_EXTERNAL_AUTOMATION_MANAGER_CACHE_ENTRIES) {
      const oldest = this.entries.keys().next()
      if (oldest.done || oldest.value === cacheKey) {
        break
      }
      this.entries.delete(oldest.value)
    }
    return entry
  }

  private pruneExpired(): void {
    const now = this.now()
    for (const [key, entry] of this.entries) {
      if (now - entry.updatedAt > this.ttlMs) {
        this.entries.delete(key)
      }
    }
  }
}
