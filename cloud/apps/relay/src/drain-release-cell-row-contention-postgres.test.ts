import { createHash } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { RelayAssignmentRowBusyError, RelayAssignmentStore } from './assignment-store.js'
import {
  encodeMembership,
  type CellAdmissionMembership,
  type CellAdmissionState
} from './cell-admission-selector.js'
import type { RelayCellConfig } from './config.js'
import {
  consumeRelayCellInventoryHold,
  consumeRelayDatabasePoolPressure,
  openRelayDatabase,
  type RelayDatabase
} from './database.js'
import { RelayPublicAssignmentAdmission } from './public-assignment-admission.js'
import {
  openDelayedPostgresDatabase,
  type StatementDelay
} from './test-fixtures/delayed-postgres-database.js'

// Reproduces the Asia drain: a draining cell's releases each end with a one-row
// UPDATE of the source relay_cells row, held for a round trip to COMMIT, while
// the directors re-place its reconnecting hosts. Placement used to lock every
// relay_cells row and starved (about 9/s at 6 releases/s, 5/s at 18/s, every
// director backend lock-waiting); it now locks only the targets. Prints one
// line per run and asserts the after picture.

const databaseUrl = process.env.ORCA_RELAY_TEST_POSTGRES_URL
const describePostgres = databaseUrl ? describe : describe.skip

// asia-east2 cell to the us-central1 database, measured in production.
const ASIA_ROUND_TRIP_MS = 171
const LOCAL_ROUND_TRIP_MS = 1
const WINDOW_MS = 10_000
// Reconnecting hosts dialling the directors during the window. Above the
// ~6-15/s the production tail sustained, so the director side is never idle.
const DIAL_RATE_PER_SECOND = 20
// Production shapes: five director instances (production.tfvars), each with
// the default pool and sticky lane (variables.tf, config.ts), and an Asia
// cell's pool (validate-relay-asia-topology-plan.mjs).
const DIRECTOR_INSTANCES = 5
const DIRECTOR_POOL_MAX = 3
const STICKY_LANE = { maxConcurrent: 1, maxQueued: 64, waitMs: 2_000, minIntervalMs: 2_000 }
const CELL_POOL_MAX = 16
const DIRECTOR_APPLICATION = 'drain-release-contention-director'

const USER_PREFIX = 'drain-release-contention'
const NOW = 1_000_000
const CAPPED = {
  capacityRequests: 6_000,
  connectionHardCap: 3_000,
  connectionUnobservedBound: 60
} as const
const SOURCE: RelayCellConfig = {
  id: 'drain-release-contention-a-source',
  url: 'https://drain-release-contention-source.example.test',
  region: 'asia-east2',
  ...CAPPED
}
const TARGETS: RelayCellConfig[] = ['b', 'c', 'd'].map((suffix) => ({
  id: `drain-release-contention-${suffix}-target`,
  url: `https://drain-release-contention-${suffix}-target.example.test`,
  region: 'asia-east2',
  ...CAPPED
}))
// Next to the database. Taken only once every Asia neighbour is at its cap.
const US_CELL: RelayCellConfig = {
  id: 'drain-release-contention-e-us',
  url: 'https://drain-release-contention-us.example.test',
  region: 'us-central1',
  ...CAPPED
}
const CELLS = [SOURCE, ...TARGETS, US_CELL]
const RELEASED_ACTIVITY = `control:${SOURCE.id}:1`

// The desktop client books each host's next /v1/assign 5-5.5s after its last
// one, whatever Retry-After says (src/main/runtime/relay/relay-assign-rate-gate.ts).
const HOST_ASSIGN_MIN_INTERVAL_MS = 5_000
const HOST_ASSIGN_INTERVAL_JITTER_MS = 500
// A host still unplaced this long after its release counts as never placed.
const REDIAL_GIVE_UP_MS = 30_000

type Identity = { userId: string; relayHostId: string }
type Tally = Record<string, number>
type Instance = { database: RelayDatabase; store: RelayAssignmentStore }

type RunReport = {
  roundTripMs: number
  releaseRate: number
  neighboursCapped: boolean
  releases: { attempted: number; ok: number; failed: Tally; p50Ms: number; p95Ms: number }
  dials: {
    attempted: number
    placed: number
    placedInWindow: number
    placedCrossRegion: number
    admissionRejected: Tally
    failed: Tally
  }
  activations: { ok: number; failed: Tally }
  placementsPerSecond: number
  director: {
    lockUnavailable: number
    lockTimeouts: number
    holds: number
    holdMsMax: number
    // Mean director backends blocked on a lock per 20ms sample, of those active.
    lockWaitingMean: number
    activeMean: number
  }
  sourcePoolWaitersMax: number
}

