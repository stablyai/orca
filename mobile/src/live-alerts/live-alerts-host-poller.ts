import type { RpcClient } from '../transport/rpc-client'
import type { Worktree } from '../worktree/workspace-list-types'

/** A read older than this by wall clock is abandoned; requests can hang while JS timers pause. */
export const POLL_STALL_MS = 15_000
/** Rows older than this are not trusted to describe the agents. */
export const STALE_AFTER_MS = 30_000
/** Hosts gone from the client list are kept this long, past the session's disconnect window. */
export const FORGET_UNLISTED_MS = 120_000
// Ticks arrive about every 3 s from two sources; allow some jitter before a host counts as due.
const DUE_TOLERANCE_MS = 500

/** Reads a host's worktree catalog; null when the read failed or returned nothing usable. */
export type FetchHostRows = (
  client: RpcClient,
  hostId: string
) => Promise<readonly Worktree[] | null>

export type HostFreshness = 'fresh' | 'pending' | 'stale'

export type LiveHostSnapshot = {
  hostId: string
  worktrees: readonly Worktree[]
  lastSuccessAt: number
  freshness: HostFreshness
}

export type HostPollerClient = { hostId: string; client: RpcClient }

type HostRecord = {
  worktrees: readonly Worktree[] | null
  lastSuccessAt: number | null
  lastFailureAt: number | null
  lastAttemptAt: number | null
  inFlightSince: number | null
  generation: number
}

type HostPollerDeps = {
  fetchRows: FetchHostRows
  now: () => number
  /** Called after every finished read, so the notification can follow at once. */
  onUpdate: () => void
}

function readInFlight(record: HostRecord, now: number): boolean {
  return record.inFlightSince !== null && now - record.inFlightSince < POLL_STALL_MS
}

function isDue(record: HostRecord, now: number, intervalMs: number): boolean {
  const last = record.lastAttemptAt
  return last === null || now - last >= intervalMs - DUE_TOLERANCE_MS
}

function freshnessOf(record: HostRecord, lastSuccessAt: number, now: number): HostFreshness {
  if (now - lastSuccessAt <= STALE_AFTER_MS) {
    return 'fresh'
  }
  // After the screen was off, the first read is in flight: old rows stand in, but only briefly.
  const failedSince = record.lastFailureAt !== null && record.lastFailureAt > lastSuccessAt
  return readInFlight(record, now) && !failedSince ? 'pending' : 'stale'
}

/**
 * Polls `worktree.ps` on each connected host the app already holds. It never opens or keeps a
 * connection of its own, so connection ownership stays with the screens.
 */
export class LiveAlertsHostPoller {
  private readonly hosts = new Map<string, HostRecord>()

  constructor(private readonly deps: HostPollerDeps) {}

  /** Starts a read on every listed, connected host whose interval passed; null pauses polling. */
  poll(
    clients: readonly HostPollerClient[],
    isConnected: (hostId: string) => boolean,
    intervalMs: number | null
  ): void {
    const now = this.deps.now()
    const listed = new Set<string>()
    for (const { hostId, client } of clients) {
      listed.add(hostId)
      if (intervalMs === null || !isConnected(hostId)) {
        continue
      }
      const record = this.hosts.get(hostId) ?? this.addHost(hostId)
      if (!readInFlight(record, now) && isDue(record, now, intervalMs)) {
        this.start(hostId, record, client, now)
      }
    }
    for (const [hostId, record] of this.hosts) {
      const lastSeen = record.lastSuccessAt ?? record.lastAttemptAt ?? now
      if (!listed.has(hostId) && now - lastSeen > FORGET_UNLISTED_MS) {
        this.hosts.delete(hostId)
      }
    }
  }

  /** The last good rows of every host that answered at least once, with their freshness. */
  snapshots(): LiveHostSnapshot[] {
    const now = this.deps.now()
    const snapshots: LiveHostSnapshot[] = []
    for (const [hostId, record] of this.hosts) {
      if (record.worktrees && record.lastSuccessAt !== null) {
        snapshots.push({
          hostId,
          worktrees: record.worktrees,
          lastSuccessAt: record.lastSuccessAt,
          freshness: freshnessOf(record, record.lastSuccessAt, now)
        })
      }
    }
    return snapshots
  }

  private addHost(hostId: string): HostRecord {
    const record: HostRecord = {
      worktrees: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastAttemptAt: null,
      inFlightSince: null,
      generation: 0
    }
    this.hosts.set(hostId, record)
    return record
  }

  private start(hostId: string, record: HostRecord, client: RpcClient, now: number): void {
    // A stalled read is abandoned: its late reply is ignored by generation.
    record.generation += 1
    const generation = record.generation
    record.inFlightSince = now
    record.lastAttemptAt = now
    void this.deps.fetchRows(client, hostId).then(
      (rows) => this.settle(hostId, generation, rows),
      () => this.settle(hostId, generation, null)
    )
  }

  private settle(hostId: string, generation: number, rows: readonly Worktree[] | null): void {
    const record = this.hosts.get(hostId)
    if (!record || record.generation !== generation) {
      return
    }
    const now = this.deps.now()
    record.inFlightSince = null
    if (rows) {
      record.worktrees = rows
      record.lastSuccessAt = now
    } else {
      record.lastFailureAt = now
    }
    this.deps.onUpdate()
  }
}
