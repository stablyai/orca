import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import {
  ASSIGNMENT_LIMITS,
  mayNormallyReassign,
  RELAY_ADMISSION_BUDGETS,
  RELAY_DEFAULT_REGION,
  RELAY_REGIONS,
  RELAY_PROTOCOL_LIMITS,
  type RelayRegion
} from '@orca-cloud/relay-contract'
import {
  cellAdmissionState,
  cellAdmissionStates,
  ensureCellAdmission,
  parseCellAdmissionState,
  RelayCellAdmissionSelector,
  setCellAdmissionBeforeBoundary,
  stateFromEnabled,
  synchronizeCellAdmissionBoundary,
  type CellAdmissionMembership,
  type CellAdmissionSelectorInspection,
  type CellAdmissionState
} from './cell-admission-selector.js'
import {
  RelayMigrationCellRegistrar,
  type MigrationCellRegistration
} from './cell-admission-migration-registration.js'
import {
  ASSIGNMENT_CONNECTION_HEADROOM_QUERY
} from './assignment-connection-headroom-query.js'
import { AssignmentIdentityQueue } from './assignment-identity-queue.js'
import type { RelayCellConfig } from './config.js'
import type { RelayDatabase, RelayTransactionOptions, SqlRow } from './database.js'
import type { RegionalRehomeSafetySnapshot } from './relay-observability.js'
import {
  combineRegionalRehomeSafety,
  REGIONAL_REHOME_RECONNECTS_PER_CELL_LIMIT,
  REGIONAL_REHOME_SQL_FAILURES_PER_CELL_LIMIT,
  regionalRehomePoolPressure,
  regionalRehomeSafetyFailure
} from './regional-rehome-safety.js'
import {
  ABANDONED_REGISTERED_MIGRATION,
  DURABLY_FENCED_MIGRATION_SOURCE,
  REGISTERED_MIGRATION_ABANDON_MS
} from './registered-migration-abandonment.js'

type AssignmentIdentity = { userId: string; relayHostId: string }
type CellHeartbeat = {
  cellId: string
  cellUrl: string
  cellIncarnation: string
  startedAt: number
  ready: boolean
  observedRequests: number
  region?: RelayRegion
  totalConnections?: number
  inFlightConnections?: number
  reservedConnectionUnits?: number
  enforcedConnectionUnits?: number
  connectionInclusionWatermark?: number
  connectionHardCap?: number
  connectionUnobservedBound?: number
}

type CellRegionalRehomeStatus = {
  cellId: string
  cellIncarnation: string
  regionalRehomeProtocol: number
  safety: RegionalRehomeSafetySnapshot
}

type RelayAssignmentStoreOptions = {
  requireLiveCells?: boolean
  heartbeatTtlMs?: number
  recordControlRenewal?: (durationMs: number, outcome: ControlRenewalOutcome) => void
}

export type ControlRenewalOutcome =
  | 'renewed'
  | 'assignment_not_found'
  | 'activity_cell_not_authoritative'
  | 'control_activity_not_found'
  | 'control_activity_moved'
  | 'database_error'

const CONTROL_RENEWAL_OUTCOMES = new Set<ControlRenewalOutcome>([
  'renewed',
  'assignment_not_found',
  'activity_cell_not_authoritative',
  'control_activity_not_found',
  'control_activity_moved'
])
export type RelayAssignment = AssignmentIdentity & {
  cellId: string
  cellUrl: string
  assignmentEpoch: number
  leaseExpiresAt: number
  region?: RelayRegion
}

export type RelayRegionCatalogEntry = {
  region: RelayRegion
  probeOrigins: string[]
}

export type RelayAssignmentMigration = AssignmentIdentity & {
  sourceCellId: string
  targetCellId: string
  previousEpoch: number
  assignmentEpoch: number
  expiresAt: number
  targetRegisteredAt?: number
}

export type RegionalRehomeAttempt = AssignmentIdentity & {
  attemptId: string
  preferredRegion: 'asia-east2'
  sourceCellId: string
  sourceCellUrl: string
  sourceCellIncarnation: string
  targetCellId: string
  targetCellIncarnation: string
  previousEpoch: number
  assignmentEpoch: number
  drainGraceMs: number
  sendAttempts: number
}

export type RegionalHostDrainOutcome =
  | 'accepted'
  | 'already-accepted'
  | 'host-not-connected'

export type RegionalRehomeFleetSafety = RegionalRehomeSafetySnapshot & {
  requiredCells: number
  missingCells: number
  maxReconnects: number
}

export type RegionalRehomeControl = {
  generation: number
  enabled: boolean
  observationStartedAt: number
  notBefore: number
  ratePerMinute: number
  preferenceMaxAgeMs: number
  drainGraceMs: number
}

type RegisteredEvacuationSupersessionInput = {
  assignmentEpoch: number
  sourceCellId: string
  currentTargetCellId: string
  replacementTargetCellId: string
}

export type DeadSourceCompletionResult = {
  changed: boolean
  assignmentEpoch: number
  sourceCellId: string
  targetCellId: string
}

export type CellEvacuationStatus = {
  inProgress: number
  oldestExpiresAt: number | null
  oldestRemainingMs: number | null
  targetRegistered: number
  registeredSourceActive: number
  registeredCompletable: number
  registeredTargetInactive: number
  completed: number
  blocked: number
  expiredUnregistered: number
  repairableExpiredUnregistered: number
  abortableExpiredUnregistered: number
  blockedExpiredUnregistered: number
  blockedExpiredOnNewerTargetAssignment: number
}

export type CellEvacuationCapacity = {
  sourceAssignments: number
  requiredTargetUnits: number
  availableTargetUnits: number
}

export type CellDeploymentStatus = {
  cellId: string
  cellUrl: string
  region: RelayRegion
  enabled: boolean
  admissionState: CellAdmissionState
  capacityRequests: number
  reservedRequests: number
  assignments: number
  activityLeases: number
  activityRequestUnits: number
  restartBlockingActivityLeases: number
  restartBlockingActivityRequestUnits: number
  restartBlockingReservedRequests: number
  outgoingMigrations: number
  incomingMigrations: number
  connectionCapacity: null | {
    hardCap: number
    controlRebindReserve: number
    ordinaryConnectionLimit: number
    unobservedBound: number
    normalAdmissionPause: number
    observedConnections: number
    inFlightConnections: number
    reservedConnectionUnits: number
    enforcedConnectionUnits: number
    pendingControlReservations: number
    heartbeatFresh: boolean
  }
  runtime: null | {
    cellUrl: string
    cellIncarnation: string
    startedAt: number
    ready: boolean
    observedRequests: number
    lastHeartbeatAt: number
    heartbeatFresh: boolean
    regionalRehomeProtocol: number
  }
}

export type CellFenceAttemptEvidence = {
  attemptId: string
  environment: 'staging' | 'production'
  cellId: string
  cellIncarnation: string
  migName: string
  instanceGroup: string
  generationIdentity: string
  fenceCommit: string
  planSha256: string
  planObjectName: string
  planObjectGeneration?: string
  varFileSha256: string
  terraformStateLineage: string
  terraformStateSerial: number
  terraformStateObjectGeneration: string
  terraformStateObjectSha256: string
  requestReason: string
}

export type CellFenceApplyInvocation = {
  invocationId: string
  requestReason: string
  startedAt: number
  gceOperation?: string
}

export type CellFenceAttempt = CellFenceAttemptEvidence & {
  applyInvocations?: CellFenceApplyInvocation[]
  gceOperation?: string
  createdAt: number
  expiresAt: number
  applyStartedAt?: number
  completedAt?: number
  abortedAt?: number
}

export type CellDrainAttemptState =
  | 'prepared'
  | 'send-may-have-started'
  | 'application-receipt'
  | 'proven-not-delivered'

export type CellDrainAttempt = {
  attemptId: string
  cellId: string
  cellIncarnation: string
  traceValue: string
  plannedGraceMs: number
  state: CellDrainAttemptState
  preparedAt: number
  sendMayHaveStartedAt?: number
  sendPermitExpiresAt?: number
  applicationReceiptAt?: number
  backendSuccessStatus?: number
  backendInstance?: string
  receiptCellIncarnation?: string
  retryAfter?: number
  recoverForwardAttemptedAt?: number
  provenNotDeliveredAt?: number
}

export type AssignmentActivityKind =
  | 'control'
  | 'splice'
  | 'invite'
  | 'install'
  | 'confirmation'
  | 'migration'

const ACTIVITY_COLUMN: Record<AssignmentActivityKind, string> = {
  control: 'reserved_controls',
  splice: 'reserved_splices',
  invite: 'reserved_invites',
  install: 'pending_installs',
  confirmation: 'pending_confirmations',
  migration: 'migration_leases'
}

const ACTIVITY_REQUEST_UNITS: Record<AssignmentActivityKind, number> = {
  control: 1,
  splice: 2,
  invite: 1,
  install: 1,
  confirmation: 1,
  migration: 1
}

const ASSIGNMENT_LOCK_RETRY_DEADLINE_MS = 15_000
// Why: stranded detection (issue #225) needs a grant old enough that a real
// attach would have registered (the 90s activity lease covers dial +
// activation), yet recent enough to prove an active retry loop rather than
// ordinary dormancy — which stays governed by the 24h rule.
const STRANDED_MIN_GRANT_AGE_MS = 60_000
const STRANDED_RECENT_ACTIVITY_MS = 15 * 60_000
const REGION_PREFERENCE_RETENTION_MS = 30 * 24 * 60 * 60_000
const REGIONAL_REHOME_UNREGISTERED_REFRESH_MS = 5 * 60_000
const REGIONAL_REHOME_MAX_REFRESH_MS = 24 * 60 * 60_000
// Drain grace is enforced by session-scoped cell state that any control
// reconnect sheds, so receipted attempts can stall dual-homed past grace;
// redrains re-dispatch them with the elapsed (zero) grace until they detach.
export const REGIONAL_REHOME_REDRAIN_INTERVAL_MS = 60_000
export const REGIONAL_REHOME_REDRAIN_SEND_LIMIT = 20
export const REGIONAL_REHOME_QUARANTINE_FAILURES = 3
export const REGIONAL_REHOME_QUARANTINE_MS = 15 * 60_000
const REGIONAL_REHOME_QUARANTINE_EXCLUSION_LIMIT = 50
const REGIONAL_REHOME_QUARANTINE_MEMORY_LIMIT = 1_000
const REGIONAL_REHOME_OBSERVATION_MS = 24 * 60 * 60_000
const ASSIGNMENT_LOCK_RETRY_MAX_DELAY_MS = 50
type AssignmentInventoryScope = 'none' | 'general' | 'all'
type RetriedAssignmentInventoryScope = Exclude<AssignmentInventoryScope, 'none'>

class AssignmentInventoryLockUnavailable extends Error {
  constructor(readonly inventoryScope: RetriedAssignmentInventoryScope) {
    super('database_lock_unavailable')
  }
}

class AssignmentInventoryScopeChanged extends Error {
  constructor() {
    super('assignment_inventory_scope_changed')
  }
}

// Debt holds connection headroom for a control that may still arrive shortly
// after its director-side timeout. Nothing legitimately arrives minutes late
// (attach deadline 10s, orphan grace 30s); unretired debt from hosts that
// never return otherwise starves connection headroom fleet-wide and turns
// every placement into relay_capacity_exhausted.
const LATE_ARRIVAL_DEBT_RETENTION_MS = 10 * 60 * 1_000
const CELL_FENCE_TTL_MS = 5 * 60 * 1_000
const CELL_FENCE_ATTEMPT_TTL_MS = 60 * 60 * 1_000
const CELL_DRAIN_SEND_PERMIT_MS = 30_000
const MAX_DRAIN_ACCOUNTING_REPAIR_ATTEMPTS = 3
const CELL_FENCE_ATTEMPT_SELECT = `
  SELECT attempts.*, bindings.plan_object_name, bindings.plan_object_generation,
         bindings.var_file_sha256, bindings.terraform_state_lineage,
         bindings.terraform_state_serial, bindings.terraform_state_object_generation,
         bindings.terraform_state_object_sha256, bindings.request_reason
  FROM relay_cell_fence_attempts attempts
  JOIN relay_cell_fence_plan_bindings bindings
    ON bindings.attempt_id = attempts.attempt_id`
export const STRANDED_MIGRATION_ABANDON_MS = REGISTERED_MIGRATION_ABANDON_MS
const ABORTABLE_EXPIRED_MIGRATION = `(
  (
    migration.target_registered_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM relay_post_drain_migration_pins pin
      WHERE pin.user_id = migration.user_id
        AND pin.relay_host_id = migration.relay_host_id
        AND pin.assignment_epoch = migration.assignment_epoch
    )
  )
  OR ${ABANDONED_REGISTERED_MIGRATION}
)`

export class RelayAssignmentStore {
  private readonly requireLiveCells: boolean
  private readonly heartbeatTtlMs: number
  // Poisoned attempts never complete or abort and stay the oldest rows, so
  // unquarantined they eventually fill the sweeps' LIMIT page and starve
  // every healthy candidate. Process-local on purpose: it resets on deploy
  // and each director relearns within a few ticks.
  private readonly regionalRehomeCandidateQuarantine = new Map<
    string,
    { failures: number; until: number }
  >()
  private readonly recordControlRenewal?: RelayAssignmentStoreOptions['recordControlRenewal']
  private readonly admissionSelector: RelayCellAdmissionSelector
  private readonly migrationCellRegistrar: RelayMigrationCellRegistrar
  private readonly activityQueue = new AssignmentIdentityQueue()
  private assignmentTail: Promise<void> = Promise.resolve()
  private pendingRegionalRehomeDisableLog: Record<string, string | number> | null = null

  constructor(
    private readonly database: RelayDatabase,
    private readonly now: () => number = Date.now,
    options: RelayAssignmentStoreOptions = {}
  ) {
    this.requireLiveCells = options.requireLiveCells ?? false
    this.heartbeatTtlMs = options.heartbeatTtlMs ?? 45_000
    this.recordControlRenewal = options.recordControlRenewal
    this.admissionSelector = new RelayCellAdmissionSelector(database, now)
    this.migrationCellRegistrar = new RelayMigrationCellRegistrar(database, now)
  }

  async reconcileCells(cells: RelayCellConfig[], disableMissing = true): Promise<void> {
    await this.reconcileCellsWithOptions(cells, disableMissing)
  }

  async reconcileCellsAtStartup(cells: RelayCellConfig[]): Promise<void> {
    await this.reconcileCellsWithOptions(cells, false, { reportRetries: false })
  }

  private async reconcileCellsWithOptions(
    cells: RelayCellConfig[],
    disableMissing: boolean,
    transactionOptions?: RelayTransactionOptions
  ): Promise<void> {
    const now = this.now()
    await this.database.transaction(async (transaction) => {
      await transaction.queryLocked(`SELECT cell_id FROM relay_cells ORDER BY cell_id ASC`)
      // Capacity rows share one global lock order with assignment transactions.
      for (const cell of [...cells].sort((left, right) => left.id.localeCompare(right.id))) {
        // Operator-owned enabled state and tagged URLs must survive revision restarts.
        await transaction.query(
          `INSERT INTO relay_cells
           (cell_id, cell_url, enabled, capacity_requests, reserved_requests,
            observed_requests, last_heartbeat_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (cell_id) DO UPDATE SET
             capacity_requests = excluded.capacity_requests,
             last_heartbeat_at = excluded.last_heartbeat_at,
             updated_at = excluded.updated_at`,
          [
            cell.id,
            cell.url,
            cell.initiallyEnabled === false ? 0 : 1,
            cell.capacityRequests,
            0,
            0,
            now,
            now
          ]
        )
        await transaction.query(
          `INSERT INTO relay_cell_regions (cell_id, region) VALUES (?, ?)
           ON CONFLICT (cell_id) DO UPDATE SET region = excluded.region`,
          [cell.id, cell.region ?? RELAY_DEFAULT_REGION]
        )
        await ensureCellAdmission(
          transaction,
          cell.id,
          stateFromEnabled(cell.initiallyEnabled !== false),
          now
        )
        if (
          cell.connectionHardCap !== undefined &&
          cell.connectionUnobservedBound !== undefined
        ) {
          const currentLimit = (
            await transaction.queryLocked(
              `SELECT hard_cap, unobserved_bound FROM relay_cell_connection_limits
               WHERE cell_id = ?`,
              [cell.id]
            )
          )[0]
          const limitChanged =
            currentLimit !== undefined &&
            (integer(currentLimit, 'hard_cap') !== cell.connectionHardCap ||
              integer(currentLimit, 'unobserved_bound') !==
                cell.connectionUnobservedBound)
          await transaction.query(
            `INSERT INTO relay_cell_connection_limits
             (cell_id, hard_cap, unobserved_bound, updated_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT (cell_id) DO UPDATE SET
               hard_cap = excluded.hard_cap,
               unobserved_bound = excluded.unobserved_bound,
               updated_at = excluded.updated_at`,
            [
              cell.id,
              cell.connectionHardCap,
              cell.connectionUnobservedBound,
              now
            ]
          )
          if (limitChanged) {
            await transaction.query(
              `DELETE FROM relay_cell_connection_snapshots WHERE cell_id = ?`,
              [cell.id]
            )
            await transaction.query(
              `DELETE FROM relay_cell_connection_runtime WHERE cell_id = ?`,
              [cell.id]
            )
          }
        }
      }
      const current = await transaction.query(
        `SELECT cell_id, enabled FROM relay_cells ORDER BY cell_id ASC`
      )
      for (const row of current) {
        await ensureCellAdmission(
          transaction,
          text(row, 'cell_id'),
          stateFromEnabled(integer(row, 'enabled') === 1),
          now
        )
      }
      if (disableMissing) {
        const ids = new Set(cells.map(({ id }) => id))
        for (const row of current) {
          const id = text(row, 'cell_id')
          if (
            !ids.has(id) &&
            (await cellAdmissionState(transaction, id)) !== 'existing-only'
          ) {
            await setCellAdmissionBeforeBoundary(transaction, id, 'existing-only', now)
          }
        }
      }
      await synchronizeCellAdmissionBoundary(transaction, now)
    }, transactionOptions)
  }

  async assign(
    identity: AssignmentIdentity,
    preferredRegion?: RelayRegion,
    placementRegion: RelayRegion = preferredRegion ?? RELAY_DEFAULT_REGION
  ): Promise<RelayAssignment> {
    const sticky = await this.assignStickyWithLockRetry(identity, preferredRegion)
    if (sticky) return sticky
    // Only placement needs the global inventory critical section; queueing those
    // attempts locally avoids turning true placement bursts into NOWAIT storms.
    return await this.serializeAssignment(
      async () => await this.assignWithLockRetry(identity, preferredRegion, placementRegion)
    )
  }

  private async assignStickyWithLockRetry(
    identity: AssignmentIdentity,
    preferredRegion?: RelayRegion
  ): Promise<RelayAssignment | null> {
    return await this.withAssignmentLockRetry(
      async (inventoryFirst) =>
        await this.assignStickyOnce(identity, inventoryFirst, preferredRegion)
    )
  }

  private async assignWithLockRetry(
    identity: AssignmentIdentity,
    preferredRegion?: RelayRegion,
    placementRegion: RelayRegion = preferredRegion ?? RELAY_DEFAULT_REGION
  ): Promise<RelayAssignment> {
    const deadline = Date.now() + ASSIGNMENT_LOCK_RETRY_DEADLINE_MS
    let inventoryScope: AssignmentInventoryScope = 'none'
    while (true) {
      try {
        return await this.assignOnce(identity, inventoryScope, preferredRegion, placementRegion)
      } catch (error) {
        if (error instanceof AssignmentInventoryScopeChanged) {
          inventoryScope = 'all'
          continue
        }
        if (
          !(error instanceof AssignmentInventoryLockUnavailable) ||
          Date.now() >= deadline
        ) {
          throw error
        }
        inventoryScope = error.inventoryScope
      }
      await waitForAssignmentLockRetry(deadline)
    }
  }

  private async withAssignmentLockRetry<T>(
    operation: (inventoryFirst: boolean) => Promise<T>
  ): Promise<T> {
    const deadline = Date.now() + ASSIGNMENT_LOCK_RETRY_DEADLINE_MS
    let inventoryFirst = false
    while (true) {
      try {
        return await operation(inventoryFirst)
      } catch (error) {
        if (!isDatabaseLockUnavailable(error) || Date.now() >= deadline) throw error
        inventoryFirst = true
      }
      // The retry joins the cell queue without holding later legacy-cycle locks.
      await waitForAssignmentLockRetry(deadline)
    }
  }

  private async assignStickyOnce(
    identity: AssignmentIdentity,
    inventoryFirst: boolean,
    preferredRegion?: RelayRegion
  ): Promise<RelayAssignment | null> {
    const now = this.now()
    return await this.database.transaction(async (transaction) => {
      const lockedCells = inventoryFirst
        ? await this.lockCellInventory(transaction)
        : undefined
      const existing = await this.assignmentRow(transaction, identity, inventoryFirst)
      if (!existing) return null
      const activityLeases = await this.lockAssignmentActivities(transaction, identity, true)
      await this.recordRegionPreference(transaction, identity, preferredRegion, now)
      if (mayNormallyReassign(activity(existing), now)) return null
      // Why: a stranded host must fall through to placement — re-granting the
      // pinned cell here is what refreshes its own activity and sustains the
      // loop (issue #225).
      if (await this.assignmentStrandedOnUnservedCell(transaction, identity, existing, now)) {
        return null
      }

      const currentCellId = text(existing, 'cell_id')
      const hadControl = holdsControlLease(
        activityLeases,
        currentCellId,
        integer(existing, 'assignment_epoch')
      )
      const currentRow = lockedCells
        ? lockedCells.find((row) => text(row, 'cell_id') === currentCellId)
        : hadControl
        ? (
            await transaction.query(`SELECT * FROM relay_cells WHERE cell_id = ?`, [
              currentCellId
            ])
          )[0]
        : (
            await transaction.queryLocked(
              `SELECT * FROM relay_cells WHERE cell_id = ?`,
              [currentCellId],
              { failIfUnavailable: true }
            )
          )[0]
      if (!currentRow) throw new Error('assigned_cell_missing')
      if (
        this.requireLiveCells &&
        !(await this.cellIsLive(transaction, currentCellId, now))
      ) {
        return null
      }

      if (
        !hadControl &&
        !(await this.cellHasConnectionHeadroom(transaction, currentCellId))
      ) {
        if (requestUnits(existing) === 0) return null
        throw new Error('relay_connection_headroom_exhausted')
      }

      const leaseExpiresAt = now + ASSIGNMENT_LIMITS.activityLeaseMs
      if (hadControl) {
        await this.touchAssignment(transaction, identity, leaseExpiresAt, now)
      } else {
        const nextReservation = integer(currentRow, 'reserved_requests') + 1
        if (nextReservation > integer(currentRow, 'capacity_requests')) {
          throw new Error('relay_capacity_exhausted')
        }
        await transaction.query(
          `UPDATE relay_cells SET reserved_requests = ?, updated_at = ? WHERE cell_id = ?`,
          [nextReservation, now, currentCellId]
        )
        await this.adjustActivityCount(transaction, identity, 'control', 1, leaseExpiresAt, now)
        await this.insertPendingControlLease(
          transaction,
          identity,
          currentCellId,
          integer(existing, 'assignment_epoch'),
          now
        )
      }
      return this.result(
        identity,
        existing,
        cell(currentRow, await this.cellRegion(transaction, currentCellId)),
        leaseExpiresAt
      )
    })
  }

  // Why: PR #194 pins assignments on existing-only cells so capacity pressure
  // cannot scatter existing hosts — assuming those cells still serve them. A
  // decommissioning cell (C3) broke that assumption: existing-only AND
  // rejecting attaches, so pinned hosts loop forever while each grant
  // refreshes their own last_activity_at, keeping dormancy-based
  // reassignment permanently out of reach (issue #225). "Stranded" therefore
  // requires proof the cell is not serving this host: a recent grant
  // (last_activity_at inside the window) that had ample time to attach and
  // still produced no live real activity. The evidence must come from the
  // assignment row itself — reservation rows do not exist for cells without
  // connection limits (C3), and expired pending leases are cleaned within a
  // maintenance cycle, so neither reliably survives until the next grant.
  private async assignmentStrandedOnUnservedCell(
    transaction: RelayDatabase,
    identity: AssignmentIdentity,
    existing: SqlRow,
    now: number
  ): Promise<boolean> {
    const lastActivityAt = integer(existing, 'last_activity_at')
    if (
      now < lastActivityAt + STRANDED_MIN_GRANT_AGE_MS ||
      now >= lastActivityAt + STRANDED_RECENT_ACTIVITY_MS
    ) {
      return false
    }
    const admissionRow = (
      await transaction.query(
        `SELECT admission_state FROM relay_cell_admission WHERE cell_id = ?`,
        [text(existing, 'cell_id')]
      )
    )[0]
    // Unknown or missing admission fails safe: the pin stays.
    if (admissionRow?.['admission_state'] !== 'existing-only') {
      return false
    }
    const liveLeases = (
      await transaction.query(
        `SELECT COUNT(*) AS live FROM relay_assignment_activity_leases
         WHERE user_id = ? AND relay_host_id = ? AND expires_at > ?
           AND activity_id NOT LIKE 'control-pending:%'`,
        [identity.userId, identity.relayHostId, now]
      )
    )[0]
    return integer(liveLeases!, 'live') === 0
  }

