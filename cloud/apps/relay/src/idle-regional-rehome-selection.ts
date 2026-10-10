import { createHash } from 'node:crypto'
import type { IdleRegionalRehomeRequest } from '@orca-cloud/relay-contract'
import type { RelayDatabase, SqlRow } from './database.js'

export const IDLE_REHOME_PAGE_SIZE = 100

// How many decision rows one poll is allowed to look at. The poll runs about
// fifty times a minute across the directors, so its cost has to be set by this
// number and not by the size of the fleet or the width of the cohort.
export const IDLE_REHOME_DECISION_WINDOW = 500

// Where the last window ended. A keyset beats OFFSET: `OFFSET n` still has to
// produce and throw away n rows, and n grew by a page on every poll that
// dispatched, so the scan got more expensive the longer the rollout ran.
export type IdleRehomeHostCursor = { userId: string; relayHostId: string } | null

export type IdleRegionalRehomeCandidate = IdleRegionalRehomeRequest & { sourceCellUrl: string }

export type IdleRegionalRehomeSelection = {
  candidates: IdleRegionalRehomeCandidate[]
  cursor: IdleRehomeHostCursor
  // Eligible cells kept out of the source set by `rehomeSourceRegionAllowed`.
  skippedOffRegionSourceCells: number
}

// TEMPORARY STOPGAP: delete with its call sites once the rehome commit stops holding
// relay_cells row locks across cross-region round trips. The source cell runs the commit,
// and one outside the database's region holds fleet-wide locks for seconds, so it may not
// be a source. It stays a target: only the source side of the commit pays the round trips.
export function rehomeSourceRegionAllowed(
  sourceRegion: string,
  directorRegion: string | undefined
): boolean {
  return directorRegion === undefined || sourceRegion === directorRegion
}

type SourceCell = {
  cellId: string
  region: string
  cellIncarnation: string
  startedAt: number
  cellUrl: string
}

type TargetCell = { cellId: string; capacityRequests: number; reservedRequests: number }

type SelectionInput = {
  database: RelayDatabase
  now: number
  heartbeatTtlMs: number
  cohortPercent: number
  preferenceMaxAgeMs: number
  hostCooldownMs: number
  cursor: IdleRehomeHostCursor
  // The director's own region; the database lives there. Undefined keeps every source.
  directorRegion?: string
  connectionHeadroom: ReadonlyMap<string, boolean>
  cellIsClean: (safety: SqlRow | undefined, runtime: SqlRow, now: number) => boolean
}

const CELL_INVENTORY_QUERY = `SELECT cell.cell_id, cell.cell_url, cell.enabled,
     cell.capacity_requests, cell.reserved_requests, region.region,
     admission.admission_state, capability.cell_incarnation AS capability_incarnation,
     capability.regional_rehome_protocol
   FROM relay_cells cell
   LEFT JOIN relay_cell_regions region ON region.cell_id = cell.cell_id
   LEFT JOIN relay_cell_admission admission ON admission.cell_id = cell.cell_id
   LEFT JOIN relay_cell_capabilities capability ON capability.cell_id = cell.cell_id`

