/**
 * Per-`{owner, provider}` manager and error state.
 *
 * Deliberately holds no reference to Orca automation storage: a provider that is
 * missing, wedged, or returning garbage is a fact about that manager only, and
 * must never be able to mark the host's Orca store unavailable.
 */

import type { ExternalAutomationManager } from '../../shared/automations-types'
import { isExternalAutomationProbeCancelled } from './external-automation-probe-scheduler'

export type ExternalAutomationManagerCacheKey = {
  ownerKey: string
  provider: string
}

export type ExternalAutomationManagerCacheEntry = {
  /** Null once a probe succeeded and found no manager configured for this scope. */
  manager: ExternalAutomationManager | null
  error: string | null
  updatedAt: number
}

const DEFAULT_CACHE_TTL_MS = 30_000
const MAX_CACHED_ERROR_LENGTH = 300

/**
 * Bounded, provider-agnostic failure text. Provider payloads can carry prompts,
 * job bodies, and run output, so only an `Error.message` is ever kept and it is
 * truncated; anything else is reduced to a fixed string.
 */
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
  // Why: ownerKey is already separator-escaped, so appending the provider stays unambiguous.
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

  /** Fresh entry for this scope, or null when absent or past its TTL. */
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

  /** Drops every provider entry for one host, e.g. after a mutation on it. */
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

  /**
   * Returns a fresh entry or loads one. A cancelled probe propagates and leaves
   * any existing entry untouched, so leaving a scope never records a failure.
   */
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
    this.entries.set(externalAutomationManagerCacheKey(key), entry)
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