  private async serializeAssignment<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.assignmentTail
    let release!: () => void
    this.assignmentTail = new Promise((resolve) => (release = resolve))
    await previous
    try {
      return await operation()
    } finally {
      release()
    }
  }

  private async assignOnce(
    identity: AssignmentIdentity,
    inventoryScope: AssignmentInventoryScope,
    preferredRegion?: RelayRegion,
    placementRegion: RelayRegion = preferredRegion ?? RELAY_DEFAULT_REGION
  ): Promise<RelayAssignment> {
    const now = this.now()
    let retryScope: RetriedAssignmentInventoryScope =
      inventoryScope === 'all' ? 'all' : 'general'
    return await this.database.transaction(async (transaction) => {
      let lockedCells =
        inventoryScope === 'all'
          ? await this.lockCellInventory(transaction)
          : inventoryScope === 'general'
            ? await this.lockGeneralCellInventory(transaction)
            : undefined
      const existing = await this.assignmentRow(
        transaction,
        identity,
        inventoryScope !== 'none'
      )
      retryScope = existing ? 'all' : 'general'
      if (inventoryScope === 'general' && existing) {
        throw new AssignmentInventoryScopeChanged()
      }
      const activityLeases = await this.lockAssignmentActivities(transaction, identity, true)
      await this.recordRegionPreference(transaction, identity, preferredRegion, now)
      let forcedDeadReassignment = false
      let connectionHeadroomReassignment = false
      let strandedReassignment = false
      if (existing && !mayNormallyReassign(activity(existing), now)) {
        lockedCells ??= await this.lockCellInventory(transaction, true)
        const admission = await cellAdmissionStates(transaction)
        const currentRow = lockedCells.find(
          (row) => text(row, 'cell_id') === text(existing, 'cell_id')
        )
        if (!currentRow) throw new Error('assigned_cell_missing')
        const current = cell(
          currentRow,
          await this.cellRegion(transaction, text(existing, 'cell_id'))
        )
        // Why: an existing-only cell that rejects attaches (C3's decommission
        // posture) must not re-pin the hosts it refuses; the dead-cell fence
        // path below does not apply either — the cell is live, just unwilling.
        strandedReassignment = await this.assignmentStrandedOnUnservedCell(
          transaction,
          identity,
          existing,
          now
        )
        if (
          !strandedReassignment &&
          (!this.requireLiveCells || (await this.cellIsLive(transaction, current.cellId, now)))
        ) {
          const hadControl = holdsControlLease(
            activityLeases,
            current.cellId,
            integer(existing, 'assignment_epoch')
          )
          const hasConnectionHeadroom =
            hadControl ||
            (await this.cellHasConnectionHeadroom(transaction, current.cellId))
          if (hasConnectionHeadroom) {
            const leaseExpiresAt = now + ASSIGNMENT_LIMITS.activityLeaseMs
            if (hadControl) {
              await this.touchAssignment(transaction, identity, leaseExpiresAt, now)
            } else {
              await this.adjustCellReservation(transaction, current.cellId, 1)
              await this.adjustActivityCount(
                transaction,
                identity,
                'control',
                1,
                leaseExpiresAt,
                now
              )
              await this.insertPendingControlLease(
                transaction,
                identity,
                current.cellId,
                integer(existing, 'assignment_epoch'),
                now
              )
            }
            return this.result(identity, existing, current, leaseExpiresAt)
          }
          if (requestUnits(existing) > 0) {
            throw new Error('relay_connection_headroom_exhausted')
          }
          if (admission.get(current.cellId) !== 'general') {
            throw new Error('relay_connection_headroom_exhausted')
          }
          connectionHeadroomReassignment = true
        }
        if (!strandedReassignment && !connectionHeadroomReassignment) {
          if (
            (await this.deadCellRequiresCommittedFence(
              transaction,
              identity,
              current.cellId,
              integer(existing, 'assignment_epoch')
            )) &&
            !(await this.cellHasCommittedFence(transaction, current.cellId, now))
          ) {
            throw new Error('relay_capacity_exhausted')
          }
          forcedDeadReassignment = true
        }
      }

      lockedCells ??= existing
        ? await this.lockCellInventory(transaction, true)
        : await this.lockGeneralCellInventory(transaction, true)
      const target = await this.leastLoadedCell(
        transaction,
        lockedCells,
        placementRegion
      )
      if (!target) throw new Error('relay_capacity_exhausted')
      const previousUnits = existing ? requestUnits(existing) : 0
      if (existing) {
        await this.adjustCellReservation(transaction, text(existing, 'cell_id'), -previousUnits)
        if (forcedDeadReassignment || strandedReassignment) {
          // A fenced/dead incarnation cannot own drainable work, and a
          // stranded host's only leases are the unclaimed grant artifacts of
          // its own loop. Removing them prevents late expiry from
          // decrementing the replacement.
          await transaction.query(
            `DELETE FROM relay_assignment_activity_leases
             WHERE user_id = ? AND relay_host_id = ?`,
            [identity.userId, identity.relayHostId]
          )
        }
      }
      await this.adjustCellReservation(transaction, target.cellId, 1)
      const assignmentEpoch = existing ? integer(existing, 'assignment_epoch') + 1 : 1
      const leaseExpiresAt = now + ASSIGNMENT_LIMITS.activityLeaseMs
      await transaction.query(
        `INSERT INTO relay_assignments
         (user_id, relay_host_id, cell_id, assignment_epoch, lease_expires_at,
          last_activity_at, reserved_controls, reserved_splices, reserved_invites,
          pending_installs, pending_confirmations, migration_leases)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (user_id, relay_host_id) DO UPDATE SET
           cell_id = excluded.cell_id,
           assignment_epoch = excluded.assignment_epoch,
           lease_expires_at = excluded.lease_expires_at,
           last_activity_at = excluded.last_activity_at,
           reserved_controls = excluded.reserved_controls,
           reserved_splices = excluded.reserved_splices,
           reserved_invites = excluded.reserved_invites,
           pending_installs = excluded.pending_installs,
           pending_confirmations = excluded.pending_confirmations,
           migration_leases = excluded.migration_leases`,
        [
          identity.userId,
          identity.relayHostId,
          target.cellId,
          assignmentEpoch,
          leaseExpiresAt,
          now,
          1,
          0,
          0,
          0,
          0,
          0
        ]
      )
      if (existing) {
        await this.releaseSupersededControlConnectionReservations(
          transaction,
          identity,
          text(existing, 'cell_id'),
          integer(existing, 'assignment_epoch'),
          now
        )
      }
      await this.insertPendingControlLease(
        transaction,
        identity,
        target.cellId,
        assignmentEpoch,
        now
      )
      return { ...identity, ...target, assignmentEpoch, leaseExpiresAt }
    }).catch((error: unknown) => {
      if (isDatabaseLockUnavailable(error)) {
        throw new AssignmentInventoryLockUnavailable(retryScope)
      }
      throw error
    })
  }

  async resolve(identity: AssignmentIdentity): Promise<RelayAssignment | null> {
    const rows = await this.database.query(
      `SELECT assignment.*, cell.cell_url, region.region
       FROM relay_assignments assignment
       JOIN relay_cells cell ON cell.cell_id = assignment.cell_id
       LEFT JOIN relay_cell_regions region ON region.cell_id = cell.cell_id
       WHERE assignment.user_id = ? AND assignment.relay_host_id = ?`,
      [identity.userId, identity.relayHostId]
    )
    const row = rows[0]
    if (
      row &&
      this.requireLiveCells &&
      !(await this.cellIsLive(this.database, text(row, 'cell_id'), this.now()))
    ) {
      return null
    }
    return row
      ? {
          ...identity,
          cellId: text(row, 'cell_id'),
          cellUrl: text(row, 'cell_url'),
          region: optionalRelayRegion(row, 'region') ?? RELAY_DEFAULT_REGION,
          assignmentEpoch: integer(row, 'assignment_epoch'),
          leaseExpiresAt: integer(row, 'lease_expires_at')
        }
      : null
  }

  async setCellEnabled(cellId: string, enabled: boolean): Promise<void> {
    await this.setCellAdmissionState(cellId, stateFromEnabled(enabled))
  }

  async setCellAdmissionState(cellId: string, state: CellAdmissionState): Promise<void> {
    await this.database.transaction(
      async (transaction) =>
        await setCellAdmissionBeforeBoundary(transaction, cellId, state, this.now())
    )
  }

  async applyCellAdmissionSelector(input: {
    attemptId: string
    expectedGeneration: number
    expectedMembershipSha256?: string
    membership: CellAdmissionMembership
  }): Promise<{
    changed: boolean
    selector: {
      generation: number
      attemptId: string | null
      membership: CellAdmissionMembership
    }
  }> {
    return await this.admissionSelector.apply(input)
  }

  async inspectCellAdmissionSelector(
    attemptId?: string
  ): Promise<CellAdmissionSelectorInspection> {
    return await this.admissionSelector.inspect(attemptId)
  }

  async addMigrationCells(input: {
    attemptId: string
    expectedGeneration: number
    cells: MigrationCellRegistration[]
  }): Promise<{
    changed: boolean
    selector: {
      generation: number
      attemptId: string | null
      membership: CellAdmissionMembership
    }
  }> {
    return await this.migrationCellRegistrar.add(input)
  }

  async recordCellHeartbeat(input: CellHeartbeat): Promise<void> {
    const now = this.now()
    let inclusionWatermark: number | undefined
    await this.database.transaction(async (transaction) => {
      const configured = (
        await transaction.queryLocked(`SELECT * FROM relay_cells WHERE cell_id = ?`, [input.cellId])
      )[0]
      if (!configured) throw new Error('cell_not_found')
      if (text(configured, 'cell_url') !== input.cellUrl) throw new Error('cell_origin_mismatch')
      if (
        (await this.cellRegion(transaction, input.cellId)) !==
        (input.region ?? RELAY_DEFAULT_REGION)
      ) {
        throw new Error('cell_region_mismatch')
      }
      const current = (
        await transaction.queryLocked(`SELECT * FROM relay_cell_runtime WHERE cell_id = ?`, [
          input.cellId
        ])
      )[0]
      if (
        current &&
        ((text(current, 'cell_incarnation') === input.cellIncarnation &&
          input.startedAt !== integer(current, 'started_at')) ||
          (text(current, 'cell_incarnation') !== input.cellIncarnation &&
            input.startedAt <= integer(current, 'started_at')))
      ) {
        throw new Error('stale_cell_incarnation')
      }
      const connectionLimit = (
        await transaction.queryLocked(
          `SELECT * FROM relay_cell_connection_limits WHERE cell_id = ?`,
          [input.cellId]
        )
      )[0]
      if (connectionLimit) {
        if (
          input.totalConnections === undefined ||
          input.inFlightConnections === undefined ||
          input.reservedConnectionUnits === undefined ||
          input.enforcedConnectionUnits === undefined ||
          input.enforcedConnectionUnits !==
            input.totalConnections +
              input.inFlightConnections +
              input.reservedConnectionUnits ||
          input.connectionHardCap !== integer(connectionLimit, 'hard_cap') ||
          input.connectionUnobservedBound !==
            integer(connectionLimit, 'unobserved_bound')
        ) {
          throw new Error('cell_connection_telemetry_mismatch')
        }
      } else if (
        input.totalConnections !== undefined ||
        input.inFlightConnections !== undefined ||
        input.reservedConnectionUnits !== undefined ||
        input.enforcedConnectionUnits !== undefined ||
        input.connectionInclusionWatermark !== undefined ||
        input.connectionHardCap !== undefined ||
        input.connectionUnobservedBound !== undefined
      ) {
        throw new Error('cell_connection_limit_not_configured')
      }
      await transaction.query(
        `INSERT INTO relay_cell_runtime
         (cell_id, cell_url, cell_incarnation, started_at, ready,
          observed_requests, last_heartbeat_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (cell_id) DO UPDATE SET
           cell_url = excluded.cell_url,
           cell_incarnation = excluded.cell_incarnation,
           started_at = excluded.started_at,
           ready = excluded.ready,
           observed_requests = excluded.observed_requests,
           last_heartbeat_at = excluded.last_heartbeat_at,
           updated_at = excluded.updated_at`,
        [
          input.cellId,
          input.cellUrl,
          input.cellIncarnation,
          input.startedAt,
          input.ready ? 1 : 0,
          input.observedRequests,
          now,
          now
        ]
      )
      // Live directors read relay_cell_runtime; keep heartbeats off the placement capacity lock.
      if (!this.requireLiveCells) {
        await transaction.query(
          `UPDATE relay_cells SET observed_requests = ?, last_heartbeat_at = ?, updated_at = ?
           WHERE cell_id = ?`,
          [input.observedRequests, now, now, input.cellId]
        )
      }
      if (connectionLimit) {
        const currentSnapshot = (
          await transaction.queryLocked(
            `SELECT * FROM relay_cell_connection_snapshots WHERE cell_id = ?`,
            [input.cellId]
          )
        )[0]
        const previousWatermark =
          currentSnapshot &&
          text(currentSnapshot, 'cell_incarnation') === input.cellIncarnation
            ? integer(currentSnapshot, 'inclusion_watermark')
            : -1
        inclusionWatermark = input.connectionInclusionWatermark ?? previousWatermark + 1
        if (
          input.connectionInclusionWatermark !== undefined &&
          inclusionWatermark <= previousWatermark
        ) {
          throw new Error('stale_connection_snapshot')
        }
        await transaction.query(
          `INSERT INTO relay_cell_connection_runtime
           (cell_id, cell_incarnation, total_connections, in_flight_connections,
            reserved_connection_units, enforced_connection_units, last_heartbeat_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (cell_id) DO UPDATE SET
             cell_incarnation = excluded.cell_incarnation,
             total_connections = excluded.total_connections,
             in_flight_connections = excluded.in_flight_connections,
             reserved_connection_units = excluded.reserved_connection_units,
             enforced_connection_units = excluded.enforced_connection_units,
             last_heartbeat_at = excluded.last_heartbeat_at,
             updated_at = excluded.updated_at`,
          [
            input.cellId,
            input.cellIncarnation,
            input.totalConnections,
            input.inFlightConnections,
            input.reservedConnectionUnits,
            input.enforcedConnectionUnits,
            now,
            now
          ]
        )
        await transaction.query(
          `INSERT INTO relay_cell_connection_snapshots
           (cell_id, cell_incarnation, inclusion_watermark, total_connections,
            in_flight_connections, reserved_connection_units,
            enforced_connection_units, snapshot_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (cell_id) DO UPDATE SET
             cell_incarnation = excluded.cell_incarnation,
             inclusion_watermark = excluded.inclusion_watermark,
             total_connections = excluded.total_connections,
             in_flight_connections = excluded.in_flight_connections,
             reserved_connection_units = excluded.reserved_connection_units,
             enforced_connection_units = excluded.enforced_connection_units,
             snapshot_at = excluded.snapshot_at`,
          [
            input.cellId,
            input.cellIncarnation,
            inclusionWatermark,
            input.totalConnections,
            input.inFlightConnections,
            input.reservedConnectionUnits,
            input.enforcedConnectionUnits,
            now
          ]
        )
      }
      await transaction.query(`DELETE FROM relay_cell_fences WHERE cell_id = ?`, [input.cellId])
      await transaction.query(`DELETE FROM relay_cell_committed_fences WHERE cell_id = ?`, [
        input.cellId
      ])
      await transaction.query(
        `DELETE FROM relay_cell_legacy_fence_adoptions WHERE cell_id = ?`,
        [input.cellId]
      )
    })
    if (inclusionWatermark !== undefined) {
      await this.releaseHeartbeatConnectionReservationDebt(
        input.cellId,
        input.cellIncarnation,
        inclusionWatermark,
        now
      )
    }
  }

  async recordCellRegionalRehomeStatus(input: CellRegionalRehomeStatus): Promise<void> {
    const now = this.now()
    await this.database.transaction(async (transaction) => {
      const runtime = (
        await transaction.queryLocked(
          `SELECT cell_incarnation FROM relay_cell_runtime WHERE cell_id = ?`,
          [input.cellId]
        )
      )[0]
      if (!runtime || text(runtime, 'cell_incarnation') !== input.cellIncarnation) {
        throw new Error('stale_cell_incarnation')
      }
      await transaction.query(
        `INSERT INTO relay_cell_capabilities
         (cell_id, cell_incarnation, regional_rehome_protocol, last_heartbeat_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (cell_id) DO UPDATE SET
           cell_incarnation = excluded.cell_incarnation,
           regional_rehome_protocol = excluded.regional_rehome_protocol,
           last_heartbeat_at = excluded.last_heartbeat_at`,
        [input.cellId, input.cellIncarnation, input.regionalRehomeProtocol, now]
      )
      const safety = input.safety
      await transaction.query(
        `INSERT INTO relay_cell_rehome_safety
         (cell_id, cell_incarnation, observed_at, sql_failures, reconnects,
          control_activity_recovery_failures, database_pool_waiting,
          database_pool_waiters_max, database_pool_wait_ms_max)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (cell_id) DO UPDATE SET
           cell_incarnation = excluded.cell_incarnation,
           observed_at = excluded.observed_at,
           sql_failures = excluded.sql_failures,
           reconnects = excluded.reconnects,
           control_activity_recovery_failures =
             excluded.control_activity_recovery_failures,
           database_pool_waiting = excluded.database_pool_waiting,
           database_pool_waiters_max = excluded.database_pool_waiters_max,
           database_pool_wait_ms_max = excluded.database_pool_wait_ms_max`,
        [
          input.cellId,
          input.cellIncarnation,
          safety.observedAt,
          safety.sqlFailures,
          safety.reconnects,
          safety.controlActivityRecoveryFailures,
          safety.databasePoolWaiting,
          safety.databasePoolWaitersMax,
          safety.databasePoolWaitMsMax
        ]
      )
    })
  }

  private async releaseHeartbeatConnectionReservationDebt(
    cellId: string,
    cellIncarnation: string,
    inclusionWatermark: number,
    now: number
  ): Promise<void> {
    await this.database.transaction(async (transaction) => {
      const runtime = (
        await transaction.queryLocked(
          `SELECT * FROM relay_cell_runtime WHERE cell_id = ?`,
          [cellId]
        )
      )[0]
      const snapshot = (
        await transaction.queryLocked(
          `SELECT * FROM relay_cell_connection_snapshots WHERE cell_id = ?`,
          [cellId]
        )
      )[0]
      if (
        !runtime ||
        !snapshot ||
        text(runtime, 'cell_incarnation') !== cellIncarnation ||
        text(snapshot, 'cell_incarnation') !== cellIncarnation ||
        integer(snapshot, 'inclusion_watermark') !== inclusionWatermark
      ) {
        return
      }
      await transaction.query(
        `UPDATE relay_control_connection_reservations
         SET state = 'released', released_at = ?, updated_at = ?
         WHERE cell_id = ? AND state = 'claimed'
           AND inclusion_watermark IS NOT NULL
           AND inclusion_watermark <= ?`,
        [now, now, cellId, inclusionWatermark]
      )
      await transaction.query(
        `UPDATE relay_control_connection_reservations
         SET state = 'released', released_at = ?, updated_at = ?
         WHERE reservation_id IN (
           SELECT duplicate.reservation_id
           FROM relay_control_connection_reservations duplicate
           WHERE duplicate.cell_id = ?
             AND duplicate.state = 'late-arrival-debt'
             AND duplicate.claim_activity_id IS NULL
             AND duplicate.timeout_at <= ?
             AND EXISTS (
               SELECT 1
               FROM relay_control_connection_reservations retained
               WHERE retained.user_id = duplicate.user_id
                 AND retained.relay_host_id = duplicate.relay_host_id
                 AND retained.assignment_epoch = duplicate.assignment_epoch
                 AND retained.cell_id = duplicate.cell_id
                 AND retained.state = 'late-arrival-debt'
                 AND retained.claim_activity_id IS NULL
                 AND retained.timeout_at <= ?
                 AND (
                   retained.created_at < duplicate.created_at OR
                   (
                     retained.created_at = duplicate.created_at AND
                     retained.reservation_id < duplicate.reservation_id
                   )
                 )
             )
        )`,
        [now, now, cellId, now, now]
      )
      await transaction.query(
        `UPDATE relay_control_connection_reservations
         SET state = 'released', released_at = ?, updated_at = ?
         WHERE cell_id = ? AND state = 'late-arrival-debt'
           AND claim_activity_id IS NULL AND timeout_at <= ?
           AND EXISTS (
             SELECT 1 FROM relay_assignments assignment
             WHERE assignment.user_id =
                 relay_control_connection_reservations.user_id
               AND assignment.relay_host_id =
                 relay_control_connection_reservations.relay_host_id
               AND assignment.assignment_epoch >
                 relay_control_connection_reservations.assignment_epoch
           )
           AND EXISTS (
             SELECT 1 FROM relay_assignment_migrations migration
             WHERE migration.user_id =
                 relay_control_connection_reservations.user_id
               AND migration.relay_host_id =
                 relay_control_connection_reservations.relay_host_id
               AND migration.assignment_epoch =
                 relay_control_connection_reservations.assignment_epoch
               AND migration.target_cell_id =
                 relay_control_connection_reservations.cell_id
               AND migration.aborted_at IS NOT NULL
           )`,
        [now, now, cellId, now]
      )
    })
  }

  async attestCellFence(cellId: string, cellIncarnation: string): Promise<number> {
    const now = this.now()
    return await this.database.transaction(async (transaction) => {
      const cell = (
        await transaction.queryLocked(`SELECT * FROM relay_cells WHERE cell_id = ?`, [cellId])
      )[0]
      if (!cell) throw new Error('cell_not_found')
      if (integer(cell, 'enabled') !== 0) throw new Error('cell_fence_admission_enabled')
      const runtime = (
        await transaction.queryLocked(`SELECT * FROM relay_cell_runtime WHERE cell_id = ?`, [
          cellId
        ])
      )[0]
      if (
        !runtime ||
        text(runtime, 'cell_incarnation') !== cellIncarnation ||
        integer(runtime, 'last_heartbeat_at') > now - this.heartbeatTtlMs
      ) {
        throw new Error('cell_fence_runtime_not_stale')
      }
      const expiresAt = now + CELL_FENCE_TTL_MS
      await transaction.query(
        `INSERT INTO relay_cell_fences
         (cell_id, cell_incarnation, attested_at, expires_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (cell_id) DO UPDATE SET
           cell_incarnation = excluded.cell_incarnation,
           attested_at = excluded.attested_at,
           expires_at = excluded.expires_at`,
        [cellId, cellIncarnation, now, expiresAt]
      )
      return expiresAt
    })
  }

  async adoptLegacyCellFence(cellId: string, cellIncarnation: string): Promise<number> {
    const now = this.now()
    return await this.database.transaction(async (transaction) => {
      const cell = (
        await transaction.queryLocked(`SELECT * FROM relay_cells WHERE cell_id = ?`, [cellId])
      )[0]
      if (!cell) throw new Error('cell_not_found')
      if (integer(cell, 'enabled') !== 0) throw new Error('cell_fence_admission_enabled')
      const runtime = (
        await transaction.queryLocked(`SELECT * FROM relay_cell_runtime WHERE cell_id = ?`, [
          cellId
        ])
      )[0]
      if (
        !runtime ||
        text(runtime, 'cell_incarnation') !== cellIncarnation ||
        integer(runtime, 'last_heartbeat_at') > now - this.heartbeatTtlMs
      ) {
        throw new Error('cell_fence_runtime_not_stale')
      }
      const attempt = (
        await transaction.queryLocked(
          `SELECT attempt_id FROM relay_cell_fence_attempts
           WHERE cell_id = ? ORDER BY created_at DESC LIMIT 1`,
          [cellId]
        )
      )[0]
      if (attempt) throw new Error('legacy_cell_fence_attempt_exists')
      const expiresAt = now + CELL_FENCE_TTL_MS
      await transaction.query(
        `INSERT INTO relay_cell_fences
         (cell_id, cell_incarnation, attested_at, expires_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (cell_id) DO UPDATE SET
           cell_incarnation = excluded.cell_incarnation,
           attested_at = excluded.attested_at,
           expires_at = excluded.expires_at`,
        [cellId, cellIncarnation, now, expiresAt]
      )
      return expiresAt
    })
  }

  async commitLegacyCellFenceAdoption(
    cellId: string,
    cellIncarnation: string
  ): Promise<void> {
    const now = this.now()
    await this.database.transaction(async (transaction) => {
      const cell = (
        await transaction.queryLocked(`SELECT * FROM relay_cells WHERE cell_id = ?`, [cellId])
      )[0]
      if (!cell) throw new Error('cell_not_found')
      if (integer(cell, 'enabled') !== 0) throw new Error('cell_fence_admission_enabled')
      const runtime = (
        await transaction.queryLocked(`SELECT * FROM relay_cell_runtime WHERE cell_id = ?`, [
          cellId
        ])
      )[0]
      const fence = (
        await transaction.queryLocked(`SELECT * FROM relay_cell_fences WHERE cell_id = ?`, [
          cellId
        ])
      )[0]
      const attempt = (
        await transaction.queryLocked(
          `SELECT attempt_id FROM relay_cell_fence_attempts
           WHERE cell_id = ? ORDER BY created_at DESC LIMIT 1`,
          [cellId]
        )
      )[0]
      if (attempt) throw new Error('legacy_cell_fence_attempt_exists')
      if (
        !runtime ||
        !fence ||
        text(runtime, 'cell_incarnation') !== cellIncarnation ||
        text(fence, 'cell_incarnation') !== cellIncarnation ||
        integer(runtime, 'last_heartbeat_at') > now - this.heartbeatTtlMs ||
        integer(fence, 'attested_at') < integer(runtime, 'last_heartbeat_at') ||
        integer(fence, 'expires_at') <= now
      ) {
        throw new Error('legacy_cell_fence_not_active')
      }
      await transaction.query(
        `INSERT INTO relay_cell_legacy_fence_adoptions
         (cell_id, cell_incarnation, attested_at, expires_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (cell_id) DO UPDATE SET
           cell_incarnation = excluded.cell_incarnation,
           attested_at = excluded.attested_at,
           expires_at = excluded.expires_at`,
        [cellId, cellIncarnation, now, integer(fence, 'expires_at')]
      )
    })
  }

  async prepareCellFenceAttempt(input: CellFenceAttemptEvidence): Promise<CellFenceAttempt> {
    const now = this.now()
    return await this.database.transaction(async (transaction) => {
      let createdAt = now
      const cell = (
        await transaction.queryLocked(`SELECT * FROM relay_cells WHERE cell_id = ?`, [
          input.cellId
        ])
      )[0]
      if (!cell) throw new Error('cell_not_found')
      if (integer(cell, 'enabled') !== 0) throw new Error('cell_fence_admission_enabled')
      const runtime = (
        await transaction.queryLocked(`SELECT * FROM relay_cell_runtime WHERE cell_id = ?`, [
          input.cellId
        ])
      )[0]
      if (!runtime || text(runtime, 'cell_incarnation') !== input.cellIncarnation) {
        throw new Error('cell_fence_runtime_mismatch')
      }
      const existing = (
        await transaction.queryLocked(
          `${CELL_FENCE_ATTEMPT_SELECT}
           WHERE attempts.cell_id = ? ORDER BY attempts.created_at DESC LIMIT 1`,
          [input.cellId]
        )
      )[0]
      if (existing) {
        const attempt = cellFenceAttempt(existing)
        if (!attempt.completedAt && !attempt.abortedAt) {
          assertCellFenceAttemptBase(existing, input)
          return attempt
        }
        createdAt = Math.max(now, attempt.createdAt + 1)
      } else {
        const activeFence = (
          await transaction.queryLocked(
            `SELECT cell_id FROM relay_cell_fences
             WHERE cell_id = ? AND cell_incarnation = ? AND expires_at > ?`,
            [input.cellId, input.cellIncarnation, now]
          )
        )[0]
        if (activeFence) throw new Error('cell_fence_already_attested')
      }
      const expiresAt = createdAt + CELL_FENCE_ATTEMPT_TTL_MS
      await transaction.query(
        `INSERT INTO relay_cell_fence_attempts
         (attempt_id, environment, cell_id, cell_incarnation, mig_name, instance_group,
          generation_identity, fence_commit, plan_sha256, gce_operation, created_at,
          expires_at, apply_started_at, completed_at, aborted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, NULL, NULL)`,
        [
          input.attemptId,
          input.environment,
          input.cellId,
          input.cellIncarnation,
          input.migName,
          input.instanceGroup,
          input.generationIdentity,
          input.fenceCommit,
          input.planSha256,
          createdAt,
          expiresAt
        ]
      )
      await transaction.query(
        `INSERT INTO relay_cell_fence_plan_bindings
         (attempt_id, plan_object_name, plan_object_generation, var_file_sha256,
          terraform_state_lineage, terraform_state_serial,
          terraform_state_object_generation, terraform_state_object_sha256,
          request_reason)
         VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
        [
          input.attemptId,
          input.planObjectName,
          input.varFileSha256,
          input.terraformStateLineage,
          input.terraformStateSerial,
          input.terraformStateObjectGeneration,
          input.terraformStateObjectSha256,
          input.requestReason
        ]
      )
      const { planObjectGeneration: _ignored, ...prepared } = input
      return { ...prepared, createdAt, expiresAt }
    })
  }

  async bindCellFencePlanGeneration(
    input: CellFenceAttemptEvidence,
    planObjectGeneration: string
  ): Promise<CellFenceAttempt> {
    const now = this.now()
    return await this.database.transaction(async (transaction) => {
      const row = await lockedCellFenceAttempt(transaction, input.attemptId)
      assertCellFenceAttemptBase(row, input)
      if (integer(row, 'expires_at') <= now) throw new Error('cell_fence_attempt_expired')
      if (row.apply_started_at !== null) throw new Error('cell_fence_apply_already_started')
      if (row.completed_at !== null || row.aborted_at !== null) {
        throw new Error('cell_fence_attempt_terminal')
      }
      const existing = optionalText(row, 'plan_object_generation')
      if (existing && existing !== planObjectGeneration) {
        throw new Error('cell_fence_plan_generation_mismatch')
      }
      if (!existing) {
        await transaction.query(
          `UPDATE relay_cell_fence_plan_bindings
           SET plan_object_generation = ? WHERE attempt_id = ?`,
          [planObjectGeneration, input.attemptId]
        )
        row.plan_object_generation = planObjectGeneration
      }
      return cellFenceAttempt(row)
    })
  }

  async startCellFenceApply(
    input: CellFenceAttemptEvidence,
    invocationId: string,
    requestReason: string
  ): Promise<{ attempt: CellFenceAttempt; invocation: CellFenceApplyInvocation }> {
    const now = this.now()
    return await this.database.transaction(async (transaction) => {
      if (requestReason !== `${input.requestReason}/${invocationId}`) {
        throw new Error('cell_fence_invocation_mismatch')
      }
      const row = await lockedCellFenceAttempt(transaction, input.attemptId)
      assertActiveCellFenceAttempt(row, input, now)
      const existing = (
        await transaction.queryLocked(
          `SELECT * FROM relay_cell_fence_apply_invocations WHERE invocation_id = ?`,
          [invocationId]
        )
      )[0]
      if (existing) {
        if (
          text(existing, 'attempt_id') !== input.attemptId ||
          text(existing, 'request_reason') !== requestReason
        ) {
          throw new Error('cell_fence_invocation_mismatch')
        }
        return {
          attempt: cellFenceAttempt(row),
          invocation: cellFenceApplyInvocation(existing)
        }
      }
      if (row.apply_started_at === null) {
        await transaction.query(
          `UPDATE relay_cell_fence_attempts SET apply_started_at = ? WHERE attempt_id = ?`,
          [now, input.attemptId]
        )
        row.apply_started_at = now
      }
      await transaction.query(
        `INSERT INTO relay_cell_fence_apply_invocations
         (invocation_id, attempt_id, request_reason, started_at, gce_operation)
         VALUES (?, ?, ?, ?, NULL)`,
        [invocationId, input.attemptId, requestReason, now]
      )
      return {
        attempt: cellFenceAttempt(row),
        invocation: { invocationId, requestReason, startedAt: now }
      }
    })
  }

  async recordCellFenceOperation(
    input: CellFenceAttemptEvidence,
    invocationId: string,
    requestReason: string,
    gceOperation: string
  ): Promise<{ attempt: CellFenceAttempt; invocation: CellFenceApplyInvocation }> {
    const now = this.now()
    return await this.database.transaction(async (transaction) => {
      if (requestReason !== `${input.requestReason}/${invocationId}`) {
        throw new Error('cell_fence_invocation_mismatch')
      }
      const row = await lockedCellFenceAttempt(transaction, input.attemptId)
      assertActiveCellFenceAttempt(row, input, now)
      if (row.apply_started_at === null) throw new Error('cell_fence_apply_not_started')
      const invocation = (
        await transaction.queryLocked(
          `SELECT * FROM relay_cell_fence_apply_invocations WHERE invocation_id = ?`,
          [invocationId]
        )
      )[0]
      if (
        !invocation ||
        text(invocation, 'attempt_id') !== input.attemptId ||
        text(invocation, 'request_reason') !== requestReason
      ) {
        throw new Error('cell_fence_invocation_mismatch')
      }
      const existing = invocation.gce_operation
      if (existing !== null && existing !== gceOperation) {
        throw new Error('cell_fence_operation_mismatch')
      }
      await transaction.query(
        `UPDATE relay_cell_fence_apply_invocations
         SET gce_operation = ? WHERE invocation_id = ?`,
        [gceOperation, invocationId]
      )
      invocation.gce_operation = gceOperation
      await transaction.query(
        `UPDATE relay_cell_fence_attempts SET gce_operation = ? WHERE attempt_id = ?`,
        [gceOperation, input.attemptId]
      )
      row.gce_operation = gceOperation
      return {
        attempt: cellFenceAttempt(row),
        invocation: cellFenceApplyInvocation(invocation)
      }
    })
  }

  async cellFenceAttempt(cellId: string): Promise<CellFenceAttempt | null> {
    const rows = await this.database.query(
      `${CELL_FENCE_ATTEMPT_SELECT}
       WHERE attempts.cell_id = ? ORDER BY attempts.created_at DESC LIMIT 1`,
      [cellId]
    )
    if (rows.length === 0) return null
    const attempt = cellFenceAttempt(rows[0]!)
    const invocations = await this.database.query(
      `SELECT * FROM relay_cell_fence_apply_invocations
       WHERE attempt_id = ? ORDER BY started_at, invocation_id`,
      [attempt.attemptId]
    )
    return {
      ...attempt,
      applyInvocations: invocations.map(cellFenceApplyInvocation)
    }
  }

  async abortCellFenceAttempt(input: CellFenceAttemptEvidence): Promise<CellFenceAttempt> {
    return await this.database.transaction(async (transaction) => {
      const row = await lockedCellFenceAttempt(transaction, input.attemptId)
      assertCellFenceAttemptBase(row, input)
      if (row.completed_at !== null) throw new Error('cell_fence_attempt_completed')
      if (row.aborted_at !== null) throw new Error('cell_fence_attempt_aborted')
      if (row.apply_started_at !== null || row.gce_operation !== null) {
        throw new Error('cell_fence_apply_may_have_started')
      }
      const abortedAt = this.now()
      await transaction.query(
        `UPDATE relay_cell_fence_attempts SET aborted_at = ? WHERE attempt_id = ?`,
        [abortedAt, input.attemptId]
      )
      row.aborted_at = abortedAt
      return cellFenceAttempt(row)
    })
  }

  async attestCellFenceAttempt(
    input: CellFenceAttemptEvidence,
    gceOperation: string
  ): Promise<{ expiresAt: number; attempt: CellFenceAttempt }> {
    const now = this.now()
    return await this.database.transaction(async (transaction) => {
      const attemptRow = await lockedCellFenceAttempt(transaction, input.attemptId)
      assertCellFenceAttemptEvidence(attemptRow, input)
      if (attemptRow.completed_at !== null) {
        if (attemptRow.gce_operation !== gceOperation) {
          throw new Error('cell_fence_operation_not_attested')
        }
        const cell = (
          await transaction.queryLocked(`SELECT * FROM relay_cells WHERE cell_id = ?`, [
            input.cellId
          ])
        )[0]
        if (!cell) throw new Error('cell_not_found')
        if (integer(cell, 'enabled') !== 0) throw new Error('cell_fence_admission_enabled')
        const runtime = (
          await transaction.queryLocked(`SELECT * FROM relay_cell_runtime WHERE cell_id = ?`, [
            input.cellId
          ])
        )[0]
        if (
          !runtime ||
          text(runtime, 'cell_incarnation') !== input.cellIncarnation ||
          integer(runtime, 'last_heartbeat_at') > now - this.heartbeatTtlMs
        ) {
          throw new Error('cell_fence_runtime_not_stale')
        }
        const expiresAt = now + CELL_FENCE_TTL_MS
        await transaction.query(
          `INSERT INTO relay_cell_fences
           (cell_id, cell_incarnation, attested_at, expires_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT (cell_id) DO UPDATE SET
             cell_incarnation = excluded.cell_incarnation,
             attested_at = excluded.attested_at,
             expires_at = excluded.expires_at`,
          [input.cellId, input.cellIncarnation, now, expiresAt]
        )
        await this.recordCommittedCellFence(
          transaction,
          input.cellId,
          input.cellIncarnation,
          input.attemptId,
          now,
          expiresAt
        )
        return {
          expiresAt,
          attempt: cellFenceAttempt(attemptRow)
        }
      }
      assertActiveCellFenceAttempt(attemptRow, input, now)
      if (
        attemptRow.apply_started_at === null ||
        attemptRow.gce_operation !== gceOperation
      ) {
        throw new Error('cell_fence_operation_not_attested')
      }
      const cell = (
        await transaction.queryLocked(`SELECT * FROM relay_cells WHERE cell_id = ?`, [
          input.cellId
        ])
      )[0]
      if (!cell) throw new Error('cell_not_found')
      if (integer(cell, 'enabled') !== 0) throw new Error('cell_fence_admission_enabled')
      const runtime = (
        await transaction.queryLocked(`SELECT * FROM relay_cell_runtime WHERE cell_id = ?`, [
          input.cellId
        ])
      )[0]
      if (
        !runtime ||
        text(runtime, 'cell_incarnation') !== input.cellIncarnation ||
        integer(runtime, 'last_heartbeat_at') > now - this.heartbeatTtlMs
      ) {
        throw new Error('cell_fence_runtime_not_stale')
      }
      const expiresAt = now + CELL_FENCE_TTL_MS
      await transaction.query(
        `INSERT INTO relay_cell_fences
         (cell_id, cell_incarnation, attested_at, expires_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (cell_id) DO UPDATE SET
           cell_incarnation = excluded.cell_incarnation,
           attested_at = excluded.attested_at,
           expires_at = excluded.expires_at`,
        [input.cellId, input.cellIncarnation, now, expiresAt]
      )
      await this.recordCommittedCellFence(
        transaction,
        input.cellId,
        input.cellIncarnation,
        input.attemptId,
        now,
        expiresAt
      )
      await transaction.query(
        `UPDATE relay_cell_fence_attempts SET completed_at = ? WHERE attempt_id = ?`,
        [now, input.attemptId]
      )
      attemptRow.completed_at = now
      return { expiresAt, attempt: cellFenceAttempt(attemptRow) }
    })
  }

  async prepareCellDrainAttempt(input: {
    attemptId: string
    cellId: string
    cellIncarnation: string
    traceValue: string
    plannedGraceMs: number
  }): Promise<CellDrainAttempt & { shouldSend: false }> {
    const now = this.now()
    return await this.database.transaction(async (transaction) => {
      await this.assertDrainCellGeneration(
        transaction,
        input.cellId,
        input.cellIncarnation
      )
      const existing = (
        await transaction.queryLocked(
          `SELECT * FROM relay_cell_drain_attempt_states
           WHERE cell_id = ? ORDER BY prepared_at DESC LIMIT 1`,
          [input.cellId]
        )
      )[0]
      if (existing) {
        if (text(existing, 'attempt_id') === input.attemptId) {
          if (
            text(existing, 'cell_incarnation') !== input.cellIncarnation ||
            text(existing, 'trace_value') !== input.traceValue ||
            integer(existing, 'planned_grace_ms') !== input.plannedGraceMs
          ) {
            throw new Error('drain_attempt_generation_mismatch')
          }
          return { ...cellDrainAttempt(existing), shouldSend: false }
        }
        if (
          text(existing, 'state') !== 'proven-not-delivered' ||
          text(existing, 'cell_incarnation') !== input.cellIncarnation
        ) {
          throw new Error('drain_attempt_generation_mismatch')
        }
      }
      await transaction.query(
        `INSERT INTO relay_cell_drain_attempt_states
         (attempt_id, cell_id, cell_incarnation, trace_value, planned_grace_ms,
          state, prepared_at, send_may_have_started_at, send_permit_expires_at,
          application_receipt_at, backend_success_status, backend_instance,
          receipt_cell_incarnation, retry_after, recover_forward_attempted_at,
          proven_not_delivered_at)
         VALUES (?, ?, ?, ?, ?, 'prepared', ?, NULL, NULL, NULL, NULL, NULL,
          NULL, NULL, NULL, NULL)`,
        [
          input.attemptId,
          input.cellId,
          input.cellIncarnation,
          input.traceValue,
          input.plannedGraceMs,
          now
        ]
      )
      return {
        attemptId: input.attemptId,
        cellId: input.cellId,
        cellIncarnation: input.cellIncarnation,
        traceValue: input.traceValue,
        plannedGraceMs: input.plannedGraceMs,
        state: 'prepared',
        preparedAt: now,
        shouldSend: false
      }
    })
  }

  async beginCellDrainSend(input: {
    attemptId: string
    cellId: string
    cellIncarnation: string
  }): Promise<CellDrainAttempt & { shouldSend: boolean }> {
    try {
      return await this.beginCellDrainSendOnce(input)
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.message !== 'migration_activity_accounting_mismatch'
      ) {
        throw error
      }
      const activityCells = await this.database.query(
        `SELECT DISTINCT lease.cell_id
         FROM relay_assignment_activity_leases lease
         WHERE EXISTS (
           SELECT 1 FROM relay_assignment_migrations migration
           WHERE migration.user_id = lease.user_id
             AND migration.relay_host_id = lease.relay_host_id
             AND migration.source_cell_id = ?
             AND migration.completed_at IS NULL
             AND migration.aborted_at IS NULL
         )
         ORDER BY lease.cell_id`,
        [input.cellId]
      )
      const cellIds = activityCells
        .map((row) => text(row, 'cell_id'))
        .filter((cellId) => cellId !== input.cellId)
      for (const cellId of cellIds) {
        await this.reconcileReservationAccounting(input.cellId, cellId)
      }
      await this.refreshDrainMigrationLeases(input)
      return await this.beginCellDrainSendOnce(input)
    }
  }

  private async refreshDrainMigrationLeases(input: {
    cellId: string
    cellIncarnation: string
  }): Promise<void> {
    await this.retireObsoleteDrainMigrations(input.cellId)
    for (let repairAttempt = 0; ; repairAttempt++) {
      try {
        await this.refreshDrainMigrationLeasesOnce(input)
        return
      } catch (error) {
        if (
          !(error instanceof Error) ||
          error.message !== 'migration_activity_accounting_mismatch' ||
          repairAttempt >= MAX_DRAIN_ACCOUNTING_REPAIR_ATTEMPTS
        ) {
          throw error
        }
        await this.reconcileDrainMigrationAccounting(input.cellId)
      }
    }
  }

  private async reconcileDrainMigrationAccounting(sourceCellId: string): Promise<void> {
    const activityCells = await this.database.query(
      `SELECT DISTINCT lease.cell_id
       FROM relay_assignment_activity_leases lease
       WHERE EXISTS (
         SELECT 1 FROM relay_assignment_migrations migration
         WHERE migration.user_id = lease.user_id
           AND migration.relay_host_id = lease.relay_host_id
           AND migration.source_cell_id = ?
           AND migration.completed_at IS NULL
           AND migration.aborted_at IS NULL
       )
       ORDER BY lease.cell_id`,
      [sourceCellId]
    )
    for (const cellId of activityCells
      .map((row) => text(row, 'cell_id'))
      .filter((cellId) => cellId !== sourceCellId)) {
      await this.reconcileReservationAccounting(sourceCellId, cellId)
    }
  }

  private async retireObsoleteDrainMigrations(sourceCellId: string): Promise<void> {
    const candidates = await this.database.query(
      `SELECT migration.user_id, migration.relay_host_id,
         migration.assignment_epoch
       FROM relay_assignment_migrations migration
       JOIN relay_assignments assignment
         ON assignment.user_id = migration.user_id
        AND assignment.relay_host_id = migration.relay_host_id
       WHERE migration.source_cell_id = ?
         AND migration.completed_at IS NULL AND migration.aborted_at IS NULL
         AND assignment.assignment_epoch > migration.assignment_epoch
       ORDER BY migration.user_id, migration.relay_host_id`,
      [sourceCellId]
    )
    for (const candidate of candidates) {
      await this.retireObsoleteDrainMigration(sourceCellId, candidate)
    }
  }

  private async retireObsoleteDrainMigration(
    sourceCellId: string,
    candidate: SqlRow
  ): Promise<void> {
    const now = this.now()
    await this.database.transaction(async (transaction) => {
      const identity = {
        userId: text(candidate, 'user_id'),
        relayHostId: text(candidate, 'relay_host_id')
      }
      const assignment = await this.assignmentRow(transaction, identity)
      const assignmentEpoch = integer(candidate, 'assignment_epoch')
      const migrationRow = (
        await transaction.queryLocked(
          `SELECT * FROM relay_assignment_migrations
           WHERE user_id = ? AND relay_host_id = ? AND assignment_epoch = ?
             AND source_cell_id = ?
             AND completed_at IS NULL AND aborted_at IS NULL`,
          [identity.userId, identity.relayHostId, assignmentEpoch, sourceCellId]
        )
      )[0]
      if (!migrationRow) return
      if (!assignment || integer(assignment, 'assignment_epoch') <= assignmentEpoch) {
        throw new Error('migration_assignment_mismatch')
      }
      const leases = await this.lockAssignmentActivities(transaction, identity)
      const obsoleteActivityIds = new Set([
        pendingControlActivityId(assignmentEpoch),
        migrationActivityId(assignmentEpoch)
      ])
      if (leases.some((lease) => obsoleteActivityIds.has(text(lease, 'activity_id')))) {
        throw new Error('migration_activity_topology_mismatch')
      }
      await this.releaseSupersededControlConnectionReservations(
        transaction,
        identity,
        text(migrationRow, 'target_cell_id'),
        assignmentEpoch,
        now
      )
      await transaction.query(
        `UPDATE relay_assignment_migrations SET aborted_at = ?, updated_at = ?
         WHERE user_id = ? AND relay_host_id = ? AND assignment_epoch = ?`,
        [now, now, identity.userId, identity.relayHostId, assignmentEpoch]
      )
    })
  }

  private async refreshDrainMigrationLeasesOnce(input: {
    cellId: string
    cellIncarnation: string
  }): Promise<void> {
    const now = this.now()
    await this.database.transaction(async (transaction) => {
      await this.assertDrainCellGeneration(
        transaction,
        input.cellId,
        input.cellIncarnation
      )
      const assignments = await transaction.queryLocked(
        `SELECT assignment.*
         FROM relay_assignments assignment
         WHERE EXISTS (
           SELECT 1 FROM relay_assignment_migrations migration
           WHERE migration.user_id = assignment.user_id
             AND migration.relay_host_id = assignment.relay_host_id
             AND migration.source_cell_id = ?
             AND migration.completed_at IS NULL
             AND migration.aborted_at IS NULL
         )
         ORDER BY assignment.user_id, assignment.relay_host_id`,
        [input.cellId]
      )
      const activityLeases = await transaction.queryLocked(
        `SELECT lease.*
         FROM relay_assignment_activity_leases lease
         WHERE EXISTS (
           SELECT 1 FROM relay_assignment_migrations migration
           WHERE migration.user_id = lease.user_id
             AND migration.relay_host_id = lease.relay_host_id
             AND migration.source_cell_id = ?
             AND migration.completed_at IS NULL
             AND migration.aborted_at IS NULL
         )
         ORDER BY lease.user_id, lease.relay_host_id, lease.activity_id`,
        [input.cellId]
      )
      const migrations = await transaction.queryLocked(
        `SELECT migration.*
         FROM relay_assignment_migrations migration
         WHERE migration.source_cell_id = ?
           AND migration.completed_at IS NULL
           AND migration.aborted_at IS NULL
         ORDER BY migration.user_id, migration.relay_host_id`,
        [input.cellId]
      )
      const cells = await this.lockCellInventory(transaction)
      for (const migrationRow of migrations) {
        const identity = {
          userId: text(migrationRow, 'user_id'),
          relayHostId: text(migrationRow, 'relay_host_id')
        }
        const assignment = assignments.find(
          (candidate) =>
            text(candidate, 'user_id') === identity.userId &&
            text(candidate, 'relay_host_id') === identity.relayHostId
        )
        assertCurrentMigrationAssignment(assignment, migrationRow)
        const leases = activityLeases.filter(
          (lease) =>
            text(lease, 'user_id') === identity.userId &&
            text(lease, 'relay_host_id') === identity.relayHostId
        )
        const migrationLeases = leases.filter(
          (lease) => text(lease, 'activity_kind') === 'migration'
        )
        const assignmentEpoch = integer(migrationRow, 'assignment_epoch')
        const sourceRequestUnits = integer(migrationRow, 'source_request_units')
        const targetCellId = text(migrationRow, 'target_cell_id')
        const expiresAt = now + ASSIGNMENT_LIMITS.migrationLeaseMs
        if (migrationLeases.length > 0) {
          assertAssignmentActivityAccounting(assignment, leases, migrationRow)
          await transaction.query(
            `UPDATE relay_assignment_activity_leases SET expires_at = ?, updated_at = ?
             WHERE user_id = ? AND relay_host_id = ?
               AND activity_id IN (?, ?)`,
            [
              expiresAt,
              now,
              identity.userId,
              identity.relayHostId,
              pendingControlActivityId(assignmentEpoch),
              migrationActivityId(assignmentEpoch)
            ]
          )
          await transaction.query(
            `UPDATE relay_assignments SET
               lease_expires_at = CASE WHEN lease_expires_at > ? THEN lease_expires_at ELSE ? END,
               last_activity_at = ?
             WHERE user_id = ? AND relay_host_id = ?`,
            [expiresAt, expiresAt, now, identity.userId, identity.relayHostId]
          )
          await transaction.query(
            `UPDATE relay_assignment_migrations SET expires_at = ?, updated_at = ?
             WHERE user_id = ? AND relay_host_id = ? AND assignment_epoch = ?`,
            [expiresAt, now, identity.userId, identity.relayHostId, assignmentEpoch]
          )
          await this.refreshPendingControlReservation(
            transaction,
            identity,
            targetCellId,
            assignmentEpoch,
            expiresAt,
            now
          )
          continue
        }
        if (
          optionalInteger(migrationRow, 'target_registered_at') === undefined ||
          integer(migrationRow, 'expires_at') > now ||
          sourceRequestUnits < 0 ||
          integer(migrationRow, 'target_reserved_units') !== sourceRequestUnits + 1 ||
          activityLeaseById(leases, migrationActivityId(assignmentEpoch)) ||
          !cells.some((cell) => text(cell, 'cell_id') === targetCellId)
        ) {
          throw new Error('migration_activity_lease_shape_mismatch')
        }
        await this.adjustCellReservation(transaction, targetCellId, sourceRequestUnits)
        await transaction.query(
          `INSERT INTO relay_assignment_activity_leases
           (user_id, relay_host_id, activity_id, activity_kind, cell_id,
            request_units, expires_at, updated_at)
           VALUES (?, ?, ?, 'migration', ?, ?, ?, ?)`,
          [
            identity.userId,
            identity.relayHostId,
            migrationActivityId(assignmentEpoch),
            targetCellId,
            sourceRequestUnits,
            expiresAt,
            now
          ]
        )
        await transaction.query(
          `UPDATE relay_assignments SET migration_leases = migration_leases + 1,
             lease_expires_at = CASE WHEN lease_expires_at > ? THEN lease_expires_at ELSE ? END,
             last_activity_at = ?
           WHERE user_id = ? AND relay_host_id = ?`,
          [expiresAt, expiresAt, now, identity.userId, identity.relayHostId]
        )
        await transaction.query(
          `UPDATE relay_assignment_migrations SET expires_at = ?, updated_at = ?
           WHERE user_id = ? AND relay_host_id = ? AND assignment_epoch = ?`,
          [expiresAt, now, identity.userId, identity.relayHostId, assignmentEpoch]
        )
        await this.refreshPendingControlReservation(
          transaction,
          identity,
          targetCellId,
          assignmentEpoch,
          expiresAt,
          now
        )
      }
    })
  }

  private async beginCellDrainSendOnce(input: {
    attemptId: string
    cellId: string
    cellIncarnation: string
  }): Promise<CellDrainAttempt & { shouldSend: boolean }> {
    const now = this.now()
    return await this.database.transaction(async (transaction) => {
      await this.assertDrainCellGeneration(
        transaction,
        input.cellId,
        input.cellIncarnation
      )
      const row = (
        await transaction.queryLocked(
          `SELECT * FROM relay_cell_drain_attempt_states
           WHERE attempt_id = ? AND cell_id = ?`,
          [input.attemptId, input.cellId]
        )
      )[0]
      if (!row || text(row, 'cell_incarnation') !== input.cellIncarnation) {
        throw new Error('drain_attempt_not_found')
      }
      if (text(row, 'state') !== 'prepared') {
        return { ...cellDrainAttempt(row), shouldSend: false }
      }
      const assignments = await transaction.queryLocked(
        `SELECT assignment.*
         FROM relay_assignments assignment
         JOIN relay_assignment_migrations migration
           ON migration.user_id = assignment.user_id
          AND migration.relay_host_id = assignment.relay_host_id
         WHERE migration.source_cell_id = ?
           AND migration.completed_at IS NULL AND migration.aborted_at IS NULL
         ORDER BY assignment.user_id, assignment.relay_host_id`,
        [input.cellId]
      )
      const activityLeases = await transaction.queryLocked(
        `SELECT lease.*
         FROM relay_assignment_activity_leases lease
         WHERE EXISTS (
           SELECT 1 FROM relay_assignment_migrations migration
           WHERE migration.user_id = lease.user_id
             AND migration.relay_host_id = lease.relay_host_id
             AND migration.source_cell_id = ?
             AND migration.completed_at IS NULL
             AND migration.aborted_at IS NULL
         )
         ORDER BY lease.user_id, lease.relay_host_id, lease.activity_id`,
        [input.cellId]
      )
      const migrationIncarnations = await transaction.queryLocked(
        `SELECT migration.*,
           (
             SELECT incarnation.source_cell_incarnation
             FROM relay_assignment_migration_incarnations incarnation
             WHERE incarnation.user_id = migration.user_id
               AND incarnation.relay_host_id = migration.relay_host_id
               AND incarnation.assignment_epoch = migration.assignment_epoch
           ) AS source_cell_incarnation,
           (
             SELECT incarnation.target_cell_incarnation
             FROM relay_assignment_migration_incarnations incarnation
             WHERE incarnation.user_id = migration.user_id
               AND incarnation.relay_host_id = migration.relay_host_id
               AND incarnation.assignment_epoch = migration.assignment_epoch
           ) AS target_cell_incarnation
         FROM relay_assignment_migrations migration
         WHERE migration.source_cell_id = ?
           AND migration.completed_at IS NULL AND migration.aborted_at IS NULL
         ORDER BY migration.user_id, migration.relay_host_id`,
        [input.cellId]
      )
      if (
        migrationIncarnations.some(
          (migration) =>
            optionalText(migration, 'source_cell_incarnation') !== input.cellIncarnation
        )
      ) {
        throw new Error('drain_migration_source_incarnation_mismatch')
      }
      for (const migrationRow of migrationIncarnations) {
        const assignment = assignments.find(
          (candidate) =>
            text(candidate, 'user_id') === text(migrationRow, 'user_id') &&
            text(candidate, 'relay_host_id') === text(migrationRow, 'relay_host_id')
        )
        assertCurrentMigrationAssignment(assignment, migrationRow)
        assertAssignmentActivityAccounting(
          assignment,
          activityLeases.filter(
            (lease) =>
              text(lease, 'user_id') === text(migrationRow, 'user_id') &&
              text(lease, 'relay_host_id') === text(migrationRow, 'relay_host_id')
          ),
          migrationRow
        )
      }
      const sendPermitExpiresAt = now + CELL_DRAIN_SEND_PERMIT_MS
      await transaction.query(
        `UPDATE relay_cell_drain_attempt_states
         SET state = 'send-may-have-started', send_may_have_started_at = ?,
           send_permit_expires_at = ?
         WHERE attempt_id = ?`,
        [now, sendPermitExpiresAt, input.attemptId]
      )
      await transaction.query(
        `INSERT INTO relay_post_drain_migration_pins
         (user_id, relay_host_id, assignment_epoch, drain_attempt_id,
          source_cell_id, source_cell_incarnation, target_cell_id,
          target_cell_incarnation, source_request_units, target_reserved_units,
          pinned_at)
         SELECT migration.user_id, migration.relay_host_id,
           migration.assignment_epoch, ?, migration.source_cell_id,
           incarnation.source_cell_incarnation, migration.target_cell_id,
           incarnation.target_cell_incarnation, migration.source_request_units,
           migration.target_reserved_units, ?
         FROM relay_assignment_migrations migration
         JOIN relay_assignment_migration_incarnations incarnation
           ON incarnation.user_id = migration.user_id
          AND incarnation.relay_host_id = migration.relay_host_id
          AND incarnation.assignment_epoch = migration.assignment_epoch
         WHERE migration.source_cell_id = ?
           AND migration.completed_at IS NULL AND migration.aborted_at IS NULL
         ON CONFLICT (user_id, relay_host_id, assignment_epoch) DO NOTHING`,
        [input.attemptId, now, input.cellId]
      )
      row.state = 'send-may-have-started'
      row.send_may_have_started_at = now
      row.send_permit_expires_at = sendPermitExpiresAt
      return { ...cellDrainAttempt(row), shouldSend: true }
    })
  }

  async recordCellDrainApplicationReceipt(input: {
    attemptId: string
    cellId: string
    cellIncarnation: string
    traceValue: string
    backendStatus: number
    backendInstance?: string
  }): Promise<CellDrainAttempt> {
    const now = this.now()
    return await this.database.transaction(async (transaction) => {
      await this.assertDrainCellGeneration(
        transaction,
        input.cellId,
        input.cellIncarnation
      )
      const row = (
        await transaction.queryLocked(
          `SELECT * FROM relay_cell_drain_attempt_states
           WHERE attempt_id = ? AND cell_id = ?`,
          [input.attemptId, input.cellId]
        )
      )[0]
      if (
        !row ||
        text(row, 'cell_incarnation') !== input.cellIncarnation ||
        text(row, 'trace_value') !== input.traceValue
      ) {
        throw new Error('drain_attempt_not_found')
      }
      if (text(row, 'state') === 'application-receipt') return cellDrainAttempt(row)
      if (
        text(row, 'state') !== 'send-may-have-started' ||
        input.backendStatus < 200 ||
        input.backendStatus >= 300
      ) {
        throw new Error('drain_application_receipt_invalid')
      }
      const retryAfter = now + integer(row, 'planned_grace_ms') + 30_000
      await transaction.query(
        `UPDATE relay_cell_drain_attempt_states
         SET state = 'application-receipt', application_receipt_at = ?,
           backend_success_status = ?, backend_instance = ?,
           receipt_cell_incarnation = ?, retry_after = ?
         WHERE attempt_id = ?`,
        [
          now,
          input.backendStatus,
          input.backendInstance,
          input.cellIncarnation,
          retryAfter,
          input.attemptId
        ]
      )
      row.state = 'application-receipt'
      row.application_receipt_at = now
      row.backend_success_status = input.backendStatus
      row.backend_instance = input.backendInstance ?? null
      row.receipt_cell_incarnation = input.cellIncarnation
      row.retry_after = retryAfter
      return cellDrainAttempt(row)
    })
  }

  async proveCellDrainNotDelivered(input: {
    attemptId: string
    cellId: string
    cellIncarnation: string
  }): Promise<CellDrainAttempt> {
    const now = this.now()
    return await this.database.transaction(async (transaction) => {
      const row = (
        await transaction.queryLocked(
          `SELECT * FROM relay_cell_drain_attempt_states
           WHERE attempt_id = ? AND cell_id = ?`,
          [input.attemptId, input.cellId]
        )
      )[0]
      if (!row || text(row, 'cell_incarnation') !== input.cellIncarnation) {
        throw new Error('drain_attempt_not_found')
      }
      if (text(row, 'state') === 'proven-not-delivered') return cellDrainAttempt(row)
      if (text(row, 'state') !== 'send-may-have-started') {
        throw new Error('drain_delivery_proof_invalid')
      }
      await transaction.query(
        `UPDATE relay_cell_drain_attempt_states
         SET state = 'proven-not-delivered', proven_not_delivered_at = ?
         WHERE attempt_id = ?`,
        [now, input.attemptId]
      )
      row.state = 'proven-not-delivered'
      row.proven_not_delivered_at = now
      return cellDrainAttempt(row)
    })
  }

  async prepareCellDrainRecovery(input: {
    attemptId?: string
    cellId: string
    cellIncarnation: string
  }): Promise<{
    shouldSend: boolean
    retryAfter: number
    preparedAttempt?: CellDrainAttempt
  }> {
    await this.refreshDrainMigrationLeases(input)
    const now = this.now()
    return await this.database.transaction(async (transaction) => {
      await this.assertDrainCellGeneration(
        transaction,
        input.cellId,
        input.cellIncarnation
      )
      const attempt = (
        await transaction.queryLocked(
          `SELECT * FROM relay_cell_drain_attempt_states
           WHERE cell_id = ?
           ORDER BY prepared_at DESC LIMIT 1`,
          [input.cellId]
        )
      )[0]
      if (!attempt || (input.attemptId && text(attempt, 'attempt_id') !== input.attemptId)) {
        throw new Error('drain_application_receipt_missing')
      }
      if (text(attempt, 'state') === 'prepared') {
        if (text(attempt, 'cell_incarnation') !== input.cellIncarnation) {
          throw new Error('drain_application_receipt_missing')
        }
        return {
          shouldSend: false,
          retryAfter: now,
          preparedAttempt: cellDrainAttempt(attempt)
        }
      }
      const applicationReceiptAt = optionalInteger(attempt, 'application_receipt_at')
      const backendSuccessStatus = optionalInteger(attempt, 'backend_success_status')
      const retryAfter = optionalInteger(attempt, 'retry_after')
      if (
        text(attempt, 'state') !== 'application-receipt' ||
        optionalText(attempt, 'receipt_cell_incarnation') !==
          text(attempt, 'cell_incarnation') ||
        applicationReceiptAt === undefined ||
        backendSuccessStatus === undefined ||
        backendSuccessStatus < 200 ||
        backendSuccessStatus >= 300 ||
        retryAfter === undefined
      ) {
        throw new Error('drain_application_receipt_missing')
      }
      if (now < retryAfter) throw new Error('drain_recovery_too_early')
      const attemptId = text(attempt, 'attempt_id')
      if (text(attempt, 'cell_incarnation') !== input.cellIncarnation) {
        const priorRecovery = (
          await transaction.queryLocked(
            `SELECT attempted_at FROM relay_cell_drain_recovery_attempts
             WHERE drain_attempt_id = ? AND cell_incarnation = ?`,
            [attemptId, input.cellIncarnation]
          )
        )[0]
        if (priorRecovery) return { shouldSend: false, retryAfter }
        await transaction.query(
          `INSERT INTO relay_cell_drain_recovery_attempts
           (drain_attempt_id, cell_incarnation, attempted_at) VALUES (?, ?, ?)`,
          [attemptId, input.cellIncarnation, now]
        )
        return { shouldSend: true, retryAfter }
      }
      if (optionalInteger(attempt, 'recover_forward_attempted_at') !== undefined) {
        return { shouldSend: false, retryAfter }
      }
      await transaction.query(
        `UPDATE relay_cell_drain_attempt_states SET recover_forward_attempted_at = ?
         WHERE attempt_id = ? AND recover_forward_attempted_at IS NULL`,
        [now, attemptId]
      )
      return { shouldSend: true, retryAfter }
    })
  }

  async evacuateDeadCells(limit = 100): Promise<number> {
    if (!this.requireLiveCells) return 0
    const cutoff = this.now() - this.heartbeatTtlMs
    const rows = await this.database.query(
      `SELECT assignment.user_id, assignment.relay_host_id, assignment.cell_id
       FROM relay_assignments assignment
       JOIN relay_cells cell ON cell.cell_id = assignment.cell_id
       LEFT JOIN relay_cell_committed_fences committed
         ON committed.cell_id = assignment.cell_id
       LEFT JOIN relay_cell_fence_attempts attempt
         ON attempt.attempt_id = committed.attempt_id
       LEFT JOIN relay_cell_fences fence ON fence.cell_id = assignment.cell_id
       LEFT JOIN relay_cell_runtime runtime ON runtime.cell_id = cell.cell_id
       WHERE (runtime.cell_id IS NULL OR runtime.ready != ? OR runtime.last_heartbeat_at <= ?)
         AND (
           (
             cell.enabled = 1
             AND NOT EXISTS (
               SELECT 1 FROM relay_cell_connection_limits limits
               WHERE limits.cell_id = assignment.cell_id
             )
             AND NOT EXISTS (
               SELECT 1 FROM relay_post_drain_migration_pins pin
               JOIN relay_assignment_migrations migration
                 ON migration.user_id = pin.user_id
                AND migration.relay_host_id = pin.relay_host_id
                AND migration.assignment_epoch = pin.assignment_epoch
               WHERE pin.user_id = assignment.user_id
                 AND pin.relay_host_id = assignment.relay_host_id
                 AND pin.assignment_epoch = assignment.assignment_epoch
                 AND pin.target_cell_id = assignment.cell_id
                 AND migration.completed_at IS NULL
                 AND migration.aborted_at IS NULL
             )
           )
           OR (
             cell.enabled = 0
             AND (
               EXISTS (
                 SELECT 1 FROM relay_cell_connection_limits limits
                 WHERE limits.cell_id = assignment.cell_id
               )
               OR EXISTS (
                 SELECT 1 FROM relay_post_drain_migration_pins pin
                 JOIN relay_assignment_migrations migration
                   ON migration.user_id = pin.user_id
                  AND migration.relay_host_id = pin.relay_host_id
                  AND migration.assignment_epoch = pin.assignment_epoch
                 WHERE pin.user_id = assignment.user_id
                   AND pin.relay_host_id = assignment.relay_host_id
                   AND pin.assignment_epoch = assignment.assignment_epoch
                   AND pin.target_cell_id = assignment.cell_id
                   AND migration.completed_at IS NULL
                   AND migration.aborted_at IS NULL
               )
             )
             AND attempt.completed_at IS NOT NULL
             AND attempt.aborted_at IS NULL
             AND committed.cell_incarnation = runtime.cell_incarnation
             AND fence.cell_incarnation = committed.cell_incarnation
             AND committed.attested_at >= runtime.last_heartbeat_at
             AND committed.expires_at > ?
             AND fence.expires_at > ?
           )
         )
       ORDER BY assignment.user_id, assignment.relay_host_id LIMIT ?`,
      [1, cutoff, this.now(), this.now(), limit]
    )
    let moved = 0
    for (const row of rows) {
      try {
        const assignment = await this.assign({
          userId: text(row, 'user_id'),
          relayHostId: text(row, 'relay_host_id')
        })
        if (assignment.cellId !== text(row, 'cell_id')) moved++
      } catch (error) {
        if (!(error instanceof Error && error.message === 'relay_capacity_exhausted')) throw error
      }
    }
    return moved
  }

  async configureCell(
    cell: RelayCellConfig,
    admission: boolean | CellAdmissionState
  ): Promise<void> {
    const now = this.now()
    const state = typeof admission === 'boolean' ? stateFromEnabled(admission) : admission
    await this.database.transaction(async (transaction) => {
      const cells = await transaction.queryLocked(
        `SELECT * FROM relay_cells ORDER BY cell_id ASC`
      )
      const current = cells.find((row) => text(row, 'cell_id') === cell.id)
      if (current && integer(current, 'reserved_requests') > cell.capacityRequests) {
        throw new Error('cell_capacity_below_reserved')
      }
      // Deploy automation owns tagged URLs; a restarted revision must not overwrite them.
      await transaction.query(
        `INSERT INTO relay_cells
         (cell_id, cell_url, enabled, capacity_requests, reserved_requests,
          observed_requests, last_heartbeat_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (cell_id) DO UPDATE SET
           cell_url = excluded.cell_url,
           enabled = excluded.enabled,
           capacity_requests = excluded.capacity_requests,
           updated_at = excluded.updated_at`,
        [
          cell.id,
          cell.url,
          state === 'existing-only' ? 0 : 1,
          cell.capacityRequests,
          0,
          0,
          now,
          now
        ]
      )
      await transaction.query(
        `INSERT INTO relay_cell_regions (cell_id, region) VALUES (?, ?)
         ON CONFLICT (cell_id) DO UPDATE SET region = excluded.region`,
        [cell.id, cell.region ?? RELAY_DEFAULT_REGION]
      )
      await ensureCellAdmission(transaction, cell.id, state, now)
      await setCellAdmissionBeforeBoundary(transaction, cell.id, state, now)
      if (
        cell.connectionHardCap !== undefined &&
        cell.connectionUnobservedBound !== undefined
      ) {
        const currentLimit = (
          await transaction.queryLocked(
            `SELECT hard_cap, unobserved_bound FROM relay_cell_connection_limits
             WHERE cell_id = ?`,
            [cell.id]
          )
        )[0]
        const limitChanged =
          currentLimit !== undefined &&
          (integer(currentLimit, 'hard_cap') !== cell.connectionHardCap ||
            integer(currentLimit, 'unobserved_bound') !==
              cell.connectionUnobservedBound)
        await transaction.query(
          `INSERT INTO relay_cell_connection_limits
           (cell_id, hard_cap, unobserved_bound, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT (cell_id) DO UPDATE SET
             hard_cap = excluded.hard_cap,
             unobserved_bound = excluded.unobserved_bound,
             updated_at = excluded.updated_at`,
          [cell.id, cell.connectionHardCap, cell.connectionUnobservedBound, now]
        )
        if (limitChanged) {
          await transaction.query(
            `DELETE FROM relay_cell_connection_snapshots WHERE cell_id = ?`,
            [cell.id]
          )
          await transaction.query(
            `DELETE FROM relay_cell_connection_runtime WHERE cell_id = ?`,
            [cell.id]
          )
        }
      }
    })
  }

  async startActiveCellEvacuations(
    sourceCellId: string,
    targetCellId: string,
    limit: number
  ): Promise<number> {
    const rows = await this.database.query(
      `SELECT user_id, relay_host_id FROM relay_assignments
       WHERE cell_id = ? AND
         (reserved_controls > 0 OR reserved_splices > 0 OR reserved_invites > 0 OR
          pending_installs > 0 OR pending_confirmations > 0 OR migration_leases > 0)
       ORDER BY user_id, relay_host_id LIMIT ?`,
      [sourceCellId, limit]
    )
    let started = 0
    for (const row of rows) {
      const migration = await this.startEvacuation(
        { userId: text(row, 'user_id'), relayHostId: text(row, 'relay_host_id') },
        targetCellId,
        sourceCellId
      )
      if (migration) started++
    }
    return started
  }

  async cellEvacuationCapacity(
    sourceCellId: string,
    targetCellId: string
  ): Promise<CellEvacuationCapacity> {
    const cells = await this.database.query(
      `SELECT * FROM relay_cells WHERE cell_id IN (?, ?) ORDER BY cell_id`,
      [sourceCellId, targetCellId]
    )
    if (!cells.some((row) => text(row, 'cell_id') === sourceCellId)) {
      throw new Error('source_cell_not_found')
    }
    const target = cells.find((row) => text(row, 'cell_id') === targetCellId)
    if (!target) throw new Error('target_cell_not_found')
    if (!(await this.cellIsLive(this.database, targetCellId, this.now()))) {
      throw new Error('target_cell_unavailable')
    }
    const summary = (
      await this.database.query(
        `SELECT COUNT(*) AS assignments,
           COALESCE(SUM((SELECT COALESCE(SUM(lease.request_units), 0)
             FROM relay_assignment_activity_leases lease
             WHERE lease.user_id = assignment.user_id
               AND lease.relay_host_id = assignment.relay_host_id)), 0) AS source_units
         FROM relay_assignments assignment
         WHERE assignment.cell_id = ? AND
           (assignment.reserved_controls > 0 OR assignment.reserved_splices > 0 OR
            assignment.reserved_invites > 0 OR assignment.pending_installs > 0 OR
            assignment.pending_confirmations > 0 OR assignment.migration_leases > 0)`,
        [sourceCellId]
      )
    )[0]!
    const sourceAssignments = integer(summary, 'assignments')
    return {
      sourceAssignments,
      // Each migration reserves its future target control plus all source-owned units.
      requiredTargetUnits: integer(summary, 'source_units') + sourceAssignments,
      availableTargetUnits:
        integer(target, 'capacity_requests') - integer(target, 'reserved_requests')
    }
  }

  async cellEvacuationStatus(
    sourceCellId: string,
    targetCellId: string,
    completeReady: boolean
  ): Promise<CellEvacuationStatus> {
    let completed = 0
    let blocked = 0
    const sourceFenced = await this.cellHasActiveFence(sourceCellId)
    if (completeReady) {
      const candidates = await this.activeCellMigrations(sourceCellId, targetCellId)
      for (const [index, row] of candidates.entries()) {
        try {
          const identity = {
            userId: text(row, 'user_id'),
            relayHostId: text(row, 'relay_host_id')
          }
          const assignmentEpoch = integer(row, 'assignment_epoch')
          if (sourceFenced) {
            await this.completeEvacuationFromDeadSource(identity, {
              assignmentEpoch,
              sourceCellId,
              targetCellId
            })
          } else {
            await this.completeEvacuation(identity, assignmentEpoch)
          }
          completed++
        } catch (error) {
          if (error instanceof Error && error.message === 'migration_cell_inventory_busy') {
            blocked += candidates.length - index
            break
          }
          if (isIncompleteMigration(error)) blocked++
          else if (!(error instanceof Error && error.message === 'migration_not_found')) throw error
        }
      }
    }
    const active = await this.activeCellMigrations(sourceCellId, targetCellId)
    const oldestExpiresAt =
      active.length === 0 ? null : Math.min(...active.map((row) => integer(row, 'expires_at')))
    if (completeReady && active.length === 0) {
      await this.reconcileReservationAccounting(sourceCellId, targetCellId)
    }
    const registered = active.filter(
      (row) => optionalInteger(row, 'target_registered_at') !== undefined
    )
    const registeredSourceActive = registered.filter(
      (row) => integer(row, 'source_activity_units') > 0
    ).length
    const registeredCompletable = registered.filter(
      (row) =>
        integer(row, 'source_activity_units') === 0 &&
        integer(row, 'target_control_current') === 1
    ).length
    const registeredTargetInactive = registered.filter(
      (row) =>
        integer(row, 'source_activity_units') === 0 &&
        integer(row, 'target_control_current') === 0
    ).length
    const expiredUnregistered = active.filter(
      (row) =>
        optionalInteger(row, 'target_registered_at') === undefined &&
        integer(row, 'expires_at') <= this.now()
    )
    const repairableExpiredUnregistered = expiredUnregistered.filter(
      (row) => migrationHasExactActiveTarget(row, targetCellId)
    ).length
    const abortableExpiredUnregistered = expiredUnregistered.filter(
      (row) => integer(row, 'target_control_active') === 0
    ).length
    const blockedExpiredUnregistered =
      expiredUnregistered.length -
      repairableExpiredUnregistered -
      abortableExpiredUnregistered
    return {
      inProgress: active.length,
      oldestExpiresAt,
      oldestRemainingMs: oldestExpiresAt === null ? null : oldestExpiresAt - this.now(),
      targetRegistered: registered.length,
      registeredSourceActive,
      registeredCompletable,
      registeredTargetInactive,
      completed,
      blocked,
      expiredUnregistered: expiredUnregistered.length,
      repairableExpiredUnregistered,
      abortableExpiredUnregistered,
      blockedExpiredUnregistered,
      blockedExpiredOnNewerTargetAssignment: expiredUnregistered.filter(
        (row) =>
          integer(row, 'target_control_active') === 1 &&
          optionalText(row, 'current_cell_id') === targetCellId &&
          (optionalInteger(row, 'current_assignment_epoch') ?? 0) >
            integer(row, 'assignment_epoch')
      ).length
    }
  }

  async completeReadyEvacuations(limit = 100): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('invalid_evacuation_completion_limit')
    }
    const now = this.now()
    const runtimeSafety = this.requireLiveCells
      ? `AND EXISTS (
           SELECT 1 FROM relay_cells source_cell
           WHERE source_cell.cell_id = migration.source_cell_id
             AND source_cell.enabled = 0
         )
         AND EXISTS (
           SELECT 1 FROM relay_cells target_cell
           WHERE target_cell.cell_id = migration.target_cell_id
             AND target_cell.enabled = 1
         )
         AND EXISTS (
           SELECT 1 FROM relay_cell_runtime source_runtime
           WHERE source_runtime.cell_id = migration.source_cell_id
             AND source_runtime.ready = 1
             AND source_runtime.observed_requests = 0
             AND source_runtime.last_heartbeat_at > ?
         )
         AND EXISTS (
           SELECT 1 FROM relay_cell_runtime target_runtime
           WHERE target_runtime.cell_id = migration.target_cell_id
             AND target_runtime.ready = 1
             AND target_runtime.last_heartbeat_at > ?
         )`
      : ''
    const targetIncarnation = this.requireLiveCells
      ? `AND target_control.updated_at >= (
           SELECT target_runtime.started_at FROM relay_cell_runtime target_runtime
           WHERE target_runtime.cell_id = migration.target_cell_id
         )`
      : ''
    // Selection avoids polling offline desktops; completeEvacuation rechecks
    // current target activity and zero source ownership under row locks.
    const candidates = await this.database.query(
      `SELECT migration.user_id, migration.relay_host_id, migration.source_cell_id,
         migration.target_cell_id, migration.assignment_epoch
       FROM relay_assignment_migrations migration
       WHERE migration.target_registered_at IS NOT NULL
         AND migration.completed_at IS NULL AND migration.aborted_at IS NULL
         ${runtimeSafety}
         AND NOT EXISTS (
           SELECT 1 FROM relay_assignment_activity_leases source_lease
           WHERE source_lease.user_id = migration.user_id
             AND source_lease.relay_host_id = migration.relay_host_id
             AND source_lease.cell_id = migration.source_cell_id
         )
         AND EXISTS (
           SELECT 1 FROM relay_assignment_activity_leases target_control
           WHERE target_control.user_id = migration.user_id
             AND target_control.relay_host_id = migration.relay_host_id
             AND target_control.cell_id = migration.target_cell_id
             AND target_control.activity_kind = 'control'
             AND target_control.activity_id NOT LIKE 'control-pending:%'
             AND target_control.expires_at > ?
             ${targetIncarnation}
         )
       ORDER BY migration.user_id, migration.relay_host_id
       LIMIT ?`,
      [
        ...(this.requireLiveCells
          ? [now - this.heartbeatTtlMs, now - this.heartbeatTtlMs]
          : []),
        now,
        limit
      ]
    )
    const pairs = new Map<string, { sourceCellId: string; targetCellId: string }>()
    let completed = 0
    for (const row of candidates) {
      const sourceCellId = text(row, 'source_cell_id')
      const targetCellId = text(row, 'target_cell_id')
      pairs.set(JSON.stringify([sourceCellId, targetCellId]), { sourceCellId, targetCellId })
      try {
        await this.completeEvacuation(
          { userId: text(row, 'user_id'), relayHostId: text(row, 'relay_host_id') },
          integer(row, 'assignment_epoch')
        )
        completed++
      } catch (error) {
        if (!isIncompleteMigration(error) && !isMissingMigration(error)) throw error
      }
    }
    for (const { sourceCellId, targetCellId } of pairs.values()) {
      if ((await this.activeCellMigrations(sourceCellId, targetCellId)).length === 0) {
        await this.reconcileReservationAccounting(sourceCellId, targetCellId)
      }
    }
    return completed
  }

  async cellDeploymentStatus(cellId: string): Promise<CellDeploymentStatus> {
    const cellRow = (
      await this.database.query(
        `WITH activity AS (
           SELECT COUNT(*) AS activity_lease_count,
             COALESCE(SUM(request_units), 0) AS activity_request_units,
             COALESCE(SUM(CASE WHEN activity_kind = 'control'
                                    AND activity_id LIKE 'control-pending:%'
                                    AND request_units = 1
                               THEN 1 ELSE 0 END), 0) AS pending_control_units
           FROM relay_assignment_activity_leases WHERE cell_id = ?
         )
         SELECT cell.*, runtime.cell_url AS runtime_cell_url,
           admission.admission_state,
           runtime.cell_incarnation AS runtime_cell_incarnation,
           runtime.started_at AS runtime_started_at, runtime.ready AS runtime_ready,
           runtime.observed_requests AS runtime_observed_requests,
           runtime.last_heartbeat_at AS runtime_last_heartbeat_at,
           COALESCE(capabilities.regional_rehome_protocol, 0)
             AS runtime_regional_rehome_protocol,
           activity.activity_lease_count, activity.activity_request_units,
           activity.activity_lease_count - activity.pending_control_units
             AS restart_blocking_activity_leases,
           activity.activity_request_units - activity.pending_control_units
             AS restart_blocking_activity_request_units,
           cell.reserved_requests - activity.pending_control_units
             AS restart_blocking_reserved_requests
         FROM relay_cells cell
         CROSS JOIN activity
         LEFT JOIN relay_cell_admission admission ON admission.cell_id = cell.cell_id
         LEFT JOIN relay_cell_runtime runtime ON runtime.cell_id = cell.cell_id
         LEFT JOIN relay_cell_capabilities capabilities
           ON capabilities.cell_id = runtime.cell_id
          AND capabilities.cell_incarnation = runtime.cell_incarnation
         WHERE cell.cell_id = ?`,
        [cellId, cellId]
      )
    )[0]
    if (!cellRow) throw new Error('cell_not_found')
    const assignmentRow = (
      await this.database.query(
        `SELECT COUNT(*) AS assignment_count FROM relay_assignments WHERE cell_id = ?`,
        [cellId]
      )
    )[0]!
    const migrationRow = (
      await this.database.query(
        `SELECT
           COALESCE(SUM(CASE WHEN source_cell_id = ? THEN 1 ELSE 0 END), 0)
             AS outgoing_migrations,
           COALESCE(SUM(CASE WHEN target_cell_id = ? THEN 1 ELSE 0 END), 0)
             AS incoming_migrations
         FROM relay_assignment_migrations
         WHERE completed_at IS NULL AND aborted_at IS NULL
           AND (source_cell_id = ? OR target_cell_id = ?)`,
        [cellId, cellId, cellId, cellId]
      )
    )[0]!
    const connectionRow = (
      await this.database.query(
        `SELECT limits.hard_cap, limits.unobserved_bound,
           connection_runtime.total_connections, connection_runtime.in_flight_connections,
           connection_runtime.reserved_connection_units,
           connection_runtime.enforced_connection_units,
           connection_runtime.last_heartbeat_at,
           current_runtime.cell_incarnation AS current_incarnation,
           connection_runtime.cell_incarnation AS connection_incarnation,
           (SELECT COUNT(*) FROM relay_control_connection_reservations reservation
            WHERE reservation.cell_id = limits.cell_id
              AND reservation.state IN
                ('reserved', 'late-arrival-debt', 'claimed')) AS outstanding_reservations
         FROM relay_cell_connection_limits limits
         LEFT JOIN relay_cell_connection_runtime connection_runtime
           ON connection_runtime.cell_id = limits.cell_id
         LEFT JOIN relay_cell_runtime current_runtime
           ON current_runtime.cell_id = limits.cell_id
         WHERE limits.cell_id = ?`,
        [cellId]
      )
    )[0]
    const runtimeHeartbeat = optionalInteger(cellRow, 'runtime_last_heartbeat_at')
    const connectionHeartbeat = connectionRow
      ? optionalInteger(connectionRow, 'last_heartbeat_at')
      : undefined
    return {
      cellId,
      cellUrl: text(cellRow, 'cell_url'),
      region: await this.cellRegion(this.database, cellId),
      enabled: integer(cellRow, 'enabled') === 1,
      admissionState: parseCellAdmissionState(text(cellRow, 'admission_state')),
      capacityRequests: integer(cellRow, 'capacity_requests'),
      reservedRequests: integer(cellRow, 'reserved_requests'),
      assignments: integer(assignmentRow, 'assignment_count'),
      activityLeases: integer(cellRow, 'activity_lease_count'),
      activityRequestUnits: integer(cellRow, 'activity_request_units'),
      restartBlockingActivityLeases: integer(
        cellRow,
        'restart_blocking_activity_leases'
      ),
      restartBlockingActivityRequestUnits: integer(
        cellRow,
        'restart_blocking_activity_request_units'
      ),
      restartBlockingReservedRequests: integer(
        cellRow,
        'restart_blocking_reserved_requests'
      ),
      outgoingMigrations: integer(migrationRow, 'outgoing_migrations'),
      incomingMigrations: integer(migrationRow, 'incoming_migrations'),
      connectionCapacity: connectionRow
          ? {
            hardCap: integer(connectionRow, 'hard_cap'),
            controlRebindReserve: RELAY_ADMISSION_BUDGETS.reservedHostControls,
            ordinaryConnectionLimit:
              integer(connectionRow, 'hard_cap') -
              RELAY_ADMISSION_BUDGETS.reservedHostControls,
            unobservedBound: integer(connectionRow, 'unobserved_bound'),
            normalAdmissionPause:
              integer(connectionRow, 'hard_cap') -
              RELAY_ADMISSION_BUDGETS.reservedHostControls -
              integer(connectionRow, 'unobserved_bound'),
            observedConnections:
              optionalInteger(connectionRow, 'total_connections') ?? 0,
            inFlightConnections:
              optionalInteger(connectionRow, 'in_flight_connections') ?? 0,
            reservedConnectionUnits:
              optionalInteger(connectionRow, 'reserved_connection_units') ?? 0,
            enforcedConnectionUnits:
              optionalInteger(connectionRow, 'enforced_connection_units') ?? 0,
            pendingControlReservations: integer(
              connectionRow,
              'outstanding_reservations'
            ),
            heartbeatFresh:
              connectionHeartbeat !== undefined &&
              connectionHeartbeat > this.now() - this.heartbeatTtlMs &&
              optionalText(connectionRow, 'current_incarnation') ===
                optionalText(connectionRow, 'connection_incarnation')
          }
        : null,
      runtime:
        runtimeHeartbeat === undefined
          ? null
          : {
              cellUrl: text(cellRow, 'runtime_cell_url'),
              cellIncarnation: text(cellRow, 'runtime_cell_incarnation'),
              startedAt: integer(cellRow, 'runtime_started_at'),
              ready: integer(cellRow, 'runtime_ready') === 1,
              observedRequests: integer(cellRow, 'runtime_observed_requests'),
              lastHeartbeatAt: runtimeHeartbeat,
              heartbeatFresh: runtimeHeartbeat > this.now() - this.heartbeatTtlMs,
              regionalRehomeProtocol: integer(
                cellRow,
                'runtime_regional_rehome_protocol'
              )
            }
    }
  }

  async verifyCellAssignment(input: AssignmentIdentity & {
    cellId: string
    assignmentEpoch: number
  }): Promise<boolean> {
    const rows = await this.database.query(
      `SELECT cell_id, assignment_epoch FROM relay_assignments
       WHERE user_id = ? AND relay_host_id = ?`,
      [input.userId, input.relayHostId]
    )
    return Boolean(
      rows[0] &&
        text(rows[0], 'cell_id') === input.cellId &&
        integer(rows[0], 'assignment_epoch') === input.assignmentEpoch
    )
  }

  async changeActivity(
    identity: AssignmentIdentity,
    kind: AssignmentActivityKind,
    delta: 1 | -1
  ): Promise<void> {
    await this.activityQueue.run(identity, async () => {
      const column = ACTIVITY_COLUMN[kind]
      const now = this.now()
      await this.database.transaction(async (transaction) => {
        const row = (
          await transaction.queryLocked(
            `SELECT * FROM relay_assignments WHERE user_id = ? AND relay_host_id = ?`,
            [identity.userId, identity.relayHostId]
          )
        )[0]
        if (!row) return
        const before = integer(row, column)
        const after = Math.max(0, before + delta)
        await transaction.query(
          `UPDATE relay_assignments SET ${column} = ?, lease_expires_at = ?, last_activity_at = ?
           WHERE user_id = ? AND relay_host_id = ?`,
          [after, now + ASSIGNMENT_LIMITS.activityLeaseMs, now, identity.userId, identity.relayHostId]
        )
        const requestDelta = ACTIVITY_REQUEST_UNITS[kind] * (after - before)
        if (requestDelta !== 0) {
          await this.lockCellInventory(transaction)
          await this.adjustCellReservation(transaction, text(row, 'cell_id'), requestDelta)
        }
      })
    })
  }

  async acquireActivity(
    identity: AssignmentIdentity,
    input: {
      activityId: string
      kind: AssignmentActivityKind
      cellId: string
      expiresAt?: number
    }
  ): Promise<void> {
    validateActivityId(input.activityId)
    await this.activityQueue.run(identity, async () => {
      const now = this.now()
      await this.database.transaction(async (transaction) => {
        const assignment = await this.assignmentRow(transaction, identity)
        if (!assignment) throw new Error('assignment_not_found')
        const assignmentCellId = text(assignment, 'cell_id')
        if (input.cellId !== assignmentCellId) {
          // Origin controls may renew work only while the exact forward
          // migration is active; completion must fence late source activity.
          const migration = (
            await transaction.queryLocked(
              `SELECT assignment_epoch FROM relay_assignment_migrations
               WHERE user_id = ? AND relay_host_id = ?
                 AND source_cell_id = ? AND target_cell_id = ?
                 AND assignment_epoch = ?
                 AND completed_at IS NULL AND aborted_at IS NULL`,
              [
                identity.userId,
                identity.relayHostId,
                input.cellId,
                assignmentCellId,
                integer(assignment, 'assignment_epoch')
              ]
            )
          )[0]
          if (!migration) throw new Error('activity_cell_not_authoritative')
        }
        const activityLeases = await this.lockAssignmentActivities(transaction, identity)
        const existing = activityLeaseById(activityLeases, input.activityId)
        const expiresAt = input.expiresAt ?? now + ASSIGNMENT_LIMITS.activityLeaseMs
        if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) {
          throw new Error('invalid_activity_expiry')
        }
        if (existing && text(existing, 'activity_kind') === input.kind && text(existing, 'cell_id') === input.cellId) {
          await transaction.query(
            `UPDATE relay_assignment_activity_leases SET expires_at = ?, updated_at = ?
             WHERE user_id = ? AND relay_host_id = ? AND activity_id = ?`,
            [expiresAt, now, identity.userId, identity.relayHostId, input.activityId]
          )
          await this.touchAssignment(transaction, identity, expiresAt, now)
          return
        }
        const units = ACTIVITY_REQUEST_UNITS[input.kind]
        if (existing) {
          await this.lockCellInventory(transaction)
          await this.removeActivityLease(transaction, identity, existing, now)
          await this.adjustCellReservation(transaction, input.cellId, units)
        }
        await this.adjustActivityCount(transaction, identity, input.kind, 1, expiresAt, now)
        await transaction.query(
          `INSERT INTO relay_assignment_activity_leases
           (user_id, relay_host_id, activity_id, activity_kind, cell_id,
            request_units, expires_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            identity.userId,
            identity.relayHostId,
            input.activityId,
            input.kind,
            input.cellId,
            units,
            expiresAt,
            now
          ]
        )
        // Keep the contended cell row locked for only the final write and commit.
        if (!existing) {
          await this.adjustCellReservationAtomically(transaction, input.cellId, units)
        }
      })
    })
  }

  async renewControlActivity(
    identity: AssignmentIdentity,
    input: { activityId: string; cellId: string; expiresAt: number }
  ): Promise<void> {
    validateActivityId(input.activityId)
    const now = this.now()
    const maximumExpiresAt =
      now +
      ASSIGNMENT_LIMITS.activityLeaseMs +
      RELAY_PROTOCOL_LIMITS.controlPingIntervalMs * 2
    if (
      !Number.isSafeInteger(input.expiresAt) ||
      input.expiresAt <= now ||
      input.expiresAt > maximumExpiresAt
    ) {
      throw new Error('invalid_activity_expiry')
    }
    const startedAt = performance.now()
    let outcome: ControlRenewalOutcome = 'database_error'
    try {
      outcome =
        this.database.dialect === 'postgres'
          ? await this.renewPostgresControlActivity(identity, input, now)
          : await this.renewTransactionalControlActivity(identity, input, now)
      if (outcome !== 'renewed') throw new Error(outcome)
    } catch (error) {
      const message = String((error as { message?: unknown }).message)
      if (CONTROL_RENEWAL_OUTCOMES.has(message as ControlRenewalOutcome)) {
        outcome = message as ControlRenewalOutcome
      }
      throw error
    } finally {
      this.recordControlRenewal?.(performance.now() - startedAt, outcome)
    }
  }

  private async renewPostgresControlActivity(
    identity: AssignmentIdentity,
    input: { activityId: string; cellId: string; expiresAt: number },
    now: number
  ): Promise<ControlRenewalOutcome> {
    const row = (
      await this.database.query(
        `WITH assignment_state AS MATERIALIZED (
           SELECT cell_id, assignment_epoch
           FROM relay_assignments
           WHERE user_id = ? AND relay_host_id = ?
           FOR UPDATE
         ), migration_state AS MATERIALIZED (
           SELECT migration.assignment_epoch
           FROM relay_assignment_migrations migration
           JOIN assignment_state assignment
             ON migration.target_cell_id = assignment.cell_id
            AND migration.assignment_epoch = assignment.assignment_epoch
           WHERE migration.user_id = ? AND migration.relay_host_id = ?
             AND migration.source_cell_id = ?
             AND migration.completed_at IS NULL AND migration.aborted_at IS NULL
           FOR UPDATE OF migration
         ), authorization_state AS MATERIALIZED (
           SELECT 1 AS authorized
           FROM assignment_state assignment
           WHERE assignment.cell_id = ? OR EXISTS (SELECT 1 FROM migration_state)
         ), lease_state AS MATERIALIZED (
           SELECT lease.activity_kind, lease.cell_id
           FROM relay_assignment_activity_leases lease
           CROSS JOIN authorization_state
           WHERE lease.user_id = ? AND lease.relay_host_id = ? AND lease.activity_id = ?
           FOR UPDATE OF lease
         ), renewed_lease AS (
           UPDATE relay_assignment_activity_leases lease
           SET expires_at = GREATEST(lease.expires_at, ?),
               updated_at = GREATEST(lease.updated_at, ?)
           FROM lease_state state
           WHERE lease.user_id = ? AND lease.relay_host_id = ? AND lease.activity_id = ?
             AND state.activity_kind = 'control' AND state.cell_id = ?
           RETURNING 1
         ), renewed_assignment AS (
           UPDATE relay_assignments assignment
           SET lease_expires_at = GREATEST(assignment.lease_expires_at, ?),
               last_activity_at = GREATEST(assignment.last_activity_at, ?)
           WHERE assignment.user_id = ? AND assignment.relay_host_id = ?
             AND EXISTS (SELECT 1 FROM renewed_lease)
           RETURNING 1
         )
         SELECT CASE
           WHEN NOT EXISTS (SELECT 1 FROM assignment_state)
             THEN 'assignment_not_found'
           WHEN NOT EXISTS (SELECT 1 FROM authorization_state)
             THEN 'activity_cell_not_authoritative'
           WHEN NOT EXISTS (SELECT 1 FROM lease_state)
             THEN 'control_activity_not_found'
           WHEN EXISTS (
             SELECT 1 FROM lease_state
             WHERE activity_kind <> 'control' OR cell_id <> ?
           ) THEN 'control_activity_moved'
           WHEN EXISTS (SELECT 1 FROM renewed_assignment) THEN 'renewed'
           ELSE 'control_activity_not_found'
         END AS outcome`,
        [
          identity.userId,
          identity.relayHostId,
          identity.userId,
          identity.relayHostId,
          input.cellId,
          input.cellId,
          identity.userId,
          identity.relayHostId,
          input.activityId,
          input.expiresAt,
          now,
          identity.userId,
          identity.relayHostId,
          input.activityId,
          input.cellId,
          input.expiresAt,
          now,
          identity.userId,
          identity.relayHostId,
          input.cellId
        ]
      )
    )[0]
    if (!row) throw new Error('missing_control_renewal_outcome')
    const outcome = text(row, 'outcome') as ControlRenewalOutcome
    if (!CONTROL_RENEWAL_OUTCOMES.has(outcome)) throw new Error('invalid_control_renewal_outcome')
    return outcome
  }

  private async renewTransactionalControlActivity(
    identity: AssignmentIdentity,
    input: { activityId: string; cellId: string; expiresAt: number },
    now: number
  ): Promise<ControlRenewalOutcome> {
    // Bypass the process queue so a network-stalled activity call cannot suppress renewal.
    await this.database.transaction(async (transaction) => {
      const assignment = await this.assignmentRow(transaction, identity)
      if (!assignment) throw new Error('assignment_not_found')
      const assignmentCellId = text(assignment, 'cell_id')
      if (input.cellId !== assignmentCellId) {
        const migration = (
          await transaction.queryLocked(
            `SELECT assignment_epoch FROM relay_assignment_migrations
             WHERE user_id = ? AND relay_host_id = ?
               AND source_cell_id = ? AND target_cell_id = ?
               AND assignment_epoch = ?
               AND completed_at IS NULL AND aborted_at IS NULL`,
            [
              identity.userId,
              identity.relayHostId,
              input.cellId,
              assignmentCellId,
              integer(assignment, 'assignment_epoch')
            ]
          )
        )[0]
        if (!migration) throw new Error('activity_cell_not_authoritative')
      }
      const lease = (
        await transaction.queryLocked(
          `SELECT * FROM relay_assignment_activity_leases
           WHERE user_id = ? AND relay_host_id = ? AND activity_id = ?`,
          [identity.userId, identity.relayHostId, input.activityId]
        )
      )[0]
      if (!lease) throw new Error('control_activity_not_found')
      if (
        text(lease, 'activity_kind') !== 'control' ||
        text(lease, 'cell_id') !== input.cellId
      ) {
        throw new Error('control_activity_moved')
      }
      await transaction.query(
        `UPDATE relay_assignment_activity_leases SET
           expires_at = CASE WHEN expires_at > ? THEN expires_at ELSE ? END,
           updated_at = CASE WHEN updated_at > ? THEN updated_at ELSE ? END
         WHERE user_id = ? AND relay_host_id = ? AND activity_id = ?`,
        [
          input.expiresAt,
          input.expiresAt,
          now,
          now,
          identity.userId,
          identity.relayHostId,
          input.activityId
        ]
      )
      await transaction.query(
        `UPDATE relay_assignments SET
           lease_expires_at = CASE WHEN lease_expires_at > ? THEN lease_expires_at ELSE ? END,
           last_activity_at = CASE WHEN last_activity_at > ? THEN last_activity_at ELSE ? END
         WHERE user_id = ? AND relay_host_id = ?`,
        [input.expiresAt, input.expiresAt, now, now, identity.userId, identity.relayHostId]
      )
    })
    return 'renewed'
  }

  async releaseActivity(identity: AssignmentIdentity, activityId: string): Promise<boolean> {
    validateActivityId(activityId)
    return await this.activityQueue.run(identity, async () => {
      const now = this.now()
      return await this.database.transaction(async (transaction) => {
        await this.assignmentRow(transaction, identity)
        const activityLeases = await this.lockAssignmentActivities(transaction, identity)
        const existing = activityLeaseById(activityLeases, activityId)
        if (!existing) return false
        await transaction.query(
          `DELETE FROM relay_assignment_activity_leases
           WHERE user_id = ? AND relay_host_id = ? AND activity_id = ?`,
          [identity.userId, identity.relayHostId, activityId]
        )
        await this.adjustActivityCount(
          transaction,
          identity,
          activityKind(existing),
          -1,
          now,
          now
        )
        // Release paths can safely defer the cell-row lock until their final write.
        await this.adjustCellReservationAtomically(
          transaction,
          text(existing, 'cell_id'),
          -integer(existing, 'request_units')
        )
        return true
      })
    })
  }

  async activateControl(
    identity: AssignmentIdentity,
    input: {
      cellId: string
      assignmentEpoch: number
      generation: number
      connectionInclusionWatermark?: number
    }
  ): Promise<string> {
    const activityId = `control:${input.cellId}:${input.generation}`
    validateActivityId(activityId)
    return await this.activityQueue.run(identity, async () => {
      const now = this.now()
      return await this.database.transaction(async (transaction) => {
        const assignment = await this.assignmentRow(transaction, identity)
        if (
          !assignment ||
          text(assignment, 'cell_id') !== input.cellId ||
          integer(assignment, 'assignment_epoch') !== input.assignmentEpoch
        ) {
          throw new Error('wrong_assignment')
        }
        const expiresAt = now + ASSIGNMENT_LIMITS.activityLeaseMs
        const activityLeases = await this.lockAssignmentActivities(transaction, identity)
        const existing = activityLeaseById(activityLeases, activityId)
        const pendingId = pendingControlActivityId(input.assignmentEpoch)
        const pending = activityLeaseById(activityLeases, pendingId)
        const retainedActivityId =
          existing || (pending && text(pending, 'cell_id') === input.cellId)
            ? existing
              ? activityId
              : pendingId
            : activityId
        await this.removeSupersededSameCellControls(
          transaction,
          identity,
          activityLeases,
          input.cellId,
          retainedActivityId,
          now
        )
        if (existing) {
          await transaction.query(
            `UPDATE relay_assignment_activity_leases SET expires_at = ?, updated_at = ?
             WHERE user_id = ? AND relay_host_id = ? AND activity_id = ?`,
            [expiresAt, now, identity.userId, identity.relayHostId, activityId]
          )
          await this.touchAssignment(transaction, identity, expiresAt, now)
        } else {
          if (pending && text(pending, 'cell_id') === input.cellId) {
            await transaction.query(
              `UPDATE relay_assignment_activity_leases
               SET activity_id = ?, expires_at = ?, updated_at = ?
               WHERE user_id = ? AND relay_host_id = ? AND activity_id = ?`,
              [activityId, expiresAt, now, identity.userId, identity.relayHostId, pendingId]
            )
            await this.touchAssignment(transaction, identity, expiresAt, now)
          } else {
            await this.lockCellInventory(transaction)
            await this.adjustCellReservation(transaction, input.cellId, 1)
            await this.adjustActivityCount(transaction, identity, 'control', 1, expiresAt, now)
            await transaction.query(
              `INSERT INTO relay_assignment_activity_leases
               (user_id, relay_host_id, activity_id, activity_kind, cell_id,
                request_units, expires_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                identity.userId,
                identity.relayHostId,
                activityId,
                'control',
                input.cellId,
                1,
                expiresAt,
                now
              ]
            )
          }
        }
        await this.claimControlConnectionReservation(
          transaction,
          identity,
          input.cellId,
          input.assignmentEpoch,
          activityId,
          input.connectionInclusionWatermark,
          now
        )
        return activityId
      })
    })
  }

  async startEvacuation(
    identity: AssignmentIdentity,
    targetCellId: string
  ): Promise<RelayAssignmentMigration>
  async startEvacuation(
    identity: AssignmentIdentity,
    targetCellId: string,
    expectedSourceCellId: string
  ): Promise<RelayAssignmentMigration | null>
  async startEvacuation(
    identity: AssignmentIdentity,
    targetCellId: string,
    expectedSourceCellId?: string
  ): Promise<RelayAssignmentMigration | null> {
    const now = this.now()
    return await this.database.transaction(async (transaction) => {
      const assignment = await this.assignmentRow(transaction, identity)
      if (!assignment) throw new Error('assignment_not_found')
      const sourceCellId = text(assignment, 'cell_id')
      // Bulk selection is intentionally staleable; fence it before considering
      // an existing migration that already moved the assignment to its target.
      if (expectedSourceCellId && sourceCellId !== expectedSourceCellId) return null
      const existing = (
        await transaction.queryLocked(
          `SELECT * FROM relay_assignment_migrations
           WHERE user_id = ? AND relay_host_id = ? AND completed_at IS NULL
             AND aborted_at IS NULL AND expires_at > ?
           ORDER BY assignment_epoch DESC LIMIT 1`,
          [identity.userId, identity.relayHostId, now]
        )
      )[0]
      if (existing) {
        if (text(existing, 'target_cell_id') !== targetCellId) {
          throw new Error('migration_in_progress')
        }
        return migration(identity, existing)
      }
      if (sourceCellId === targetCellId) throw new Error('target_matches_source')
      await this.lockAssignmentActivities(transaction, identity)
      const cells = await this.lockCellInventory(transaction)
      const target = cells.find((row) => text(row, 'cell_id') === targetCellId)
      if (!target || integer(target, 'enabled') !== 1) throw new Error('target_cell_unavailable')
      if (!(await this.cellIsLive(transaction, targetCellId, now))) {
        throw new Error('target_cell_unavailable')
      }
      let sourceCellIncarnation: string | undefined
      let targetCellIncarnation: string | undefined
      if (this.requireLiveCells) {
        const runtimes = await transaction.queryLocked(
          `SELECT * FROM relay_cell_runtime WHERE cell_id IN (?, ?) ORDER BY cell_id`,
          [sourceCellId, targetCellId]
        )
        const sourceRuntime = runtimes.find(
          (runtime) => text(runtime, 'cell_id') === sourceCellId
        )
        const targetRuntime = runtimes.find(
          (runtime) => text(runtime, 'cell_id') === targetCellId
        )
        if (
          !sourceRuntime ||
          integer(sourceRuntime, 'ready') !== 1 ||
          integer(sourceRuntime, 'last_heartbeat_at') <= now - this.heartbeatTtlMs
        ) {
          throw new Error('source_cell_unavailable')
        }
        if (
          !targetRuntime ||
          integer(targetRuntime, 'ready') !== 1 ||
          integer(targetRuntime, 'last_heartbeat_at') <= now - this.heartbeatTtlMs
        ) {
          throw new Error('target_cell_unavailable')
        }
        sourceCellIncarnation = text(sourceRuntime, 'cell_incarnation')
        targetCellIncarnation = text(targetRuntime, 'cell_incarnation')
      }
      await this.assertCellConnectionHeadroom(transaction, targetCellId)
      const sourceUnitsRow = (
        await transaction.query(
          `SELECT COALESCE(SUM(request_units), 0) AS units
           FROM relay_assignment_activity_leases
           WHERE user_id = ? AND relay_host_id = ? AND cell_id = ?`,
          [identity.userId, identity.relayHostId, sourceCellId]
        )
      )[0]
      const sourceRequestUnits = integer(sourceUnitsRow!, 'units')
      const targetReservedUnits = sourceRequestUnits + 1
      await this.adjustCellReservation(transaction, targetCellId, targetReservedUnits)
      const previousEpoch = integer(assignment, 'assignment_epoch')
      const assignmentEpoch = previousEpoch + 1
      const expiresAt = now + ASSIGNMENT_LIMITS.migrationLeaseMs
      await transaction.query(
        `UPDATE relay_assignments SET cell_id = ?, assignment_epoch = ?,
           reserved_controls = reserved_controls + 1,
           migration_leases = migration_leases + 1,
           lease_expires_at = ?, last_activity_at = ?
         WHERE user_id = ? AND relay_host_id = ?`,
        [
          targetCellId,
          assignmentEpoch,
          expiresAt,
          now,
          identity.userId,
          identity.relayHostId
        ]
      )
      await transaction.query(
        `INSERT INTO relay_assignment_activity_leases
         (user_id, relay_host_id, activity_id, activity_kind, cell_id,
          request_units, expires_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          identity.userId,
          identity.relayHostId,
          pendingControlActivityId(assignmentEpoch),
          'control',
          targetCellId,
          1,
          expiresAt,
          now,
          identity.userId,
          identity.relayHostId,
          migrationActivityId(assignmentEpoch),
          'migration',
          targetCellId,
          sourceRequestUnits,
          expiresAt,
          now
        ]
      )
      await this.insertControlConnectionReservation(
        transaction,
        identity,
        targetCellId,
        assignmentEpoch,
        expiresAt,
        now
      )
      await transaction.query(
        `INSERT INTO relay_assignment_migrations
         (user_id, relay_host_id, source_cell_id, target_cell_id,
          previous_epoch, assignment_epoch, source_request_units,
          target_reserved_units, expires_at, target_registered_at,
          completed_at, aborted_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)`,
        [
          identity.userId,
          identity.relayHostId,
          sourceCellId,
          targetCellId,
          previousEpoch,
          assignmentEpoch,
          sourceRequestUnits,
          targetReservedUnits,
          expiresAt,
          now,
          now
        ]
      )
      if (sourceCellIncarnation && targetCellIncarnation) {
        await transaction.query(
          `INSERT INTO relay_assignment_migration_incarnations
           (user_id, relay_host_id, assignment_epoch, source_cell_incarnation,
            target_cell_incarnation)
           VALUES (?, ?, ?, ?, ?)`,
          [
            identity.userId,
            identity.relayHostId,
            assignmentEpoch,
            sourceCellIncarnation,
            targetCellIncarnation
          ]
        )
      }
      return {
        ...identity,
        sourceCellId,
        targetCellId,
        previousEpoch,
        assignmentEpoch,
        expiresAt
      }
    })
  }

  async markMigrationTargetRegistered(
    identity: AssignmentIdentity,
    input: { cellId: string; assignmentEpoch: number }
  ): Promise<boolean> {
    const now = this.now()
    return await this.database.transaction(async (transaction) => {
      const rows = await transaction.queryLocked(
        `SELECT * FROM relay_assignment_migrations
         WHERE user_id = ? AND relay_host_id = ? AND assignment_epoch = ?
           AND target_cell_id = ? AND completed_at IS NULL AND aborted_at IS NULL`,
        [
          identity.userId,
          identity.relayHostId,
          input.assignmentEpoch,
          input.cellId
        ]
      )
      if (!rows[0]) return false
      await transaction.query(
        `UPDATE relay_assignment_migrations
         SET target_registered_at = COALESCE(target_registered_at, ?), updated_at = ?
         WHERE user_id = ? AND relay_host_id = ? AND assignment_epoch = ?`,
        [now, now, identity.userId, identity.relayHostId, input.assignmentEpoch]
      )
      return true
    })
  }

  async completeEvacuationFromDeadSource(
    identity: AssignmentIdentity,
    input: {
      assignmentEpoch: number
      sourceCellId: string
      targetCellId: string
    }
  ): Promise<DeadSourceCompletionResult> {
    try {
      return await this.withAssignmentLockRetry(
        async (inventoryFirst) =>
          await this.completeEvacuationFromDeadSourceOnce(identity, input, inventoryFirst)
      )
    } catch (error) {
      if (isDatabaseLockUnavailable(error)) {
        throw new Error('migration_cell_inventory_busy')
      }
      throw error
    }
  }

  private async completeEvacuationFromDeadSourceOnce(
    identity: AssignmentIdentity,
    input: {
      assignmentEpoch: number
      sourceCellId: string
      targetCellId: string
    },
    inventoryFirst: boolean
  ): Promise<DeadSourceCompletionResult> {
    const now = this.now()
    return await this.database.transaction(async (transaction) => {
      let lockedCells: SqlRow[] | undefined
      if (inventoryFirst) {
        try {
          lockedCells = await this.lockCellInventory(transaction)
        } catch (error) {
          if (isDatabaseLockTimeout(error)) {
            throw new Error('database_lock_unavailable')
          }
          throw error
        }
      }
      const assignment = await this.assignmentRow(transaction, identity, inventoryFirst)
      const row = (
        await transaction.queryLocked(
          `SELECT * FROM relay_assignment_migrations
           WHERE user_id = ? AND relay_host_id = ? AND assignment_epoch = ?`,
          [identity.userId, identity.relayHostId, input.assignmentEpoch]
        )
      )[0]
      if (!row) throw new Error('migration_not_found')
      assertMigrationPair(row, input.sourceCellId, input.targetCellId)
      if (optionalInteger(row, 'completed_at') !== undefined) {
        return deadSourceCompletionResult(row, false)
      }
      if (optionalInteger(row, 'aborted_at') !== undefined) {
        throw new Error('migration_already_aborted')
      }
      if (optionalInteger(row, 'target_registered_at') === undefined) {
        throw new Error('migration_target_not_registered')
      }
      assertCurrentMigrationAssignment(assignment, row)
      const activityLeases = await this.lockAssignmentActivities(transaction, identity)
      assertAssignmentActivityAccounting(assignment, activityLeases, row)
      if (
        activityLeases.some(
          (lease) =>
            ![input.sourceCellId, input.targetCellId].includes(text(lease, 'cell_id'))
        )
      ) {
        throw new Error('migration_activity_topology_mismatch')
      }
      if (activityUnitsForCell(activityLeases, input.sourceCellId) > 0) {
        throw new Error('migration_source_still_active')
      }
      const cells = lockedCells ?? (await this.lockCellInventory(transaction, true))
      const source = cells.find((cell) => text(cell, 'cell_id') === input.sourceCellId)
      const target = cells.find((cell) => text(cell, 'cell_id') === input.targetCellId)
      if (!source || integer(source, 'enabled') !== 0) {
        throw new Error('migration_source_admission_changed')
      }
      if (!target || integer(target, 'enabled') !== 1) {
        throw new Error('migration_target_admission_changed')
      }
      await assertCellReservationAccounting(transaction, cells, [
        input.sourceCellId,
        input.targetCellId
      ])
      const runtimes = await transaction.queryLocked(
        `SELECT * FROM relay_cell_runtime WHERE cell_id IN (?, ?) ORDER BY cell_id`,
        [input.sourceCellId, input.targetCellId]
      )
      const sourceRuntime = runtimes.find(
        (runtime) => text(runtime, 'cell_id') === input.sourceCellId
      )
      const targetRuntime = runtimes.find(
        (runtime) => text(runtime, 'cell_id') === input.targetCellId
      )
      const freshAfter = now - this.heartbeatTtlMs
      await this.requireCellFence(transaction, input.sourceCellId, sourceRuntime, now)
      if (!sourceRuntime || integer(sourceRuntime, 'last_heartbeat_at') > freshAfter) {
        throw new Error('migration_source_runtime_not_dead')
      }
      if (
        !targetRuntime ||
        integer(targetRuntime, 'ready') !== 1 ||
        integer(targetRuntime, 'last_heartbeat_at') <= freshAfter
      ) {
        throw new Error('migration_target_runtime_not_ready')
      }
      const targetIsActive = activityLeases.some(
        (lease) =>
          text(lease, 'cell_id') === input.targetCellId &&
          text(lease, 'activity_kind') === 'control' &&
          !text(lease, 'activity_id').startsWith('control-pending:') &&
          integer(lease, 'expires_at') > now &&
          integer(lease, 'updated_at') >= integer(targetRuntime, 'started_at')
      )
      if (!targetIsActive) {
        const inactiveTargetControls = activityLeases.filter(
          (lease) =>
            text(lease, 'cell_id') === input.targetCellId &&
            text(lease, 'activity_kind') === 'control'
        )
        for (const lease of inactiveTargetControls) {
          await this.removeActivityLease(transaction, identity, lease, now)
        }
        await this.releaseSupersededControlConnectionReservations(
          transaction,
          identity,
          input.targetCellId,
          input.assignmentEpoch,
          now
        )
      }
      const migrationLease = activityLeaseById(
        activityLeases,
        migrationActivityId(input.assignmentEpoch)
      )
      if (migrationLease) {
        await this.removeActivityLease(transaction, identity, migrationLease, now)
      }
      await transaction.query(
        `UPDATE relay_assignment_migrations SET completed_at = ?, updated_at = ?
         WHERE user_id = ? AND relay_host_id = ? AND assignment_epoch = ?`,
        [now, now, identity.userId, identity.relayHostId, input.assignmentEpoch]
      )
      return deadSourceCompletionResult(row, true)
    })
  }

  async supersedeRegisteredEvacuation(
    identity: AssignmentIdentity,
    input: RegisteredEvacuationSupersessionInput,
    preservedActivityCellIds: readonly string[] = []
  ): Promise<RelayAssignmentMigration> {
    if (input.assignmentEpoch >= Number.MAX_SAFE_INTEGER) {
      throw new Error('assignment_epoch_exhausted')
    }
    return await this.withAssignmentLockRetry(
      async (inventoryFirst) =>
        await this.supersedeRegisteredEvacuationOnce(
          identity,
          input,
          inventoryFirst,
          preservedActivityCellIds
        )
    )
  }

  private async supersedeRegisteredEvacuationOnce(
    identity: AssignmentIdentity,
    input: RegisteredEvacuationSupersessionInput,
    inventoryFirst: boolean,
    preservedActivityCellIds: readonly string[]
  ): Promise<RelayAssignmentMigration> {
    const now = this.now()
    return await this.database.transaction(async (transaction) => {
      const lockedCells = inventoryFirst
        ? await this.lockCellInventory(transaction)
        : undefined
      const assignment = await this.assignmentRow(transaction, identity, inventoryFirst)
      const existing = (
        await transaction.queryLocked(
          `SELECT * FROM relay_assignment_migrations
           WHERE user_id = ? AND relay_host_id = ? AND assignment_epoch = ?`,
          [identity.userId, identity.relayHostId, input.assignmentEpoch]
        )
      )[0]
      if (!existing) throw new Error('migration_not_found')
      assertMigrationPair(existing, input.sourceCellId, input.currentTargetCellId)
      if (optionalInteger(existing, 'completed_at') !== undefined) {
        throw new Error('migration_already_completed')
      }
      if (optionalInteger(existing, 'aborted_at') !== undefined) {
        const successor = (
          await transaction.queryLocked(
            `SELECT * FROM relay_assignment_migrations
             WHERE user_id = ? AND relay_host_id = ? AND previous_epoch = ?
               AND source_cell_id = ? AND target_cell_id = ?
             ORDER BY assignment_epoch DESC LIMIT 1`,
            [
              identity.userId,
              identity.relayHostId,
              input.assignmentEpoch,
              input.sourceCellId,
              input.replacementTargetCellId
            ]
          )
        )[0]
        if (!successor) throw new Error('migration_already_superseded')
        return migration(identity, successor)
      }
      if (optionalInteger(existing, 'target_registered_at') === undefined) {
        throw new Error('migration_target_not_registered')
      }
      const existingIncarnation = (
        await transaction.queryLocked(
          `SELECT * FROM relay_assignment_migration_incarnations
           WHERE user_id = ? AND relay_host_id = ? AND assignment_epoch = ?`,
          [identity.userId, identity.relayHostId, input.assignmentEpoch]
        )
      )[0]
      const existingPin = (
        await transaction.queryLocked(
          `SELECT * FROM relay_post_drain_migration_pins
           WHERE user_id = ? AND relay_host_id = ? AND assignment_epoch = ?`,
          [identity.userId, identity.relayHostId, input.assignmentEpoch]
        )
      )[0]
      if (existingPin && !existingIncarnation) {
        throw new Error('drain_migration_source_incarnation_mismatch')
      }
      assertCurrentMigrationAssignment(assignment, existing)
      if (input.currentTargetCellId === input.replacementTargetCellId) {
        throw new Error('target_matches_source')
      }
      const activityLeases = await this.lockAssignmentActivities(transaction, identity)
      assertAssignmentActivityAccounting(assignment, activityLeases, existing)
      const additionalActivityCellIds = new Set(
        activityLeases
          .map((lease) => text(lease, 'cell_id'))
          .filter(
            (cellId) =>
              ![input.sourceCellId, input.currentTargetCellId].includes(cellId)
          )
      )
      if (
        preservedActivityCellIds.includes(input.replacementTargetCellId) ||
        !matchesExactCellSet(additionalActivityCellIds, preservedActivityCellIds)
      ) {
        throw new Error('migration_activity_topology_mismatch')
      }
      const cells = lockedCells ?? (await this.lockCellInventory(transaction, true))
      const source = cells.find((cell) => text(cell, 'cell_id') === input.sourceCellId)
      const currentTarget = cells.find(
        (cell) => text(cell, 'cell_id') === input.currentTargetCellId
      )
      const replacement = cells.find(
        (cell) => text(cell, 'cell_id') === input.replacementTargetCellId
      )
      if (!source || integer(source, 'enabled') !== 0) {
        throw new Error('migration_source_admission_changed')
      }
      if (!currentTarget || integer(currentTarget, 'enabled') !== 0) {
        throw new Error('migration_target_still_enabled')
      }
      if (!replacement || integer(replacement, 'enabled') !== 1) {
        throw new Error('replacement_target_unavailable')
      }
      await assertCellReservationAccounting(transaction, cells, [
        input.sourceCellId,
        input.currentTargetCellId,
        input.replacementTargetCellId,
        ...preservedActivityCellIds
      ])
      const runtimeCellIds = [
        input.currentTargetCellId,
        input.replacementTargetCellId,
        ...preservedActivityCellIds
      ]
      const runtimes = await transaction.queryLocked(
        `SELECT * FROM relay_cell_runtime
         WHERE cell_id IN (${runtimeCellIds.map(() => '?').join(', ')})
         ORDER BY cell_id`,
        runtimeCellIds
      )
      const currentRuntime = runtimes.find(
        (runtime) => text(runtime, 'cell_id') === input.currentTargetCellId
      )
      const replacementRuntime = runtimes.find(
        (runtime) => text(runtime, 'cell_id') === input.replacementTargetCellId
      )
      const freshAfter = now - this.heartbeatTtlMs
      await this.requireCellFence(
        transaction,
        input.currentTargetCellId,
        currentRuntime,
        now
      )
      if (
        currentRuntime &&
        integer(currentRuntime, 'ready') === 1 &&
        integer(currentRuntime, 'last_heartbeat_at') > freshAfter
      ) {
        throw new Error('migration_target_still_available')
      }
      if (
        !replacementRuntime ||
        integer(replacementRuntime, 'ready') !== 1 ||
        integer(replacementRuntime, 'last_heartbeat_at') <= freshAfter
      ) {
        throw new Error('replacement_target_unavailable')
      }
      if (
        preservedActivityCellIds.some((cellId) => {
          const runtime = runtimes.find((row) => text(row, 'cell_id') === cellId)
          return (
            !runtime ||
            integer(runtime, 'ready') !== 1 ||
            integer(runtime, 'last_heartbeat_at') <= freshAfter
          )
        })
      ) {
        throw new Error('migration_preserved_activity_cell_unavailable')
      }
      await this.assertCellConnectionHeadroom(
        transaction,
        input.replacementTargetCellId
      )
      for (const lease of activityLeases.filter(
        (candidate) => text(candidate, 'cell_id') === input.currentTargetCellId
      )) {
        await this.removeActivityLease(transaction, identity, lease, now)
      }
      const sourceRequestUnits = activityUnitsForCell(activityLeases, input.sourceCellId)
      const targetReservedUnits = sourceRequestUnits + 1
      await this.adjustCellReservation(
        transaction,
        input.replacementTargetCellId,
        targetReservedUnits
      )
      const assignmentEpoch = input.assignmentEpoch + 1
      const expiresAt = now + ASSIGNMENT_LIMITS.migrationLeaseMs
      await transaction.query(
        `UPDATE relay_assignments SET cell_id = ?, assignment_epoch = ?,
           reserved_controls = reserved_controls + 1,
           migration_leases = migration_leases + 1,
           lease_expires_at = ?, last_activity_at = ?
         WHERE user_id = ? AND relay_host_id = ?`,
        [
          input.replacementTargetCellId,
          assignmentEpoch,
          expiresAt,
          now,
          identity.userId,
          identity.relayHostId
        ]
      )
      await transaction.query(
        `INSERT INTO relay_assignment_activity_leases
         (user_id, relay_host_id, activity_id, activity_kind, cell_id,
          request_units, expires_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          identity.userId,
          identity.relayHostId,
          pendingControlActivityId(assignmentEpoch),
          'control',
          input.replacementTargetCellId,
          1,
          expiresAt,
          now,
          identity.userId,
          identity.relayHostId,
          migrationActivityId(assignmentEpoch),
          'migration',
          input.replacementTargetCellId,
          sourceRequestUnits,
          expiresAt,
          now
        ]
      )
      await this.insertControlConnectionReservation(
        transaction,
        identity,
        input.replacementTargetCellId,
        assignmentEpoch,
        expiresAt,
        now
      )
      await this.releaseSupersededControlConnectionReservations(
        transaction,
        identity,
        input.currentTargetCellId,
        input.assignmentEpoch,
        now
      )
      await transaction.query(
        `UPDATE relay_assignment_migrations SET aborted_at = ?, updated_at = ?
         WHERE user_id = ? AND relay_host_id = ? AND assignment_epoch = ?`,
        [now, now, identity.userId, identity.relayHostId, input.assignmentEpoch]
      )
      await transaction.query(
        `INSERT INTO relay_assignment_migrations
         (user_id, relay_host_id, source_cell_id, target_cell_id,
          previous_epoch, assignment_epoch, source_request_units,
          target_reserved_units, expires_at, target_registered_at,
          completed_at, aborted_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)`,
        [
          identity.userId,
          identity.relayHostId,
          input.sourceCellId,
          input.replacementTargetCellId,
          input.assignmentEpoch,
          assignmentEpoch,
          sourceRequestUnits,
          targetReservedUnits,
          expiresAt,
          now,
          now
        ]
      )
      if (existingIncarnation) {
        await transaction.query(
          `INSERT INTO relay_assignment_migration_incarnations
           (user_id, relay_host_id, assignment_epoch, source_cell_incarnation,
            target_cell_incarnation)
           VALUES (?, ?, ?, ?, ?)`,
          [
            identity.userId,
            identity.relayHostId,
            assignmentEpoch,
            text(existingIncarnation, 'source_cell_incarnation'),
            text(replacementRuntime, 'cell_incarnation')
          ]
        )
      }
      if (existingPin) {
        await transaction.query(
          `INSERT INTO relay_post_drain_migration_pins
           (user_id, relay_host_id, assignment_epoch, drain_attempt_id,
            source_cell_id, source_cell_incarnation, target_cell_id,
            target_cell_incarnation, source_request_units, target_reserved_units,
            pinned_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            identity.userId,
            identity.relayHostId,
            assignmentEpoch,
            text(existingPin, 'drain_attempt_id'),
            input.sourceCellId,
            text(existingPin, 'source_cell_incarnation'),
            input.replacementTargetCellId,
            text(replacementRuntime, 'cell_incarnation'),
            sourceRequestUnits,
            targetReservedUnits,
            now
          ]
        )
      }
      return {
        ...identity,
        sourceCellId: input.sourceCellId,
        targetCellId: input.replacementTargetCellId,
        previousEpoch: input.assignmentEpoch,
        assignmentEpoch,
        expiresAt
      }
    })
  }

  async supersedeRegisteredCellEvacuations(
    sourceCellId: string,
    currentTargetCellId: string,
    replacementTargetCellId: string,
    limit: number
  ): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('invalid_evacuation_limit')
    }
    const rows = await this.database.query(
      `SELECT user_id, relay_host_id, assignment_epoch
       FROM relay_assignment_migrations
       WHERE source_cell_id = ? AND target_cell_id = ?
         AND target_registered_at IS NOT NULL
         AND completed_at IS NULL AND aborted_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM relay_assignment_migrations earlier
           WHERE earlier.user_id = relay_assignment_migrations.user_id
             AND earlier.relay_host_id = relay_assignment_migrations.relay_host_id
             AND earlier.source_cell_id = relay_assignment_migrations.source_cell_id
             AND earlier.target_cell_id = relay_assignment_migrations.target_cell_id
             AND earlier.target_registered_at IS NOT NULL
             AND earlier.completed_at IS NULL AND earlier.aborted_at IS NULL
             AND earlier.assignment_epoch < relay_assignment_migrations.assignment_epoch
         )
       ORDER BY user_id, relay_host_id, assignment_epoch
       LIMIT ?`,
      [sourceCellId, currentTargetCellId, limit]
    )
    let superseded = 0
    let reconciledAccounting = false
    for (const row of rows) {
      const identity = {
        userId: text(row, 'user_id'),
        relayHostId: text(row, 'relay_host_id')
      }
      const input = {
        assignmentEpoch: integer(row, 'assignment_epoch'),
        sourceCellId,
        currentTargetCellId,
        replacementTargetCellId
      }
      const prepared = await this.prepareRegisteredCellSupersession(identity, input)
      if (prepared.retired) {
        input.assignmentEpoch = integer(row, 'assignment_epoch')
        await this.supersedeRegisteredEvacuation(identity, input)
        superseded++
        continue
      }
      input.assignmentEpoch = prepared.assignmentEpoch
      try {
        await this.supersedeRegisteredEvacuation(identity, input)
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === 'migration_activity_topology_mismatch'
        ) {
          const preservedActivityCellIds = await this.additionalActivityCellIds(
            identity,
            sourceCellId,
            currentTargetCellId
          )
          if (
            preservedActivityCellIds.length === 0 ||
            preservedActivityCellIds.includes(replacementTargetCellId)
          ) {
            throw error
          }
          await this.reconcileReservationAccounting(sourceCellId, currentTargetCellId)
          await this.reconcileReservationAccounting(sourceCellId, replacementTargetCellId)
          for (const cellId of preservedActivityCellIds) {
            await this.reconcileReservationAccounting(sourceCellId, cellId)
          }
          await this.supersedeRegisteredEvacuation(
            identity,
            input,
            preservedActivityCellIds
          )
          superseded++
          continue
        }
        if (
          reconciledAccounting ||
          !(error instanceof Error) ||
          error.message !== 'migration_cell_reservation_accounting_mismatch'
        ) {
          throw error
        }
        await this.reconcileReservationAccounting(sourceCellId, currentTargetCellId)
        await this.reconcileReservationAccounting(sourceCellId, replacementTargetCellId)
        reconciledAccounting = true
        await this.supersedeRegisteredEvacuation(identity, input)
      }
      superseded++
    }
    return superseded
  }

  private async prepareRegisteredCellSupersession(
    identity: AssignmentIdentity,
    input: RegisteredEvacuationSupersessionInput
  ): Promise<{ assignmentEpoch: number; retired: boolean }> {
    const now = this.now()
    return await this.database.transaction(async (transaction) => {
      const assignment = await this.assignmentRow(transaction, identity)
      const staleMigration = (
        await transaction.queryLocked(
          `SELECT * FROM relay_assignment_migrations
           WHERE user_id = ? AND relay_host_id = ? AND assignment_epoch = ?`,
          [identity.userId, identity.relayHostId, input.assignmentEpoch]
        )
      )[0]
      if (!assignment || !staleMigration) throw new Error('migration_assignment_mismatch')
      assertMigrationPair(
        staleMigration,
        input.sourceCellId,
        input.currentTargetCellId
      )
      if (
        optionalInteger(staleMigration, 'completed_at') !== undefined ||
        optionalInteger(staleMigration, 'aborted_at') !== undefined
      ) {
        return { assignmentEpoch: integer(assignment, 'assignment_epoch'), retired: true }
      }
      if (optionalInteger(staleMigration, 'target_registered_at') === undefined) {
        throw new Error('migration_not_registered_for_supersession')
      }
      const assignmentEpoch = integer(assignment, 'assignment_epoch')
      if (assignmentEpoch < input.assignmentEpoch) {
        throw new Error('migration_assignment_mismatch')
      }
      const assignmentCellId = text(assignment, 'cell_id')
      if (
        ![input.currentTargetCellId, input.replacementTargetCellId].includes(
          assignmentCellId
        )
      ) {
        throw new Error('migration_assignment_mismatch')
      }
      const leases = await this.lockAssignmentActivities(transaction, identity)
      const staleIncarnation = (
        await transaction.queryLocked(
          `SELECT * FROM relay_assignment_migration_incarnations
           WHERE user_id = ? AND relay_host_id = ? AND assignment_epoch = ?`,
          [identity.userId, identity.relayHostId, input.assignmentEpoch]
        )
      )[0]
      const stalePin = (
        await transaction.queryLocked(
          `SELECT * FROM relay_post_drain_migration_pins
           WHERE user_id = ? AND relay_host_id = ? AND assignment_epoch = ?`,
          [identity.userId, identity.relayHostId, input.assignmentEpoch]
        )
      )[0]
      assertMigrationRecoveryMetadata(staleMigration, staleIncarnation, stalePin)
      const failedRuntime = (
        await transaction.queryLocked(
          `SELECT * FROM relay_cell_runtime WHERE cell_id = ?`,
          [input.currentTargetCellId]
        )
      )[0]
      await this.requireCellFence(
        transaction,
        input.currentTargetCellId,
        failedRuntime,
        now
      )
      if (
        assignmentEpoch > input.assignmentEpoch &&
        assignmentCellId === input.replacementTargetCellId
      ) {
        const obsoleteActivityIds = new Set([
          pendingControlActivityId(input.assignmentEpoch),
          migrationActivityId(input.assignmentEpoch)
        ])
        const obsoleteLeases = leases.filter((lease) =>
          obsoleteActivityIds.has(text(lease, 'activity_id'))
        )
        assertAssignmentActivityCounts(
          assignment,
          leases,
          leases.filter((lease) => activityKind(lease) === 'migration').length
        )
        for (const lease of obsoleteLeases) {
          const kind = activityKind(lease)
          const expectedUnits =
            kind === 'migration'
              ? integer(staleMigration, 'source_request_units')
              : ACTIVITY_REQUEST_UNITS.control
          if (
            text(lease, 'cell_id') !== input.currentTargetCellId ||
            !['control', 'migration'].includes(kind) ||
            integer(lease, 'request_units') !== expectedUnits
          ) {
            throw new Error('migration_activity_topology_mismatch')
          }
        }
        if (obsoleteLeases.length > 0) await this.lockCellInventory(transaction)
        for (const lease of obsoleteLeases) {
          await this.removeActivityLease(transaction, identity, lease, now)
        }
        await this.releaseSupersededControlConnectionReservations(
          transaction,
          identity,
          input.currentTargetCellId,
          input.assignmentEpoch,
          now
        )
        await transaction.query(
          `UPDATE relay_assignment_migrations SET aborted_at = ?, updated_at = ?
           WHERE user_id = ? AND relay_host_id = ? AND assignment_epoch = ?`,
          [now, now, identity.userId, identity.relayHostId, input.assignmentEpoch]
        )
        return { assignmentEpoch, retired: true }
      }
      let migrationRow = staleMigration
      if (assignmentEpoch > input.assignmentEpoch) {
        const existingCurrent = (
          await transaction.queryLocked(
            `SELECT * FROM relay_assignment_migrations
             WHERE user_id = ? AND relay_host_id = ? AND assignment_epoch = ?`,
            [identity.userId, identity.relayHostId, assignmentEpoch]
          )
        )[0]
        if (existingCurrent) {
          assertMigrationPair(
            existingCurrent,
            input.sourceCellId,
            input.currentTargetCellId
          )
          if (
            optionalInteger(existingCurrent, 'completed_at') !== undefined ||
            optionalInteger(existingCurrent, 'aborted_at') !== undefined ||
            optionalInteger(existingCurrent, 'target_registered_at') === undefined
          ) {
            throw new Error('migration_activity_topology_mismatch')
          }
          assertCurrentMigrationAssignment(assignment, existingCurrent)
          const currentIncarnation = (
            await transaction.queryLocked(
              `SELECT * FROM relay_assignment_migration_incarnations
               WHERE user_id = ? AND relay_host_id = ? AND assignment_epoch = ?`,
              [identity.userId, identity.relayHostId, assignmentEpoch]
            )
          )[0]
          const currentPin = (
            await transaction.queryLocked(
              `SELECT * FROM relay_post_drain_migration_pins
               WHERE user_id = ? AND relay_host_id = ? AND assignment_epoch = ?`,
              [identity.userId, identity.relayHostId, assignmentEpoch]
            )
          )[0]
          assertMigrationRecoveryMetadata(
            existingCurrent,
            currentIncarnation,
            currentPin
          )
          migrationRow = existingCurrent
        } else {
          if (leases.length !== 0) {
            throw new Error('migration_activity_topology_mismatch')
          }
          assertAssignmentActivityCounts(assignment, leases, 0)
          const currentIncarnations = await transaction.queryLocked(
            `SELECT assignment_epoch FROM relay_assignment_migration_incarnations
             WHERE user_id = ? AND relay_host_id = ? AND assignment_epoch = ?`,
            [identity.userId, identity.relayHostId, assignmentEpoch]
          )
          const currentPins = await transaction.queryLocked(
            `SELECT assignment_epoch FROM relay_post_drain_migration_pins
             WHERE user_id = ? AND relay_host_id = ? AND assignment_epoch = ?`,
            [identity.userId, identity.relayHostId, assignmentEpoch]
          )
          if (currentIncarnations.length > 0 || currentPins.length > 0) {
            throw new Error('migration_activity_topology_mismatch')
          }
          await transaction.query(
            `INSERT INTO relay_assignment_migrations
             (user_id, relay_host_id, source_cell_id, target_cell_id,
              previous_epoch, assignment_epoch, source_request_units,
              target_reserved_units, expires_at, target_registered_at,
              completed_at, aborted_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 0, 1, ?, ?, NULL, NULL, ?, ?)`,
            [
              identity.userId,
              identity.relayHostId,
              input.sourceCellId,
              input.currentTargetCellId,
              input.assignmentEpoch,
              assignmentEpoch,
              now - 1,
              now,
              now,
              now
            ]
          )
          migrationRow = {
            ...staleMigration,
            assignment_epoch: assignmentEpoch,
            previous_epoch: input.assignmentEpoch,
            source_request_units: 0,
            target_reserved_units: 1,
            expires_at: now - 1,
            target_registered_at: now,
            completed_at: null,
            aborted_at: null
          }
          if (staleIncarnation) {
            await transaction.query(
              `INSERT INTO relay_assignment_migration_incarnations
               (user_id, relay_host_id, assignment_epoch,
                source_cell_incarnation, target_cell_incarnation)
               VALUES (?, ?, ?, ?, ?)`,
              [
                identity.userId,
                identity.relayHostId,
                assignmentEpoch,
                text(staleIncarnation, 'source_cell_incarnation'),
                text(staleIncarnation, 'target_cell_incarnation')
              ]
            )
          }
          if (stalePin) {
            await transaction.query(
              `INSERT INTO relay_post_drain_migration_pins
               (user_id, relay_host_id, assignment_epoch, drain_attempt_id,
                source_cell_id, source_cell_incarnation, target_cell_id,
                target_cell_incarnation, source_request_units,
                target_reserved_units, pinned_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?)`,
              [
                identity.userId,
                identity.relayHostId,
                assignmentEpoch,
                text(stalePin, 'drain_attempt_id'),
                input.sourceCellId,
                text(stalePin, 'source_cell_incarnation'),
                input.currentTargetCellId,
                text(stalePin, 'target_cell_incarnation'),
                now
              ]
            )
          }
        }
        await this.releaseSupersededControlConnectionReservations(
          transaction,
          identity,
          input.currentTargetCellId,
          input.assignmentEpoch,
          now
        )
        await transaction.query(
          `UPDATE relay_assignment_migrations SET aborted_at = ?, updated_at = ?
           WHERE user_id = ? AND relay_host_id = ? AND assignment_epoch = ?`,
          [now, now, identity.userId, identity.relayHostId, input.assignmentEpoch]
        )
      }
      const migrationLeases = leases.filter(
        (lease) => activityKind(lease) === 'migration'
      )
      if (migrationLeases.length > 0) {
        assertAssignmentActivityAccounting(assignment, leases, migrationRow)
        return { assignmentEpoch, retired: false }
      }
      assertAssignmentActivityCounts(assignment, leases, 0)
      const sourceRequestUnits = integer(migrationRow, 'source_request_units')
      if (
        integer(migrationRow, 'expires_at') > now ||
        sourceRequestUnits < 0 ||
        integer(migrationRow, 'target_reserved_units') !== sourceRequestUnits + 1
      ) {
        throw new Error('migration_activity_lease_shape_mismatch')
      }
      await this.lockCellInventory(transaction)
      await this.adjustCellReservation(
        transaction,
        input.currentTargetCellId,
        sourceRequestUnits
      )
      const expiresAt = now + ASSIGNMENT_LIMITS.migrationLeaseMs
      await transaction.query(
        `INSERT INTO relay_assignment_activity_leases
         (user_id, relay_host_id, activity_id, activity_kind, cell_id,
          request_units, expires_at, updated_at)
         VALUES (?, ?, ?, 'migration', ?, ?, ?, ?)`,
        [
          identity.userId,
          identity.relayHostId,
          migrationActivityId(assignmentEpoch),
          input.currentTargetCellId,
          sourceRequestUnits,
          expiresAt,
          now
        ]
      )
      await transaction.query(
        `UPDATE relay_assignments SET migration_leases = migration_leases + 1,
           lease_expires_at = CASE WHEN lease_expires_at > ? THEN lease_expires_at ELSE ? END,
           last_activity_at = ?
         WHERE user_id = ? AND relay_host_id = ?`,
        [expiresAt, expiresAt, now, identity.userId, identity.relayHostId]
      )
      await transaction.query(
        `UPDATE relay_assignment_migrations SET expires_at = ?, updated_at = ?
         WHERE user_id = ? AND relay_host_id = ? AND assignment_epoch = ?`,
        [expiresAt, now, identity.userId, identity.relayHostId, assignmentEpoch]
      )
      return { assignmentEpoch, retired: false }
    })
  }

  private async additionalActivityCellIds(
    identity: AssignmentIdentity,
    sourceCellId: string,
    currentTargetCellId: string
  ): Promise<string[]> {
    const rows = await this.database.query(
      `SELECT DISTINCT cell_id FROM relay_assignment_activity_leases
       WHERE user_id = ? AND relay_host_id = ?
         AND cell_id NOT IN (?, ?)
       ORDER BY cell_id`,
      [identity.userId, identity.relayHostId, sourceCellId, currentTargetCellId]
    )
    return rows.map((row) => text(row, 'cell_id'))
  }

  async completeEvacuation(
    identity: AssignmentIdentity,
    assignmentEpoch: number
  ): Promise<void> {
    const now = this.now()
    await this.database.transaction(async (transaction) => {
      const assignment = await this.assignmentRow(transaction, identity)
      const row = (
        await transaction.queryLocked(
          `SELECT * FROM relay_assignment_migrations
           WHERE user_id = ? AND relay_host_id = ? AND assignment_epoch = ?
             AND completed_at IS NULL AND aborted_at IS NULL`,
          [identity.userId, identity.relayHostId, assignmentEpoch]
        )
      )[0]
      if (!row) throw new Error('migration_not_found')
      if (optionalInteger(row, 'target_registered_at') === undefined) {
        throw new Error('migration_target_not_registered')
      }
      const sourceCellId = text(row, 'source_cell_id')
      const targetCellId = text(row, 'target_cell_id')
      if (
        !assignment ||
        text(assignment, 'cell_id') !== targetCellId ||
        integer(assignment, 'assignment_epoch') !== assignmentEpoch
      ) {
        throw new Error('migration_assignment_mismatch')
      }
      const activityLeases = await this.lockAssignmentActivities(transaction, identity)
      const sourceUnits = activityUnitsForCell(activityLeases, sourceCellId)
      if (sourceUnits > 0) throw new Error('migration_source_still_active')
      let cellsLocked = false
      let targetStartedAt = 0
      if (this.requireLiveCells) {
        let cells: SqlRow[]
        try {
          cells = await this.lockCellInventory(transaction, true)
        } catch (error) {
          if (isDatabaseLockUnavailable(error)) {
            // Mixed-version workers may still hold a cell-first lock; defer
            // instead of waiting long enough to form their legacy lock cycle.
            throw new Error('migration_cell_inventory_busy')
          }
          throw error
        }
        cellsLocked = true
        const source = cells.find((cell) => text(cell, 'cell_id') === sourceCellId)
        const target = cells.find((cell) => text(cell, 'cell_id') === targetCellId)
        if (!source || integer(source, 'enabled') !== 0) {
          throw new Error('migration_source_admission_changed')
        }
        if (!target || integer(target, 'enabled') !== 1) {
          throw new Error('migration_target_admission_changed')
        }
        const runtimes = await transaction.queryLocked(
          `SELECT * FROM relay_cell_runtime WHERE cell_id IN (?, ?) ORDER BY cell_id`,
          [sourceCellId, targetCellId]
        )
        const sourceRuntime = runtimes.find(
          (runtime) => text(runtime, 'cell_id') === sourceCellId
        )
        const targetRuntime = runtimes.find(
          (runtime) => text(runtime, 'cell_id') === targetCellId
        )
        const freshAfter = now - this.heartbeatTtlMs
        if (
          !sourceRuntime ||
          integer(sourceRuntime, 'ready') !== 1 ||
          integer(sourceRuntime, 'observed_requests') !== 0 ||
          integer(sourceRuntime, 'last_heartbeat_at') <= freshAfter
        ) {
          throw new Error('migration_source_runtime_not_quiescent')
        }
        if (
          !targetRuntime ||
          integer(targetRuntime, 'ready') !== 1 ||
          integer(targetRuntime, 'last_heartbeat_at') <= freshAfter
        ) {
          throw new Error('migration_target_runtime_not_ready')
        }
        targetStartedAt = integer(targetRuntime, 'started_at')
      }
      const targetIsActive = activityLeases.some(
        (lease) =>
          text(lease, 'cell_id') === targetCellId &&
          text(lease, 'activity_kind') === 'control' &&
          !text(lease, 'activity_id').startsWith('control-pending:') &&
          integer(lease, 'expires_at') > now &&
          integer(lease, 'updated_at') >= targetStartedAt
      )
      if (!targetIsActive) throw new Error('migration_target_not_active')
      const lease = activityLeaseById(activityLeases, migrationActivityId(assignmentEpoch))
      if (lease && !cellsLocked) await this.lockCellInventory(transaction)
      if (lease) await this.removeActivityLease(transaction, identity, lease, now)
      await transaction.query(
        `UPDATE relay_assignment_migrations SET completed_at = ?, updated_at = ?
         WHERE user_id = ? AND relay_host_id = ? AND assignment_epoch = ?`,
        [now, now, identity.userId, identity.relayHostId, assignmentEpoch]
      )
    })
  }

  async rebalanceDormant(
    identity: AssignmentIdentity,
    targetCellId: string
  ): Promise<RelayAssignment> {
    const now = this.now()
    return await this.database.transaction(async (transaction) => {
      const assignment = await this.assignmentRow(transaction, identity)
      if (!assignment) throw new Error('assignment_not_found')
      if (!mayNormallyReassign(activity(assignment), now)) throw new Error('assignment_active')
      const sourceCellId = text(assignment, 'cell_id')
      if (sourceCellId === targetCellId) throw new Error('target_matches_source')
      await this.lockAssignmentActivities(transaction, identity)
      const cells = await this.lockCellInventory(transaction)
      const admission = await cellAdmissionStates(transaction)
      const targetRow = cells.find(
        (row) =>
          text(row, 'cell_id') === targetCellId &&
          admission.get(targetCellId) === 'general'
      )
      if (!targetRow) throw new Error('target_cell_unavailable')
      if (!(await this.cellIsLive(transaction, targetCellId, now))) {
        throw new Error('target_cell_unavailable')
      }
      await this.assertCellConnectionHeadroom(transaction, targetCellId)
      const target = cell(targetRow, await this.cellRegion(transaction, targetCellId))
      await this.adjustCellReservation(transaction, targetCellId, 1)
      const assignmentEpoch = integer(assignment, 'assignment_epoch') + 1
      const leaseExpiresAt = now + ASSIGNMENT_LIMITS.activityLeaseMs
      await transaction.query(
        `UPDATE relay_assignments SET cell_id = ?, assignment_epoch = ?,
           reserved_controls = 1, lease_expires_at = ?, last_activity_at = ?
         WHERE user_id = ? AND relay_host_id = ?`,
        [
          targetCellId,
          assignmentEpoch,
          leaseExpiresAt,
          now,
          identity.userId,
          identity.relayHostId
        ]
      )
      await this.releaseSupersededControlConnectionReservations(
        transaction,
        identity,
        sourceCellId,
        assignmentEpoch - 1,
        now
      )
      await this.insertPendingControlLease(
        transaction,
        identity,
        targetCellId,
        assignmentEpoch,
        now
      )
      return {
        ...identity,
        ...target,
        assignmentEpoch,
        leaseExpiresAt
      }
    })
  }

  async inspectRegionalRehomeControl(): Promise<RegionalRehomeControl> {
    const now = this.now()
    return await this.database.transaction(async (transaction) => {
      await this.initializeRegionalRehomeControl(transaction, now)
      const row = (
        await transaction.query(
          `SELECT * FROM relay_region_rehome_control WHERE control_id = 'global'`
        )
      )[0]!
      return regionalRehomeControl(row)
    })
  }

  async applyRegionalRehomeControl(input: {
    expectedGeneration: number
    enabled: boolean
    notBefore: number
    ratePerMinute: number
    preferenceMaxAgeMs: number
    drainGraceMs: number
  }): Promise<RegionalRehomeControl> {
    if (!Number.isSafeInteger(input.expectedGeneration) || input.expectedGeneration < 0) {
      throw new Error('invalid_regional_rehome_generation')
    }
    if (!Number.isSafeInteger(input.notBefore) || input.notBefore < 0) {
      throw new Error('invalid_regional_rehome_not_before')
    }
    if (!Number.isSafeInteger(input.ratePerMinute) || input.ratePerMinute < 1 || input.ratePerMinute > 120) {
      throw new Error('invalid_regional_rehome_rate')
    }
    if (
      !Number.isSafeInteger(input.preferenceMaxAgeMs) ||
      input.preferenceMaxAgeMs < 60_000 ||
      input.preferenceMaxAgeMs > 30 * 24 * 60 * 60_000
    ) {
      throw new Error('invalid_regional_rehome_preference_age')
    }
    if (
      !Number.isSafeInteger(input.drainGraceMs) ||
      input.drainGraceMs < 60_000 ||
      input.drainGraceMs > 60 * 60_000
    ) {
      throw new Error('invalid_regional_rehome_drain_grace')
    }
    const now = this.now()
    return await this.database.transaction(async (transaction) => {
      await this.initializeRegionalRehomeControl(transaction, now)
      const current = (
        await transaction.queryLocked(
          `SELECT * FROM relay_region_rehome_control WHERE control_id = 'global'`
        )
      )[0]!
      if (integer(current, 'generation') !== input.expectedGeneration) {
        throw new Error('regional_rehome_generation_mismatch')
      }
      if (
        input.enabled &&
        input.notBefore <
          integer(current, 'observation_started_at') + REGIONAL_REHOME_OBSERVATION_MS
      ) {
        throw new Error('regional_rehome_observation_window_incomplete')
      }
      await transaction.query(
        `UPDATE relay_region_rehome_control
         SET generation = generation + 1, enabled = ?, not_before = ?,
             rate_per_minute = ?, preference_max_age_ms = ?, drain_grace_ms = ?,
             updated_at = ?
         WHERE control_id = 'global'`,
        [
          input.enabled ? 1 : 0,
          input.notBefore,
          input.ratePerMinute,
          input.preferenceMaxAgeMs,
          input.drainGraceMs,
          now
        ]
      )
      const updated = (
        await transaction.query(
          `SELECT * FROM relay_region_rehome_control WHERE control_id = 'global'`
        )
      )[0]!
      return regionalRehomeControl(updated)
    })
  }

  async disableRegionalRehomeControl(): Promise<boolean> {
    const now = this.now()
    const result = await this.database.query(
      `UPDATE relay_region_rehome_control
       SET generation = generation + 1, enabled = 0, updated_at = ?
       WHERE control_id = 'global' AND enabled = 1`,
      [now]
    )
    return integer(result[0]!, 'changes') === 1
  }

  private async initializeRegionalRehomeControl(
    database: RelayDatabase,
    now: number
  ): Promise<void> {
    await database.query(
      `INSERT INTO relay_region_rehome_control
       (control_id, generation, enabled, observation_started_at, not_before,
        rate_per_minute, preference_max_age_ms, drain_grace_ms, updated_at)
       VALUES ('global', 0, 0, ?, 0, 10, ?, ?, ?)
       ON CONFLICT (control_id) DO NOTHING`,
      [now, 24 * 60 * 60_000, 60 * 60_000, now]
    )
  }

  async regionalRehomeFleetSafety(): Promise<RegionalRehomeFleetSafety> {
    return await this.readRegionalRehomeFleetSafety(this.database, this.now())
  }

  private async readRegionalRehomeFleetSafety(
    database: RelayDatabase,
    now: number
  ): Promise<RegionalRehomeFleetSafety> {
    const rows = await database.query(
      `SELECT runtime.ready, runtime.last_heartbeat_at,
              safety.cell_id AS safety_cell_id, safety.observed_at,
              safety.sql_failures, safety.reconnects,
              safety.control_activity_recovery_failures,
              safety.database_pool_waiting, safety.database_pool_waiters_max,
              safety.database_pool_wait_ms_max
       FROM relay_cells cell
       JOIN relay_cell_admission admission ON admission.cell_id = cell.cell_id
       JOIN relay_cell_regions region ON region.cell_id = cell.cell_id
       LEFT JOIN relay_cell_runtime runtime ON runtime.cell_id = cell.cell_id
       LEFT JOIN relay_cell_capabilities capability ON capability.cell_id = cell.cell_id
       LEFT JOIN relay_cell_rehome_safety safety
         ON safety.cell_id = runtime.cell_id
        AND safety.cell_incarnation = runtime.cell_incarnation
       WHERE cell.enabled = 1 AND admission.admission_state = 'general'
         AND (
           region.region = 'asia-east2' OR
           (region.region = 'us-central1' AND capability.regional_rehome_protocol >= 1)
         )`
    )
    const valid = rows.filter(
      (row) =>
        integer(row, 'ready') === 1 &&
        integer(row, 'last_heartbeat_at') > now - this.heartbeatTtlMs &&
        optionalText(row, 'safety_cell_id') !== undefined &&
        integer(row, 'observed_at') > now - 60_000
    )
    const missingCells = rows.length === 0 ? 1 : rows.length - valid.length
    return {
      requiredCells: rows.length,
      missingCells,
      observedAt:
        missingCells > 0
          ? 0
          : Math.min(...valid.map((row) => integer(row, 'observed_at'))),
      sqlFailures: valid.reduce((total, row) => total + integer(row, 'sql_failures'), 0),
      reconnects: valid.reduce((total, row) => total + integer(row, 'reconnects'), 0),
      maxReconnects: Math.max(0, ...valid.map((row) => integer(row, 'reconnects'))),
      controlActivityRecoveryFailures: valid.reduce(
        (total, row) => total + integer(row, 'control_activity_recovery_failures'),
        0
      ),
      databasePoolWaiting: Math.max(
        0,
        ...valid.map((row) => integer(row, 'database_pool_waiting'))
      ),
      databasePoolWaitersMax: Math.max(
        0,
        ...valid.map((row) => integer(row, 'database_pool_waiters_max'))
      ),
      databasePoolWaitMsMax: Math.max(
        0,
        ...valid.map((row) => integer(row, 'database_pool_wait_ms_max'))
      )
    }
  }

  async claimRegionalRehome(
    processSafety?: RegionalRehomeSafetySnapshot
  ): Promise<RegionalRehomeAttempt | null> {
    const now = this.now()
    // Directors poll every second; avoid taking the global worker-row lock while disabled.
    const control = (
      await this.database.query(
        `SELECT enabled, not_before
         FROM relay_region_rehome_control
         WHERE control_id = 'global'`
      )
    )[0]
    if (!control) {
      await this.initializeRegionalRehomeControl(this.database, now)
      return null
    }
    if (integer(control, 'enabled') !== 1 || integer(control, 'not_before') > now) {
      return null
    }
    this.pendingRegionalRehomeDisableLog = null
    const candidateSkips: RegionalRehomeCandidateSkip[] = []
    const claimResult = await this.database.transaction(async (transaction) => {
      candidateSkips.length = 0
      await this.initializeRegionalRehomeControl(transaction, now)
      const control = (
        await transaction.queryLocked(
          `SELECT * FROM relay_region_rehome_control WHERE control_id = 'global'`
        )
      )[0]!
      if (integer(control, 'enabled') !== 1 || integer(control, 'not_before') > now) {
        return null
      }
      const intervalMs = Math.ceil(60_000 / integer(control, 'rate_per_minute'))
      const preferenceCutoff = now - integer(control, 'preference_max_age_ms')
      await transaction.query(
        `INSERT INTO relay_region_rehome_worker_state
         (worker_id, next_dispatch_at, paused_until, consecutive_failures, updated_at)
         VALUES ('global', 0, 0, 0, ?)
         ON CONFLICT (worker_id) DO NOTHING`,
        [now]
      )
      const worker = (
        await transaction.queryLocked(
          `SELECT * FROM relay_region_rehome_worker_state WHERE worker_id = 'global'`
        )
      )[0]!
      if (
        integer(worker, 'paused_until') > now ||
        integer(worker, 'next_dispatch_at') > now
      ) {
        return null
      }
      const effectiveProcessSafety = processSafety ?? cleanRegionalRehomeSafety(now)
      const fleetSafety = await this.readRegionalRehomeFleetSafety(transaction, now)
      if (
        !(await this.regionalRehomeSafetyAllowsClaim(
          transaction,
          worker,
          effectiveProcessSafety,
          fleetSafety,
          now
        ))
      ) {
        return null
      }
      const retry = (
        await transaction.queryLocked(
          `SELECT attempt.*, source.cell_url AS source_cell_url
           FROM relay_region_rehome_attempts attempt
           JOIN relay_cells source ON source.cell_id = attempt.source_cell_id
           JOIN relay_cell_runtime runtime ON runtime.cell_id = attempt.source_cell_id
           JOIN relay_cell_capabilities capability
             ON capability.cell_id = runtime.cell_id
            AND capability.cell_incarnation = runtime.cell_incarnation
           JOIN relay_assignment_migrations migration
             ON migration.user_id = attempt.user_id
            AND migration.relay_host_id = attempt.relay_host_id
            AND migration.assignment_epoch = attempt.assignment_epoch
           WHERE attempt.drain_receipt_at IS NULL
             AND attempt.completed_at IS NULL AND attempt.aborted_at IS NULL
             AND attempt.send_attempts < 10
             AND (attempt.last_send_attempt_at IS NULL OR attempt.last_send_attempt_at <= ?)
             AND runtime.cell_incarnation = attempt.source_cell_incarnation
             AND runtime.ready = 1 AND runtime.last_heartbeat_at > ?
             AND capability.regional_rehome_protocol >= 1
             AND migration.completed_at IS NULL AND migration.aborted_at IS NULL
           ORDER BY attempt.created_at, attempt.attempt_id
           LIMIT 1`,
          [now - 30_000, now - this.heartbeatTtlMs]
        )
      )[0]
      if (retry) {
        const fleetSafety = await this.lockedRegionalRehomeFleetSafety(transaction, now)
        if (
          !(await this.regionalRehomeSafetyAllowsClaim(
            transaction,
            worker,
            effectiveProcessSafety,
            fleetSafety,
            now
          ))
        ) {
          return null
        }
        await this.markRegionalRehomeDispatchClaimed(
          transaction,
          text(retry, 'attempt_id'),
          now,
          intervalMs
        )
        retry.send_attempts = integer(retry, 'send_attempts') + 1
        return regionalRehomeAttempt(retry)
      }

      // A drain receipt is not convergence: grace enforcement lives only in
      // source-cell session state, and attempts have been observed stalled
      // dual-homed well past grace with source leases still renewing. Such
      // attempts are re-dispatched with the remaining (zero) grace so the
      // source force-closes and the host re-resolves onto its registered
      // target.
      const redrain = (
        await transaction.queryLocked(
          `SELECT attempt.*, source.cell_url AS source_cell_url
           FROM relay_region_rehome_attempts attempt
           JOIN relay_cells source ON source.cell_id = attempt.source_cell_id
           JOIN relay_cell_runtime runtime ON runtime.cell_id = attempt.source_cell_id
           JOIN relay_cell_capabilities capability
             ON capability.cell_id = runtime.cell_id
            AND capability.cell_incarnation = runtime.cell_incarnation
           JOIN relay_assignment_migrations migration
             ON migration.user_id = attempt.user_id
            AND migration.relay_host_id = attempt.relay_host_id
            AND migration.assignment_epoch = attempt.assignment_epoch
           WHERE attempt.drain_receipt_at IS NOT NULL
             AND attempt.completed_at IS NULL AND attempt.aborted_at IS NULL
             AND attempt.created_at + attempt.drain_grace_ms <= ?
             AND attempt.send_attempts < ?
             AND (attempt.last_send_attempt_at IS NULL OR attempt.last_send_attempt_at <= ?)
             AND runtime.cell_incarnation = attempt.source_cell_incarnation
             AND runtime.ready = 1 AND runtime.last_heartbeat_at > ?
             AND capability.regional_rehome_protocol >= 1
             AND migration.completed_at IS NULL AND migration.aborted_at IS NULL
             AND migration.target_registered_at IS NOT NULL
             AND EXISTS (
               SELECT 1 FROM relay_assignment_activity_leases source_lease
               WHERE source_lease.user_id = attempt.user_id
                 AND source_lease.relay_host_id = attempt.relay_host_id
                 AND source_lease.cell_id = attempt.source_cell_id
             )
           ORDER BY attempt.created_at, attempt.attempt_id
           LIMIT 1`,
          [
            now,
            REGIONAL_REHOME_REDRAIN_SEND_LIMIT,
            now - REGIONAL_REHOME_REDRAIN_INTERVAL_MS,
            now - this.heartbeatTtlMs
          ]
        )
      )[0]
      if (redrain) {
        const fleetSafety = await this.lockedRegionalRehomeFleetSafety(transaction, now)
        if (
          !(await this.regionalRehomeSafetyAllowsClaim(
            transaction,
            worker,
            effectiveProcessSafety,
            fleetSafety,
            now
          ))
        ) {
          return null
        }
        await this.markRegionalRehomeDispatchClaimed(
          transaction,
          text(redrain, 'attempt_id'),
          now,
          intervalMs
        )
        redrain.send_attempts = integer(redrain, 'send_attempts') + 1
        redrain.drain_grace_ms = 0
        return regionalRehomeAttempt(redrain)
      }

      const candidates = await transaction.query(
        `SELECT preference.user_id, preference.relay_host_id,
           preference.observed_at, assignment.cell_id AS source_cell_id,
           assignment.assignment_epoch
         FROM relay_assignment_region_preferences preference
         JOIN relay_assignments assignment
           ON assignment.user_id = preference.user_id
          AND assignment.relay_host_id = preference.relay_host_id
         JOIN relay_cell_regions region ON region.cell_id = assignment.cell_id
         JOIN relay_cell_admission admission ON admission.cell_id = assignment.cell_id
         JOIN relay_cell_runtime runtime ON runtime.cell_id = assignment.cell_id
         JOIN relay_cell_capabilities capability
           ON capability.cell_id = runtime.cell_id
          AND capability.cell_incarnation = runtime.cell_incarnation
         WHERE preference.preferred_region = 'asia-east2'
           AND preference.observed_at >= ?
           AND region.region = 'us-central1'
           AND admission.admission_state = 'general'
           AND runtime.ready = 1 AND runtime.last_heartbeat_at > ?
           AND capability.regional_rehome_protocol >= 1
           AND EXISTS (
             SELECT 1 FROM relay_assignment_activity_leases control
             WHERE control.user_id = assignment.user_id
               AND control.relay_host_id = assignment.relay_host_id
               AND control.cell_id = assignment.cell_id
               AND control.activity_kind = 'control'
               AND control.activity_id NOT LIKE 'control-pending:%'
               AND control.expires_at > ?
               AND control.updated_at >= runtime.started_at
           )
           AND NOT EXISTS (
             SELECT 1 FROM relay_assignment_migrations migration
             WHERE migration.user_id = assignment.user_id
               AND migration.relay_host_id = assignment.relay_host_id
               AND migration.completed_at IS NULL AND migration.aborted_at IS NULL
           )
         ORDER BY preference.observed_at, preference.user_id, preference.relay_host_id
         LIMIT 10`,
        [preferenceCutoff, now - this.heartbeatTtlMs, now]
      )
      for (const candidate of candidates) {
        const claimed = await this.startRegionalRehomeCandidate(transaction, {
          identity: {
            userId: text(candidate, 'user_id'),
            relayHostId: text(candidate, 'relay_host_id')
          },
          sourceCellId: text(candidate, 'source_cell_id'),
          assignmentEpoch: integer(candidate, 'assignment_epoch'),
          preferenceCutoff,
          drainGraceMs: integer(control, 'drain_grace_ms'),
          processSafety: effectiveProcessSafety,
          worker,
          now,
          skips: candidateSkips
        })
        if (!claimed) continue
        await this.markRegionalRehomeDispatchClaimed(
          transaction,
          claimed.attemptId,
          now,
          intervalMs
        )
        return { ...claimed, sendAttempts: 1 }
      }
      if (candidates.length > 0) {
        // Skipped candidates still cost all-rows FOR UPDATE inventory scans;
        // charge the dispatch interval so skips are rate-limited like claims.
        await this.markRegionalRehomeTickSkipped(transaction, now, intervalMs)
      }
      return null
    })
    const pendingDisableLog = this.pendingRegionalRehomeDisableLog
    this.pendingRegionalRehomeDisableLog = null
    if (pendingDisableLog) console.warn(JSON.stringify(pendingDisableLog))
    if (claimResult === null && candidateSkips.length > 0) {
      console.warn(JSON.stringify(aggregateRegionalRehomeCandidateSkips(candidateSkips)))
    }
    return claimResult
  }

  private async startRegionalRehomeCandidate(
    transaction: RelayDatabase,
    input: {
      identity: AssignmentIdentity
      sourceCellId: string
      assignmentEpoch: number
      preferenceCutoff: number
      drainGraceMs: number
      processSafety: RegionalRehomeSafetySnapshot
      worker: SqlRow
      now: number
      skips: RegionalRehomeCandidateSkip[]
    }
  ): Promise<Omit<RegionalRehomeAttempt, 'sendAttempts'> | null> {
    const assignment = await this.assignmentRow(transaction, input.identity)
    if (
      !assignment ||
      text(assignment, 'cell_id') !== input.sourceCellId ||
      integer(assignment, 'assignment_epoch') !== input.assignmentEpoch
    ) {
      input.skips.push({ reason: 'candidate_stale' })
      return null
    }
    const preference = (
      await transaction.queryLocked(
        `SELECT * FROM relay_assignment_region_preferences
         WHERE user_id = ? AND relay_host_id = ?`,
        [input.identity.userId, input.identity.relayHostId]
      )
    )[0]
    if (
      !preference ||
      text(preference, 'preferred_region') !== 'asia-east2' ||
      integer(preference, 'observed_at') < input.preferenceCutoff
    ) {
      input.skips.push({ reason: 'candidate_stale' })
      return null
    }
    const activeMigration = await transaction.queryLocked(
      `SELECT assignment_epoch FROM relay_assignment_migrations
       WHERE user_id = ? AND relay_host_id = ?
         AND completed_at IS NULL AND aborted_at IS NULL`,
      [input.identity.userId, input.identity.relayHostId]
    )
    if (activeMigration.length > 0) {
      input.skips.push({ reason: 'candidate_stale' })
      return null
    }
    const activityLeases = await this.lockAssignmentActivities(transaction, input.identity)
    assertAssignmentActivityCounts(assignment, activityLeases, 0)
    const cells = await this.lockCellInventory(transaction)
    const admission = await cellAdmissionStates(transaction)
    const regions = new Map(
      (await transaction.query(`SELECT cell_id, region FROM relay_cell_regions`)).map((row) => [
        text(row, 'cell_id'),
        relayRegion(row, 'region')
      ])
    )
    const runtimes = await transaction.queryLocked(
      `SELECT * FROM relay_cell_runtime ORDER BY cell_id`
    )
    const capabilities = await transaction.queryLocked(
      `SELECT * FROM relay_cell_capabilities ORDER BY cell_id`
    )
    const safetyRows = await transaction.queryLocked(
      `SELECT * FROM relay_cell_rehome_safety ORDER BY cell_id`
    )
    const source = cells.find((row) => text(row, 'cell_id') === input.sourceCellId)
    const sourceRuntime = runtimes.find(
      (row) => text(row, 'cell_id') === input.sourceCellId
    )
    const sourceCapability = capabilities.find(
      (row) => text(row, 'cell_id') === input.sourceCellId
    )
    const sourceSafety = safetyRows.find(
      (row) => text(row, 'cell_id') === input.sourceCellId
    )
    const fleetSafety = regionalRehomeFleetSafetyFromInventory({
      cells,
      admission,
      regions,
      runtimes,
      capabilities,
      safetyRows,
      now: input.now,
      heartbeatTtlMs: this.heartbeatTtlMs
    })
    const safetyFailure = regionalRehomeFleetSafetyFailure(
      input.processSafety,
      fleetSafety,
      input.now
    )
    if (safetyFailure) {
      await this.pauseRegionalRehomeForSafety(
        transaction,
        input.worker,
        input.now,
        safetyFailure,
        fleetSafety
      )
      return null
    }
    if (
      !source ||
      integer(source, 'enabled') !== 1 ||
      admission.get(input.sourceCellId) !== 'general' ||
      regions.get(input.sourceCellId) !== RELAY_DEFAULT_REGION ||
      !sourceRuntime ||
      integer(sourceRuntime, 'ready') !== 1 ||
      integer(sourceRuntime, 'last_heartbeat_at') <= input.now - this.heartbeatTtlMs ||
      !sourceCapability ||
      text(sourceCapability, 'cell_incarnation') !==
        text(sourceRuntime, 'cell_incarnation') ||
      integer(sourceCapability, 'regional_rehome_protocol') < 1
    ) {
      input.skips.push({ reason: 'source_ineligible', cellId: input.sourceCellId })
      return null
    }
    if (!regionalRehomeCellSafetyIsClean(sourceSafety, sourceRuntime, input.now)) {
      input.skips.push(cellUncleanSkip('source_unclean', input.sourceCellId, sourceSafety))
      return null
    }
    const sourceControlActive = activityLeases.some(
      (lease) =>
        text(lease, 'cell_id') === input.sourceCellId &&
        text(lease, 'activity_kind') === 'control' &&
        !text(lease, 'activity_id').startsWith('control-pending:') &&
        integer(lease, 'expires_at') > input.now &&
        integer(lease, 'updated_at') >= integer(sourceRuntime, 'started_at')
    )
    if (!sourceControlActive) {
      input.skips.push({ reason: 'source_control_inactive', cellId: input.sourceCellId })
      return null
    }
    const connectionHeadroom = await this.connectionHeadroomByCell(transaction)
    const eligibleTargets = cells.filter((row) => {
      const cellId = text(row, 'cell_id')
      const runtime = runtimes.find((candidate) => text(candidate, 'cell_id') === cellId)
      return (
        cellId !== input.sourceCellId &&
        integer(row, 'enabled') === 1 &&
        admission.get(cellId) === 'general' &&
        regions.get(cellId) === 'asia-east2' &&
        runtime !== undefined &&
        integer(runtime, 'ready') === 1 &&
        integer(runtime, 'last_heartbeat_at') > input.now - this.heartbeatTtlMs
      )
    })
    const targetIsClean = (row: SqlRow): boolean => {
      const cellId = text(row, 'cell_id')
      return regionalRehomeCellSafetyIsClean(
        safetyRows.find((safety) => text(safety, 'cell_id') === cellId),
        runtimes.find((candidate) => text(candidate, 'cell_id') === cellId)!,
        input.now
      )
    }
    const targetCandidates = eligibleTargets.filter(
      (row) => targetIsClean(row) && connectionHeadroom.get(text(row, 'cell_id')) !== false
    )
    if (targetCandidates.length === 0) {
      const unclean = eligibleTargets.filter((row) => !targetIsClean(row))
      for (const row of unclean) {
        const cellId = text(row, 'cell_id')
        input.skips.push(
          cellUncleanSkip(
            'target_unclean',
            cellId,
            safetyRows.find((safety) => text(safety, 'cell_id') === cellId)
          )
        )
      }
      if (unclean.length === 0) {
        input.skips.push({
          reason: eligibleTargets.length === 0 ? 'no_eligible_target' : 'no_target_headroom'
        })
      }
      return null
    }
    targetCandidates.sort((left, right) => {
      const leftRuntime = runtimes.find(
        (runtime) => text(runtime, 'cell_id') === text(left, 'cell_id')
      )!
      const rightRuntime = runtimes.find(
        (runtime) => text(runtime, 'cell_id') === text(right, 'cell_id')
      )!
      const leftLoad =
        (integer(left, 'reserved_requests') + integer(leftRuntime, 'observed_requests')) /
        integer(left, 'capacity_requests')
      const rightLoad =
        (integer(right, 'reserved_requests') + integer(rightRuntime, 'observed_requests')) /
        integer(right, 'capacity_requests')
      return leftLoad - rightLoad ||
        text(left, 'cell_id').localeCompare(text(right, 'cell_id'))
    })
    const sourceRequestUnits = activityUnitsForCell(activityLeases, input.sourceCellId)
    const targetReservedUnits = sourceRequestUnits + 1
    const target = targetCandidates.find(
      (row) =>
        integer(row, 'reserved_requests') + targetReservedUnits <=
        integer(row, 'capacity_requests')
    )
    if (!target) {
      input.skips.push({ reason: 'no_target_headroom' })
      return null
    }
    const targetCellId = text(target, 'cell_id')
    const targetRuntime = runtimes.find(
      (runtime) => text(runtime, 'cell_id') === targetCellId
    )!
    await this.adjustCellReservation(transaction, targetCellId, targetReservedUnits)
    const previousEpoch = integer(assignment, 'assignment_epoch')
    const assignmentEpoch = previousEpoch + 1
    const expiresAt = input.now + ASSIGNMENT_LIMITS.migrationLeaseMs
    await transaction.query(
      `UPDATE relay_assignments SET cell_id = ?, assignment_epoch = ?,
         reserved_controls = reserved_controls + 1,
         migration_leases = migration_leases + 1,
         lease_expires_at = ?, last_activity_at = ?
       WHERE user_id = ? AND relay_host_id = ?`,
      [
        targetCellId,
        assignmentEpoch,
        expiresAt,
        input.now,
        input.identity.userId,
        input.identity.relayHostId
      ]
    )
    await transaction.query(
      `INSERT INTO relay_assignment_activity_leases
       (user_id, relay_host_id, activity_id, activity_kind, cell_id,
        request_units, expires_at, updated_at)
       VALUES (?, ?, ?, 'control', ?, 1, ?, ?),
              (?, ?, ?, 'migration', ?, ?, ?, ?)`,
      [
        input.identity.userId,
        input.identity.relayHostId,
        pendingControlActivityId(assignmentEpoch),
        targetCellId,
        expiresAt,
        input.now,
        input.identity.userId,
        input.identity.relayHostId,
        migrationActivityId(assignmentEpoch),
        targetCellId,
        sourceRequestUnits,
        expiresAt,
        input.now
      ]
    )
    await this.insertControlConnectionReservation(
      transaction,
      input.identity,
      targetCellId,
      assignmentEpoch,
      expiresAt,
      input.now
    )
    await transaction.query(
      `INSERT INTO relay_assignment_migrations
       (user_id, relay_host_id, source_cell_id, target_cell_id,
        previous_epoch, assignment_epoch, source_request_units,
        target_reserved_units, expires_at, target_registered_at,
        completed_at, aborted_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)`,
      [
        input.identity.userId,
        input.identity.relayHostId,
        input.sourceCellId,
        targetCellId,
        previousEpoch,
        assignmentEpoch,
        sourceRequestUnits,
        targetReservedUnits,
        expiresAt,
        input.now,
        input.now
      ]
    )
    await transaction.query(
      `INSERT INTO relay_assignment_migration_incarnations
       (user_id, relay_host_id, assignment_epoch, source_cell_incarnation,
        target_cell_incarnation)
       VALUES (?, ?, ?, ?, ?)`,
      [
        input.identity.userId,
        input.identity.relayHostId,
        assignmentEpoch,
        text(sourceRuntime, 'cell_incarnation'),
        text(targetRuntime, 'cell_incarnation')
      ]
    )
    const attemptId = randomUUID()
    await transaction.query(
      `INSERT INTO relay_region_rehome_attempts
       (attempt_id, user_id, relay_host_id, preferred_region,
        source_cell_id, source_cell_incarnation, target_cell_id,
        target_cell_incarnation, previous_epoch, assignment_epoch,
        drain_grace_ms, send_attempts, last_send_attempt_at,
        drain_receipt_at, drain_outcome, completed_at, aborted_at,
        created_at, updated_at)
       VALUES (?, ?, ?, 'asia-east2', ?, ?, ?, ?, ?, ?, ?, 0, NULL,
         NULL, NULL, NULL, NULL, ?, ?)`,
      [
        attemptId,
        input.identity.userId,
        input.identity.relayHostId,
        input.sourceCellId,
        text(sourceRuntime, 'cell_incarnation'),
        targetCellId,
        text(targetRuntime, 'cell_incarnation'),
        previousEpoch,
        assignmentEpoch,
        input.drainGraceMs,
        input.now,
        input.now
      ]
    )
    return {
      ...input.identity,
      attemptId,
      preferredRegion: 'asia-east2',
      sourceCellId: input.sourceCellId,
      sourceCellUrl: text(source, 'cell_url'),
      sourceCellIncarnation: text(sourceRuntime, 'cell_incarnation'),
      targetCellId,
      targetCellIncarnation: text(targetRuntime, 'cell_incarnation'),
      previousEpoch,
      assignmentEpoch,
      drainGraceMs: input.drainGraceMs
    }
  }

  private async lockedRegionalRehomeFleetSafety(
    transaction: RelayDatabase,
    now: number
  ): Promise<RegionalRehomeFleetSafety> {
    const cells = await this.lockCellInventory(transaction)
    const admission = await cellAdmissionStates(transaction)
    const regions = new Map(
      (await transaction.query(`SELECT cell_id, region FROM relay_cell_regions`)).map((row) => [
        text(row, 'cell_id'),
        relayRegion(row, 'region')
      ])
    )
    const runtimes = await transaction.queryLocked(
      `SELECT * FROM relay_cell_runtime ORDER BY cell_id`
    )
    const capabilities = await transaction.queryLocked(
      `SELECT * FROM relay_cell_capabilities ORDER BY cell_id`
    )
    const safetyRows = await transaction.queryLocked(
      `SELECT * FROM relay_cell_rehome_safety ORDER BY cell_id`
    )
    return regionalRehomeFleetSafetyFromInventory({
      cells,
      admission,
      regions,
      runtimes,
      capabilities,
      safetyRows,
      now,
      heartbeatTtlMs: this.heartbeatTtlMs
    })
  }

  private async regionalRehomeSafetyAllowsClaim(
    transaction: RelayDatabase,
    worker: SqlRow,
    processSafety: RegionalRehomeSafetySnapshot,
    fleetSafety: RegionalRehomeFleetSafety,
    now: number
  ): Promise<boolean> {
    const failure = regionalRehomeFleetSafetyFailure(processSafety, fleetSafety, now)
    if (!failure) {
      return true
    }
    await this.pauseRegionalRehomeForSafety(transaction, worker, now, failure, fleetSafety)
    return false
  }

  private async pauseRegionalRehomeForSafety(
    transaction: RelayDatabase,
    worker: SqlRow,
    now: number,
    reason: string,
    fleetSafety: RegionalRehomeFleetSafety
  ): Promise<void> {
    const disabled = await transaction.query(
      `UPDATE relay_region_rehome_control
       SET generation = generation + 1, enabled = 0, updated_at = ?
       WHERE control_id = 'global' AND enabled = 1
       RETURNING generation`,
      [now]
    )
    // The durable disable is otherwise invisible: nothing else records why
    // claims stopped and inspection only shows enabled=false. Logged after
    // the transaction commits so a rollback cannot fabricate the record.
    if (disabled.length > 0) {
      this.pendingRegionalRehomeDisableLog = {
        event: 'orca_relay_regional_rehome_safety_disabled',
        reason,
        controlGeneration: integer(disabled[0]!, 'generation'),
        now,
        requiredCells: fleetSafety.requiredCells,
        missingCells: fleetSafety.missingCells,
        observedAt: fleetSafety.observedAt,
        sqlFailures: fleetSafety.sqlFailures,
        reconnects: fleetSafety.reconnects,
        maxReconnects: fleetSafety.maxReconnects,
        controlActivityRecoveryFailures: fleetSafety.controlActivityRecoveryFailures,
        databasePoolWaiting: fleetSafety.databasePoolWaiting,
        databasePoolWaitersMax: fleetSafety.databasePoolWaitersMax,
        databasePoolWaitMsMax: fleetSafety.databasePoolWaitMsMax
      }
    }
    await this.incrementRegionalRehomeWorkerFailure(transaction, worker, now)
  }

  private async markRegionalRehomeTickSkipped(
    transaction: RelayDatabase,
    now: number,
    intervalMs: number
  ): Promise<void> {
    await transaction.query(
      `UPDATE relay_region_rehome_worker_state
       SET next_dispatch_at = ?, updated_at = ? WHERE worker_id = 'global'`,
      [now + intervalMs, now]
    )
  }

  private async markRegionalRehomeDispatchClaimed(
    transaction: RelayDatabase,
    attemptId: string,
    now: number,
    intervalMs: number
  ): Promise<void> {
    await transaction.query(
      `UPDATE relay_region_rehome_attempts
       SET send_attempts = send_attempts + 1, last_send_attempt_at = ?, updated_at = ?
       WHERE attempt_id = ?`,
      [now, now, attemptId]
    )
    await transaction.query(
      `UPDATE relay_region_rehome_worker_state
       SET next_dispatch_at = ?, updated_at = ? WHERE worker_id = 'global'`,
      [now + intervalMs, now]
    )
  }

  async recordRegionalRehomeDrainReceipt(
    attemptId: string,
    outcome: RegionalHostDrainOutcome
  ): Promise<boolean> {
    const now = this.now()
    return await this.database.transaction(async (transaction) => {
      const worker = (
        await transaction.queryLocked(
          `SELECT * FROM relay_region_rehome_worker_state WHERE worker_id = 'global'`
        )
      )[0]
      const attempt = (
        await transaction.queryLocked(
          `SELECT * FROM relay_region_rehome_attempts WHERE attempt_id = ?`,
          [attemptId]
        )
      )[0]
      if (!attempt) throw new Error('regional_rehome_attempt_not_found')
      // Any receipt proves the source cell answered: reset the failure budget
      // even when a redrain repeats the stored outcome; otherwise a
      // redrain-dominated stream lets scattered transient failures reach the
      // durable three-failure disable.
      if (worker) {
        await transaction.query(
          `UPDATE relay_region_rehome_worker_state
           SET consecutive_failures = 0, paused_until = 0, updated_at = ?
           WHERE worker_id = 'global'`,
          [now]
        )
      }
      const existingOutcome = optionalText(attempt, 'drain_outcome')
      if (existingOutcome === outcome) return false
      // Redrains produce one receipt per dispatch; the latest outcome wins.
      await transaction.query(
        `UPDATE relay_region_rehome_attempts
         SET drain_receipt_at = ?, drain_outcome = ?, updated_at = ?
         WHERE attempt_id = ?`,
        [now, outcome, now, attemptId]
      )
      return true
    })
  }

  async recordRegionalRehomeDispatchFailure(attemptId: string): Promise<void> {
    const now = this.now()
    await this.database.transaction(async (transaction) => {
      const worker = (
        await transaction.queryLocked(
          `SELECT * FROM relay_region_rehome_worker_state WHERE worker_id = 'global'`
        )
      )[0]
      const attempt = (
        await transaction.queryLocked(
          `SELECT attempt_id FROM relay_region_rehome_attempts WHERE attempt_id = ?`,
          [attemptId]
        )
      )[0]
      if (!worker || !attempt) return
      await this.incrementRegionalRehomeWorkerFailure(transaction, worker, now)
    })
  }

  async recordRegionalRehomeWorkerFailure(): Promise<void> {
    const now = this.now()
    await this.database.transaction(async (transaction) => {
      await transaction.query(
        `INSERT INTO relay_region_rehome_worker_state
         (worker_id, next_dispatch_at, paused_until, consecutive_failures, updated_at)
         VALUES ('global', 0, 0, 0, ?)
         ON CONFLICT (worker_id) DO NOTHING`,
        [now]
      )
      const worker = (
        await transaction.queryLocked(
          `SELECT * FROM relay_region_rehome_worker_state WHERE worker_id = 'global'`
        )
      )[0]!
      await this.incrementRegionalRehomeWorkerFailure(transaction, worker, now)
    })
  }

  private async incrementRegionalRehomeWorkerFailure(
    transaction: RelayDatabase,
    worker: SqlRow,
    now: number
  ): Promise<void> {
    const failures = integer(worker, 'consecutive_failures') + 1
    await transaction.query(
      `UPDATE relay_region_rehome_worker_state
       SET consecutive_failures = ?, paused_until = ?, updated_at = ?
       WHERE worker_id = 'global'`,
      [failures, failures >= 3 ? now + 5 * 60_000 : 0, now]
    )
    if (failures >= 3) {
      await transaction.query(
        `UPDATE relay_region_rehome_control
         SET generation = generation + 1, enabled = 0, updated_at = ?
         WHERE control_id = 'global' AND enabled = 1`,
        [now]
      )
    }
  }

  async completeReadyRegionalRehomes(limit = 10): Promise<number> {
    const now = this.now()
    const quarantined = this.quarantinedRegionalRehomeAttemptIds(now)
    const exclusion = quarantined.length
      ? ` AND attempt.attempt_id NOT IN (${quarantined.map(() => '?').join(', ')})`
      : ''
    const candidates = await this.database.query(
      `SELECT attempt.attempt_id, attempt.user_id, attempt.relay_host_id,
         attempt.assignment_epoch
       FROM relay_region_rehome_attempts attempt
       JOIN relay_assignment_migrations migration
         ON migration.user_id = attempt.user_id
        AND migration.relay_host_id = attempt.relay_host_id
        AND migration.assignment_epoch = attempt.assignment_epoch
       WHERE attempt.completed_at IS NULL AND attempt.aborted_at IS NULL
         AND migration.target_registered_at IS NOT NULL
         AND migration.completed_at IS NULL AND migration.aborted_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM relay_assignment_activity_leases source_lease
           WHERE source_lease.user_id = attempt.user_id
             AND source_lease.relay_host_id = attempt.relay_host_id
             AND source_lease.cell_id = attempt.source_cell_id
         )${exclusion}
       ORDER BY attempt.created_at, attempt.attempt_id
       LIMIT ?`,
      [...quarantined, limit]
    )
    let completed = 0
    for (const candidate of candidates) {
      // One poisoned row must not stall every later candidate: an invariant
      // throw here blocked fleet completions head-of-line in production.
      const attemptId = text(candidate, 'attempt_id')
      try {
        const changed = await this.completeRegionalRehomeCandidate(
          {
            userId: text(candidate, 'user_id'),
            relayHostId: text(candidate, 'relay_host_id')
          },
          integer(candidate, 'assignment_epoch'),
          now
        )
        if (changed) completed++
        this.regionalRehomeCandidateQuarantine.delete(attemptId)
      } catch (error) {
        this.recordRegionalRehomeCandidateFailure('complete', attemptId, now, error)
      }
    }
    return completed
  }

  // Repeated invariant failures quarantine the attempt out of the sweeps'
  // LIMIT pages: poisoned rows are permanent and always the oldest, so
  // without exclusion they eventually starve every healthy candidate.
  private recordRegionalRehomeCandidateFailure(
    operation: 'complete' | 'abort',
    attemptId: string,
    now: number,
    error: unknown
  ): void {
    const entry = this.regionalRehomeCandidateQuarantine.get(attemptId) ?? {
      failures: 0,
      until: 0
    }
    entry.failures++
    if (entry.failures >= REGIONAL_REHOME_QUARANTINE_FAILURES) {
      entry.until = now + REGIONAL_REHOME_QUARANTINE_MS
    }
    this.regionalRehomeCandidateQuarantine.delete(attemptId)
    this.regionalRehomeCandidateQuarantine.set(attemptId, entry)
    if (this.regionalRehomeCandidateQuarantine.size > REGIONAL_REHOME_QUARANTINE_MEMORY_LIMIT) {
      // Evict a non-quarantined entry first: mid-quarantine rows are excluded
      // from the candidate pages and losing one returns it to the page with a
      // reset counter.
      let evict = this.regionalRehomeCandidateQuarantine.keys().next().value!
      for (const [key, candidate] of this.regionalRehomeCandidateQuarantine) {
        if (candidate.until <= now) {
          evict = key
          break
        }
      }
      this.regionalRehomeCandidateQuarantine.delete(evict)
    }
    warnRegionalRehomeCandidateFailure(operation, attemptId, error)
  }

  private quarantinedRegionalRehomeAttemptIds(now: number): string[] {
    const excluded: string[] = []
    for (const [attemptId, entry] of this.regionalRehomeCandidateQuarantine) {
      if (entry.until > now) excluded.push(attemptId)
      if (excluded.length >= REGIONAL_REHOME_QUARANTINE_EXCLUSION_LIMIT) break
    }
    return excluded
  }

  async refreshRegionalRehomeLeases(limit = 100): Promise<number> {
    const now = this.now()
    const candidates = await this.database.query(
      `SELECT user_id, relay_host_id, assignment_epoch
       FROM relay_region_rehome_attempts
       WHERE completed_at IS NULL AND aborted_at IS NULL
       ORDER BY created_at, attempt_id LIMIT ?`,
      [limit]
    )
    let refreshed = 0
    for (const candidate of candidates) {
      const identity = {
        userId: text(candidate, 'user_id'),
        relayHostId: text(candidate, 'relay_host_id')
      }
      const assignmentEpoch = integer(candidate, 'assignment_epoch')
      const changed = await this.database.transaction(async (transaction) => {
        const assignment = await this.assignmentRow(transaction, identity)
        const attempt = (
          await transaction.queryLocked(
            `SELECT * FROM relay_region_rehome_attempts
             WHERE user_id = ? AND relay_host_id = ? AND assignment_epoch = ?`,
            [identity.userId, identity.relayHostId, assignmentEpoch]
          )
        )[0]
        const migration = (
          await transaction.queryLocked(
            `SELECT * FROM relay_assignment_migrations
             WHERE user_id = ? AND relay_host_id = ? AND assignment_epoch = ?`,
            [identity.userId, identity.relayHostId, assignmentEpoch]
          )
        )[0]
        if (
          !assignment ||
          !attempt ||
          !migration ||
          optionalInteger(attempt, 'completed_at') !== undefined ||
          optionalInteger(attempt, 'aborted_at') !== undefined ||
          optionalInteger(migration, 'completed_at') !== undefined ||
          optionalInteger(migration, 'aborted_at') !== undefined
        ) {
          return false
        }
        const attemptAgeMs = now - integer(attempt, 'created_at')
        if (attemptAgeMs >= REGIONAL_REHOME_MAX_REFRESH_MS) {
          return false
        }
        if (
          optionalInteger(migration, 'target_registered_at') === undefined &&
          attemptAgeMs >= REGIONAL_REHOME_UNREGISTERED_REFRESH_MS
        ) {
          await transaction.query(
            `UPDATE relay_assignment_activity_leases
             SET expires_at = CASE WHEN expires_at < ? THEN expires_at ELSE ? END,
                 updated_at = ?
             WHERE user_id = ? AND relay_host_id = ?
               AND activity_id IN (?, ?)`,
            [
              now,
              now,
              now,
              identity.userId,
              identity.relayHostId,
              pendingControlActivityId(assignmentEpoch),
              migrationActivityId(assignmentEpoch)
            ]
          )
          await transaction.query(
            `UPDATE relay_assignment_migrations
             SET expires_at = CASE WHEN expires_at < ? THEN expires_at ELSE ? END,
                 updated_at = ?
             WHERE user_id = ? AND relay_host_id = ? AND assignment_epoch = ?`,
            [now, now, now, identity.userId, identity.relayHostId, assignmentEpoch]
          )
          return false
        }
        const leases = await this.lockAssignmentActivities(transaction, identity)
        const protectedIds = new Set([
          pendingControlActivityId(assignmentEpoch),
          migrationActivityId(assignmentEpoch)
        ])
        const protectedLeases = leases.filter((lease) =>
          protectedIds.has(text(lease, 'activity_id'))
        )
        if (protectedLeases.length === 0) return false
        const expiresAt = now + ASSIGNMENT_LIMITS.migrationLeaseMs
        await transaction.query(
          `UPDATE relay_assignment_activity_leases
           SET expires_at = ?, updated_at = ?
           WHERE user_id = ? AND relay_host_id = ?
             AND activity_id IN (?, ?)`,
          [
            expiresAt,
            now,
            identity.userId,
            identity.relayHostId,
            pendingControlActivityId(assignmentEpoch),
            migrationActivityId(assignmentEpoch)
          ]
        )
        await transaction.query(
          `UPDATE relay_assignment_migrations SET expires_at = ?, updated_at = ?
           WHERE user_id = ? AND relay_host_id = ? AND assignment_epoch = ?`,
          [expiresAt, now, identity.userId, identity.relayHostId, assignmentEpoch]
        )
        await transaction.query(
          `UPDATE relay_assignments SET lease_expires_at =
             CASE WHEN lease_expires_at > ? THEN lease_expires_at ELSE ? END,
             last_activity_at = ?
           WHERE user_id = ? AND relay_host_id = ?`,
          [expiresAt, expiresAt, now, identity.userId, identity.relayHostId]
        )
        return true
      })
      if (changed) refreshed++
    }
    return refreshed
  }

  private async completeRegionalRehomeCandidate(
    identity: AssignmentIdentity,
    assignmentEpoch: number,
    now: number
  ): Promise<boolean> {
    return await this.database.transaction(async (transaction) => {
      const assignment = await this.assignmentRow(transaction, identity)
      const attempt = (
        await transaction.queryLocked(
          `SELECT * FROM relay_region_rehome_attempts
           WHERE user_id = ? AND relay_host_id = ? AND assignment_epoch = ?`,
          [identity.userId, identity.relayHostId, assignmentEpoch]
        )
      )[0]
      const migration = (
        await transaction.queryLocked(
          `SELECT * FROM relay_assignment_migrations
           WHERE user_id = ? AND relay_host_id = ? AND assignment_epoch = ?`,
          [identity.userId, identity.relayHostId, assignmentEpoch]
        )
      )[0]
      if (
        !attempt ||
        !migration ||
        optionalInteger(attempt, 'completed_at') !== undefined ||
        optionalInteger(attempt, 'aborted_at') !== undefined ||
        optionalInteger(migration, 'target_registered_at') === undefined ||
        optionalInteger(migration, 'completed_at') !== undefined ||
        optionalInteger(migration, 'aborted_at') !== undefined
      ) {
        return false
      }
      const sourceCellId = text(attempt, 'source_cell_id')
      const targetCellId = text(attempt, 'target_cell_id')
      if (
        !assignment ||
        text(assignment, 'cell_id') !== targetCellId ||
        integer(assignment, 'assignment_epoch') !== assignmentEpoch ||
        text(migration, 'source_cell_id') !== sourceCellId ||
        text(migration, 'target_cell_id') !== targetCellId
      ) {
        throw new Error('regional_rehome_assignment_mismatch')
      }
      const leases = await this.lockAssignmentActivities(transaction, identity)
      if (activityUnitsForCell(leases, sourceCellId) !== 0) return false
      await this.repairAssignmentActivityCounts(
        transaction,
        identity,
        text(attempt, 'attempt_id'),
        assignment,
        leases,
        migration
      )
      const cells = await this.lockCellInventory(transaction)
      const target = cells.find((cell) => text(cell, 'cell_id') === targetCellId)
      const admission = await cellAdmissionStates(transaction)
      if (
        !target ||
        integer(target, 'enabled') !== 1 ||
        !['general', 'migration-only'].includes(admission.get(targetCellId) ?? '')
      ) {
        return false
      }
      const targetRuntime = (
        await transaction.queryLocked(
          `SELECT * FROM relay_cell_runtime WHERE cell_id = ?`,
          [targetCellId]
        )
      )[0]
      if (
        !targetRuntime ||
        integer(targetRuntime, 'ready') !== 1 ||
        integer(targetRuntime, 'last_heartbeat_at') <= now - this.heartbeatTtlMs
      ) {
        return false
      }
      const targetActive = leases.some(
        (lease) =>
          text(lease, 'cell_id') === targetCellId &&
          text(lease, 'activity_kind') === 'control' &&
          !text(lease, 'activity_id').startsWith('control-pending:') &&
          integer(lease, 'expires_at') > now &&
          integer(lease, 'updated_at') >= integer(targetRuntime, 'started_at')
      )
      if (!targetActive) return false
      const migrationLease = activityLeaseById(
        leases,
        migrationActivityId(assignmentEpoch)
      )
      if (migrationLease) {
        await this.removeActivityLease(transaction, identity, migrationLease, now)
      }
      await transaction.query(
        `UPDATE relay_assignment_migrations SET completed_at = ?, updated_at = ?
         WHERE user_id = ? AND relay_host_id = ? AND assignment_epoch = ?`,
        [now, now, identity.userId, identity.relayHostId, assignmentEpoch]
      )
      await transaction.query(
        `UPDATE relay_region_rehome_attempts SET completed_at = ?, updated_at = ?
         WHERE attempt_id = ?`,
        [now, now, text(attempt, 'attempt_id')]
      )
      return true
    })
  }

  // Why: counter skew left by a pre-fix sticky grant is reconstructible from the
  // locked lease rows; lease shape and migration topology are not, so only a
  // count mismatch is repaired and the re-assert still throws on anything else.
  // reconcileReservationAccounting cannot stand in: it opens its own
  // transaction, while this has to run inside the sweep's on rows it holds.
  private async repairAssignmentActivityCounts(
    transaction: RelayDatabase,
    identity: AssignmentIdentity,
    attemptId: string,
    assignment: SqlRow,
    leases: SqlRow[],
    migrationRow: SqlRow
  ): Promise<void> {
    try {
      assertAssignmentActivityAccounting(assignment, leases, migrationRow)
      return
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.message !== 'migration_activity_accounting_mismatch'
      ) {
        throw error
      }
    }
    const counts = activityCounts(leases)
    await transaction.query(
      `UPDATE relay_assignments SET reserved_controls = ?, reserved_splices = ?,
         reserved_invites = ?, pending_installs = ?, pending_confirmations = ?,
         migration_leases = ?
       WHERE user_id = ? AND relay_host_id = ?`,
      [
        counts.control,
        counts.splice,
        counts.invite,
        counts.install,
        counts.confirmation,
        counts.migration,
        identity.userId,
        identity.relayHostId
      ]
    )
    const repaired = await this.assignmentRow(transaction, identity)
    if (!repaired) throw new Error('regional_rehome_assignment_mismatch')
    assertAssignmentActivityAccounting(repaired, leases, migrationRow)
    noteRegionalRehomeActivityCountsRepaired(attemptId)
  }

  async reapRegionalRehomeAttempts(): Promise<number> {
    const now = this.now()
    const completed = await this.database.query(
      `UPDATE relay_region_rehome_attempts
       SET completed_at = COALESCE(completed_at, ?), updated_at = ?
       WHERE completed_at IS NULL AND aborted_at IS NULL
         AND EXISTS (
           SELECT 1 FROM relay_assignment_migrations migration
           WHERE migration.user_id = relay_region_rehome_attempts.user_id
             AND migration.relay_host_id = relay_region_rehome_attempts.relay_host_id
             AND migration.assignment_epoch = relay_region_rehome_attempts.assignment_epoch
             AND migration.completed_at IS NOT NULL
         )`,
      [now, now]
    )
    const aborted = await this.database.query(
      `UPDATE relay_region_rehome_attempts
       SET aborted_at = COALESCE(aborted_at, ?), updated_at = ?
       WHERE completed_at IS NULL AND aborted_at IS NULL
         AND EXISTS (
           SELECT 1 FROM relay_assignment_migrations migration
           WHERE migration.user_id = relay_region_rehome_attempts.user_id
             AND migration.relay_host_id = relay_region_rehome_attempts.relay_host_id
             AND migration.assignment_epoch = relay_region_rehome_attempts.assignment_epoch
             AND migration.aborted_at IS NOT NULL
         )`,
      [now, now]
    )
    if (integer(aborted[0]!, 'changes') > 0) {
      await this.disableRegionalRehomeControl()
    }
    return integer(completed[0]!, 'changes') + integer(aborted[0]!, 'changes')
  }

  async abortExpiredRegionalRehomes(limit = 100): Promise<number> {
    const now = this.now()
    const quarantined = this.quarantinedRegionalRehomeAttemptIds(now)
    const exclusion = quarantined.length
      ? ` AND attempt_id NOT IN (${quarantined.map(() => '?').join(', ')})`
      : ''
    const candidates = await this.database.query(
      `SELECT attempt_id, user_id, relay_host_id, assignment_epoch
       FROM relay_region_rehome_attempts
       WHERE completed_at IS NULL AND aborted_at IS NULL
         AND created_at <= ?${exclusion}
       ORDER BY created_at, attempt_id LIMIT ?`,
      [now - REGIONAL_REHOME_MAX_REFRESH_MS, ...quarantined, limit]
    )
    let aborted = 0
    for (const candidate of candidates) {
      const identity = {
        userId: text(candidate, 'user_id'),
        relayHostId: text(candidate, 'relay_host_id')
      }
      const assignmentEpoch = integer(candidate, 'assignment_epoch')
      const attemptId = text(candidate, 'attempt_id')
      // Isolated like the completion sweep: one poisoned row must not stall
      // every later candidate.
      let changed = false
      try {
        changed = await this.database.transaction(async (transaction) => {
        const assignment = await this.assignmentRow(transaction, identity)
        const attempt = (
          await transaction.queryLocked(
            `SELECT * FROM relay_region_rehome_attempts
             WHERE user_id = ? AND relay_host_id = ? AND assignment_epoch = ?`,
            [identity.userId, identity.relayHostId, assignmentEpoch]
          )
        )[0]
        const migration = (
          await transaction.queryLocked(
            `SELECT * FROM relay_assignment_migrations
             WHERE user_id = ? AND relay_host_id = ? AND assignment_epoch = ?`,
            [identity.userId, identity.relayHostId, assignmentEpoch]
          )
        )[0]
        if (
          !assignment ||
          !attempt ||
          !migration ||
          optionalInteger(attempt, 'completed_at') !== undefined ||
          optionalInteger(attempt, 'aborted_at') !== undefined ||
          integer(attempt, 'created_at') > now - REGIONAL_REHOME_MAX_REFRESH_MS ||
          optionalInteger(migration, 'completed_at') !== undefined ||
          optionalInteger(migration, 'aborted_at') !== undefined
        ) {
          return false
        }
        const sourceCellId = text(attempt, 'source_cell_id')
        const targetCellId = text(attempt, 'target_cell_id')
        if (
          text(assignment, 'cell_id') !== targetCellId ||
          integer(assignment, 'assignment_epoch') !== assignmentEpoch
        ) {
          throw new Error('regional_rehome_assignment_mismatch')
        }
        const leases = await this.lockAssignmentActivities(transaction, identity)
        if (activityUnitsForCell(leases, sourceCellId) > 0) return false
        const targetActive = leases.some(
          (lease) =>
            text(lease, 'cell_id') === targetCellId &&
            text(lease, 'activity_kind') === 'control' &&
            !text(lease, 'activity_id').startsWith('control-pending:') &&
            integer(lease, 'expires_at') > now
        )
        if (targetActive) return false
        const cells = await this.lockCellInventory(transaction)
        const source = cells.find((cell) => text(cell, 'cell_id') === sourceCellId)
        const admission = await cellAdmissionStates(transaction)
        if (
          !source ||
          integer(source, 'enabled') !== 1 ||
          admission.get(sourceCellId) !== 'general' ||
          !(await this.cellIsLive(transaction, sourceCellId, now))
        ) {
          return false
        }
        for (const activityId of [
          pendingControlActivityId(assignmentEpoch),
          migrationActivityId(assignmentEpoch)
        ]) {
          const lease = activityLeaseById(leases, activityId)
          if (lease) await this.removeActivityLease(transaction, identity, lease, now)
        }
        await this.releaseSupersededControlConnectionReservations(
          transaction,
          identity,
          targetCellId,
          assignmentEpoch,
          now
        )
        await transaction.query(
          `UPDATE relay_assignments SET cell_id = ?, assignment_epoch = ?,
             lease_expires_at = ?, last_activity_at = ?
           WHERE user_id = ? AND relay_host_id = ?`,
          [
            sourceCellId,
            assignmentEpoch + 1,
            now + ASSIGNMENT_LIMITS.activityLeaseMs,
            now,
            identity.userId,
            identity.relayHostId
          ]
        )
        await transaction.query(
          `UPDATE relay_assignment_migrations SET aborted_at = ?, updated_at = ?
           WHERE user_id = ? AND relay_host_id = ? AND assignment_epoch = ?`,
          [now, now, identity.userId, identity.relayHostId, assignmentEpoch]
        )
        await transaction.query(
          `UPDATE relay_region_rehome_attempts SET aborted_at = ?, updated_at = ?
           WHERE attempt_id = ?`,
          [now, now, text(attempt, 'attempt_id')]
        )
        await transaction.query(
          `UPDATE relay_region_rehome_control
           SET generation = generation + 1, enabled = 0, updated_at = ?
           WHERE control_id = 'global' AND enabled = 1`,
          [now]
        )
        return true
        })
        this.regionalRehomeCandidateQuarantine.delete(attemptId)
      } catch (error) {
        this.recordRegionalRehomeCandidateFailure('abort', attemptId, now, error)
      }
      if (changed) aborted++
    }
    return aborted
  }

  async abortExpiredEvacuations(): Promise<number> {
    const now = this.now()
    const abandonedBefore = now - STRANDED_MIGRATION_ABANDON_MS
    const candidates = await this.database.query(
      `SELECT migration.user_id, migration.relay_host_id, migration.assignment_epoch
       FROM relay_assignment_migrations migration
       WHERE migration.expires_at <= ?
         AND migration.completed_at IS NULL AND migration.aborted_at IS NULL
         AND ${ABORTABLE_EXPIRED_MIGRATION}
       ORDER BY user_id, relay_host_id, assignment_epoch`,
      [now, now, abandonedBefore, abandonedBefore]
    )
    let aborted = 0
    for (const candidate of candidates) {
      const didAbort = await this.database.transaction(async (transaction) => {
        const identity = {
          userId: text(candidate, 'user_id'),
          relayHostId: text(candidate, 'relay_host_id')
        }
        // Migration cleanup follows the same assignment-first order as evacuation.
        const assignment = await this.assignmentRow(transaction, identity)
        const assignmentEpoch = integer(candidate, 'assignment_epoch')
        const regionalAttempt = (
          await transaction.queryLocked(
            `SELECT attempt_id FROM relay_region_rehome_attempts
             WHERE user_id = ? AND relay_host_id = ? AND assignment_epoch = ?
               AND completed_at IS NULL AND aborted_at IS NULL`,
            [identity.userId, identity.relayHostId, assignmentEpoch]
          )
        )[0]
        const row = (
          await transaction.queryLocked(
            `SELECT migration.* FROM relay_assignment_migrations migration
             WHERE migration.user_id = ? AND migration.relay_host_id = ?
               AND migration.assignment_epoch = ?
               AND migration.expires_at <= ?
               AND migration.completed_at IS NULL AND migration.aborted_at IS NULL
               AND ${ABORTABLE_EXPIRED_MIGRATION}`,
            [
              identity.userId,
              identity.relayHostId,
              assignmentEpoch,
              now,
              now,
              abandonedBefore,
              abandonedBefore
            ]
          )
        )[0]
        if (!row) return false
        const targetCellId = text(row, 'target_cell_id')
        const activityLeases = await this.lockAssignmentActivities(transaction, identity)
        if (!assignment) throw new Error('migration_assignment_missing')
        const currentAssignmentEpoch = integer(assignment, 'assignment_epoch')
        const assignmentEpochMatches =
          text(assignment, 'cell_id') === targetCellId &&
          currentAssignmentEpoch === assignmentEpoch
        const pendingTargetControl = activityLeaseById(
          activityLeases,
          pendingControlActivityId(assignmentEpoch)
        )
        const targetGrantIsFresh =
          assignmentEpochMatches &&
          pendingTargetControl !== undefined &&
          text(pendingTargetControl, 'cell_id') === targetCellId &&
          text(pendingTargetControl, 'activity_kind') === 'control' &&
          integer(pendingTargetControl, 'expires_at') > now
        const targetIsActive = activityLeases.some(
          (lease) =>
            text(lease, 'cell_id') === targetCellId &&
            text(lease, 'activity_kind') === 'control' &&
            text(lease, 'activity_id') !== pendingControlActivityId(assignmentEpoch)
        )
        if (targetGrantIsFresh) return false
        if (targetIsActive && assignmentEpochMatches) {
          // A committed target control is stronger evidence than a failed follow-up
          // write; repair the marker instead of rolling a live desktop backward.
          await transaction.query(
            `UPDATE relay_assignment_migrations
             SET target_registered_at = COALESCE(target_registered_at, ?), updated_at = ?
             WHERE user_id = ? AND relay_host_id = ? AND assignment_epoch = ?`,
            [now, now, identity.userId, identity.relayHostId, assignmentEpoch]
          )
          return false
        }
        if (!assignmentEpochMatches) {
          if (currentAssignmentEpoch <= assignmentEpoch) {
            throw new Error('migration_assignment_mismatch')
          }
          // A newer assignment is authoritative regardless of where it landed.
          // Retire only this obsolete migration; never rewrite the newer epoch.
          const obsoleteLeases = [
            pendingControlActivityId(assignmentEpoch),
            migrationActivityId(assignmentEpoch)
          ]
            .map((activityId) => activityLeaseById(activityLeases, activityId))
            .filter((lease): lease is SqlRow => lease !== undefined)
          if (obsoleteLeases.length > 0) await this.lockCellInventory(transaction)
          for (const lease of obsoleteLeases) {
            await this.removeActivityLease(transaction, identity, lease, now)
          }
          await this.releaseSupersededControlConnectionReservations(
            transaction,
            identity,
            targetCellId,
            assignmentEpoch,
            now
          )
          await transaction.query(
            `UPDATE relay_assignment_migrations SET aborted_at = ?, updated_at = ?
             WHERE user_id = ? AND relay_host_id = ? AND assignment_epoch = ?`,
            [now, now, identity.userId, identity.relayHostId, assignmentEpoch]
          )
          return true
        }
        const cells = await this.lockCellInventory(transaction)
        const sourceCellId = text(row, 'source_cell_id')
        const admissionRows = await transaction.query(
          `SELECT cell_id, admission_state, updated_at FROM relay_cell_admission
           WHERE cell_id IN (?, ?)`,
          [sourceCellId, targetCellId]
        )
        const sourceCell = cells.find((cell) => text(cell, 'cell_id') === sourceCellId)
        const targetCell = cells.find((cell) => text(cell, 'cell_id') === targetCellId)
        const sourceAdmission = admissionRows.find(
          (admission) => text(admission, 'cell_id') === sourceCellId
        )
        const targetAdmission = admissionRows.find(
          (admission) => text(admission, 'cell_id') === targetCellId
        )
        const registered = optionalInteger(row, 'target_registered_at') !== undefined
        const sourceIsDurablyFenced =
          registered &&
          (
            await transaction.query(
              `SELECT 1 FROM relay_assignment_migrations migration
               WHERE migration.user_id = ? AND migration.relay_host_id = ?
                 AND migration.assignment_epoch = ?
                 AND ${DURABLY_FENCED_MIGRATION_SOURCE}`,
              [identity.userId, identity.relayHostId, assignmentEpoch]
            )
          ).length === 1
        const retireOnTarget =
          registered &&
          activityUnitsForCell(activityLeases, sourceCellId) === 0 &&
          sourceCell !== undefined &&
          integer(sourceCell, 'enabled') === 0 &&
          sourceAdmission !== undefined &&
          text(sourceAdmission, 'admission_state') === 'existing-only' &&
          (integer(sourceAdmission, 'updated_at') <= abandonedBefore ||
            sourceIsDurablyFenced) &&
          targetCell !== undefined &&
          integer(targetCell, 'enabled') === 1 &&
          targetAdmission !== undefined &&
          ['migration-only', 'general'].includes(text(targetAdmission, 'admission_state'))
        const rollbackReason =
          !registered ||
          (targetCell !== undefined &&
            integer(targetCell, 'enabled') === 0 &&
            targetAdmission !== undefined &&
            text(targetAdmission, 'admission_state') === 'existing-only' &&
            integer(targetAdmission, 'updated_at') <= abandonedBefore)
        const regionalRollbackSourceAvailable =
          !regionalAttempt ||
          (sourceCell !== undefined &&
            integer(sourceCell, 'enabled') === 1 &&
            sourceAdmission !== undefined &&
            text(sourceAdmission, 'admission_state') === 'general' &&
            (await this.cellIsLive(transaction, sourceCellId, now)))
        const rollbackToSource = rollbackReason && regionalRollbackSourceAvailable
        if (!retireOnTarget && !rollbackToSource) return false
        for (const activityId of [
          pendingControlActivityId(assignmentEpoch),
          migrationActivityId(assignmentEpoch)
        ]) {
          const lease = activityLeaseById(activityLeases, activityId)
          if (lease) await this.removeActivityLease(transaction, identity, lease, now)
        }
        await this.releaseSupersededControlConnectionReservations(
          transaction,
          identity,
          targetCellId,
          assignmentEpoch,
          now
        )
        if (retireOnTarget) {
          await transaction.query(
            `UPDATE relay_assignment_migrations SET completed_at = ?, updated_at = ?
             WHERE user_id = ? AND relay_host_id = ? AND assignment_epoch = ?`,
            [now, now, identity.userId, identity.relayHostId, assignmentEpoch]
          )
          return true
        }
        await transaction.query(
          `UPDATE relay_assignments SET cell_id = ?, assignment_epoch = ?,
             lease_expires_at = ?, last_activity_at = ?
           WHERE user_id = ? AND relay_host_id = ?`,
          [
            sourceCellId,
            assignmentEpoch + 1,
            now + ASSIGNMENT_LIMITS.activityLeaseMs,
            now,
            identity.userId,
            identity.relayHostId
          ]
        )
        await transaction.query(
          `UPDATE relay_assignment_migrations SET aborted_at = ?, updated_at = ?
           WHERE user_id = ? AND relay_host_id = ? AND assignment_epoch = ?`,
          [now, now, identity.userId, identity.relayHostId, assignmentEpoch]
        )
        return true
      })
      if (didAbort) aborted++
    }
    return aborted
  }

  async releaseExpiredActivityLeases(): Promise<number> {
    const now = this.now()
    await this.database.query(
      `UPDATE relay_control_connection_reservations
       SET state = 'late-arrival-debt', updated_at = ?
       WHERE state = 'reserved' AND timeout_at <= ?`,
      [now, now]
    )
    await this.database.query(
      `UPDATE relay_control_connection_reservations
       SET state = 'released', released_at = ?, updated_at = ?
       WHERE state = 'late-arrival-debt'
         AND claim_activity_id IS NULL
         AND timeout_at <= ?`,
      [now, now, now - LATE_ARRIVAL_DEBT_RETENTION_MS]
    )
    const candidates = await this.database.query(
      `SELECT user_id, relay_host_id, activity_id
       FROM relay_assignment_activity_leases lease
       WHERE expires_at <= ?
         AND NOT EXISTS (
           SELECT 1 FROM relay_region_rehome_attempts rehome
           WHERE rehome.user_id = lease.user_id
             AND rehome.relay_host_id = lease.relay_host_id
             AND rehome.completed_at IS NULL AND rehome.aborted_at IS NULL
             AND lease.activity_id IN (
               'control-pending:' || CAST(rehome.assignment_epoch AS TEXT),
               'migration:' || CAST(rehome.assignment_epoch AS TEXT)
             )
         )
         AND NOT EXISTS (
           SELECT 1 FROM relay_post_drain_migration_pins pin
           JOIN relay_assignment_migrations migration
             ON migration.user_id = pin.user_id
            AND migration.relay_host_id = pin.relay_host_id
            AND migration.assignment_epoch = pin.assignment_epoch
           WHERE pin.user_id = lease.user_id
             AND pin.relay_host_id = lease.relay_host_id
             AND migration.completed_at IS NULL
             AND migration.aborted_at IS NULL
             AND lease.activity_id IN (
               'control-pending:' || CAST(pin.assignment_epoch AS TEXT),
               'migration:' || CAST(pin.assignment_epoch AS TEXT)
             )
         )`,
      [now]
    )
    let released = 0
    for (const candidate of candidates) {
      let didRelease: boolean
      try {
        didRelease = await this.database.transaction(async (transaction) => {
          const identity = {
            userId: text(candidate, 'user_id'),
            relayHostId: text(candidate, 'relay_host_id')
          }
          // Why: re-check under the canonical assignment-first lock so a concurrent
          // renewal wins without cleanup reaping its refreshed lease.
          // Several directors sweep the same expired rows. Skip a row another
          // director is settling instead of waiting and retrying the transaction.
          await this.assignmentRow(transaction, identity, true)
          const activityLeases = await this.lockAssignmentActivities(transaction, identity, true)
          const lease = activityLeaseById(activityLeases, text(candidate, 'activity_id'))
          if (!lease || integer(lease, 'expires_at') > now) return false
          await this.lockCellInventory(transaction, true)
          await this.removeActivityLease(transaction, identity, lease, now)
          return true
        })
      } catch (error) {
        // Released cell images can still hold their legacy cell-first lock;
        // expiry is durable, so a later maintenance sweep can safely retry it.
        if (isDatabaseLockUnavailable(error)) continue
        throw error
      }
      if (didRelease) released++
    }
    return released
  }

  async releaseExpiredActivity(): Promise<number> {
    const now = this.now()
    try {
      return await this.database.transaction(async (transaction) => {
        const expired = await transaction.queryLocked(
          `SELECT * FROM relay_assignments WHERE lease_expires_at <= ? AND
           (reserved_controls > 0 OR reserved_splices > 0 OR reserved_invites > 0 OR
            pending_installs > 0 OR pending_confirmations > 0 OR migration_leases > 0)
           AND NOT EXISTS (
             SELECT 1 FROM relay_region_rehome_attempts rehome
             WHERE rehome.user_id = relay_assignments.user_id
               AND rehome.relay_host_id = relay_assignments.relay_host_id
               AND rehome.completed_at IS NULL AND rehome.aborted_at IS NULL
           )
           AND NOT EXISTS (
             SELECT 1 FROM relay_post_drain_migration_pins pin
             JOIN relay_assignment_migrations migration
               ON migration.user_id = pin.user_id
              AND migration.relay_host_id = pin.relay_host_id
              AND migration.assignment_epoch = pin.assignment_epoch
             WHERE pin.user_id = relay_assignments.user_id
               AND pin.relay_host_id = relay_assignments.relay_host_id
               AND migration.completed_at IS NULL
               AND migration.aborted_at IS NULL
           )
           ORDER BY user_id, relay_host_id`,
          [now],
          { failIfUnavailable: true }
        )
        if (expired.length > 0) await this.lockCellInventory(transaction, true)
        for (const row of expired) {
          await this.adjustCellReservation(transaction, text(row, 'cell_id'), -requestUnits(row))
          await transaction.query(
            `UPDATE relay_assignments SET reserved_controls = 0, reserved_splices = 0,
             reserved_invites = 0, pending_installs = 0, pending_confirmations = 0,
             migration_leases = 0
             WHERE user_id = ? AND relay_host_id = ?`,
            [text(row, 'user_id'), text(row, 'relay_host_id')]
          )
        }
        return expired.length
      })
    } catch (error) {
      // Aggregate expiry is reconstructible from durable leases; never wait
      // long enough to form a mixed-version cell/assignment lock cycle.
      if (isDatabaseLockUnavailable(error)) return 0
      throw error
    }
  }

  async releaseExpiredRegionPreferences(): Promise<number> {
    const result = await this.database.query(
      `DELETE FROM relay_assignment_region_preferences WHERE observed_at < ?`,
      [this.now() - REGION_PREFERENCE_RETENTION_MS]
    )
    return integer(result[0]!, 'changes')
  }

  private async reconcileReservationAccounting(
    sourceCellId: string,
    targetCellId: string
  ): Promise<void> {
    const now = this.now()
    await this.database.transaction(async (transaction) => {
      // Reconciliation takes the same assignment→activity→cell order as live
      // mutations so correcting drift never races a credential or socket lease.
      const assignments = await transaction.queryLocked(
        `SELECT assignment.* FROM relay_assignments assignment
         WHERE assignment.cell_id IN (?, ?) OR EXISTS (
           SELECT 1 FROM relay_assignment_activity_leases scoped_lease
           WHERE scoped_lease.user_id = assignment.user_id
             AND scoped_lease.relay_host_id = assignment.relay_host_id
             AND scoped_lease.cell_id IN (?, ?)
         )
         ORDER BY assignment.user_id, assignment.relay_host_id`,
        [sourceCellId, targetCellId, sourceCellId, targetCellId]
      )
      const leases = await transaction.queryLocked(
        `SELECT lease.* FROM relay_assignment_activity_leases lease
         WHERE lease.cell_id IN (?, ?) OR EXISTS (
           SELECT 1 FROM relay_assignments assignment
           WHERE assignment.user_id = lease.user_id
             AND assignment.relay_host_id = lease.relay_host_id
             AND (
               assignment.cell_id IN (?, ?) OR EXISTS (
                 SELECT 1 FROM relay_assignment_activity_leases scoped_lease
                 WHERE scoped_lease.user_id = lease.user_id
                   AND scoped_lease.relay_host_id = lease.relay_host_id
                   AND scoped_lease.cell_id IN (?, ?)
               )
             )
         )
         ORDER BY lease.user_id, lease.relay_host_id, lease.activity_id`,
        [
          sourceCellId,
          targetCellId,
          sourceCellId,
          targetCellId,
          sourceCellId,
          targetCellId
        ]
      )
      const cells = await this.lockCellInventory(transaction)
      const assignmentKeys = new Set(
        assignments.map((row) =>
          assignmentKey(text(row, 'user_id'), text(row, 'relay_host_id'))
        )
      )
      const cellIds = new Set(cells.map((row) => text(row, 'cell_id')))
      const assignmentCounts = new Map<
        string,
        { counts: Record<AssignmentActivityKind, number>; leaseExpiresAt: number }
      >()
      const cellUnits = new Map<string, number>()

      for (const lease of leases) {
        const key = assignmentKey(text(lease, 'user_id'), text(lease, 'relay_host_id'))
        if (!assignmentKeys.has(key)) throw new Error('activity_lease_assignment_missing')
        const cellId = text(lease, 'cell_id')
        if (!cellIds.has(cellId)) throw new Error('activity_lease_cell_missing')
        const current =
          assignmentCounts.get(key) ?? {
            counts: emptyActivityCounts(),
            leaseExpiresAt: 0
          }
        const kind = activityKind(lease)
        current.counts[kind]++
        current.leaseExpiresAt = Math.max(current.leaseExpiresAt, integer(lease, 'expires_at'))
        assignmentCounts.set(key, current)
        cellUnits.set(cellId, (cellUnits.get(cellId) ?? 0) + integer(lease, 'request_units'))
      }

      for (const row of assignments) {
        const current = assignmentCounts.get(
          assignmentKey(text(row, 'user_id'), text(row, 'relay_host_id'))
        )
        const counts = current?.counts ?? emptyActivityCounts()
        const differs = (Object.keys(ACTIVITY_COLUMN) as AssignmentActivityKind[]).some(
          (kind) => integer(row, ACTIVITY_COLUMN[kind]) !== counts[kind]
        )
        const expiryDiffers =
          current !== undefined && integer(row, 'lease_expires_at') !== current.leaseExpiresAt
        if (!differs && !expiryDiffers) continue
        await transaction.query(
          `UPDATE relay_assignments SET reserved_controls = ?, reserved_splices = ?,
             reserved_invites = ?, pending_installs = ?, pending_confirmations = ?,
             migration_leases = ?, lease_expires_at = ?
           WHERE user_id = ? AND relay_host_id = ?`,
          [
            counts.control,
            counts.splice,
            counts.invite,
            counts.install,
            counts.confirmation,
            counts.migration,
            current?.leaseExpiresAt ?? integer(row, 'lease_expires_at'),
            text(row, 'user_id'),
            text(row, 'relay_host_id')
          ]
        )
      }

      for (const row of cells.filter((cell) =>
        [sourceCellId, targetCellId].includes(text(cell, 'cell_id'))
      )) {
        const cellId = text(row, 'cell_id')
        const expected = cellUnits.get(cellId) ?? 0
        if (expected > integer(row, 'capacity_requests')) {
          throw new Error('relay_capacity_exhausted')
        }
        if (integer(row, 'reserved_requests') === expected) continue
        await transaction.query(
          `UPDATE relay_cells SET reserved_requests = ?, updated_at = ? WHERE cell_id = ?`,
          [expected, now, cellId]
        )
      }
    })
  }

  private async lockCellInventory(
    database: RelayDatabase,
    failIfUnavailable = false
  ): Promise<SqlRow[]> {
    // Every capacity-changing assignment takes the tiny cell inventory in one
    // order; dynamically locking only the selected target allowed cross-cell cycles.
    return await database.queryLocked(
      `SELECT * FROM relay_cells ORDER BY cell_id ASC`,
      [],
      { failIfUnavailable }
    )
  }

  private async lockGeneralCellInventory(
    database: RelayDatabase,
    failIfUnavailable = false
  ): Promise<SqlRow[]> {
    return await database.queryLocked(
      `SELECT * FROM relay_cells
       WHERE cell_id IN (
         SELECT cell_id FROM relay_cell_admission WHERE admission_state = 'general'
       )
       ORDER BY cell_id ASC`,
      [],
      { failIfUnavailable }
    )
  }

  private async leastLoadedCell(
    database: RelayDatabase,
    lockedCells: SqlRow[] | undefined,
    preferredRegion: RelayRegion
  ): Promise<CellRow | null> {
    const rows = lockedCells ?? (await this.lockCellInventory(database))
    const regions = new Map(
      (await database.query(`SELECT cell_id, region FROM relay_cell_regions`)).map((row) => [
        text(row, 'cell_id'),
        relayRegion(row, 'region')
      ])
    )
    const admission = await cellAdmissionStates(database)
    const runtimeLoad = this.requireLiveCells
      ? new Map(
          (
            await database.query(
              `SELECT cell_id, observed_requests FROM relay_cell_runtime
               WHERE ready = ? AND last_heartbeat_at > ?`,
              [1, this.now() - this.heartbeatTtlMs]
            )
          ).map((row) => [text(row, 'cell_id'), integer(row, 'observed_requests')])
        )
      : null
    const connectionHeadroom = await this.connectionHeadroomByCell(database)
    const candidates = rows.filter((row) => {
      const cellId = text(row, 'cell_id')
      return (
        admission.get(cellId) === 'general' &&
        integer(row, 'reserved_requests') < integer(row, 'capacity_requests') &&
        (!runtimeLoad || runtimeLoad.has(cellId)) &&
        connectionHeadroom.get(cellId) !== false
      )
    })
    candidates.sort((left, right) => {
      const leftLoad =
        integer(left, 'reserved_requests') +
        (runtimeLoad?.get(text(left, 'cell_id')) ?? integer(left, 'observed_requests'))
      const rightLoad =
        integer(right, 'reserved_requests') +
        (runtimeLoad?.get(text(right, 'cell_id')) ?? integer(right, 'observed_requests'))
      const loadDifference =
        leftLoad / integer(left, 'capacity_requests') -
        rightLoad / integer(right, 'capacity_requests')
      return loadDifference || text(left, 'cell_id').localeCompare(text(right, 'cell_id'))
    })
    const preferred = candidates.filter(
      (candidate) =>
        (regions.get(text(candidate, 'cell_id')) ?? RELAY_DEFAULT_REGION) === preferredRegion
    )
    const selected = preferred[0] ?? candidates[0]
    return selected
      ? cell(selected, regions.get(text(selected, 'cell_id')) ?? RELAY_DEFAULT_REGION)
      : null
  }

  async regionCatalog(): Promise<RelayRegionCatalogEntry[]> {
    const rows = await this.database.query(
      `SELECT cell.cell_id, cell.cell_url, region.region
       FROM relay_cells cell
       LEFT JOIN relay_cell_regions region ON region.cell_id = cell.cell_id
       JOIN relay_cell_admission admission ON admission.cell_id = cell.cell_id
       JOIN relay_cell_runtime runtime ON runtime.cell_id = cell.cell_id
       WHERE cell.enabled = 1
         AND admission.admission_state = 'general'
         AND runtime.ready = ? AND runtime.last_heartbeat_at > ?
       ORDER BY cell.cell_id ASC`,
      [1, this.now() - this.heartbeatTtlMs]
    )
    const origins = new Map<RelayRegion, string[]>()
    for (const row of rows) {
      const region = optionalRelayRegion(row, 'region') ?? RELAY_DEFAULT_REGION
      const current = origins.get(region) ?? []
      if (current.length < 2) current.push(text(row, 'cell_url'))
      origins.set(region, current)
    }
    return RELAY_REGIONS.flatMap((region) => {
      const probeOrigins = origins.get(region)
      return probeOrigins?.length ? [{ region, probeOrigins }] : []
    })
  }

  private async recordRegionPreference(
    database: RelayDatabase,
    identity: AssignmentIdentity,
    preferredRegion: RelayRegion | undefined,
    observedAt: number
  ): Promise<void> {
    if (!preferredRegion) return
    await database.query(
      `INSERT INTO relay_assignment_region_preferences
       (user_id, relay_host_id, preferred_region, observed_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id, relay_host_id) DO UPDATE SET
         preferred_region = CASE
           WHEN excluded.observed_at >= relay_assignment_region_preferences.observed_at
             THEN excluded.preferred_region
           ELSE relay_assignment_region_preferences.preferred_region
         END,
         observed_at = CASE
           WHEN excluded.observed_at >= relay_assignment_region_preferences.observed_at
             THEN excluded.observed_at
           ELSE relay_assignment_region_preferences.observed_at
         END`,
      [identity.userId, identity.relayHostId, preferredRegion, observedAt]
    )
  }

  private async cellRegion(database: RelayDatabase, cellId: string): Promise<RelayRegion> {
    const row = (
      await database.query(`SELECT region FROM relay_cell_regions WHERE cell_id = ?`, [cellId])
    )[0]
    return row ? relayRegion(row, 'region') : RELAY_DEFAULT_REGION
  }

  private async connectionHeadroomByCell(
    database: RelayDatabase
  ): Promise<Map<string, boolean>> {
    const now = this.now()
    const rows = await database.query(ASSIGNMENT_CONNECTION_HEADROOM_QUERY)
    return new Map(
      rows.map((row) => {
        const heartbeat = optionalInteger(row, 'last_heartbeat_at')
        const hasFreshTelemetry =
          heartbeat !== undefined &&
          heartbeat > now - this.heartbeatTtlMs &&
          optionalText(row, 'connection_incarnation') ===
            optionalText(row, 'current_incarnation')
        const hasHeadroom =
          hasFreshTelemetry &&
          integer(row, 'enforced_connection_units') +
            integer(row, 'outstanding_reservations') +
            integer(row, 'unobserved_bound') <
            integer(row, 'hard_cap') -
              RELAY_ADMISSION_BUDGETS.reservedHostControls
        return [text(row, 'cell_id'), hasHeadroom] as const
      })
    )
  }

  private async assertCellConnectionHeadroom(
    database: RelayDatabase,
    cellId: string
  ): Promise<void> {
    if (!(await this.cellHasConnectionHeadroom(database, cellId))) {
      throw new Error('relay_connection_headroom_exhausted')
    }
  }

  private async cellHasConnectionHeadroom(
    database: RelayDatabase,
    cellId: string
  ): Promise<boolean> {
    return (await this.connectionHeadroomByCell(database)).get(cellId) !== false
  }

  private async cellIsLive(
    database: RelayDatabase,
    cellId: string,
    now: number
  ): Promise<boolean> {
    if (!this.requireLiveCells) return true
    const rows = await database.query(
      `SELECT cell.cell_id FROM relay_cells cell
       JOIN relay_cell_runtime runtime ON runtime.cell_id = cell.cell_id
       WHERE cell.cell_id = ? AND runtime.ready = ? AND runtime.last_heartbeat_at > ?`,
      [cellId, 1, now - this.heartbeatTtlMs]
    )
    return rows.length === 1
  }

  private async cellHasActiveFence(cellId: string): Promise<boolean> {
    const rows = await this.database.query(
      `SELECT fence.cell_id FROM relay_cell_fences fence
       JOIN relay_cells cell ON cell.cell_id = fence.cell_id
       JOIN relay_cell_runtime runtime ON runtime.cell_id = fence.cell_id
       WHERE fence.cell_id = ? AND cell.enabled = 0
         AND fence.cell_incarnation = runtime.cell_incarnation
         AND fence.attested_at >= runtime.last_heartbeat_at
         AND fence.expires_at > ?`,
      [cellId, this.now()]
    )
    return rows.length === 1
  }

  private async recordCommittedCellFence(
    transaction: RelayDatabase,
    cellId: string,
    cellIncarnation: string,
    attemptId: string,
    attestedAt: number,
    expiresAt: number
  ): Promise<void> {
    await transaction.query(
      `INSERT INTO relay_cell_committed_fences
       (cell_id, attempt_id, cell_incarnation, attested_at, expires_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (cell_id) DO UPDATE SET
         attempt_id = excluded.attempt_id,
         cell_incarnation = excluded.cell_incarnation,
         attested_at = excluded.attested_at,
         expires_at = excluded.expires_at`,
      [cellId, attemptId, cellIncarnation, attestedAt, expiresAt]
    )
  }

  private async cellHasCommittedFence(
    database: RelayDatabase,
    cellId: string,
    now: number
  ): Promise<boolean> {
    const rows = await database.query(
      `SELECT committed.cell_id
       FROM relay_cell_committed_fences committed
       JOIN relay_cell_fence_attempts attempt
         ON attempt.attempt_id = committed.attempt_id
       JOIN relay_cell_fences fence ON fence.cell_id = committed.cell_id
       JOIN relay_cell_runtime runtime ON runtime.cell_id = committed.cell_id
       JOIN relay_cells cell ON cell.cell_id = committed.cell_id
       WHERE committed.cell_id = ?
         AND attempt.completed_at IS NOT NULL
         AND attempt.aborted_at IS NULL
         AND cell.enabled = 0
         AND committed.cell_incarnation = runtime.cell_incarnation
         AND fence.cell_incarnation = committed.cell_incarnation
         AND committed.attested_at >= runtime.last_heartbeat_at
         AND committed.expires_at > ?
         AND fence.expires_at > ?`,
      [cellId, now, now]
    )
    return rows.length === 1
  }

  private async deadCellRequiresCommittedFence(
    database: RelayDatabase,
    identity: AssignmentIdentity,
    cellId: string,
    assignmentEpoch: number
  ): Promise<boolean> {
    const row = (
      await database.query(
        `SELECT
           CASE WHEN EXISTS (
             SELECT 1 FROM relay_cell_connection_limits limits
             WHERE limits.cell_id = ?
           ) THEN 1 ELSE 0 END AS capped,
           CASE WHEN EXISTS (
             SELECT 1 FROM relay_post_drain_migration_pins pin
             JOIN relay_assignment_migrations migration
               ON migration.user_id = pin.user_id
              AND migration.relay_host_id = pin.relay_host_id
              AND migration.assignment_epoch = pin.assignment_epoch
             WHERE pin.user_id = ? AND pin.relay_host_id = ?
               AND pin.assignment_epoch = ?
               AND pin.target_cell_id = ?
               AND migration.completed_at IS NULL
               AND migration.aborted_at IS NULL
           ) THEN 1 ELSE 0 END AS pinned`,
        [cellId, identity.userId, identity.relayHostId, assignmentEpoch, cellId]
      )
    )[0]
    if (!row) return false
    return integer(row, 'capped') === 1 || integer(row, 'pinned') === 1
  }

  private async assertDrainCellGeneration(
    transaction: RelayDatabase,
    cellId: string,
    cellIncarnation: string
  ): Promise<void> {
    const cell = (
      await transaction.queryLocked(`SELECT * FROM relay_cells WHERE cell_id = ?`, [cellId])
    )[0]
    const runtime = (
      await transaction.queryLocked(`SELECT * FROM relay_cell_runtime WHERE cell_id = ?`, [
        cellId
      ])
    )[0]
    if (!cell || integer(cell, 'enabled') !== 0) {
      throw new Error('drain_attempt_admission_enabled')
    }
    if (!runtime || text(runtime, 'cell_incarnation') !== cellIncarnation) {
      throw new Error('drain_attempt_generation_mismatch')
    }
  }

  private async requireCellFence(
    transaction: RelayDatabase,
    cellId: string,
    runtime: SqlRow | undefined,
    now: number
  ): Promise<void> {
    const fence = (
      await transaction.queryLocked(`SELECT * FROM relay_cell_fences WHERE cell_id = ?`, [
        cellId
      ])
    )[0]
    if (
      !fence ||
      !runtime ||
      text(fence, 'cell_incarnation') !== text(runtime, 'cell_incarnation') ||
      integer(fence, 'attested_at') < integer(runtime, 'last_heartbeat_at') ||
      integer(fence, 'expires_at') <= now
    ) {
      throw new Error('cell_fence_attestation_missing')
    }
  }

  private async activeCellMigrations(sourceCellId: string, targetCellId: string): Promise<SqlRow[]> {
    const targetRuntimeSafety = this.requireLiveCells
      ? `AND EXISTS (
           SELECT 1 FROM relay_cell_runtime target_runtime
           WHERE target_runtime.cell_id = migration.target_cell_id
             AND lease.updated_at >= target_runtime.started_at
         )`
      : ''
    return await this.database.query(
      `SELECT migration.*, assignment.cell_id AS current_cell_id,
         assignment.assignment_epoch AS current_assignment_epoch,
         COALESCE((
           SELECT SUM(source_lease.request_units)
           FROM relay_assignment_activity_leases source_lease
           WHERE source_lease.user_id = migration.user_id
             AND source_lease.relay_host_id = migration.relay_host_id
             AND source_lease.cell_id = migration.source_cell_id
         ), 0) AS source_activity_units,
         CASE WHEN EXISTS (
           SELECT 1 FROM relay_assignment_activity_leases lease
           WHERE lease.user_id = migration.user_id
             AND lease.relay_host_id = migration.relay_host_id
             AND lease.cell_id = migration.target_cell_id
             AND lease.activity_kind = 'control'
             AND lease.activity_id NOT LIKE 'control-pending:%'
         ) THEN 1 ELSE 0 END AS target_control_active,
         CASE WHEN EXISTS (
           SELECT 1 FROM relay_assignment_activity_leases lease
           WHERE lease.user_id = migration.user_id
             AND lease.relay_host_id = migration.relay_host_id
             AND lease.cell_id = migration.target_cell_id
             AND lease.activity_kind = 'control'
             AND lease.activity_id NOT LIKE 'control-pending:%'
             AND lease.expires_at > ?
             ${targetRuntimeSafety}
         ) THEN 1 ELSE 0 END AS target_control_current
       FROM relay_assignment_migrations migration
       LEFT JOIN relay_assignments assignment
         ON assignment.user_id = migration.user_id
        AND assignment.relay_host_id = migration.relay_host_id
       WHERE migration.source_cell_id = ? AND migration.target_cell_id = ?
         AND migration.completed_at IS NULL AND migration.aborted_at IS NULL
       ORDER BY migration.user_id, migration.relay_host_id`,
      [this.now(), sourceCellId, targetCellId]
    )
  }

  private async insertPendingControlLease(
    database: RelayDatabase,
    identity: AssignmentIdentity,
    cellId: string,
    assignmentEpoch: number,
    now: number
  ): Promise<void> {
    const timeoutAt = now + ASSIGNMENT_LIMITS.activityLeaseMs
    await database.query(
      `INSERT INTO relay_assignment_activity_leases
       (user_id, relay_host_id, activity_id, activity_kind, cell_id,
        request_units, expires_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, relay_host_id, activity_id) DO UPDATE SET
         expires_at = excluded.expires_at, updated_at = excluded.updated_at`,
      [
        identity.userId,
        identity.relayHostId,
        pendingControlActivityId(assignmentEpoch),
        'control',
        cellId,
        1,
        timeoutAt,
        now
      ]
    )
    await this.insertControlConnectionReservation(
      database,
      identity,
      cellId,
      assignmentEpoch,
      timeoutAt,
      now
    )
  }

  private async insertControlConnectionReservation(
    database: RelayDatabase,
    identity: AssignmentIdentity,
    cellId: string,
    assignmentEpoch: number,
    timeoutAt: number,
    now: number
  ): Promise<void> {
    const existing = await database.queryLocked(
      `SELECT reservation_id
       FROM relay_control_connection_reservations
       WHERE user_id = ? AND relay_host_id = ? AND assignment_epoch = ?
         AND cell_id = ? AND state IN ('reserved', 'late-arrival-debt')
         AND claim_activity_id IS NULL
       ORDER BY created_at ASC, reservation_id ASC
       LIMIT 1`,
      [identity.userId, identity.relayHostId, assignmentEpoch, cellId]
    )
    if (existing.length > 0) return
    const reservationId = randomUUID()
    await database.query(
      `INSERT INTO relay_control_connection_reservations
       (reservation_id, idempotency_key, user_id, relay_host_id,
        assignment_epoch, cell_id, state, inclusion_watermark,
        claim_activity_id, created_at, timeout_at, claimed_at, released_at,
        updated_at)
       SELECT ?, ?, ?, ?, ?, ?, 'reserved', NULL, NULL, ?, ?, NULL, NULL, ?
       FROM relay_cell_connection_limits WHERE cell_id = ?`,
      [
        reservationId,
        reservationId,
        identity.userId,
        identity.relayHostId,
        assignmentEpoch,
        cellId,
        now,
        timeoutAt,
        now,
        cellId
      ]
    )
  }

  private async refreshPendingControlReservation(
    database: RelayDatabase,
    identity: AssignmentIdentity,
    cellId: string,
    assignmentEpoch: number,
    timeoutAt: number,
    now: number
  ): Promise<void> {
    await database.query(
      `UPDATE relay_control_connection_reservations
       SET state = 'reserved', timeout_at = ?, updated_at = ?
       WHERE user_id = ? AND relay_host_id = ? AND assignment_epoch = ?
         AND cell_id = ? AND state IN ('reserved', 'late-arrival-debt')
         AND claim_activity_id IS NULL`,
      [
        timeoutAt,
        now,
        identity.userId,
        identity.relayHostId,
        assignmentEpoch,
        cellId
      ]
    )
  }

  private async claimControlConnectionReservation(
    database: RelayDatabase,
    identity: AssignmentIdentity,
    cellId: string,
    assignmentEpoch: number,
    activityId: string,
    inclusionWatermark: number | undefined,
    now: number
  ): Promise<void> {
    await database.query(
      `UPDATE relay_control_connection_reservations
       SET claim_activity_id = ?, updated_at = ?
       WHERE user_id = ? AND relay_host_id = ? AND assignment_epoch = ?
         AND cell_id = ? AND state = 'claimed'
         AND claim_activity_id IS NOT NULL AND claim_activity_id <> ?`,
      [
        activityId,
        now,
        identity.userId,
        identity.relayHostId,
        assignmentEpoch,
        cellId,
        activityId
      ]
    )
    // A released row's claim_activity_id is history, not a live claim: a control that
    // reconnects under the same generation would otherwise leave its fresh reservation
    // unclaimable, decaying through debt while the connection is already enforced.
    const alreadyClaimed = await database.queryLocked(
      `SELECT reservation_id FROM relay_control_connection_reservations
       WHERE user_id = ? AND relay_host_id = ? AND assignment_epoch = ?
         AND cell_id = ? AND claim_activity_id = ? AND state <> 'released'
       ORDER BY created_at ASC, reservation_id ASC`,
      [
        identity.userId,
        identity.relayHostId,
        assignmentEpoch,
        cellId,
        activityId
      ]
    )
    if (alreadyClaimed.length > 0) return
    const reservation = (
      await database.queryLocked(
        `SELECT * FROM relay_control_connection_reservations
         WHERE user_id = ? AND relay_host_id = ? AND assignment_epoch = ?
           AND cell_id = ? AND state IN ('reserved', 'late-arrival-debt')
           AND claim_activity_id IS NULL
         ORDER BY created_at ASC, reservation_id ASC`,
        [identity.userId, identity.relayHostId, assignmentEpoch, cellId]
      )
    )[0]
    if (!reservation) return
    await database.query(
      `UPDATE relay_control_connection_reservations
       SET state = 'claimed', inclusion_watermark = ?, claim_activity_id = ?,
         claimed_at = ?, updated_at = ?
       WHERE reservation_id = ?`,
      [
        inclusionWatermark,
        activityId,
        now,
        now,
        text(reservation, 'reservation_id')
      ]
    )
  }

  private async releaseSupersededControlConnectionReservations(
    database: RelayDatabase,
    identity: AssignmentIdentity,
    cellId: string,
    assignmentEpoch: number,
    now: number
  ): Promise<void> {
    await database.query(
      `UPDATE relay_control_connection_reservations
       SET state = 'released', released_at = ?, updated_at = ?
       WHERE user_id = ? AND relay_host_id = ? AND cell_id = ?
         AND assignment_epoch = ? AND state <> 'released'`,
      [
        now,
        now,
        identity.userId,
        identity.relayHostId,
        cellId,
        assignmentEpoch
      ]
    )
  }

  private async assignmentRow(
    database: RelayDatabase,
    identity: AssignmentIdentity,
    failIfUnavailable = false
  ): Promise<SqlRow | undefined> {
    return (
      await database.queryLocked(
        `SELECT * FROM relay_assignments WHERE user_id = ? AND relay_host_id = ?`,
        [identity.userId, identity.relayHostId],
        { failIfUnavailable }
      )
    )[0]
  }

  private async lockAssignmentActivities(
    database: RelayDatabase,
    identity: AssignmentIdentity,
    failIfUnavailable = false
  ): Promise<SqlRow[]> {
    // Lease rows always precede the globally ordered capacity rows.
    return await database.queryLocked(
      `SELECT * FROM relay_assignment_activity_leases
       WHERE user_id = ? AND relay_host_id = ? ORDER BY activity_id ASC`,
      [identity.userId, identity.relayHostId],
      { failIfUnavailable }
    )
  }

  private async removeActivityLease(
    database: RelayDatabase,
    identity: AssignmentIdentity,
    lease: SqlRow,
    now: number
  ): Promise<void> {
    const kind = activityKind(lease)
    await this.adjustCellReservation(
      database,
      text(lease, 'cell_id'),
      -integer(lease, 'request_units')
    )
    await database.query(
      `DELETE FROM relay_assignment_activity_leases
       WHERE user_id = ? AND relay_host_id = ? AND activity_id = ?`,
      [identity.userId, identity.relayHostId, text(lease, 'activity_id')]
    )
    await this.adjustActivityCount(database, identity, kind, -1, now, now)
  }

  private async removeSupersededSameCellControls(
    database: RelayDatabase,
    identity: AssignmentIdentity,
    leases: SqlRow[],
    cellId: string,
    retainedActivityId: string,
    now: number
  ): Promise<void> {
    const superseded = leases.filter(
      (lease) =>
        activityKind(lease) === 'control' &&
        text(lease, 'cell_id') === cellId &&
        text(lease, 'activity_id') !== retainedActivityId
    )
    if (superseded.length === 0) return
    if (
      superseded.some(
        (lease) => integer(lease, 'request_units') !== ACTIVITY_REQUEST_UNITS.control
      )
    ) {
      throw new Error('activity_lease_shape_mismatch')
    }
    const cells = await this.lockCellInventory(database)
    await database.query(
      `DELETE FROM relay_assignment_activity_leases
       WHERE user_id = ? AND relay_host_id = ? AND activity_kind = 'control'
         AND cell_id = ? AND activity_id <> ?`,
      [identity.userId, identity.relayHostId, cellId, retainedActivityId]
    )
    const remainingControls =
      leases.filter((lease) => activityKind(lease) === 'control').length - superseded.length
    await database.query(
      `UPDATE relay_assignments SET reserved_controls = ?, last_activity_at = ?
       WHERE user_id = ? AND relay_host_id = ?`,
      [remainingControls, now, identity.userId, identity.relayHostId]
    )
    const cellUnitsRow = (
      await database.query(
        `SELECT COALESCE(SUM(request_units), 0) AS request_units
         FROM relay_assignment_activity_leases WHERE cell_id = ?`,
        [cellId]
      )
    )[0]!
    const cellRow = cells.find((cell) => text(cell, 'cell_id') === cellId)
    const cellUnits = integer(cellUnitsRow, 'request_units')
    if (!cellRow) throw new Error('assigned_cell_missing')
    if (cellUnits > integer(cellRow, 'capacity_requests')) {
      throw new Error('relay_capacity_exhausted')
    }
    await database.query(
      `UPDATE relay_cells SET reserved_requests = ?, updated_at = ? WHERE cell_id = ?`,
      [cellUnits, now, cellId]
    )
  }

  private async adjustActivityCount(
    database: RelayDatabase,
    identity: AssignmentIdentity,
    kind: AssignmentActivityKind,
    delta: 1 | -1,
    leaseExpiresAt: number,
    now: number
  ): Promise<void> {
    const column = ACTIVITY_COLUMN[kind]
    await database.query(
      `UPDATE relay_assignments SET ${column} =
         CASE WHEN ${column} + ? < 0 THEN 0 ELSE ${column} + ? END,
         lease_expires_at =
           CASE WHEN lease_expires_at > ? THEN lease_expires_at ELSE ? END,
         last_activity_at = ?
       WHERE user_id = ? AND relay_host_id = ?`,
      [delta, delta, leaseExpiresAt, leaseExpiresAt, now, identity.userId, identity.relayHostId]
    )
  }

  private async touchAssignment(
    database: RelayDatabase,
    identity: AssignmentIdentity,
    leaseExpiresAt: number,
    now: number
  ): Promise<void> {
    await database.query(
      `UPDATE relay_assignments SET lease_expires_at =
         CASE WHEN lease_expires_at > ? THEN lease_expires_at ELSE ? END,
         last_activity_at = ?
       WHERE user_id = ? AND relay_host_id = ?`,
      [leaseExpiresAt, leaseExpiresAt, now, identity.userId, identity.relayHostId]
    )
  }

  private async adjustCellReservation(
    database: RelayDatabase,
    cellId: string,
    delta: number
  ): Promise<void> {
    const row = (await database.queryLocked(`SELECT * FROM relay_cells WHERE cell_id = ?`, [cellId]))[0]
    if (!row) throw new Error('assigned_cell_missing')
    const next = integer(row, 'reserved_requests') + delta
    if (next > integer(row, 'capacity_requests')) throw new Error('relay_capacity_exhausted')
    await database.query(
      `UPDATE relay_cells SET reserved_requests =
         CASE WHEN reserved_requests + ? < 0 THEN 0 ELSE reserved_requests + ? END,
         updated_at = ? WHERE cell_id = ?`,
      [delta, delta, this.now(), cellId]
    )
  }

  private async adjustCellReservationAtomically(
    database: RelayDatabase,
    cellId: string,
    delta: number
  ): Promise<void> {
    const rows = await database.query(
      `UPDATE relay_cells SET reserved_requests =
         CASE WHEN reserved_requests + ? < 0 THEN 0 ELSE reserved_requests + ? END,
         updated_at = ?
       WHERE cell_id = ?
         AND (? <= 0 OR reserved_requests + ? <= capacity_requests)
       RETURNING cell_id`,
      [delta, delta, this.now(), cellId, delta, delta]
    )
    if (rows.length > 0) return
    const cell = (
      await database.query(`SELECT cell_id FROM relay_cells WHERE cell_id = ?`, [cellId])
    )[0]
    if (!cell) throw new Error('assigned_cell_missing')
    throw new Error('relay_capacity_exhausted')
  }

  private result(
    identity: AssignmentIdentity,
    row: SqlRow,
    cellRow: CellRow,
    leaseExpiresAt: number
  ): RelayAssignment {
    return {
      ...identity,
      ...cellRow,
      assignmentEpoch: integer(row, 'assignment_epoch'),
      leaseExpiresAt
    }
  }
}

