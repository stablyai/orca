/* eslint-disable no-control-regex -- Terminal control-sequence parsing intentionally matches raw control bytes. */
import type {
  AdvertisedUrl,
  AdvertisedUrlChangeEvent,
  AdvertisedUrlListenerObservation,
  HostKind
} from './advertised-url-watcher'

const PER_PTY_BUFFER_LIMIT = 4096
export const PENDING_PRE_BIND_LIMIT = 16 * 1024
/** Cap on distinct never-bound PTY IDs; spawn-failure paths never bindPty, so without a bound they'd leak one entry each. */
export const MAX_PENDING_ENTRIES = 32
export const MAX_CACHE_ENTRIES = 256
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

export type CacheKey = string
export type ListenerScanState = { kind: 'absent' } | { kind: 'present'; pid?: number }

export function cacheKey(worktreeId: string, port: number): CacheKey {
  return `${worktreeId}::${port}`
}

export function worktreeIdFromCacheKey(key: CacheKey, port: number): string {
  const suffix = `::${port}`
  return key.endsWith(suffix) ? key.slice(0, -suffix.length) : key
}

export class PtyBuffer {
  private raw = ''

  /** Append a chunk; return cleaned text up to the last newline. The tail stays buffered so a URL or ANSI sequence split across chunks survives. */
  ingest(chunk: string): string {
    const chunkHasLineBreak = chunk.includes('\n') || chunk.includes('\r')
    // Keep the suffix directly so oversized chunks never materialize a throwaway full concatenation.
    if (chunk.length >= PER_PTY_BUFFER_LIMIT) {
      this.raw = chunk.slice(-PER_PTY_BUFFER_LIMIT)
    } else if (this.raw.length + chunk.length > PER_PTY_BUFFER_LIMIT) {
      this.raw = `${this.raw.slice(-(PER_PTY_BUFFER_LIMIT - chunk.length))}${chunk}`
    } else {
      this.raw += chunk
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
    return mayContainHttpUrl(finalized) ? stripTerminalControls(finalized) : ''
  }
}

function mayContainHttpUrl(text: string): boolean {
  // Control stripping cannot create any character required by an HTTP scheme.
  return (
    (text.includes('h') || text.includes('H')) &&
    (text.includes('t') || text.includes('T')) &&
    (text.includes('p') || text.includes('P')) &&
    text.includes(':') &&
    text.includes('/')
  )
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

export function isUnspecifiedHost(hostname: string): boolean {
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

export function shouldReplace(existing: AdvertisedUrl, candidate: AdvertisedUrl): boolean {
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

export function isDefaultPort(protocol: 'http' | 'https', port: number): boolean {
  return (protocol === 'http' && port === 80) || (protocol === 'https' && port === 443)
}

export function formatHostForOrigin(url: URL): string {
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

export function observedListenersByPort(
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

export function scanStateChanged(previous: ListenerScanState, current: ListenerScanState): boolean {
  if (previous.kind !== current.kind) {
    return true
  }
  if (previous.kind === 'absent' || current.kind === 'absent') {
    return false
  }
  return previous.pid !== undefined && current.pid !== undefined && previous.pid !== current.pid
}

export function dedupeChangeEvents(
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