export async function selectIdleRegionalRehomes(
  input: SelectionInput
): Promise<IdleRegionalRehomeSelection> {
  const cells = await readCellInventory(input)
  const skippedOffRegionSourceCells = cells.skippedOffRegionSourceCells
  if (!cells.sources.size || !cells.targetsByRegion.size) {
    return { candidates: [], cursor: null, skippedOffRegionSourceCells }
  }
  const sourceRegions = [...new Set([...cells.sources.values()].map((cell) => cell.region))]
  const targetRegions = [...cells.targetsByRegion.keys()]
  const decisionFilter = `outcome = 'conclusive' AND policy_version = 1
       AND preferred_region IN (${placeholders(targetRegions.length)})
       AND incumbent_region IN (${placeholders(sourceRegions.length)})
       AND preferred_region <> incumbent_region
       AND expires_at > ? AND observed_at >= ? AND cohort_bucket < ?`
  const decisionParams = [
    ...targetRegions,
    ...sourceRegions,
    input.now,
    input.now - input.preferenceMaxAgeMs,
    input.cohortPercent
  ]
  const after = input.cursor ? [input.cursor.userId, input.cursor.relayHostId] : []
  const afterFilter = input.cursor ? 'AND (user_id, relay_host_id) > (?, ?)' : ''

  // The window is taken first and on its own so the poll knows where it stopped
  // reading, not just where it stopped emitting. Every gate below this point can
  // reject a host, and a cursor that only advanced past emitted rows would park
  // on a rejected host forever.
  const window = await input.database.query(
    `SELECT user_id, relay_host_id FROM relay_region_decisions
     WHERE ${decisionFilter} ${afterFilter}
     ORDER BY user_id, relay_host_id LIMIT ?`,
    [...decisionParams, ...after, IDLE_REHOME_DECISION_WINDOW]
  )
  if (!window.length) return { candidates: [], cursor: null, skippedOffRegionSourceCells }
  const windowEnd = window[window.length - 1]!
  const windowWasFull = window.length === IDLE_REHOME_DECISION_WINDOW

  const sourceList = [...cells.sources.values()]
  const rows = await input.database.query(
    // The verification names the window's keys rather than repeating its LIMIT:
    // the two reads take separate snapshots, and a decision that turned eligible
    // between them would otherwise shift the second LIMIT and push the last host
    // out of it while the cursor still advanced past it.
    `SELECT d.user_id, d.relay_host_id, d.preferred_region, a.cell_id AS source_cell_id,
       a.assignment_epoch, host.generation
     FROM (SELECT user_id, relay_host_id, preferred_region, incumbent_region, assignment_epoch
       FROM relay_region_decisions
       WHERE ${decisionFilter}
         AND (user_id, relay_host_id) IN (${Array.from({ length: window.length }, () => '(?,?)').join(',')})
       -- The LIMIT cannot truncate a key set this size; it is here because without
       -- it Postgres flattens the subquery, estimates one row out of the join, and
       -- drives the whole plan from a sequential scan of the capability table.
       ORDER BY user_id, relay_host_id LIMIT ?) d
     JOIN relay_assignments a ON a.user_id = d.user_id AND a.relay_host_id = d.relay_host_id
       AND a.assignment_epoch = d.assignment_epoch
     JOIN (${inlineRows(SOURCE_CELL_COLUMNS, sourceList.length)}) source
       ON source.cell_id = a.cell_id AND source.region = d.incumbent_region
     JOIN relay_control_capabilities host ON host.user_id = d.user_id
       AND host.relay_host_id = d.relay_host_id AND host.cell_id = a.cell_id
       AND host.assignment_epoch = a.assignment_epoch
       AND host.cell_incarnation = source.cell_incarnation AND host.idle_regional_rehome = 1
     JOIN relay_assignment_activity_leases lease ON lease.user_id = d.user_id
       AND lease.relay_host_id = d.relay_host_id AND lease.activity_id = host.activity_id
       AND lease.cell_id = a.cell_id AND lease.activity_kind = 'control'
       AND lease.expires_at > ? AND lease.updated_at >= source.started_at
     WHERE NOT EXISTS (SELECT 1 FROM relay_assignment_migrations migration
         WHERE migration.user_id = d.user_id AND migration.relay_host_id = d.relay_host_id
           AND migration.completed_at IS NULL AND migration.aborted_at IS NULL)
       AND NOT EXISTS (SELECT 1 FROM relay_region_rehome_attempts attempt
         WHERE attempt.user_id = d.user_id AND attempt.relay_host_id = d.relay_host_id
           AND attempt.created_at > ?)
     ORDER BY d.user_id, d.relay_host_id, host.generation DESC
     -- Counted in hosts, because a host with one eligible target has to be able
     -- to fill a page on its own. A host with many leaves part of this page
     -- unread, and the cursor stops where the page stopped, so it is re-read
     -- next poll rather than skipped.
     LIMIT ?`,
    [
      ...decisionParams,
      ...window.flatMap((row) => [row.user_id, row.relay_host_id]),
      IDLE_REHOME_DECISION_WINDOW,
      ...sourceList.flatMap((cell) => [cell.cellId, cell.region, cell.cellIncarnation, cell.startedAt]),
      input.now,
      input.now - input.hostCooldownMs,
      IDLE_REHOME_PAGE_SIZE
    ]
  )
  const units = rows.length ? await sourceRequestUnits(input.database, rows) : new Map<string, number>()

  const candidates: IdleRegionalRehomeCandidate[] = []
  let stoppedAt: IdleRehomeHostCursor = null
  for (const row of rows) {
    // Whole hosts only: the lower-priority targets are a host's fallbacks when
    // the first one defers, and splitting them across pages loses them.
    if (candidates.length >= IDLE_REHOME_PAGE_SIZE) {
      return { candidates, cursor: stoppedAt, skippedOffRegionSourceCells }
    }
    const source = cells.sources.get(String(row.source_cell_id))!
    const sourceUnits = units.get(hostKey(row)) ?? 0
    for (const target of cells.targetsByRegion.get(String(row.preferred_region)) ?? []) {
      if (target.reservedRequests + 1 + sourceUnits > target.capacityRequests) continue
      candidates.push(idleRehomeCandidate(row, source, target.cellId))
    }
    stoppedAt = { userId: String(row.user_id), relayHostId: String(row.relay_host_id) }
  }
  // A full verification page may have been cut short of the window's end, so only
  // a page that ran the window out may wrap to the head of the keyspace.
  if (rows.length === IDLE_REHOME_PAGE_SIZE) {
    return { candidates, cursor: stoppedAt, skippedOffRegionSourceCells }
  }
  return {
    candidates,
    skippedOffRegionSourceCells,
    cursor: windowWasFull
      ? { userId: String(windowEnd.user_id), relayHostId: String(windowEnd.relay_host_id) }
      : null
  }
}