type CellRow = { cellId: string; cellUrl: string; region: RelayRegion }

function cell(row: SqlRow, region: RelayRegion): CellRow {
  return { cellId: text(row, 'cell_id'), cellUrl: text(row, 'cell_url'), region }
}

function relayRegion(row: SqlRow, field: string): RelayRegion {
  const value = text(row, field)
  if (!RELAY_REGIONS.includes(value as RelayRegion)) throw new Error(`invalid region field ${field}`)
  return value as RelayRegion
}

function optionalRelayRegion(row: SqlRow, field: string): RelayRegion | undefined {
  const value = optionalText(row, field)
  if (value === undefined) return undefined
  if (!RELAY_REGIONS.includes(value as RelayRegion)) throw new Error(`invalid region field ${field}`)
  return value as RelayRegion
}

function activityLeaseById(rows: SqlRow[], activityId: string): SqlRow | undefined {
  return rows.find((row) => text(row, 'activity_id') === activityId)
}

// Why: mid-rehome a host legitimately holds the source control plus the
// target's pending control, so only the lease rows — never the counter a grant
// would overwrite — can say whether this cell is already reserved for it.
function holdsControlLease(
  rows: SqlRow[],
  cellId: string,
  assignmentEpoch: number
): boolean {
  const pendingId = pendingControlActivityId(assignmentEpoch)
  return rows.some((row) => {
    if (activityKind(row) !== 'control' || text(row, 'cell_id') !== cellId) return false
    const activityId = text(row, 'activity_id')
    return activityId === pendingId || !activityId.startsWith('control-pending:')
  })
}

