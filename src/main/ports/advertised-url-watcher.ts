// Watches PTY output for HTTP(S) URLs dev servers print on startup, caching the
// advertised origin per {worktreeId, port} for the ports panel (vs the kernel bind).
// Why a separate stateful buffer per PTY: ANSI sequences and URLs can straddle PTY
// write boundaries, so we accumulate raw bytes and strip-and-scan only at newlines.
import {
  MAX_CACHE_ENTRIES,
  MAX_PENDING_ENTRIES,
  PENDING_PRE_BIND_LIMIT,
  PtyBuffer,
  cacheKey,
  dedupeChangeEvents,
  extractUrlCandidates,
  observedListenersByPort,
  worktreeIdFromCacheKey,
  type CacheKey,
  type ListenerScanState
} from './advertised-url-parsing'
import { considerAdvertisedUrl } from './advertised-url-cache-update'
import {
  lookupBestAdvertisedUrl,
  shouldEvictAdvertisedUrlAfterScan
} from './advertised-url-reconciliation'
export type HostKind = 'custom' | 'loopback' | 'private-ip' | 'public-ip'

export type AdvertisedUrl = {
  origin: string
  host: string
  hostKind: HostKind
  protocol: 'http' | 'https'
  port: number
  ptyId: string
  lastSeenAt: number
  validatedListenerPid?: number
}

export type AdvertisedUrlChangeEvent = {
  worktreeId: string
  port: number
}

export type AdvertisedUrlListenerObservation = {
  port: number
  pid?: number
}

export type AdvertisedUrlWatcherOptions = {
  now?: () => number
  maxCacheEntries?: number
}

export class AdvertisedUrlWatcher {
  private readonly buffers = new Map<string, PtyBuffer>()
  private readonly ptyToWorktree = new Map<string, string>()
  private readonly pending = new Map<string, string>()
  private readonly cache = new Map<CacheKey, AdvertisedUrl>()
  private readonly scanSnapshots = new Map<string, Map<number, number | undefined>>()
  private readonly validationBaselines = new Map<CacheKey, ListenerScanState>()
  private readonly startupAbsentAllowances = new Set<CacheKey>()
  private readonly listeners = new Set<(event: AdvertisedUrlChangeEvent) => void>()
  private readonly now: () => number
  private readonly maxCacheEntries: number

  constructor(options: AdvertisedUrlWatcherOptions = {}) {
    this.now = options.now ?? Date.now
    this.maxCacheEntries = options.maxCacheEntries ?? MAX_CACHE_ENTRIES
  }