// Every cell predicate the candidate join used to re-evaluate per (host, cell)
// pair. There are tens of cells and tens of thousands of hosts, so this is
// resolved once per poll against the four small inventory tables.
async function readCellInventory(
  input: SelectionInput
): Promise<{
  sources: Map<string, SourceCell>
  targetsByRegion: Map<string, TargetCell[]>
  skippedOffRegionSourceCells: number
}> {
  const { database, now } = input
  const [runtimeRows, safetyRows, inventory] = await Promise.all([
    database.query('SELECT * FROM relay_cell_runtime'),
    database.query('SELECT * FROM relay_cell_rehome_safety'),
    database.query(CELL_INVENTORY_QUERY)
  ])
  const runtimes = new Map(runtimeRows.map((row) => [String(row.cell_id), row]))
  const safety = new Map(safetyRows.map((row) => [String(row.cell_id), row]))
  const sources = new Map<string, SourceCell>()
  const targetsByRegion = new Map<string, TargetCell[]>()
  const load = new Map<string, number>()
  let skippedOffRegionSourceCells = 0
  for (const cell of inventory) {
    const cellId = String(cell.cell_id)
    const runtime = runtimes.get(cellId)
    if (!runtime || !input.cellIsClean(safety.get(cellId), runtime, now)) continue
    if (
      Number(cell.enabled) !== 1 ||
      cell.admission_state !== 'general' ||
      cell.region == null ||
      Number(runtime.ready) !== 1 ||
      Number(runtime.last_heartbeat_at) <= now - input.heartbeatTtlMs ||
      cell.capability_incarnation == null ||
      String(cell.capability_incarnation) !== String(runtime.cell_incarnation) ||
      Number(cell.regional_rehome_protocol) < 3
    ) {
      continue
    }
    const region = String(cell.region)
    // Only the source set shrinks, which narrows the window's `incumbent_region IN`;
    // the cell still falls through to the target list below.
    if (rehomeSourceRegionAllowed(region, input.directorRegion)) {
      sources.set(cellId, {
        cellId,
        region,
        cellIncarnation: String(runtime.cell_incarnation),
        startedAt: Number(runtime.started_at),
        cellUrl: String(cell.cell_url)
      })
    } else {
      skippedOffRegionSourceCells += 1
    }
    if (input.connectionHeadroom.get(cellId) === false) continue
    const capacityRequests = Number(cell.capacity_requests)
    const reservedRequests = Number(cell.reserved_requests)
    const targets = targetsByRegion.get(region) ?? []
    targets.push({ cellId, capacityRequests, reservedRequests })
    targetsByRegion.set(region, targets)
    load.set(cellId, (reservedRequests + Number(runtime.observed_requests)) / capacityRequests)
  }
  for (const targets of targetsByRegion.values()) {
    targets.sort(
      (left, right) =>
        load.get(left.cellId)! - load.get(right.cellId)! || (left.cellId < right.cellId ? -1 : 1)
    )
  }
  return { sources, targetsByRegion, skippedOffRegionSourceCells }
}