function activityCounts(rows: SqlRow[]): Record<AssignmentActivityKind, number> {
  const counts = emptyActivityCounts()
  for (const row of rows) counts[activityKind(row)]++
  return counts
}

function activityUnitsForCell(rows: SqlRow[], cellId: string): number {
  return rows.reduce(
    (total, row) =>
      text(row, 'cell_id') === cellId ? total + integer(row, 'request_units') : total,
    0
  )
}

function activity(row: SqlRow) {
  return {
    relayHostId: text(row, 'relay_host_id'),
    cellId: text(row, 'cell_id'),
    assignmentEpoch: integer(row, 'assignment_epoch'),
    leaseExpiresAt: integer(row, 'lease_expires_at'),
    lastActivityAt: integer(row, 'last_activity_at'),
    reservedControls: integer(row, 'reserved_controls'),
    reservedSplices: integer(row, 'reserved_splices'),
    reservedInvites: integer(row, 'reserved_invites'),
    pendingInstalls: integer(row, 'pending_installs'),
    pendingConfirmations: integer(row, 'pending_confirmations'),
    migrationLeases: integer(row, 'migration_leases')
  }
}

function requestUnits(row: SqlRow): number {
  return (
    integer(row, 'reserved_controls') +
    2 * integer(row, 'reserved_splices') +
    integer(row, 'reserved_invites') +
    integer(row, 'pending_installs') +
    integer(row, 'pending_confirmations') +
    integer(row, 'migration_leases')
  )
}

