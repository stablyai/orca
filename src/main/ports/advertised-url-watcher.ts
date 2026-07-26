/* eslint-disable no-control-regex, max-lines -- control-sequence regexes need raw matching; URL parsing, host classification, cache lifecycle, and cross-worktree lookup stay in one file to keep the rules in lockstep. */
// Watches PTY output for HTTP(S) URLs dev servers print on startup, caching the
// advertised origin per {worktreeId, port} for the ports panel (vs the kernel bind).
// Why a separate stateful buffer per PTY: ANSI sequences and URLs can straddle PTY
// write boundaries, so we accumulate raw bytes and strip-and-scan only at newlines.

const PER_PTY_BUFFER_LIMIT = 4096
const PENDING_PRE_BIND_LIMIT = 16 * 1024
/** Cap on distinct never-bound PTY IDs; spawn-failure paths never bindPty, so without a bound they'd leak one entry each. */
const MAX_PENDING_ENTRIES = 32
const MAX_CACHE_ENTRIES = 256
const URL_CANDIDATE_LIMIT = 2048

// ANSI/OSC strippers mirror the runtime normalizer in src/main/runtime/orca-runtime.ts, plus URL-specific cursor-move handling to avoid fusing skipped text.
const OSC_PATTERN = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g
// Why: cursor moves in differential redraws skip on-screen cells; a URL-invalid guard drops the damaged candidate.
const CURSOR_MOVE_PATTERN = /\x1b\[[0-?]*[ -/]*[CDGHf]/g
const CURSOR_MOVE_URL_GUARD = '['
const CSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g
const SINGLE_ESC_PATTERN = /\x1b[@-_]/g
const CONTROL_PATTERN = /[\x00-\x08\x0b-\x1f\x7f]/g

// Permissive matcher (real validation is `new URL()` below); stops at non-URL chars so terminal punctuation isn't absorbed.
const URL_CANDIDATE_PATTERN = /\bhttps?:\/\/[^\s<>"'`]+/gi

export type HostKind = 'custom' | 'loopback' | 'private-ip' | 'public-ip'

export type AdvertisedUrl = {
  origin: string
  host: string
  hostKind: HostKind
  protocol: 'http' | 'https'
  port: number
  ptyId: string
  lastSeenAt: number
  /** Listener PID this URL was validated against on a prior scan; a later mismatch evicts the entry.
   *  Captured on first scan (not at capture time) because the PTY shell PID isn't the listener PID. */
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

type CacheKey = string
type ListenerScanState = { kind: 'absent' } | { kind: 'present'; pid?: number }

function cacheKey(worktreeId: string, port: number): CacheKey {
  return `${worktreeId}::${port}`
}

function worktreeIdFromCacheKey(key: CacheKey, port: number): string {
  const suffix = `::${port}`
  return key.endsWith(suffix) ? key.slice(0, -suffix.length) : key
}

class PtyBuffer {
  private raw = ''

  /** Append a chunk; return cleaned text up to the last newline. The tail stays buffered so a URL or ANSI sequence split across chunks survives. */
  ingest(chunk: string): string {
    const chunkHasLineBreak = chunk.includes('\n') || chunk.includes('\r')
    this.raw += chunk
    if (this.raw.length > PER_PTY_BUFFER_LIMIT) {
      this.raw = this.raw.slice(-PER_PTY_BUFFER_LIMIT)
    }
    if (!chunkHasLineBreak) {
      return ''
    }
    const lastNewline = lastLineBreak(this.raw)
    if (lastNewline === -1) {
      return ''
    }
    const finalized = this.raw.slice(0, lastNewline + 1)
    this.raw = this.raw.slice(lastNewline + 1)
    return stripTerminalControls(finalized)
  }
}

function lastLineBreak(text: string): number {
  // Accept either \n or \r as a finalize point (\r\n is normalized later in stripTerminalControls).
  for (let i = text.length - 1; i >= 0; i--) {
    const ch = text.charCodeAt(i)
    if (ch === 0x0a || ch === 0x0d) {
      return i
    }
  }
  return -1
}

export function stripTerminalControls(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(OSC_PATTERN, '')
    .replace(CURSOR_MOVE_PATTERN, CURSOR_MOVE_URL_GUARD)
    .replace(CSI_PATTERN, '')
    .replace(SINGLE_ESC_PATTERN, '')
    .replace(CONTROL_PATTERN, '')
}

export function extractUrlCandidates(cleaned: string): URL[] {
  const results: URL[] = []
  for (const match of cleaned.matchAll(URL_CANDIDATE_PATTERN)) {
    let candidate = match[0]
    if (candidate.length > URL_CANDIDATE_LIMIT) {
      continue
    }
    // Strip common trailing punctuation that cannot end a real URL.
    while (candidate.length > 0 && /[.,;:!?)\]}>'"`]/.test(candidate.slice(-1))) {
      candidate = candidate.slice(0, -1)
    }
    const url = parseUrl(candidate)
    if (url) {
      results.push(url)
    }
  }
  return results
}

function parseUrl(candidate: string): URL | null {
  try {
    const url = new URL(candidate)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return null
    }
    if (!url.hostname) {
      return null
    }
    return url
  } catch {
    return null
  }
}

