// Bounds how many not-yet-authenticated connections one source may hold, so one host cannot fill the listener's global caps.
import type { Socket } from 'node:net'
import { classifyNetworkSource, networkSourceKey } from './network-source-class'

// Generous: desktop clients open one socket per subscription and may reconnect them together.
export const MAX_UNAUTHENTICATED_CONNECTIONS_PER_SOURCE = 64
const REFUSAL_LOG_INTERVAL_MS = 60 * 60_000

type TrackedSocket = { key: string; authenticated: boolean }

export class UnauthenticatedSourceCap {
  private readonly pending = new Map<string, number>()
  private readonly authenticated = new Map<string, number>()
  private readonly tracked = new WeakMap<Socket, TrackedSocket>()
  private lastRefusalLogAt = Number.NEGATIVE_INFINITY

  constructor(
    private readonly maxPerSource = MAX_UNAUTHENTICATED_CONNECTIONS_PER_SOURCE,
    private readonly now: () => number = Date.now,
    private readonly log: (message: string) => void = console.warn
  ) {}

  /** False when the caller must drop this freshly accepted socket. */
  admit(socket: Socket): boolean {
    const key = networkSourceKey(socket.remoteAddress)
    // Loopback is this machine (and SSH port-forwards); an address-less socket has already closed.
    if (key === null || classifyNetworkSource(socket.remoteAddress) === 'loopback') {
      return true
    }
    const pending = this.pending.get(key) ?? 0
    // A source already holding a credential-proven socket is a client, not a slot filler.
    if (pending >= this.maxPerSource && !this.authenticated.has(key)) {
      this.logRefusal(key)
      return false
    }
    this.pending.set(key, pending + 1)
    const entry: TrackedSocket = { key, authenticated: false }
    this.tracked.set(socket, entry)
    socket.once('close', () => this.release(entry))
    return true
  }

  noteAuthenticated(socket: Socket): void {
    const entry = this.tracked.get(socket)
    if (!entry || entry.authenticated) {
      return
    }
    entry.authenticated = true
    decrement(this.pending, entry.key)
    this.authenticated.set(entry.key, (this.authenticated.get(entry.key) ?? 0) + 1)
  }

  private release(entry: TrackedSocket): void {
    decrement(entry.authenticated ? this.authenticated : this.pending, entry.key)
  }

  private logRefusal(key: string): void {
    const now = this.now()
    if (now - this.lastRefusalLogAt < REFUSAL_LOG_INTERVAL_MS) {
      return
    }
    this.lastRefusalLogAt = now
    this.log(
      `[ws-transport] Refusing connections from ${key}: it already holds ${this.maxPerSource} that have not authenticated. Further refusals this hour are not logged.`
    )
  }
}

function decrement(counts: Map<string, number>, key: string): void {
  const next = (counts.get(key) ?? 0) - 1
  if (next > 0) {
    counts.set(key, next)
  } else {
    counts.delete(key)
  }
}