function integer(row: SqlRow, field: string): number {
  const value = Number(row[field])
  if (!Number.isSafeInteger(value)) throw new Error(`invalid_${field}`)
  return value
}

function text(row: SqlRow, field: string): string {
  const value = row[field]
  if (typeof value !== 'string') throw new Error(`invalid_${field}`)
  return value
}

function cellFenceAttempt(row: SqlRow): CellFenceAttempt {
  const environment = text(row, 'environment')
  if (!['staging', 'production'].includes(environment)) {
    throw new Error('invalid_environment')
  }
  return {
    attemptId: text(row, 'attempt_id'),
    environment: environment as CellFenceAttempt['environment'],
    cellId: text(row, 'cell_id'),
    cellIncarnation: text(row, 'cell_incarnation'),
    migName: text(row, 'mig_name'),
    instanceGroup: text(row, 'instance_group'),
    generationIdentity: text(row, 'generation_identity'),
    fenceCommit: text(row, 'fence_commit'),
    planSha256: text(row, 'plan_sha256'),
    planObjectName: text(row, 'plan_object_name'),
    planObjectGeneration: optionalText(row, 'plan_object_generation'),
    varFileSha256: text(row, 'var_file_sha256'),
    terraformStateLineage: text(row, 'terraform_state_lineage'),
    terraformStateSerial: integer(row, 'terraform_state_serial'),
    terraformStateObjectGeneration: text(
      row,
      'terraform_state_object_generation'
    ),
    terraformStateObjectSha256: text(row, 'terraform_state_object_sha256'),
    requestReason: text(row, 'request_reason'),
    gceOperation: optionalText(row, 'gce_operation'),
    createdAt: integer(row, 'created_at'),
    expiresAt: integer(row, 'expires_at'),
    applyStartedAt: optionalInteger(row, 'apply_started_at'),
    completedAt: optionalInteger(row, 'completed_at'),
    abortedAt: optionalInteger(row, 'aborted_at')
  }
}