type DepartingReport = {
  dialDelayMs: number
  neighboursCapped: boolean
  hosts: number
  placed: number
  firstAttempt: { placed: number; rejected: Tally; failed: Tally }
  // Row-busy refusals on any attempt, and errors no client would retry.
  busyRefusals: number
  // Hosts refused more than once, for any reason, before being placed.
  hostsRefusedTwice: number
  unexpected: Tally
  redials: number
  // Release start to the grant that re-placed the host, redials included.
  timeToPlacedMs: { p50: number; p95: number; max: number }
  placementsPerSecond: number
  releases: { ok: number; failed: Tally }
  lockWaitingMean: number
  activeMean: number
}

function hostIdentity(index: number): Identity {
  return {
    userId: `${USER_PREFIX}-${index}`,
    // Relay host ids are fixed-width opaque ids.
    relayHostId: `drainrel${String(index).padStart(8, '0')}`
  }
}

function failureCode(error: unknown): string {
  if (error instanceof Error) {
    const code = 'code' in error ? error.code : undefined
    return typeof code === 'string' ? code : error.message
  }
  return String(error)
}

function count(tally: Tally, key: string): void {
  tally[key] = (tally[key] ?? 0) + 1
}

function total(tally: Tally): number {
  return Object.values(tally).reduce((sum, value) => sum + value, 0)
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))]!)
}

function mean(sum: number, samples: number): number {
  return samples === 0 ? 0 : Number((sum / samples).toFixed(2))
}

// Fires `operation` at a fixed rate without awaiting it, like independent
// socket closes or dials would.
async function paced<T>(
  ratePerSecond: number,
  total: number,
  operation: (index: number) => Promise<T>
): Promise<Promise<T>[]> {
  const startedAt = performance.now()
  const started: Promise<T>[] = []
  for (let index = 0; index < total; index += 1) {
    const dueMs = (index * 1_000) / ratePerSecond - (performance.now() - startedAt)
    if (dueMs > 0) await new Promise((resolve) => setTimeout(resolve, dueMs))
    started.push(operation(index))
  }
  return started
}