// One grouped read for the page instead of a correlated aggregate per (host, cell) pair.
async function sourceRequestUnits(
  database: RelayDatabase,
  rows: SqlRow[]
): Promise<Map<string, number>> {
  const seen = new Set<string>()
  const params: unknown[] = []
  for (const row of rows) {
    if (seen.has(hostKey(row))) continue
    seen.add(hostKey(row))
    params.push(row.user_id, row.relay_host_id, row.source_cell_id)
  }
  const sums = await database.query(
    `SELECT user_id, relay_host_id, COALESCE(SUM(request_units), 0) AS request_units
     FROM relay_assignment_activity_leases
     WHERE (user_id, relay_host_id, cell_id) IN (${Array.from({ length: seen.size }, () => '(?,?,?)').join(',')})
     GROUP BY user_id, relay_host_id`,
    params
  )
  return new Map(sums.map((row) => [hostKey(row), Number(row.request_units)]))
}

const SOURCE_CELL_COLUMNS = [
  ['cell_id', 'TEXT'],
  ['region', 'TEXT'],
  ['cell_incarnation', 'TEXT'],
  ['started_at', 'BIGINT']
] as const

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(',')
}

// A derived table the planner can hash, in the one syntax both Postgres and the
// SQLite test engine accept (`VALUES ... AS t(col)` and LATERAL are not common to
// both). Only the first branch is cast; both engines take the union's types from it.
function inlineRows(columns: ReadonlyArray<readonly [string, string]>, rows: number): string {
  const first = columns.map(([name, type]) => `CAST(? AS ${type}) AS ${name}`)
  const rest = Array.from({ length: rows - 1 }, () => `UNION ALL SELECT ${placeholders(columns.length)}`)
  return `SELECT ${first.join(', ')} ${rest.join(' ')}`
}

function hostKey(row: SqlRow): string {
  return `${String(row.user_id)} ${String(row.relay_host_id)}`
}

function idleRehomeCandidate(
  row: SqlRow,
  source: SourceCell,
  targetCellId: string
): IdleRegionalRehomeCandidate {
  const request = {
    v: 1 as const,
    userId: String(row.user_id),
    relayHostId: String(row.relay_host_id),
    sourceCellId: source.cellId,
    sourceCellIncarnation: source.cellIncarnation,
    sourceAssignmentEpoch: Number(row.assignment_epoch),
    sourceGeneration: Number(row.generation),
    targetCellId
  }
  // UUIDv5 keeps retries on every director bound to the same source authority and target.
  const digest = createHash('sha1')
    .update(Buffer.from('0a1c5a9b197b4ea8b6f1f3bcaa3d712c', 'hex'))
    .update(JSON.stringify(request))
    .digest()
  digest[6] = (digest[6]! & 0x0f) | 0x50
  digest[8] = (digest[8]! & 0x3f) | 0x80
  const hex = digest.subarray(0, 16).toString('hex')
  const attemptId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  return { ...request, attemptId, sourceCellUrl: source.cellUrl }
}