function cellFenceApplyInvocation(row: SqlRow): CellFenceApplyInvocation {
  return {
    invocationId: text(row, 'invocation_id'),
    requestReason: text(row, 'request_reason'),
    startedAt: integer(row, 'started_at'),
    gceOperation: optionalText(row, 'gce_operation')
  }
}

function assertCellFenceAttemptBase(
  row: SqlRow,
  input: CellFenceAttemptEvidence
): void {
  const fields: [keyof CellFenceAttemptEvidence, string][] = [
    ['attemptId', 'attempt_id'],
    ['environment', 'environment'],
    ['cellId', 'cell_id'],
    ['cellIncarnation', 'cell_incarnation'],
    ['migName', 'mig_name'],
    ['instanceGroup', 'instance_group'],
    ['generationIdentity', 'generation_identity'],
    ['fenceCommit', 'fence_commit'],
    ['planSha256', 'plan_sha256'],
    ['planObjectName', 'plan_object_name'],
    ['varFileSha256', 'var_file_sha256'],
    ['terraformStateLineage', 'terraform_state_lineage'],
    ['terraformStateObjectGeneration', 'terraform_state_object_generation'],
    ['terraformStateObjectSha256', 'terraform_state_object_sha256'],
    ['requestReason', 'request_reason']
  ]
  if (
    fields.some(([inputField, rowField]) => input[inputField] !== text(row, rowField)) ||
    input.terraformStateSerial !== integer(row, 'terraform_state_serial')
  ) {
    throw new Error('cell_fence_attempt_evidence_mismatch')
  }
}