describePostgres('PostgreSQL drain releases against director placement', () => {
  const storeOptions = { requireLiveCells: true, heartbeatTtlMs: 45_000 }
  // One switch for every Asia pool: the source cell and each target cell.
  const delay: StatementDelay = { enabled: false, delayMs: LOCAL_ROUND_TRIP_MS }
  const directors: Instance[] = []
  const servingCells = new Map<string, Instance>()
  let observer: RelayDatabase
  const reports: RunReport[] = []
  const departingReports: DepartingReport[] = []

  function admin(): Instance {
    return directors[0]!
  }

  function servingCell(cellId: string): Instance {
    const instance = servingCells.get(cellId)
    if (!instance) throw new Error(`no cell pool for ${cellId}`)
    return instance
  }

  async function applySelector(
    states: Record<string, CellAdmissionState>,
    rollIsolatedCells?: string[]
  ): Promise<void> {
    const current = await admin().store.inspectCellAdmissionSelector()
    // Built from relay_cells: the apply requires exact coverage of a shared fleet.
    const fleet = await admin().database.query(
      `SELECT cell_id FROM relay_cells ORDER BY cell_id ASC`
    )
    const membership: CellAdmissionMembership = {
      existingOnly: [],
      migrationOnly: [],
      general: []
    }
    for (const row of fleet) {
      const cellId = String(row['cell_id'])
      const state =
        states[cellId] ??
        (current.selector.membership.existingOnly.includes(cellId)
          ? 'existing-only'
          : current.selector.membership.migrationOnly.includes(cellId)
            ? 'migration-only'
            : 'general')
      if (state === 'existing-only') membership.existingOnly.push(cellId)
      else if (state === 'migration-only') membership.migrationOnly.push(cellId)
      else membership.general.push(cellId)
    }
    await admin().store.applyCellAdmissionSelector({
      attemptId: `drain-release-${current.selector.generation}`,
      expectedGeneration: current.selector.generation,
      ...(current.selector.generation === 0
        ? {
            expectedMembershipSha256: createHash('sha256')
              .update(encodeMembership(current.selector.membership))
              .digest('hex')
          }
        : {}),
      membership,
      ...(rollIsolatedCells ? { rollIsolatedCells } : {})
    })
  }

  // Other Postgres files write admission through the generation-0 helpers, so
  // the selector goes back to generation 0 exactly as found.
  async function resetSelectorBoundary(): Promise<void> {
    await admin().database.query(
      `UPDATE relay_admission_selectors SET generation = 0, attempt_id = NULL
       WHERE selector_id = 'general'`
    )
    await admin().database.query(
      `DELETE FROM relay_admission_selector_intents WHERE attempt_id LIKE 'drain-release-%'`
    )
    await admin().store.reconcileCells([], false)
  }

  async function deleteHostRows(): Promise<void> {
    for (const table of [
      'relay_control_capabilities',
      'relay_control_connection_reservations',
      'relay_assignment_activity_leases',
      'relay_assignment_migrations',
      'relay_assignment_region_preferences',
      'relay_assignments'
    ]) {
      await admin().database.query(`DELETE FROM ${table} WHERE user_id LIKE '${USER_PREFIX}-%'`)
    }
  }

  // `atCap` reports those cells at their connection cap: no headroom left.
  async function heartbeatAll(atCap: RelayCellConfig[] = []): Promise<void> {
    for (const [index, config] of CELLS.entries()) {
      await admin().store.recordCellHeartbeat({
        cellId: config.id,
        cellUrl: config.url,
        cellIncarnation: `2222222${index}-2222-4222-8222-222222222222`,
        startedAt: NOW - 1_000,
        ready: true,
        observedRequests: 0,
        region: config.region,
        // The cell checks enforced = total + in-flight + reserved.
        totalConnections: atCap.includes(config) ? CAPPED.connectionHardCap : 0,
        inFlightConnections: 0,
        reservedConnectionUnits: 0,
        enforcedConnectionUnits: atCap.includes(config) ? CAPPED.connectionHardCap : 0,
        connectionHardCap: CAPPED.connectionHardCap,
        connectionUnobservedBound: CAPPED.connectionUnobservedBound
      })
    }
  }

  // Every host holds a live control lease on the source, then the source is
  // isolated for a roll: the state an Asia drain starts from.
  async function seed(hosts: Identity[]): Promise<void> {
    await deleteHostRows()
    await admin().database.query(
      `UPDATE relay_cells SET reserved_requests = 0 WHERE cell_id LIKE '${USER_PREFIX}-%'`
    )
    // Restoring the source to general also clears the previous run's roll stamp.
    await applySelector({
      [SOURCE.id]: 'general',
      ...Object.fromEntries(TARGETS.map((target) => [target.id, 'migration-only' as const]))
    })
    for (const identity of hosts) {
      const grant = await admin().store.assign(identity, 'asia-east2', 'asia-east2')
      expect(grant.cellId).toBe(SOURCE.id)
      await admin().store.activateControl(identity, {
        cellId: SOURCE.id,
        assignmentEpoch: grant.assignmentEpoch,
        generation: 1
      })
    }
    await applySelector(
      Object.fromEntries(TARGETS.map((target) => [target.id, 'general' as const]))
    )
    await applySelector({ [SOURCE.id]: 'migration-only' }, [SOURCE.id])
  }

  // Samples director backends so the report shows where director time goes: a
  // failed or slow placement leaves no hold sample behind.
  function sampleDirectorWaits(): { stop: () => Promise<{ waiting: number; active: number }> } {
    let running = true
    let samples = 0
    let waiting = 0
    let active = 0
    const loop = (async () => {
      while (running) {
        const rows = await observer.query(
          `SELECT wait_event_type FROM pg_stat_activity
           WHERE application_name = ? AND state = 'active'`,
          [DIRECTOR_APPLICATION]
        )
        samples += 1
        active += rows.length
        waiting += rows.filter((row) => row['wait_event_type'] === 'Lock').length
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
    })()
    return {
      stop: async () => {
        running = false
        await loop
        return { waiting: mean(waiting, samples), active: mean(active, samples) }
      }
    }
  }

  async function run(
    roundTripMs: number,
    releaseRate: number,
    neighboursCapped = false
  ): Promise<RunReport> {
    const releaseCount = Math.round((releaseRate * WINDOW_MS) / 1_000)
    const dialCount = Math.round((DIAL_RATE_PER_SECOND * WINDOW_MS) / 1_000)
    const releasing = Array.from({ length: releaseCount }, (_, index) => hostIdentity(index))
    const dialling = Array.from({ length: dialCount }, (_, index) =>
      hostIdentity(releaseCount + index)
    )
    await seed([...releasing, ...dialling])
    if (neighboursCapped) await heartbeatAll(TARGETS)

    const releaseLatencies: number[] = []
    const releaseFailed: Tally = {}
    const releases = { attempted: 0, ok: 0, failed: releaseFailed }
    const admissionRejected: Tally = {}
    const dialFailed: Tally = {}
    const dials = {
      attempted: 0,
      placed: 0,
      placedInWindow: 0,
      placedCrossRegion: 0,
      admissionRejected,
      failed: dialFailed
    }
    const activationFailed: Tally = {}
    const activations = { ok: 0, failed: activationFailed }
    const activationWork: Promise<void>[] = []
    const stickyLanes = directors.map(() => new RelayPublicAssignmentAdmission(STICKY_LANE))
    for (const instance of directors) consumeRelayCellInventoryHold(instance.database)
    consumeRelayDatabasePoolPressure(servingCell(SOURCE.id).database)
    delay.delayMs = roundTripMs
    delay.enabled = true
    const sampler = sampleDirectorWaits()
    const startedAt = performance.now()

    const releaseWork = paced(releaseRate, releaseCount, async (index) => {
      releases.attempted += 1
      const began = performance.now()
      try {
        const released = await servingCell(SOURCE.id).store.releaseActivity(
          releasing[index]!,
          RELEASED_ACTIVITY
        )
        if (released) releases.ok += 1
        else count(releases.failed, 'lease_missing')
      } catch (error) {
        count(releases.failed, failureCode(error))
      }
      releaseLatencies.push(performance.now() - began)
    })
    // The reconnect path, round-robin over directors: sticky-lane admission,
    // the durable-pin check, then the assign the route calls, which re-places
    // off the isolated cell. The host then attaches to its new Asia cell.
    const dialWork = paced(DIAL_RATE_PER_SECOND, dialCount, async (index) => {
      const identity = dialling[index]!
      const director = directors[index % directors.length]!
      dials.attempted += 1
      let rejection = 'unknown'
      const lease = await stickyLanes[index % directors.length]!.acquire(
        identity.relayHostId,
        (reason) => {
          rejection = reason
        }
      )
      if (!lease) {
        count(dials.admissionRejected, rejection)
        return
      }
      try {
        if (!(await director.store.resolve(identity))) {
          count(dials.failed, 'unverified')
          return
        }
        const grant = await director.store.assign(identity, 'asia-east2', 'asia-east2')
        if (grant.cellId === SOURCE.id) {
          count(dials.failed, 'kept_on_source')
          return
        }
        dials.placed += 1
        if (grant.region !== SOURCE.region) dials.placedCrossRegion += 1
        if (performance.now() - startedAt <= WINDOW_MS) dials.placedInWindow += 1
        activationWork.push(
          servingCell(grant.cellId)
            .store.activateControl(identity, {
              cellId: grant.cellId,
              assignmentEpoch: grant.assignmentEpoch,
              generation: 1
            })
            .then(
              () => {
                activations.ok += 1
              },
              (error: unknown) => count(activations.failed, failureCode(error))
            )
        )
      } catch (error) {
        count(dials.failed, failureCode(error))
      } finally {
        lease.release()
      }
    })
    await Promise.allSettled([...(await releaseWork), ...(await dialWork)])
    await Promise.allSettled(activationWork)
    const waits = await sampler.stop()
    delay.enabled = false
    if (neighboursCapped) await heartbeatAll()

    const holds = directors.map((instance) => consumeRelayCellInventoryHold(instance.database))
    const report: RunReport = {
      roundTripMs,
      releaseRate,
      neighboursCapped,
      releases: {
        ...releases,
        p50Ms: percentile(releaseLatencies, 0.5),
        p95Ms: percentile(releaseLatencies, 0.95)
      },
      dials,
      activations,
      placementsPerSecond: Number(((dials.placedInWindow * 1_000) / WINDOW_MS).toFixed(1)),
      director: {
        lockUnavailable: holds.reduce((sum, hold) => sum + hold.cellInventoryLockUnavailable, 0),
        lockTimeouts: holds.reduce((sum, hold) => sum + hold.cellInventoryLockTimeouts, 0),
        holds: holds.reduce((sum, hold) => sum + hold.cellInventoryHolds, 0),
        holdMsMax: Math.round(Math.max(...holds.map((hold) => hold.cellInventoryHoldMsMax))),
        lockWaitingMean: waits.waiting,
        activeMean: waits.active
      },
      sourcePoolWaitersMax: consumeRelayDatabasePoolPressure(servingCell(SOURCE.id).database)
        .databasePoolWaitersMax
    }
    reports.push(report)
    console.info(JSON.stringify({ event: 'drain_release_cell_row_contention', ...report }))
    return report
  }

  // Production's shape: the host whose socket the draining cell closes is the
  // one that redials. Its release locks its own assignment row first and holds
  // it while queued on the source row, so its own placement can meet it.
  async function runDepartingRedial(
    dialDelayMs: number,
    neighboursCapped: boolean
  ): Promise<DepartingReport> {
    const releaseRate = 18
    const hosts = Array.from({ length: (releaseRate * WINDOW_MS) / 1_000 }, (_, index) =>
      hostIdentity(index)
    )
    await seed(hosts)
    if (neighboursCapped) await heartbeatAll(TARGETS)
    const stickyLanes = directors.map(() => new RelayPublicAssignmentAdmission(STICKY_LANE))
    const firstRejected: Tally = {}
    const firstFailed: Tally = {}
    const releaseFailed: Tally = {}
    const firstAttempt = { placed: 0, rejected: firstRejected, failed: firstFailed }
    const releases = { ok: 0, failed: releaseFailed }
    const timeToPlaced: number[] = []
    let redials = 0
    let busyRefusals = 0
    let hostsRefusedTwice = 0
    const unexpected: Tally = {}
    let placedInWindow = 0
    const activationWork: Promise<unknown>[] = []
    delay.delayMs = ASIA_ROUND_TRIP_MS
    delay.enabled = true
    const sampler = sampleDirectorWaits()
    const startedAt = performance.now()

    // One dial through the sticky lane; 'placed', or the reason it was not.
    async function dial(identity: Identity, director: number): Promise<string> {
      let rejection = 'unknown'
      const lease = await stickyLanes[director]!.acquire(identity.relayHostId, (reason) => {
        rejection = reason
      })
      if (!lease) return `rejected:${rejection}`
      try {
        if (!(await directors[director]!.store.resolve(identity))) return 'failed:unverified'
        const grant = await directors[director]!.store.assign(identity, 'asia-east2', 'asia-east2')
        if (grant.cellId === SOURCE.id) return 'failed:kept_on_source'
        activationWork.push(
          servingCell(grant.cellId)
            .store.activateControl(identity, {
              cellId: grant.cellId,
              assignmentEpoch: grant.assignmentEpoch,
              generation: 1
            })
            .catch(() => undefined)
        )
        return 'placed'
      } catch (error) {
        if (error instanceof RelayAssignmentRowBusyError) return `rejected:${error.message}`
        return `failed:${failureCode(error)}`
      } finally {
        lease.release()
      }
    }

    const work = paced(releaseRate, hosts.length, async (index) => {
      const identity = hosts[index]!
      const releasedAt = performance.now()
      const release = servingCell(SOURCE.id)
        .store.releaseActivity(identity, RELEASED_ACTIVITY)
        .then(
          (released) => {
            if (released) releases.ok += 1
            else count(releases.failed, 'lease_missing')
          },
          (error: unknown) => count(releases.failed, failureCode(error))
        )
      await new Promise((resolve) => setTimeout(resolve, dialDelayMs))
      const director = index % directors.length
      for (let attempt = 0; ; attempt += 1) {
        const sentAt = performance.now()
        const outcome = await dial(identity, director)
        if (outcome === `rejected:${new RelayAssignmentRowBusyError().message}`) busyRefusals += 1
        if (outcome.startsWith('failed:')) count(unexpected, outcome.slice(7))
        if (attempt === 0) {
          if (outcome === 'placed') firstAttempt.placed += 1
          else if (outcome.startsWith('rejected:')) count(firstRejected, outcome.slice(9))
          else count(firstFailed, outcome.slice(7))
        }
        if (outcome === 'placed') {
          const placedAt = performance.now()
          timeToPlaced.push(placedAt - releasedAt)
          if (placedAt - startedAt <= WINDOW_MS + dialDelayMs) placedInWindow += 1
          break
        }
        if (!outcome.startsWith('rejected:')) break
        if (attempt === 1) hostsRefusedTwice += 1
        const nextAt =
          sentAt +
          HOST_ASSIGN_MIN_INTERVAL_MS +
          Math.random() * HOST_ASSIGN_INTERVAL_JITTER_MS
        if (nextAt - releasedAt > REDIAL_GIVE_UP_MS) break
        redials += 1
        await new Promise((resolve) => setTimeout(resolve, nextAt - performance.now()))
      }
      await release
    })
    await Promise.allSettled(await work)
    await Promise.allSettled(activationWork)
    const waits = await sampler.stop()
    delay.enabled = false
    if (neighboursCapped) await heartbeatAll()
    const report: DepartingReport = {
      dialDelayMs,
      neighboursCapped,
      hosts: hosts.length,
      placed: timeToPlaced.length,
      firstAttempt,
      busyRefusals,
      hostsRefusedTwice,
      unexpected,
      redials,
      timeToPlacedMs: {
        p50: percentile(timeToPlaced, 0.5),
        p95: percentile(timeToPlaced, 0.95),
        max: percentile(timeToPlaced, 1)
      },
      placementsPerSecond: Number(((placedInWindow * 1_000) / WINDOW_MS).toFixed(1)),
      releases,
      lockWaitingMean: waits.waiting,
      activeMean: waits.active
    }
    departingReports.push(report)
    console.info(JSON.stringify({ event: 'drain_departing_host_redial', ...report }))
    return report
  }

  beforeAll(async () => {
    for (let index = 0; index < DIRECTOR_INSTANCES; index += 1) {
      const database = await openRelayDatabase({
        databaseUrl,
        dataDir: '',
        poolMax: DIRECTOR_POOL_MAX,
        applicationName: DIRECTOR_APPLICATION
      })
      directors.push({
        database,
        store: new RelayAssignmentStore(database, () => NOW, storeOptions)
      })
    }
    for (const config of CELLS) {
      const database = openDelayedPostgresDatabase(
        databaseUrl!,
        config === US_CELL ? { enabled: false, delayMs: 0 } : delay,
        CELL_POOL_MAX
      )
      servingCells.set(config.id, {
        database,
        store: new RelayAssignmentStore(database, () => NOW, storeOptions)
      })
    }
    observer = await openRelayDatabase({ databaseUrl, dataDir: '', poolMax: 1 })
    await deleteHostRows()
    await admin().store.reconcileCells(CELLS, false)
    await resetSelectorBoundary()
    await heartbeatAll()
  })

  afterAll(async () => {
    delay.enabled = false
    if (reports.length > 0) console.table(reports.map(flattenReport))
    if (departingReports.length > 0) console.table(departingReports.map(flattenDeparting))
    if (directors.length > 0) {
      await deleteHostRows()
      // Cells before the selector rebuild, or its membership names missing rows.
      for (const config of CELLS) {
        for (const table of [
          'relay_cell_connection_snapshots',
          'relay_cell_connection_runtime',
          'relay_cell_connection_limits',
          'relay_cell_runtime',
          'relay_cell_admission',
          'relay_cell_regions',
          'relay_cells'
        ]) {
          await admin().database.query(`DELETE FROM ${table} WHERE cell_id = ?`, [config.id])
        }
      }
      await resetSelectorBoundary()
    }
    for (const instance of [...directors, ...servingCells.values()]) await instance.database.close()
    await observer?.close()
  })

  it('keeps placing during a paced drain when the cells are next to the database', async () => {
    for (const rate of [6, 18]) {
      const report = await run(LOCAL_ROUND_TRIP_MS, rate)
      expect(report.dials.failed).toEqual({})
      // Failures, rejections and lock waits, not placements/s: pacing on a slow runner
      // moves the rate without any lock being involved.
      expect(total(report.dials.admissionRejected)).toBeLessThan(0.1 * report.dials.attempted)
      expect(report.director.lockWaitingMean).toBeLessThan(0.5)
    }
  }, 120_000)

  it('keeps placing while an Asia drain holds the source row', async () => {
    // Before the fix: 90 and 140 of 200 dials rejected by the sticky lane and
    // about 3.5 of 3.5 active director backends lock-waiting. Pass bars are on
    // those, not on placements/s, which a slow runner's pacing alone can move.
    for (const [rate, neighboursCapped] of [
      [6, false],
      [18, false],
      [18, true]
    ] as const) {
      const report = await run(ASIA_ROUND_TRIP_MS, rate, neighboursCapped)
      expect(report.dials.failed).toEqual({})
      expect(total(report.dials.admissionRejected)).toBeLessThan(0.1 * report.dials.attempted)
      expect(report.director.lockWaitingMean).toBeLessThan(0.5)
      expect(report.dials.placedCrossRegion).toBe(neighboursCapped ? report.dials.placed : 0)
      if (rate === 18) {
        // The release commits with its counter write, so the source row is no longer
        // held for a round trip and releases stop shedding to lease expiry. With the
        // separate COMMIT, 79 of 180 landed and the rest timed out waiting for the pool.
        expect(report.releases.ok).toBe(report.releases.attempted)
      }
    }
  }, 240_000)

  it('re-places departing hosts that redial after their own release', async () => {
    for (const neighboursCapped of [false, true]) {
      for (const dialDelayMs of [150, 400, 1_000]) {
        const report = await runDepartingRedial(dialDelayMs, neighboursCapped)
        expect(report.unexpected).toEqual({})
        expect(report.placed).toBe(report.hosts)
        // A busy own row is refused at once by design; what must not happen is
        // the sticky slot backing up behind it. Before: 72-143 wait-timeouts at
        // 400ms and 1s, 2.4-3.6 director backends lock-waiting.
        const { relay_assignment_row_busy: _refused, ...slotRejections } =
          report.firstAttempt.rejected
        expect(total(slotRejections)).toBeLessThan(0.1 * report.hosts)
        expect(report.lockWaitingMean).toBeLessThan(0.5)
        // A redial that beats its own release meets its own row (16-80 of 180, by how many
        // releases are still in flight at the dial) and is answered at once. That release
        // has finished by the next dial, so no host is refused twice. Measured p95 5.6-6.5s;
        // before the row-busy answer, p95 was 11-16s.
        expect(report.hostsRefusedTwice).toBe(0)
        expect(report.timeToPlacedMs.p95).toBeLessThanOrEqual(8_000)
      }
    }
  }, 600_000)
})

function flattenReport(report: RunReport): Record<string, string | number> {
  const failed = (tally: Tally): string =>
    Object.entries(tally)
      .map(([key, value]) => `${key}:${value}`)
      .join(' ') || '-'
  return {
    rttMs: report.roundTripMs,
    capped: report.neighboursCapped ? 'yes' : 'no',
    crossRegion: report.dials.placedCrossRegion,
    releasesPerSec: report.releaseRate,
    releasesOk: report.releases.ok,
    releasesFailed: failed(report.releases.failed),
    releaseP95Ms: report.releases.p95Ms,
    dialsPlaced: report.dials.placed,
    placementsPerSec: report.placementsPerSecond,
    dialsFailed: failed(report.dials.failed),
    stickyRejected: failed(report.dials.admissionRejected),
    lockTimeouts: report.director.lockTimeouts,
    lockUnavailable: report.director.lockUnavailable,
    lockWaiting: `${report.director.lockWaitingMean}/${report.director.activeMean}`,
    activationsFailed: failed(report.activations.failed)
  }
}

function flattenDeparting(report: DepartingReport): Record<string, string | number> {
  const failed = (tally: Tally): string =>
    Object.entries(tally)
      .map(([key, value]) => `${key}:${value}`)
      .join(' ') || '-'
  return {
    delayMs: report.dialDelayMs,
    capped: report.neighboursCapped ? 'yes' : 'no',
    placed: `${report.placed}/${report.hosts}`,
    firstPlaced: report.firstAttempt.placed,
    firstRejected: failed(report.firstAttempt.rejected),
    busy: report.busyRefusals,
    unexpected: failed(report.unexpected),
    redials: report.redials,
    placedP50Ms: report.timeToPlacedMs.p50,
    placedP95Ms: report.timeToPlacedMs.p95,
    placedMaxMs: report.timeToPlacedMs.max,
    placementsPerSec: report.placementsPerSecond,
    lockWaiting: `${report.lockWaitingMean}/${report.activeMean}`
  }
}