  onDidChange(listener: (event: AdvertisedUrlChangeEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  bindPty(ptyId: string, worktreeId: string): void {
    const pending = this.pending.get(ptyId)
    if (this.ptyToWorktree.get(ptyId) === worktreeId && pending === undefined) {
      return
    }
    this.ptyToWorktree.set(ptyId, worktreeId)
    if (pending !== undefined) {
      this.pending.delete(ptyId)
      this.ingest(ptyId, pending)
    }
  }

  unbindPty(ptyId: string): void {
    this.ptyToWorktree.delete(ptyId)
    this.buffers.delete(ptyId)
    this.pending.delete(ptyId)
    const removedEvents: AdvertisedUrlChangeEvent[] = []
    for (const [key, entry] of this.cache) {
      if (entry.ptyId !== ptyId) {
        continue
      }
      // Why: SSH forward enrichment has no listener PID, so PTY teardown is the only reliable expiry signal.
      this.cache.delete(key)
      this.validationBaselines.delete(key)
      this.startupAbsentAllowances.delete(key)
      const worktreeId = worktreeIdFromCacheKey(key, entry.port)
      removedEvents.push({ worktreeId, port: entry.port })
    }
    for (const event of removedEvents) {
      this.emitChange(event)
    }
  }

  forgetWorktree(worktreeId: string): void {
    // Why: worktree IDs are reused, so a removed worktree must not leave scan baselines for a future one.
    for (const [ptyId, boundWorktreeId] of this.ptyToWorktree) {
      if (boundWorktreeId !== worktreeId) {
        continue
      }
      this.ptyToWorktree.delete(ptyId)
      this.buffers.delete(ptyId)
    }

    this.scanSnapshots.delete(worktreeId)
    const removedEvents: AdvertisedUrlChangeEvent[] = []
    for (const [key, entry] of this.cache) {
      const entryWorktreeId = worktreeIdFromCacheKey(key, entry.port)
      if (entryWorktreeId !== worktreeId) {
        continue
      }
      this.cache.delete(key)
      this.validationBaselines.delete(key)
      this.startupAbsentAllowances.delete(key)
      removedEvents.push({ worktreeId, port: entry.port })
    }
    for (const event of dedupeChangeEvents(removedEvents)) {
      this.emitChange(event)
    }
  }

  ingest(ptyId: string, chunk: string, now?: number): void {
    if (!chunk) {
      return
    }
    const worktreeId = this.ptyToWorktree.get(ptyId)
    if (!worktreeId) {
      // Why: daemon PTY data can arrive before the spawn handler resolves the worktreeId (src/main/ipc/pty.ts:1318-1323); buffer until bindPty replays.
      const prior = this.pending.get(ptyId) ?? ''
      const merged = (prior + chunk).slice(-PENDING_PRE_BIND_LIMIT)
      // Why: drop+reinsert refreshes Map insertion order (LRU) so the eviction below drops the oldest unbound PTY.
      this.pending.delete(ptyId)
      this.pending.set(ptyId, merged)
      while (this.pending.size > MAX_PENDING_ENTRIES) {
        const oldest = this.pending.keys().next().value
        if (oldest === undefined) {
          break
        }
        this.pending.delete(oldest)
      }
      return
    }
    let buffer = this.buffers.get(ptyId)
    if (!buffer) {
      buffer = new PtyBuffer()
      this.buffers.set(ptyId, buffer)
    }
    const finalized = buffer.ingest(chunk)
    if (!finalized) {
      return
    }
    const timestamp = now ?? this.now()
    for (const url of extractUrlCandidates(finalized)) {
      const events = considerAdvertisedUrl({
        url,
        ptyId,
        worktreeId,
        timestamp,
        cache: this.cache,
        validationBaselines: this.validationBaselines,
        startupAbsentAllowances: this.startupAbsentAllowances,
        currentScanState: this.currentScanStateFor(
          worktreeId,
          url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80
        ),
        maxCacheEntries: this.maxCacheEntries
      })
      for (const event of events) {
        this.emitChange(event)
      }
    }
  }

  private emitChange(event: AdvertisedUrlChangeEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (error) {
        console.warn('[advertised-url-watcher] listener failed', error)
      }
    }
  }

  lookup(worktreeId: string, port: number, currentListenerPid?: number): AdvertisedUrl | undefined {
    const key = cacheKey(worktreeId, port)
    const entry = this.cache.get(key)
    if (!entry) {
      return undefined
    }
    if (currentListenerPid !== undefined) {
      if (entry.validatedListenerPid === undefined) {
        entry.validatedListenerPid = currentListenerPid
      } else if (entry.validatedListenerPid !== currentListenerPid) {
        // Why: a different process now listens on this port, so the captured banner may be unrelated — drop it.
        this.cache.delete(key)
        this.validationBaselines.delete(key)
        this.startupAbsentAllowances.delete(key)
        this.emitChange({ worktreeId, port })
        return undefined
      }
    }
    return entry
  }

  /** Drop a single cached entry. */
  invalidate(worktreeId: string, port: number): void {
    const key = cacheKey(worktreeId, port)
    this.validationBaselines.delete(key)
    this.startupAbsentAllowances.delete(key)
    if (this.cache.delete(key)) {
      this.emitChange({ worktreeId, port })
    }
  }

  /** Reconcile the URL cache with a scanner snapshot. Unvalidated URLs stay tied to the
   *  listener state seen at capture, so a later absent port or changed PID can't lazily bless them. */
  reconcileScan(
    worktreeIds: readonly string[],
    observations: readonly AdvertisedUrlListenerObservation[]
  ): void {
    const observedByPort = observedListenersByPort(observations)
    const worktreeSet = new Set(worktreeIds)
    const removedEvents: AdvertisedUrlChangeEvent[] = []

    for (const [key, entry] of this.cache) {
      const worktreeId = worktreeIdFromCacheKey(key, entry.port)
      if (!worktreeSet.has(worktreeId)) {
        continue
      }
      const current = observedByPort.has(entry.port)
        ? ({ kind: 'present', pid: observedByPort.get(entry.port) } as const)
        : ({ kind: 'absent' } as const)

      if (
        shouldEvictAdvertisedUrlAfterScan({
          key,
          entry,
          current,
          validationBaselines: this.validationBaselines,
          startupAbsentAllowances: this.startupAbsentAllowances
        })
      ) {
        this.cache.delete(key)
        this.validationBaselines.delete(key)
        this.startupAbsentAllowances.delete(key)
        removedEvents.push({ worktreeId, port: entry.port })
      } else if (entry.validatedListenerPid === undefined) {
        this.validationBaselines.set(key, current)
      }
    }

    for (const worktreeId of worktreeSet) {
      this.scanSnapshots.set(worktreeId, new Map(observedByPort))
    }
    for (const event of removedEvents) {
      this.emitChange(event)
    }
  }

  /** Find the best advertised URL for `port` across worktrees, scored via `shouldReplace`.
   *  Scans all worktrees on the connection because an SSH port scanner reports ports for the
   *  whole connection, not per-worktree. With `currentListenerPid`, mismatched pinned entries
   *  are evicted and only the winner is pinned. */
  lookupBest(
    worktreeIds: readonly string[],
    port: number,
    currentListenerPid?: number
  ): AdvertisedUrl | undefined {
    return lookupBestAdvertisedUrl({
      worktreeIds,
      port,
      currentListenerPid,
      cache: this.cache,
      validationBaselines: this.validationBaselines,
      startupAbsentAllowances: this.startupAbsentAllowances,
      onEvict: (worktreeId) => this.emitChange({ worktreeId, port })
    })
  }

  clear(): void {
    this.buffers.clear()
    this.ptyToWorktree.clear()
    this.pending.clear()
    this.cache.clear()
    this.scanSnapshots.clear()
    this.validationBaselines.clear()
    this.startupAbsentAllowances.clear()
  }

  private currentScanStateFor(worktreeId: string, port: number): ListenerScanState | undefined {
    const snapshot = this.scanSnapshots.get(worktreeId)
    if (!snapshot) {
      return undefined
    }
    return snapshot.has(port) ? { kind: 'present', pid: snapshot.get(port) } : { kind: 'absent' }
  }
}

/** Process-wide singleton fed by the runtime and read by scanner enrichment. */
export const advertisedUrlWatcher = new AdvertisedUrlWatcher()
