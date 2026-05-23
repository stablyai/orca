/* eslint-disable no-control-regex, max-lines -- Why: ANSI/OSC stripping must match raw
 * control sequences in PTY output, same as src/main/runtime/orca-runtime.ts;
 * URL parsing, host classification, cache lifecycle, and cross-worktree lookup
 * are tightly coupled and kept in one file to keep the rules in lockstep. */
// Watches PTY output for HTTP(S) URLs that dev servers (Vite, Next, etc.)
// print on startup. Maintains a per-{worktreeId, port} cache so the workspace
// ports panel can show the tool-advertised origin instead of the kernel bind
// (e.g. `https://local.getmontecarlo.com:3001/` rather than `127.0.0.1:3001`).
//
// Why a separate stateful buffer per PTY: ANSI escape sequences and URLs can
// both straddle PTY write boundaries, so we cannot strip ANSI and scan one
// chunk at a time. We accumulate raw bytes, finalize only at newline-anchored
// boundaries, then run a stateless strip-and-scan on the finalized prefix.

const PER_PTY_BUFFER_LIMIT = 4096
const PENDING_PRE_BIND_LIMIT = 16 * 1024
/** Cap on distinct never-bound PTY IDs. Spawn-failure paths can leave a
 *  pending entry that never gets bindPty'd — without an upper bound, a
 *  long-running app would slowly leak one entry per failure. */
const MAX_PENDING_ENTRIES = 32
const MAX_CACHE_ENTRIES = 256
const URL_CANDIDATE_LIMIT = 2048

// ANSI/OSC strippers mirror normalizeTerminalChunk in
// src/main/runtime/orca-runtime.ts so the two stay in lockstep.
const OSC_PATTERN = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g
const CSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g
const SINGLE_ESC_PATTERN = /\x1b[@-_]/g
const CONTROL_PATTERN = /[\x00-\x08\x0b-\x1f\x7f]/g

// Why: this is a permissive candidate matcher. Real validation happens via
// `new URL()` below. Stopping at characters that cannot appear in a URL
// (whitespace, quotes, angle brackets, backtick) avoids absorbing terminal
// punctuation. Trailing punctuation like `.,;)` is trimmed before parsing
// because URLs are commonly followed by sentence punctuation in human text.
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
  /** PID of the listening process that this advertised URL was validated
   *  against on a previous scan. Set by lookup APIs when a current PID is
   *  supplied; a later mismatch evicts the entry. Captured on first scan
   *  rather than at capture time because the PTY shell PID is not the
   *  listener PID. */
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

  /** Append a chunk and return the cleaned, finalized text (everything up to
   *  and including the last newline). Whatever follows the last newline stays
   *  buffered so that a URL or ANSI sequence split across chunks survives. */
  ingest(chunk: string): string {
    this.raw += chunk
    if (this.raw.length > PER_PTY_BUFFER_LIMIT) {
      this.raw = this.raw.slice(-PER_PTY_BUFFER_LIMIT)
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
  // Both \n and \r are accepted; \r\n is handled by stripping \r in
  // stripTerminalControls — but we still want either one as a finalize point.
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
  // Why: Node's URL.hostname returns IPv6 literals with brackets ("[::1]"),
  // while the public API for this function should accept either form.
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
  // Codex's preference: custom DNS > loopback > private IP > public IP.
  // A custom-configured host (e.g. `local.getmontecarlo.com`) is almost always
  // the one the user wants opened, and loopback beats LAN for cert/cookie
  // reasons on a single-machine setup.
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
    this.ptyToWorktree.set(ptyId, worktreeId)
    const pending = this.pending.get(ptyId)
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
      // Why: SSH forward enrichment has no listener PID to validate against,
      // so PTY teardown is the only reliable expiry signal for that cache row.
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

  ingest(ptyId: string, chunk: string, now?: number): void {
    if (!chunk) {
      return
    }
    const worktreeId = this.ptyToWorktree.get(ptyId)
    if (!worktreeId) {
      // Why: data can arrive on daemon-backed PTYs before the spawn handler
      // resolves and we learn the worktreeId (see comment at
      // src/main/ipc/pty.ts:1318-1323). Buffer until bindPty replays.
      const prior = this.pending.get(ptyId) ?? ''
      const merged = (prior + chunk).slice(-PENDING_PRE_BIND_LIMIT)
      // Why: drop+reinsert touches insertion order so this acts as an LRU
      // (Map iterates in insertion order). Combined with the eviction below,
      // we keep at most MAX_PENDING_ENTRIES distinct unbound PTYs.
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
    // Why: dev servers sometimes print their bind address verbatim
    // (`http://0.0.0.0:3000/`). Those wildcard hosts cannot be opened in a
    // browser — the OS scanner already normalizes wildcards to `localhost`
    // for the connect host, so refuse the advertised value rather than let
    // it overwrite that sensible default.
    if (isUnspecifiedHost(hostname)) {
      return
    }
    const hostKind = classifyHost(hostname)
    // Why: store origin only — no path, query, fragment, or userinfo. A
    // terminal line containing an OAuth callback or token must not get
    // surfaced in the port panel.
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
          // Why: the advertised URL can arrive between the process printing its
          // banner and the scanner seeing the listener; allow one settling scan.
          this.startupAbsentAllowances.add(key)
        } else {
          this.startupAbsentAllowances.delete(key)
        }
      } else {
        this.validationBaselines.delete(key)
        // Why: PTY output can arrive before the scanner has produced any
        // snapshot for the worktree; give that startup race the same one-scan
        // absent allowance as a known-absent baseline.
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
        // Why: the process that printed this URL is gone and a different
        // process is now listening on the port. Drop the cached URL — the
        // new listener may be unrelated to the captured banner.
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

  /** Reconcile the URL cache with a scanner snapshot for a worktree scope.
   *  Unvalidated URLs are tied to the listener state observed around capture,
   *  so a later absent port or changed PID cannot be lazily blessed. */
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
      // Why: dev servers can print their URL before the OS listener scan sees
      // the port. Let that first present scan validate the startup banner.
      return false
    }
    return (
      entry.validatedListenerPid === undefined &&
      baseline !== undefined &&
      scanStateChanged(baseline, current)
    )
  }

  /** Find the best advertised URL for `port` across multiple worktrees. SSH
   *  connections host several worktrees but the remote-side port scanner
   *  returns ports for the whole connection, so we need to scan all the
   *  worktrees attached to that connection. Returns the highest-scoring
   *  entry by hostKind (custom DNS > loopback > private IP > public IP),
   *  with HTTPS and recency as tie-breakers — same rule as `shouldReplace`
   *  uses on insert.
   *
   *  When `currentListenerPid` is supplied each candidate entry is run
   *  through PID filtering first. Already-pinned mismatches are evicted,
   *  then only the returned winner is pinned to the current listener. */
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

/** Process-wide singleton. The runtime feeds it from `onPtyData`; the scanner
 *  enrichment reads it. Tests should instantiate their own
 *  `AdvertisedUrlWatcher` rather than relying on this. */
export const advertisedUrlWatcher = new AdvertisedUrlWatcher()

function formatHostForOrigin(url: URL): string {
  // Why: Node returns IPv6 hostnames pre-bracketed ("[::1]"). Some other JS
  // runtimes strip the brackets. Accept both: re-bracket if a bare IPv6
  // literal slips through.
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
      // Multiple host-specific listeners on one port make PID attribution
      // ambiguous for our port-keyed URL cache; preserve presence only.
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