export function classifyHost(hostname: string): HostKind {
  // Why: strip IPv6 brackets so this public API accepts both "[::1]" (Node's form) and bare literals.
  const lower = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (lower === 'localhost' || lower === '127.0.0.1' || lower === '::1') {
    return 'loopback'
  }
  if (isIpv4(lower)) {
    if (isPrivateIpv4(lower)) {
      return 'private-ip'
    }
    return 'public-ip'
  }
  if (isIpv6(lower)) {
    if (isPrivateIpv6(lower)) {
      return 'private-ip'
    }
    return 'public-ip'
  }
  // Anything else is a DNS name — that's what we prefer for dev servers.
  return 'custom'
}

function isIpv4(value: string): boolean {
  const parts = value.split('.')
  if (parts.length !== 4) {
    return false
  }
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)
}

function isPrivateIpv4(value: string): boolean {
  const [a, b] = value.split('.').map((n) => Number(n))
  // 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16 (link-local)
  if (a === 10) {
    return true
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return true
  }
  if (a === 192 && b === 168) {
    return true
  }
  if (a === 169 && b === 254) {
    return true
  }
  return false
}

function isUnspecifiedHost(hostname: string): boolean {
  const stripped = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return stripped === '0.0.0.0' || stripped === '::' || stripped === '*'
}

function isIpv6(value: string): boolean {
  // url.hostname for IPv6 returns lowercase without brackets — quick sniff.
  return value.includes(':') && /^[0-9a-f:]+$/.test(value)
}

function isPrivateIpv6(value: string): boolean {
  // fc00::/7 (ULA) and fe80::/10 (link-local)
  if (value.startsWith('fc') || value.startsWith('fd')) {
    return true
  }
  const firstHextet = Number.parseInt(value.split(':', 1)[0], 16)
  return Number.isFinite(firstHextet) && (firstHextet & 0xffc0) === 0xfe80
}

function hostKindScore(kind: HostKind): number {
  // Prefer custom DNS > loopback > private IP > public IP: loopback beats LAN for cert/cookie reasons on one machine.
  switch (kind) {
    case 'custom':
      return 3
    case 'loopback':
      return 2
    case 'private-ip':
      return 1
    case 'public-ip':
      return 0
  }
}

function shouldReplace(existing: AdvertisedUrl, candidate: AdvertisedUrl): boolean {
  const oldScore = hostKindScore(existing.hostKind)
  const newScore = hostKindScore(candidate.hostKind)
  if (newScore !== oldScore) {
    return newScore > oldScore
  }
  if (existing.protocol !== candidate.protocol) {
    return candidate.protocol === 'https'
  }
  return candidate.lastSeenAt >= existing.lastSeenAt
}

