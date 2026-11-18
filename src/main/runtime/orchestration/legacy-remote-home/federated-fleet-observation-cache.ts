// Execution-host verdicts for federated workers, read for bot and chat views that re-read on every
// notice: each Dispatch's last answer is kept, so a read waits on its host only the first time, and
// each paired server is asked one batch at a time however many views read at once.
import type { OrchestrationDb } from '../db/orchestration-db'
import type { FederatedDispatchRow } from '../db/orchestration-records'
import {
  FLEET_HOST_CONCURRENCY,
  FLEET_HOST_TIMEOUT_MS,
  readFederatedFleetSnapshots,
  type FederatedFleetRuntime,
  type FederatedFleetHostError,
  type FederatedFleetObservation
} from './federated-fleet-snapshot'

/** How long an answer stands before the next read refreshes it in the background. */
export const FEDERATED_OBSERVATION_FRESH_MS = 10_000
/** A settled worker is read no more, so its last answer would stay forever. */
const FORGET_AFTER_MS = 10 * 60_000

type FederatedSnapshots = Awaited<ReturnType<typeof readFederatedFleetSnapshots>>

type Entry = {
  at: number
  observation: FederatedFleetObservation | undefined
  error: Omit<FederatedFleetHostError, 'dispatchIds'> | undefined
  homeAutoReleaseAt: string | undefined
}

/** One paired server's reads: the batch being asked, and the ids waiting for the next one. */
type HostLane = {
  environmentId: string
  name: string
  asking: { ids: ReadonlySet<string>; done: Promise<void> } | null
  /** Its read outlived the deadline and gave up its slot; its call has not settled yet. */
  overdue: boolean
  queued: Set<string>
  queuedDone: { promise: Promise<void>; resolve: () => void } | null
}

type Cache = {
  entries: Map<string, Entry>
  lanes: Map<string, HostLane>
  /** Reads in flight across every server, at most FLEET_HOST_CONCURRENCY. */
  active: number
  /** Servers with ids queued, waiting for a free read, first come first served. */
  waiting: string[]
}

// Keyed by the database, which every runtime view of this machine shares.
const caches = new WeakMap<OrchestrationDb, Cache>()

function cacheOf(db: OrchestrationDb): Cache {
  let cache = caches.get(db)
  if (!cache) {
    cache = { entries: new Map(), lanes: new Map(), active: 0, waiting: [] }
    caches.set(db, cache)
  }
  return cache
}