function assertCellFenceAttemptEvidence(
  row: SqlRow,
  input: CellFenceAttemptEvidence
): void {
  assertCellFenceAttemptBase(row, input)
  if (
    !input.planObjectGeneration ||
    input.planObjectGeneration !== optionalText(row, 'plan_object_generation')
  ) {
    throw new Error('cell_fence_attempt_evidence_mismatch')
  }
}

function assertActiveCellFenceAttempt(
  row: SqlRow,
  input: CellFenceAttemptEvidence,
  now: number
): void {
  assertCellFenceAttemptEvidence(row, input)
  if (
    integer(row, 'expires_at') <= now &&
    optionalInteger(row, 'apply_started_at') === undefined
  ) {
    throw new Error('cell_fence_attempt_expired')
  }
  if (row.completed_at !== null) throw new Error('cell_fence_attempt_completed')
  if (row.aborted_at !== null) throw new Error('cell_fence_attempt_aborted')
}

async function lockedCellFenceAttempt(
  transaction: RelayDatabase,
  attemptId: string
): Promise<SqlRow> {
  const row = (
    await transaction.queryLocked(
      `${CELL_FENCE_ATTEMPT_SELECT} WHERE attempts.attempt_id = ?`,
      [attemptId]
    )
  )[0]
  if (!row) throw new Error('cell_fence_attempt_not_found')
  return row
}