export type AdvertisedUrlWatcherOptions = {
  /** Override the clock; useful for tests. */
  now?: () => number
  /** Override the max cache entries (default 256). */
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
      this.consider(url, ptyId, worktreeId, timestamp)
    }
  }

  private consider(url: URL, ptyId: string, worktreeId: string, timestamp: number): void {
    const protocol = url.protocol === 'https:' ? 'https' : 'http'
    const port = url.port ? Number(url.port) : protocol === 'https' ? 443 : 80
    if (!Number.isFinite(port) || port <= 0 || port > 65535) {
      return
    }
    const hostname = url.hostname
    // Why: wildcard bind hosts (0.0.0.0, ::) can't be opened in a browser; keep the scanner's localhost default instead.
    if (isUnspecifiedHost(hostname)) {
      return
    }
    const hostKind = classifyHost(hostname)
    // Why: store origin only (no path/query/fragment/userinfo) so an OAuth callback or token can't leak to the panel.
    const origin = `${protocol}://${formatHostForOrigin(url)}${
      isDefaultPort(protocol, port) ? '' : `:${port}`
    }`
    const candidate: AdvertisedUrl = {
      origin,
      host: hostname,
      hostKind,
      protocol,
      port,
      ptyId,
      lastSeenAt: timestamp
    }
    const key = cacheKey(worktreeId, port)
    const existing = this.cache.get(key)
    if (!existing || shouldReplace(existing, candidate)) {
      this.cache.set(key, candidate)
      const baseline = this.currentScanStateFor(worktreeId, port)
      if (baseline) {
        this.validationBaselines.set(key, baseline)
        if (baseline.kind === 'absent') {
          // Why: the URL can arrive between the banner print and the scanner seeing the listener; allow one settling scan.
          this.startupAbsentAllowances.add(key)
        } else {
          this.startupAbsentAllowances.delete(key)
        }
      } else {
        this.validationBaselines.delete(key)
        // Why: PTY output can arrive before any scan snapshot exists; grant the same one-scan absent allowance.
        this.startupAbsentAllowances.add(key)
      }
      const changedEvents = this.enforceCacheLimit()
      if (!existing || existing.origin !== candidate.origin) {
        changedEvents.push({ worktreeId, port })
      }
      for (const event of dedupeChangeEvents(changedEvents)) {
        this.emitChange(event)
      }
    } else {
      // Refresh recency on the existing entry so it isn't evicted by LRU.
      existing.lastSeenAt = timestamp
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

  private enforceCacheLimit(): AdvertisedUrlChangeEvent[] {
    if (this.cache.size <= this.maxCacheEntries) {
      return []
    }
    // Drop oldest by lastSeenAt until we are back at the cap.
    const entries = Array.from(this.cache.entries()).sort(
      (a, b) => a[1].lastSeenAt - b[1].lastSeenAt
    )
    const overflow = this.cache.size - this.maxCacheEntries
    const removedEvents: AdvertisedUrlChangeEvent[] = []
    for (let i = 0; i < overflow; i++) {
      const [key, entry] = entries[i]
      this.cache.delete(key)
      this.validationBaselines.delete(key)
      this.startupAbsentAllowances.delete(key)
      removedEvents.push({ worktreeId: worktreeIdFromCacheKey(key, entry.port), port: entry.port })
    }
    return removedEvents
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

      if (this.shouldEvictAfterScan(key, entry, current)) {
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

  private shouldEvictAfterScan(
    key: CacheKey,
    entry: AdvertisedUrl,
    current: ListenerScanState
  ): boolean {
    const baseline = this.validationBaselines.get(key)
    if (current.kind === 'absent') {
      if (
        entry.validatedListenerPid === undefined &&
        baseline?.kind !== 'present' &&
        this.startupAbsentAllowances.delete(key)
      ) {
        return false
      }
      return true
    }
    if (
      entry.validatedListenerPid !== undefined &&
      current.pid !== undefined &&
      entry.validatedListenerPid !== current.pid
    ) {
      return true
    }
    if (baseline?.kind === 'absent' && current.kind === 'present') {
      this.startupAbsentAllowances.delete(key)
      // Why: dev servers print their URL before the listener scan sees the port; let this first present scan validate it.
      return false
    }
    return (
      entry.validatedListenerPid === undefined &&
      baseline !== undefined &&
      scanStateChanged(baseline, current)
    )
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
    let best: { worktreeId: string; entry: AdvertisedUrl } | undefined
    for (const worktreeId of worktreeIds) {
      const key = cacheKey(worktreeId, port)
      const candidate = this.cache.get(key)
      if (!candidate) {
        continue
      }
      if (currentListenerPid !== undefined) {
        if (
          candidate.validatedListenerPid !== undefined &&
          candidate.validatedListenerPid !== currentListenerPid
        ) {
          this.cache.delete(key)
          this.validationBaselines.delete(key)
          this.startupAbsentAllowances.delete(key)
          this.emitChange({ worktreeId, port })
          continue
        }
      }
      if (!best || shouldReplace(best.entry, candidate)) {
        best = { worktreeId, entry: candidate }
      }
    }
    if (best && currentListenerPid !== undefined && best.entry.validatedListenerPid === undefined) {
      best.entry.validatedListenerPid = currentListenerPid
      this.validationBaselines.delete(cacheKey(best.worktreeId, port))
      this.startupAbsentAllowances.delete(cacheKey(best.worktreeId, port))
    }
    return best?.entry
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

function isDefaultPort(protocol: 'http' | 'https', port: number): boolean {
  return (protocol === 'http' && port === 80) || (protocol === 'https' && port === 443)
}

/** Process-wide singleton fed by the runtime and read by scanner enrichment. Tests should instantiate their own instead. */
export const advertisedUrlWatcher = new AdvertisedUrlWatcher()

function formatHostForOrigin(url: URL): string {
  // Why: some JS runtimes strip the IPv6 brackets Node adds; re-bracket a bare IPv6 literal.
  const h = url.hostname
  if (h.startsWith('[') && h.endsWith(']')) {
    return h
  }
  if (h.includes(':')) {
    return `[${h}]`
  }
  return h
}

function observedListenersByPort(
  observations: readonly AdvertisedUrlListenerObservation[]
): Map<number, number | undefined> {
  const observed = new Map<number, number | undefined>()
  for (const observation of observations) {
    const existing = observed.get(observation.port)
    if (!observed.has(observation.port)) {
      observed.set(observation.port, observation.pid)
    } else if (existing !== observation.pid) {
      // Multiple host-specific listeners on one port make PID attribution ambiguous; keep presence only.
      observed.set(observation.port, undefined)
    }
  }
  return observed
}

function scanStateChanged(previous: ListenerScanState, current: ListenerScanState): boolean {
  if (previous.kind !== current.kind) {
    return true
  }
  if (previous.kind === 'absent' || current.kind === 'absent') {
    return false
  }
  return previous.pid !== undefined && current.pid !== undefined && previous.pid !== current.pid
}

function dedupeChangeEvents(
  events: readonly AdvertisedUrlChangeEvent[]
): AdvertisedUrlChangeEvent[] {
  const seen = new Set<string>()
  const deduped: AdvertisedUrlChangeEvent[] = []
  for (const event of events) {
    const key = cacheKey(event.worktreeId, event.port)
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    deduped.push(event)
  }
  return deduped
}