function laneKey(row: FederatedDispatchRow): string {
  return `${row.environment_id}\u0000${row.peer_fingerprint}`
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

/** Queues these ids on their servers' lanes; resolves once each has been asked. */
function ask(
  runtime: FederatedFleetRuntime,
  db: OrchestrationDb,
  cache: Cache,
  rows: readonly FederatedDispatchRow[]
): Promise<void> {
  const waits = new Set<Promise<void>>()
  for (const row of rows) {
    const key = laneKey(row)
    let lane = cache.lanes.get(key)
    if (!lane) {
      lane = {
        environmentId: row.environment_id,
        name: row.environment_name,
        asking: null,
        overdue: false,
        queued: new Set(),
        queuedDone: null
      }
      cache.lanes.set(key, lane)
    }
    if (lane.overdue) {
      // Its server has not answered the last read; asking again would only queue behind it.
      if (!cache.entries.has(row.dispatch_id)) {
        rememberUnanswered(db, cache, lane, [row.dispatch_id])
      }
      continue
    }
    if (lane.asking?.ids.has(row.dispatch_id)) {
      waits.add(lane.asking.done)
      continue
    }
    lane.queued.add(row.dispatch_id)
    lane.queuedDone ??= deferred()
    waits.add(lane.queuedDone.promise)
    if (!lane.asking && !cache.waiting.includes(key)) {
      cache.waiting.push(key)
    }
  }
  // After queueing every id, so one read carries all of a server's ids.
  pump(runtime, db, cache)
  return Promise.all(waits).then(() => undefined)
}

/** Starts the waiting servers' reads, oldest first, while the runtime-wide cap allows. */
function pump(runtime: FederatedFleetRuntime, db: OrchestrationDb, cache: Cache): void {
  while (cache.active < FLEET_HOST_CONCURRENCY && cache.waiting.length > 0) {
    const key = cache.waiting.shift()!
    const lane = cache.lanes.get(key)
    if (lane && !lane.asking) {
      read(runtime, db, cache, key, lane)
    }
  }
}

/** Asks the server for everything queued on its lane; what queues meanwhile waits its turn again. */
function read(
  runtime: FederatedFleetRuntime,
  db: OrchestrationDb,
  cache: Cache,
  key: string,
  lane: HostLane
): void {
  if (lane.queued.size === 0 || !lane.queuedDone) {
    cache.lanes.delete(key)
    return
  }
  const ids = lane.queued
  const finished = lane.queuedDone
  lane.queued = new Set()
  lane.queuedDone = null
  lane.asking = { ids, done: finished.promise }
  cache.active += 1
  let released = false
  const release = (): void => {
    if (!released) {
      released = true
      cache.active -= 1
      finished.resolve()
    }
  }
  // The slot is the deadline's, not the transport's: a server stuck behind its own queue gives
  // the slot back on time, its ids read as unanswered, and its late answer is dropped.
  const deadline = setTimeout(() => {
    lane.overdue = true
    rememberUnanswered(db, cache, lane, [...ids])
    release()
    pump(runtime, db, cache)
  }, FLEET_HOST_TIMEOUT_MS)
  void readFederatedFleetSnapshots({ runtime, db, dispatchIds: [...ids] })
    .then((snapshots) => {
      if (!lane.overdue) {
        remember(db, cache, [...ids], snapshots)
      }
    })
    .catch(() => undefined)
    .finally(() => {
      clearTimeout(deadline)
      lane.asking = null
      lane.overdue = false
      release()
      if (lane.queued.size > 0) {
        cache.waiting.push(key)
      } else {
        cache.lanes.delete(key)
      }
      pump(runtime, db, cache)
    })
}

/** These ids' server did not answer in time. */
function rememberUnanswered(
  db: OrchestrationDb,
  cache: Cache,
  lane: HostLane,
  dispatchIds: string[]
): void {
  remember(db, cache, dispatchIds, {
    observations: new Map(),
    hosts: new Map(),
    homeAutoReleases: new Map(),
    errors: [
      {
        environmentId: lane.environmentId,
        name: lane.name,
        code: 'host_unavailable',
        dispatchIds
      }
    ]
  })
}

function entryKey(entry: Entry): string {
  return JSON.stringify([entry.observation ?? null, entry.error ?? null])
}

/** Keeps each answer; one that changes what a view already drew is announced, so it re-reads. */
function remember(
  db: OrchestrationDb,
  cache: Cache,
  dispatchIds: readonly string[],
  snapshots: FederatedSnapshots
): void {
  const at = Date.now()
  const changed: string[] = []
  for (const id of dispatchIds) {
    const error = snapshots.errors.find((each) => each.dispatchIds.includes(id))
    const before = cache.entries.get(id)
    const next: Entry = {
      at,
      observation: snapshots.observations.get(id),
      error: error
        ? { environmentId: error.environmentId, name: error.name, code: error.code }
        : undefined,
      homeAutoReleaseAt: snapshots.homeAutoReleases.get(id)
    }
    cache.entries.set(id, next)
    if (before && entryKey(before) !== entryKey(next)) {
      changed.push(id)
    }
  }
  if (changed.length > 0) {
    db.federatedWorkersListener?.(changed)
  }
}

function forgetOld(cache: Cache, now: number): void {
  for (const [id, entry] of cache.entries) {
    if (now - entry.at >= FORGET_AFTER_MS) {
      cache.entries.delete(id)
    }
  }
}

function snapshotsOf(
  cache: Cache,
  rows: readonly FederatedDispatchRow[],
  observed: ReadonlySet<string>
): FederatedSnapshots {
  const observations = new Map<string, FederatedFleetObservation>()
  const hosts = new Map<string, string>()
  const homeAutoReleases = new Map<string, string>()
  const errors = new Map<string, FederatedFleetHostError>()
  for (const row of rows) {
    const id = row.dispatch_id
    hosts.set(id, row.environment_id)
    const entry = observed.has(id) ? cache.entries.get(id) : undefined
    if (!entry) {
      continue
    }
    if (entry.observation) {
      observations.set(id, entry.observation)
    }
    if (entry.homeAutoReleaseAt) {
      homeAutoReleases.set(id, entry.homeAutoReleaseAt)
    }
    if (entry.error) {
      const key = `${entry.error.environmentId}\u0000${entry.error.code}`
      const grouped = errors.get(key) ?? { ...entry.error, dispatchIds: [] }
      grouped.dispatchIds.push(id)
      errors.set(key, grouped)
    }
  }
  return { observations, hosts, homeAutoReleases, errors: [...errors.values()] }
}

/**
 * Each federated Dispatch's server, and its host's verdict for the open ones; null when none is
 * federated, so a local-only read never leaves this machine. A Dispatch no read has asked about yet
 * waits on its host (within the snapshot's own budget); a stale answer is returned while a fresh one
 * loads, and a fresh one that differs is announced through `federatedWorkersListener`.
 */
export async function readCachedFederatedFleetSnapshots(args: {
  runtime: FederatedFleetRuntime
  db: OrchestrationDb
  dispatchIds: readonly string[]
  /** The ones still open; a settled worker's host has nothing left to say. */
  isOpen: (dispatchId: string) => boolean
}): Promise<FederatedSnapshots | null> {
  const { runtime, db } = args
  const rows =
    args.dispatchIds.length > 0 ? db.listFederatedDispatchesByIds([...args.dispatchIds]) : []
  if (rows.length === 0) {
    return null
  }
  const cache = cacheOf(db)
  const now = Date.now()
  forgetOld(cache, now)
  const open = rows.filter((row) => args.isOpen(row.dispatch_id))
  const unknown = open.filter((row) => !cache.entries.has(row.dispatch_id))
  const stale = open.filter((row) => {
    const entry = cache.entries.get(row.dispatch_id)
    return entry !== undefined && now - entry.at >= FEDERATED_OBSERVATION_FRESH_MS
  })
  if (stale.length > 0) {
    void ask(runtime, db, cache, stale)
  }
  if (unknown.length > 0) {
    await ask(runtime, db, cache, unknown)
  }
  return snapshotsOf(cache, rows, new Set(open.map((row) => row.dispatch_id)))
}
