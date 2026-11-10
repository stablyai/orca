import type pg from 'pg'

// A floor above healthy US round trips (1.7-4.5 ms medians); the 10-26 director stalls held one connection at 52-59 ms.
export const SLOW_CONNECTION_MEDIAN_MS = 25
// Relative to the pool's other connections, so a far region's round trip, a slow database, event-loop
// lag or a lock convoy (which slow every connection alike) never retire anything.
export const SLOW_CONNECTION_PEER_RATIO = 3
// Enough statements that one lock wait or slow plan cannot retire a healthy connection.
export const SLOW_CONNECTION_WINDOW = 16
// A peer is judged on its latest samples this many; fewer make its median noise.
export const SLOW_CONNECTION_PEER_MIN_SAMPLES = 8
// pg-pool reuses the last-released client, so peers often sit idle through a stall: their latest
// samples may predate the slow window by seconds (10-26 replay: up to ~30 s).
// Trade-off: at a database-wide slowdown onset with idle peers, up to 3 retirements per pool (one per
// 10 s while the idle peers' fast samples stay inside this slack), then none.
export const SLOW_CONNECTION_PEER_SLACK_MS = 30_000
// Older samples describe a connection that may have recovered since.
export const SLOW_CONNECTION_SAMPLE_MAX_AGE_MS = 60_000
// Per pool: bounds reconnects if the rule ever misfires.
export const SLOW_CONNECTION_RETIRE_INTERVAL_MS = 10_000
// The tail shape (10-26 14:58 and 15:24): a normal median but statements of ~200/400/800 ms, the
// doubling of TCP retransmit backoff on one connection's path. Judged on the Nth-slowest statement
// of the last minute (about p99 at director rates); a 16-statement p99 would be its single maximum.
export const SLOW_CONNECTION_TAIL_RANK = 3
export const SLOW_CONNECTION_TAIL_MS = 200
export const SLOW_CONNECTION_TAIL_PEER_RATIO = 5
// Fewer statements than this leave a peer's tail unmeasured.
export const SLOW_CONNECTION_TAIL_PEER_MIN_SAMPLES = 32
// Bounds memory at director rates (~20 statements/s) over the 60 s window.
const MAX_SAMPLES_PER_CONNECTION = 4_096

type Sample = { ms: number; at: number }

const recentStatements = new WeakMap<pg.PoolClient, Sample[]>()

// Records only clients a retiring pool has tracked, so pools without retirement keep no samples.
export function noteConnectionStatement(client: pg.PoolClient, durationMs: number): void {
  const samples = recentStatements.get(client)
  if (!samples) {
    return
  }
  const sample = { ms: durationMs, at: Date.now() }
  samples.push(sample)
  while (
    samples.length > MAX_SAMPLES_PER_CONNECTION ||
    (samples[0] && sample.at - samples[0].at > SLOW_CONNECTION_SAMPLE_MAX_AGE_MS)
  ) {
    samples.shift()
  }
}

// Lower median: with an even window, one long statement still cannot lift it.
function median(values: number[]): number {
  return [...values].sort((a, b) => a - b)[(values.length - 1) >> 1] ?? 0
}

function tail(samples: Sample[]): number {
  return [...samples].sort((a, b) => b.ms - a.ms)[SLOW_CONNECTION_TAIL_RANK - 1]?.ms ?? 0
}

const rounded = (ms: number) => Math.round(ms * 1_000) / 1_000

// pg-pool reuses the most recently released client, so a slow connection that stays busy is never
// idle long enough to close; it keeps serving every ask until something destroys it.
export class SlowConnectionRetirement {
  private lastRetiredAt = Number.NEGATIVE_INFINITY
  // Clients this pool has released; entries leave once their samples go stale.
  private readonly clients = new Set<pg.PoolClient>()

  constructor(private readonly now: () => number = Date.now) {}

  get trackedClients(): number {
    return this.clients.size
  }

  track(client: pg.PoolClient): void {
    if (!recentStatements.has(client)) {
      recentStatements.set(client, [])
    }
  }

  forget(client: pg.PoolClient): void {
    this.clients.delete(client)
    recentStatements.delete(client)
  }

  // True when the caller should destroy the client instead of returning it to the pool.
  shouldRetire(client: pg.PoolClient, connectionId: number): boolean {
    this.clients.add(client)
    const now = this.now()
    const oldest = now - SLOW_CONNECTION_SAMPLE_MAX_AGE_MS
    const since = (candidate: pg.PoolClient, from: number): Sample[] =>
      (recentStatements.get(candidate) ?? []).filter((sample) => sample.at >= from)
    // Pruned before any early return: pg-pool closes idle clients without telling this class.
    for (const tracked of this.clients) {
      if (since(tracked, oldest).length === 0) {
        this.clients.delete(tracked)
      }
    }
    const fresh = since(client, oldest)
    const own = fresh.slice(-SLOW_CONNECTION_WINDOW)
    if (own.length < SLOW_CONNECTION_WINDOW) {
      return false
    }
    const peers = [...this.clients].filter((peer) => peer !== client)
    // Each peer's latest samples, close enough to this window that a slowdown reaching every
    // connection shows in them too.
    const peerSamples = (start: number) =>
      peers.map((peer) => since(peer, Math.max(oldest, start - SLOW_CONNECTION_PEER_SLACK_MS)))
    const peerMedians = peerSamples(own[0]?.at ?? now)
      .map((samples) => samples.slice(-SLOW_CONNECTION_PEER_MIN_SAMPLES))
      .filter((samples) => samples.length === SLOW_CONNECTION_PEER_MIN_SAMPLES)
      .map((samples) => median(samples.map((sample) => sample.ms)))
    // Each peer's single slowest statement; the bar is the slowest of them all, so if any peer saw
    // a statement that slow, the tail is not this connection's alone.
    const peerTails = peerSamples(fresh[0]?.at ?? now)
      .filter((samples) => samples.length >= SLOW_CONNECTION_TAIL_PEER_MIN_SAMPLES)
      .map((samples) => Math.max(...samples.map((sample) => sample.ms)))
    const medianMs = median(own.map((sample) => sample.ms))
    const peerMedianMs = median(peerMedians)
    const tailMs = tail(fresh)
    const peerTailMs = Math.max(0, ...peerTails)
    const slowMedian =
      peerMedians.length > 0 &&
      medianMs > SLOW_CONNECTION_MEDIAN_MS &&
      medianMs >= peerMedianMs * SLOW_CONNECTION_PEER_RATIO
    const slowTail =
      peerTails.length > 0 &&
      tailMs > SLOW_CONNECTION_TAIL_MS &&
      tailMs >= peerTailMs * SLOW_CONNECTION_TAIL_PEER_RATIO
    if (!slowMedian && !slowTail) {
      return false
    }
    if (now - this.lastRetiredAt < SLOW_CONNECTION_RETIRE_INTERVAL_MS) {
      return false
    }
    this.lastRetiredAt = now
    this.forget(client)
    // Cloud Run labels each line with its instance, so retirements count per instance.
    console.warn(
      JSON.stringify({
        event: 'orca_relay_postgres_slow_connection_retired',
        connectionId,
        shape: slowMedian ? 'median' : 'tail',
        medianMs: rounded(medianMs),
        peerMedianMs: rounded(peerMedianMs),
        tailMs: rounded(tailMs),
        peerTailMs: rounded(peerTailMs),
        statements: fresh.length
      })
    )
    return true
  }
}
