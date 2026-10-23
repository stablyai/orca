// Refuses peers that keep opening runtime WebSocket connections that never authenticate.
import { isIP } from 'node:net'
import { isLoopbackClientAddress } from './ws-client-address-policy'

const DEFAULT_MAX_FAILURES = 20
const DEFAULT_WINDOW_MS = 5 * 60_000
const DEFAULT_BLOCK_MS = 15 * 60_000
// Why: an attacker rotating addresses must not grow these maps without bound.
const MAX_TRACKED_SOURCES = 10_000

export type UnauthenticatedClientLockoutOptions = {
  maxFailures?: number
  windowMs?: number
  blockMs?: number
  now?: () => number
}

/**
 * Counts connections that closed before the E2EE handshake bound a device. Paired clients
 * never count, so a phone reconnecting on a flaky network is not locked out.
 */
export class UnauthenticatedClientLockout {
  private readonly maxFailures: number
  private readonly windowMs: number
  private readonly blockMs: number
  private readonly now: () => number
  private readonly failures = new Map<string, number[]>()
  private readonly blockedUntil = new Map<string, number>()

  constructor(options: UnauthenticatedClientLockoutOptions = {}) {
    this.maxFailures = options.maxFailures ?? DEFAULT_MAX_FAILURES
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS
    this.blockMs = options.blockMs ?? DEFAULT_BLOCK_MS
    this.now = options.now ?? Date.now
  }

  recordFailure(address: string): void {
    if (isLoopbackClientAddress(address)) {
      return
    }
    const source = lockoutSource(address)
    const now = this.now()
    const recent = (this.failures.get(source) ?? []).filter((at) => now - at < this.windowMs)
    recent.push(now)
    this.failures.delete(source)
    if (recent.length < this.maxFailures) {
      this.failures.set(source, recent)
      evictOldest(this.failures)
      return
    }
    this.blockedUntil.delete(source)
    this.blockedUntil.set(source, now + this.blockMs)
    evictOldest(this.blockedUntil)
    console.warn(
      `[ws-transport] refusing connections from ${source} for ${Math.round(this.blockMs / 60_000)} min after ${recent.length} unauthenticated attempts`
    )
  }

  isBlocked(address: string): boolean {
    const source = lockoutSource(address)
    const until = this.blockedUntil.get(source)
    if (until === undefined) {
      return false
    }
    if (this.now() >= until) {
      this.blockedUntil.delete(source)
      return false
    }
    return true
  }
}

/** Why /64 for IPv6: one subscriber usually holds a whole /64, so per-address counting is free to evade. */
export function lockoutSource(address: string): string {
  if (isIP(address) !== 6) {
    return address
  }
  return `${expandIpv6(address).slice(0, 4).join(':')}::/64`
}

function expandIpv6(address: string): string[] {
  const [head = '', tail] = address.split('::')
  const headGroups = head ? head.split(':') : []
  const tailGroups = tail ? tail.split(':') : []
  const missing = tail === undefined ? 0 : 8 - headGroups.length - tailGroups.length
  return [...headGroups, ...Array<string>(missing).fill('0'), ...tailGroups].map((group) =>
    (Number.parseInt(group, 16) || 0).toString(16)
  )
}

function evictOldest(map: Map<string, unknown>): void {
  while (map.size > MAX_TRACKED_SOURCES) {
    const oldest = map.keys().next().value
    if (oldest === undefined) {
      return
    }
    map.delete(oldest)
  }
}