function pendingControlActivityId(assignmentEpoch: number): string {
  return `control-pending:${assignmentEpoch}`
}

function validateActivityId(activityId: string): void {
  if (!activityId || activityId.length > 256) throw new Error('invalid_activity_id')
}

function activityKind(row: SqlRow): AssignmentActivityKind {
  const value = text(row, 'activity_kind')
  if (!(value in ACTIVITY_REQUEST_UNITS)) throw new Error('invalid_activity_kind')
  return value as AssignmentActivityKind
}

function migrationActivityId(assignmentEpoch: number): string {
  return `migration:${assignmentEpoch}`
}

function isIncompleteMigration(error: unknown): boolean {
  return (
    error instanceof Error &&
    [
      'migration_target_not_registered',
      'migration_source_still_active',
      'migration_target_not_active',
      'migration_assignment_mismatch',
      'migration_source_admission_changed',
      'migration_target_admission_changed',
      'migration_source_runtime_not_quiescent',
      'migration_source_runtime_not_dead',
      'migration_target_runtime_not_ready',
      'migration_cell_inventory_busy',
      'migration_activity_accounting_mismatch',
      'migration_activity_topology_mismatch',
      'migration_activity_lease_shape_mismatch',
      'migration_cell_reservation_accounting_mismatch',
      'cell_fence_attestation_missing'
    ].includes(error.message)
  )
}

function isMissingMigration(error: unknown): boolean {
  return error instanceof Error && error.message === 'migration_not_found'
}

function isDatabaseLockUnavailable(error: unknown): boolean {
  return error instanceof Error && error.message === 'database_lock_unavailable'
}

function isDatabaseLockTimeout(error: unknown): boolean {
  return String((error as { code?: unknown }).code) === '55P03'
}

async function waitForAssignmentLockRetry(deadline: number): Promise<void> {
  const remainingMs = Math.max(0, deadline - Date.now())
  const maxDelayMs = Math.min(ASSIGNMENT_LOCK_RETRY_MAX_DELAY_MS, remainingMs)
  const delayMs = Math.floor(Math.random() * (maxDelayMs + 1))
  await new Promise((resolve) => setTimeout(resolve, delayMs))
}

function migration(identity: AssignmentIdentity, row: SqlRow): RelayAssignmentMigration {
  const targetRegisteredAt = optionalInteger(row, 'target_registered_at')
  return {
    ...identity,
    sourceCellId: text(row, 'source_cell_id'),
    targetCellId: text(row, 'target_cell_id'),
    previousEpoch: integer(row, 'previous_epoch'),
    assignmentEpoch: integer(row, 'assignment_epoch'),
    expiresAt: integer(row, 'expires_at'),
    ...(targetRegisteredAt === undefined ? {} : { targetRegisteredAt })
  }
}

// Attempt ids are server-minted UUIDs and this codebase's invariant messages
// are snake_case slugs; anything else could carry secrets and logs redacted.
function warnRegionalRehomeCandidateFailure(
  operation: 'complete' | 'abort',
  attemptId: string,
  error: unknown
): void {
  const message = error instanceof Error ? error.message : ''
  console.warn(
    JSON.stringify({
      event: 'orca_relay_regional_rehome_candidate_failed',
      operation,
      attemptId,
      reason: /^[a-z0-9_]{1,64}$/.test(message) ? message : 'redacted'
    })
  )
}

// The attempt id is the only field: counts would say which host holds what.
function noteRegionalRehomeActivityCountsRepaired(attemptId: string): void {
  console.warn(
    JSON.stringify({
      event: 'orca_relay_regional_rehome_activity_counts_repaired',
      attemptId
    })
  )
}

function regionalRehomeAttempt(row: SqlRow): RegionalRehomeAttempt {
  return {
    attemptId: text(row, 'attempt_id'),
    userId: text(row, 'user_id'),
    relayHostId: text(row, 'relay_host_id'),
    preferredRegion: 'asia-east2',
    sourceCellId: text(row, 'source_cell_id'),
    sourceCellUrl: text(row, 'source_cell_url'),
    sourceCellIncarnation: text(row, 'source_cell_incarnation'),
    targetCellId: text(row, 'target_cell_id'),
    targetCellIncarnation: text(row, 'target_cell_incarnation'),
    previousEpoch: integer(row, 'previous_epoch'),
    assignmentEpoch: integer(row, 'assignment_epoch'),
    drainGraceMs: integer(row, 'drain_grace_ms'),
    sendAttempts: integer(row, 'send_attempts')
  }
}

function regionalRehomeControl(row: SqlRow): RegionalRehomeControl {
  return {
    generation: integer(row, 'generation'),
    enabled: integer(row, 'enabled') === 1,
    observationStartedAt: integer(row, 'observation_started_at'),
    notBefore: integer(row, 'not_before'),
    ratePerMinute: integer(row, 'rate_per_minute'),
    preferenceMaxAgeMs: integer(row, 'preference_max_age_ms'),
    drainGraceMs: integer(row, 'drain_grace_ms')
  }
}

function cleanRegionalRehomeSafety(now: number): RegionalRehomeSafetySnapshot {
  return {
    observedAt: now,
    sqlFailures: 0,
    reconnects: 0,
    controlActivityRecoveryFailures: 0,
    databasePoolWaiting: 0,
    databasePoolWaitersMax: 0,
    databasePoolWaitMsMax: 0
  }
}

function regionalRehomeFleetSafetyFromInventory(input: {
  cells: SqlRow[]
  admission: ReadonlyMap<string, CellAdmissionState>
  regions: ReadonlyMap<string, RelayRegion>
  runtimes: SqlRow[]
  capabilities: SqlRow[]
  safetyRows: SqlRow[]
  now: number
  heartbeatTtlMs: number
}): RegionalRehomeFleetSafety {
  const capabilities = new Map(
    input.capabilities.map((row) => [text(row, 'cell_id'), row])
  )
  const runtimes = new Map(input.runtimes.map((row) => [text(row, 'cell_id'), row]))
  const safetyRows = new Map(
    input.safetyRows.map((row) => [text(row, 'cell_id'), row])
  )
  const required = input.cells.filter((row) => {
    const cellId = text(row, 'cell_id')
    const capability = capabilities.get(cellId)
    return (
      integer(row, 'enabled') === 1 &&
      input.admission.get(cellId) === 'general' &&
      (input.regions.get(cellId) === 'asia-east2' ||
        (input.regions.get(cellId) === RELAY_DEFAULT_REGION &&
          capability !== undefined &&
          integer(capability, 'regional_rehome_protocol') >= 1))
    )
  })
  const valid = required.flatMap((row) => {
    const cellId = text(row, 'cell_id')
    const runtime = runtimes.get(cellId)
    const safety = safetyRows.get(cellId)
    if (
      !runtime ||
      integer(runtime, 'ready') !== 1 ||
      integer(runtime, 'last_heartbeat_at') <= input.now - input.heartbeatTtlMs ||
      !safety ||
      text(safety, 'cell_incarnation') !== text(runtime, 'cell_incarnation') ||
      integer(safety, 'observed_at') <= input.now - 60_000
    ) {
      return []
    }
    return [safety]
  })
  const missingCells = required.length === 0 ? 1 : required.length - valid.length
  return {
    requiredCells: required.length,
    missingCells,
    observedAt:
      missingCells > 0
        ? 0
        : Math.min(...valid.map((row) => integer(row, 'observed_at'))),
    sqlFailures: valid.reduce((total, row) => total + integer(row, 'sql_failures'), 0),
    reconnects: valid.reduce((total, row) => total + integer(row, 'reconnects'), 0),
    maxReconnects: Math.max(0, ...valid.map((row) => integer(row, 'reconnects'))),
    controlActivityRecoveryFailures: valid.reduce(
      (total, row) => total + integer(row, 'control_activity_recovery_failures'),
      0
    ),
    databasePoolWaiting: Math.max(
      0,
      ...valid.map((row) => integer(row, 'database_pool_waiting'))
    ),
    databasePoolWaitersMax: Math.max(
      0,
      ...valid.map((row) => integer(row, 'database_pool_waiters_max'))
    ),
    databasePoolWaitMsMax: Math.max(
      0,
      ...valid.map((row) => integer(row, 'database_pool_wait_ms_max'))
    )
  }
}

function regionalRehomeFleetSafetyFailure(
  processSafety: RegionalRehomeSafetySnapshot,
  fleetSafety: RegionalRehomeFleetSafety,
  now: number
): string | null {
  if (fleetSafety.maxReconnects > REGIONAL_REHOME_RECONNECTS_PER_CELL_LIMIT) {
    return 'elevated_reconnects'
  }
  return regionalRehomeSafetyFailure(
    combineRegionalRehomeSafety(processSafety, fleetSafety),
    now,
    fleetSafety.requiredCells
  )
}

type RegionalRehomeCandidateSkip = {
  reason:
    | 'candidate_stale'
    | 'source_ineligible'
    | 'source_unclean'
    | 'source_control_inactive'
    | 'target_unclean'
    | 'no_eligible_target'
    | 'no_target_headroom'
  cellId?: string
  sqlFailures?: number
  reconnects?: number
}

function cellUncleanSkip(
  reason: 'source_unclean' | 'target_unclean',
  cellId: string,
  safety: SqlRow | undefined
): RegionalRehomeCandidateSkip {
  return {
    reason,
    cellId,
    sqlFailures: safety === undefined ? undefined : integer(safety, 'sql_failures'),
    reconnects: safety === undefined ? undefined : integer(safety, 'reconnects')
  }
}

// Candidate skips are otherwise invisible: they neither latch the control off
// nor produce attempts, so an operator cannot tell "skipping" from "idle".
// Cell ids and counters only — never free-form error text.
function aggregateRegionalRehomeCandidateSkips(
  skips: readonly RegionalRehomeCandidateSkip[]
): Record<string, unknown> {
  // `candidates` counts skipped candidate iterations, not distinct cells: one
  // unclean cell blocking six candidates reports candidates=6 on one cellId.
  const aggregated = new Map<string, RegionalRehomeCandidateSkip & { candidates: number }>()
  for (const skip of skips) {
    const key = `${skip.reason}:${skip.cellId ?? ''}`
    const entry = aggregated.get(key)
    if (entry) entry.candidates += 1
    else aggregated.set(key, { ...skip, candidates: 1 })
  }
  return {
    event: 'orca_relay_regional_rehome_candidates_skipped',
    skips: [...aggregated.values()]
  }
}

function regionalRehomeCellSafetyIsClean(
  safety: SqlRow | undefined,
  runtime: SqlRow,
  now: number
): boolean {
  return (
    safety !== undefined &&
    text(safety, 'cell_incarnation') === text(runtime, 'cell_incarnation') &&
    integer(safety, 'observed_at') > now - 60_000 &&
    integer(safety, 'sql_failures') <= REGIONAL_REHOME_SQL_FAILURES_PER_CELL_LIMIT &&
    integer(safety, 'reconnects') <= REGIONAL_REHOME_RECONNECTS_PER_CELL_LIMIT &&
    integer(safety, 'control_activity_recovery_failures') === 0 &&
    !regionalRehomePoolPressure({
      databasePoolWaitersMax: integer(safety, 'database_pool_waiters_max'),
      databasePoolWaitMsMax: integer(safety, 'database_pool_wait_ms_max')
    })
  )
}

function assertMigrationPair(row: SqlRow, sourceCellId: string, targetCellId: string): void {
  if (
    text(row, 'source_cell_id') !== sourceCellId ||
    text(row, 'target_cell_id') !== targetCellId
  ) {
    throw new Error('migration_pair_mismatch')
  }
}

function matchesExactCellSet(
  actual: ReadonlySet<string>,
  expected: readonly string[]
): boolean {
  const expectedSet = new Set(expected)
  return (
    expectedSet.size === expected.length &&
    actual.size === expectedSet.size &&
    [...actual].every((cellId) => expectedSet.has(cellId))
  )
}

function assertCurrentMigrationAssignment(
  assignment: SqlRow | undefined,
  migrationRow: SqlRow
): asserts assignment is SqlRow {
  if (
    !assignment ||
    text(assignment, 'cell_id') !== text(migrationRow, 'target_cell_id') ||
    integer(assignment, 'assignment_epoch') !== integer(migrationRow, 'assignment_epoch')
  ) {
    throw new Error('migration_assignment_mismatch')
  }
}

function assertMigrationRecoveryMetadata(
  migrationRow: SqlRow,
  incarnation: SqlRow | undefined,
  pin: SqlRow | undefined
): void {
  if (pin && !incarnation) {
    throw new Error('drain_migration_source_incarnation_mismatch')
  }
  if (
    pin &&
    incarnation &&
    (text(pin, 'source_cell_id') !== text(migrationRow, 'source_cell_id') ||
      text(pin, 'target_cell_id') !== text(migrationRow, 'target_cell_id') ||
      text(pin, 'source_cell_incarnation') !==
        text(incarnation, 'source_cell_incarnation') ||
      text(pin, 'target_cell_incarnation') !==
        text(incarnation, 'target_cell_incarnation') ||
      integer(pin, 'source_request_units') !==
        integer(migrationRow, 'source_request_units') ||
      integer(pin, 'target_reserved_units') !==
        integer(migrationRow, 'target_reserved_units'))
  ) {
    throw new Error('migration_activity_topology_mismatch')
  }
}

function assertAssignmentActivityAccounting(
  assignment: SqlRow,
  leases: SqlRow[],
  migrationRow: SqlRow
): void {
  if (
    integer(migrationRow, 'target_reserved_units') !==
    integer(migrationRow, 'source_request_units') + 1
  ) {
    throw new Error('migration_activity_lease_shape_mismatch')
  }
  const counts = emptyActivityCounts()
  for (const lease of leases) {
    const kind = activityKind(lease)
    const requestUnits = integer(lease, 'request_units')
    if (kind === 'migration') {
      if (
        text(lease, 'activity_id') !==
          migrationActivityId(integer(migrationRow, 'assignment_epoch')) ||
        text(lease, 'cell_id') !== text(migrationRow, 'target_cell_id') ||
        requestUnits !== integer(migrationRow, 'source_request_units')
      ) {
        throw new Error('migration_activity_lease_shape_mismatch')
      }
    } else if (requestUnits !== ACTIVITY_REQUEST_UNITS[kind]) {
      throw new Error('migration_activity_lease_shape_mismatch')
    }
    counts[kind]++
  }
  assertAssignmentActivityCounts(assignment, leases, 1)
}

function assertAssignmentActivityCounts(
  assignment: SqlRow,
  leases: SqlRow[],
  expectedMigrations: number
): void {
  const counts = activityCounts(leases)
  if (
    (Object.keys(ACTIVITY_COLUMN) as AssignmentActivityKind[]).some(
      (kind) => integer(assignment, ACTIVITY_COLUMN[kind]) !== counts[kind]
    ) ||
    counts.migration !== expectedMigrations
  ) {
    throw new Error('migration_activity_accounting_mismatch')
  }
}

async function assertCellReservationAccounting(
  transaction: RelayDatabase,
  cells: SqlRow[],
  cellIds: string[]
): Promise<void> {
  const uniqueCellIds = [...new Set(cellIds)]
  const rows = await transaction.query(
    `SELECT cell_id, COALESCE(SUM(request_units), 0) AS request_units
     FROM relay_assignment_activity_leases
     WHERE cell_id IN (${uniqueCellIds.map(() => '?').join(', ')})
     GROUP BY cell_id`,
    uniqueCellIds
  )
  const unitsByCell = new Map(
    rows.map((row) => [text(row, 'cell_id'), integer(row, 'request_units')])
  )
  for (const cellId of uniqueCellIds) {
    const cell = cells.find((row) => text(row, 'cell_id') === cellId)
    if (!cell || integer(cell, 'reserved_requests') !== (unitsByCell.get(cellId) ?? 0)) {
      throw new Error('migration_cell_reservation_accounting_mismatch')
    }
  }
}

function deadSourceCompletionResult(
  row: SqlRow,
  changed: boolean
): DeadSourceCompletionResult {
  return {
    changed,
    assignmentEpoch: integer(row, 'assignment_epoch'),
    sourceCellId: text(row, 'source_cell_id'),
    targetCellId: text(row, 'target_cell_id')
  }
}

function cellDrainAttempt(row: SqlRow): CellDrainAttempt {
  const state = text(row, 'state')
  if (
    ![
      'prepared',
      'send-may-have-started',
      'application-receipt',
      'proven-not-delivered'
    ].includes(state)
  ) {
    throw new Error('invalid_drain_attempt_state')
  }
  return {
    attemptId: text(row, 'attempt_id'),
    cellId: text(row, 'cell_id'),
    cellIncarnation: text(row, 'cell_incarnation'),
    traceValue: text(row, 'trace_value'),
    plannedGraceMs: integer(row, 'planned_grace_ms'),
    state: state as CellDrainAttemptState,
    preparedAt: integer(row, 'prepared_at'),
    sendMayHaveStartedAt: optionalInteger(row, 'send_may_have_started_at'),
    sendPermitExpiresAt: optionalInteger(row, 'send_permit_expires_at'),
    applicationReceiptAt: optionalInteger(row, 'application_receipt_at'),
    backendSuccessStatus: optionalInteger(row, 'backend_success_status'),
    backendInstance: optionalText(row, 'backend_instance'),
    receiptCellIncarnation: optionalText(row, 'receipt_cell_incarnation'),
    retryAfter: optionalInteger(row, 'retry_after'),
    recoverForwardAttemptedAt: optionalInteger(row, 'recover_forward_attempted_at'),
    provenNotDeliveredAt: optionalInteger(row, 'proven_not_delivered_at')
  }
}

function optionalInteger(row: SqlRow, field: string): number | undefined {
  if (row[field] === null || row[field] === undefined) return undefined
  return integer(row, field)
}

function optionalText(row: SqlRow, field: string): string | undefined {
  if (row[field] === null || row[field] === undefined) return undefined
  return text(row, field)
}

function migrationHasExactActiveTarget(row: SqlRow, targetCellId: string): boolean {
  return (
    integer(row, 'target_control_active') === 1 &&
    optionalText(row, 'current_cell_id') === targetCellId &&
    optionalInteger(row, 'current_assignment_epoch') === integer(row, 'assignment_epoch')
  )
}

function assignmentKey(userId: string, relayHostId: string): string {
  return `${userId}\u0000${relayHostId}`
}

function emptyActivityCounts(): Record<AssignmentActivityKind, number> {
  return {
    control: 0,
    splice: 0,
    invite: 0,
    install: 0,
    confirmation: 0,
    migration: 0
  }
}
